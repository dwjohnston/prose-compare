// One lane = one Cloudflare Sandbox (Containers + @cloudflare/sandbox Files), destroyed afterwards
// (SPEC.md "Run pipeline"). Follows the runner in Cloudflare's OpenCode guide
// (https://developers.cloudflare.com/sandbox/coding-agents/opencode/, example code in
// cloudflare/sandbox-sdk examples/coding-agents), with the run held open by this RPC call instead of
// polled, because one lane is bounded by a wall-clock timeout well under the queue consumer's limit.
import { Files } from "@cloudflare/sandbox";
import { DurableObject } from "cloudflare:workers";

import { harnessArgv, harnessConfig, harnessEnv, SKILLS_DIR, WORK_DIR } from "../config/harness";
import type { Env } from "../env";
import { planMaterialise } from "./materialise";
import type { Outbound } from "./outbound";

// The container trusts this CA for intercepted HTTPS. exec() doesn't inherit start() env, so pass it on
// every command that makes HTTPS requests. OpenCode V2 is a Bun binary and reads NODE_EXTRA_CA_CERTS /
// SSL_CERT_FILE. TODO(golden-capture): confirm in a live run that model calls succeed through intercept.
const CA_PATH = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";
const TRUST_ENV = {
  NODE_EXTRA_CA_CERTS: CA_PATH,
  SSL_CERT_FILE: CA_PATH,
  CURL_CA_BUNDLE: CA_PATH,
};
const RUN_USER = "runner";
const MAX_EVENTS_BYTES = 16 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;

export interface LaneRunSpec {
  laneId: string;
  model: string;
  prompt: string;
  skills: { name: string; files: { path: string; bytes: Uint8Array }[] }[];
  timeoutMs: number;
}

export interface LaneRunResult {
  exitCode: number | null;
  timedOut: boolean;
  events: string;
  eventsTruncated: boolean;
  stderrTail: string;
  durationMs: number;
  /** The run was stopped by cancel(). */
  cancelled: boolean;
}

const CANCEL_KEY = "cancelled";

interface SandboxState extends DurableObjectState {
  readonly exports: Cloudflare.Exports & { readonly Outbound: LoopbackForExport<typeof Outbound> };
}

export class LaneSandbox extends DurableObject<Env> {
  readonly #container: Container;
  readonly #files: Files;
  readonly #outbound: Fetcher;
  /** Set while `opencode run` is executing; ends the run early when called. */
  #onCancel: (() => void) | undefined;

  constructor(ctx: SandboxState, env: Env) {
    super(ctx, env);
    const container = ctx.container;
    if (container === undefined) throw new Error("Container attachment is unavailable");
    this.#container = container;
    this.#files = new Files(container);
    this.#outbound = ctx.exports.Outbound({});
  }

  /**
   * Stop this lane. Recorded in storage first, so a cancel that arrives before run() reaches the model
   * (or between the consumer claiming the lane and calling run()) still takes effect.
   */
  async cancel(): Promise<void> {
    this.ctx.storage.kv.put(CANCEL_KEY, "1");
    this.#onCancel?.();
  }

  #isCancelled(): boolean {
    return this.ctx.storage.kv.get(CANCEL_KEY) !== undefined;
  }

  async run(spec: LaneRunSpec): Promise<LaneRunResult> {
    // Validate before anything starts: a bad snapshot never reaches a container.
    const plan = planMaterialise(spec.skills);
    const started = Date.now();
    const cancelledEarly = (): LaneRunResult => ({
      exitCode: null,
      timedOut: false,
      events: "",
      eventsTruncated: false,
      stderrTail: "",
      durationMs: Date.now() - started,
      cancelled: true,
    });
    if (this.#isCancelled()) return cancelledEarly();
    try {
      if (this.#container.running) await this.#container.destroy();
      this.#container.start({
        image: this.#container.images.sandbox,
        instance: "standard-1",
        enableInternet: false,
        labels: { app: "prose-compare", lane: spec.laneId },
      });
      // Every HTTP and HTTPS request from the guest goes to the Outbound entrypoint; other ports have no route.
      await this.#container.interceptAllOutboundHttp(this.#outbound);
      await this.#container.interceptOutboundHttps("*", this.#outbound);
      await this.#container.setInactivityTimeout(spec.timeoutMs + 5 * 60_000);

      // Materialise: one file at a time through the Files API, under /work/.opencode/skills/<name>/.
      for (const dir of plan.directories) await this.#files.mkdir(dir, { recursive: true });
      for (const file of plan.files) await this.#files.writeFile(file.absolutePath, file.bytes);
      const home = `/tmp/home-${crypto.randomUUID()}`;
      await this.#root(["/bin/sh", "-c", 'mkdir -p "$1" && chown -R runner:runner "$1" && chmod -R a+rX "$2"', "prep", home, SKILLS_DIR]);

      if (this.#isCancelled()) return cancelledEarly();
      const config = JSON.stringify(harnessConfig(spec.skills.map((s) => s.name), spec.model));
      const proc = await this.#container.exec(harnessArgv(spec.model, spec.prompt), {
        cwd: WORK_DIR,
        user: RUN_USER,
        env: { ...TRUST_ENV, ...harnessEnv(config, home), PATH: "/usr/local/bin:/usr/bin:/bin" },
        stdout: "pipe",
        stderr: "pipe",
      });

      const stdout = collect(proc.stdout, MAX_EVENTS_BYTES, "head");
      const stderr = collect(proc.stderr, MAX_STDERR_BYTES, "tail");
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), spec.timeoutMs);
      });
      const cancel = new Promise<"cancelled">((resolve) => {
        this.#onCancel = () => resolve("cancelled");
      });
      // A cancel that landed between the last check and installing the handler.
      if (this.#isCancelled()) this.#onCancel?.();
      const outcome = await Promise.race([proc.exitCode, timeout, cancel]);
      this.#onCancel = undefined;
      clearTimeout(timer);
      const timedOut = outcome === "timeout";
      const cancelled = outcome === "cancelled";
      if (timedOut || cancelled) {
        try {
          proc.kill(9);
        } catch {
          // already gone
        }
      }
      const [out, err] = await Promise.all([settle(stdout, 10_000), settle(stderr, 10_000)]);
      return {
        exitCode: timedOut || cancelled ? null : (outcome as number),
        timedOut,
        cancelled,
        events: out.text,
        eventsTruncated: out.truncated,
        stderrTail: err.text,
        durationMs: Date.now() - started,
      };
    } finally {
      this.#onCancel = undefined;
      // Tear down: destroy the sandbox whatever happened.
      await this.#container.destroy().catch(() => {});
    }
  }

  async #root(argv: string[]): Promise<void> {
    const p = await this.#container.exec(argv, { cwd: "/", user: "root" });
    const out = await p.output();
    if (out.exitCode !== 0) throw new Error(`Sandbox setup failed (${out.exitCode}): ${new TextDecoder().decode(out.stderr).slice(-500)}`);
  }
}

interface Collected {
  text: string;
  truncated: boolean;
}

/** Read a stream to the end, keeping at most `max` bytes from the head or the tail. */
async function collect(stream: ReadableStream | null, max: number, keep: "head" | "tail"): Promise<Collected> {
  if (stream === null) return { text: "", truncated: false };
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = value instanceof Uint8Array ? value : new Uint8Array(value as ArrayBuffer);
    if (keep === "head") {
      const room = max - size;
      if (chunk.byteLength > room) truncated = true;
      if (room <= 0) continue;
      const part = chunk.subarray(0, room);
      chunks.push(part);
      size += part.byteLength;
    } else {
      chunks.push(chunk);
      size += chunk.byteLength;
      while (size > max && chunks.length > 1) {
        size -= chunks.shift()!.byteLength;
        truncated = true;
      }
    }
  }
  const buf = new Uint8Array(size);
  let o = 0;
  for (const c of chunks) {
    buf.set(c, o);
    o += c.byteLength;
  }
  let text = new TextDecoder().decode(buf);
  // A truncated head can end mid-line: drop the partial last line so the NDJSON stays parseable.
  if (truncated && keep === "head") text = text.slice(0, text.lastIndexOf("\n") + 1);
  return { text, truncated };
}

async function settle(p: Promise<Collected>, ms: number): Promise<Collected> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const fallback = new Promise<Collected>((resolve) => {
    timer = setTimeout(() => resolve({ text: "", truncated: true }), ms);
  });
  const result = await Promise.race([p, fallback]);
  clearTimeout(timer);
  return result;
}
