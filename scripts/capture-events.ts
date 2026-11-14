#!/usr/bin/env bun
// Capture the golden `opencode run --format json` event log from the PINNED OpenCode V2 (SPEC.md
// "Remaining tasks": capture the event schema).
//
//   OPENROUTER_API_KEY=... bun scripts/capture-events.ts            # native binary for this machine
//   OPENROUTER_API_KEY=... bun scripts/capture-events.ts --docker   # inside the sandbox image (closest to prod)
//
// Options: --model <openrouter slug> (default: the app's default model).
//
// It installs @opencode-ai/cli-<platform>@<pinned version> into .capture/, writes a tiny test skill
// (`capture-probe`, with a references/ file) into a scratch work dir, runs one prompt that should trigger
// it with the app's own harness config and env flags, and saves:
//   test/fixtures/events/golden-v2.ndjson     the raw NDJSON events
//   test/fixtures/events/golden-v2.meta.json  harness version, model, skill name
// then prints what the detector makes of it. Commit both files; test/events.golden.test.ts picks them up.
//
// Your key is passed to OpenCode as OPENROUTER_API_KEY (only here: in production the sandbox only ever
// sees a placeholder). It is never printed, and the script refuses to save a log that contains it.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { HARNESS_VERSION, harnessConfig, harnessEnv, OPENCODE_VERSION } from "../src/config/harness";
import { DEFAULT_MODEL, isAllowedModel } from "../src/config/models";
import { analyseLane } from "../src/runner/events";

const ROOT = resolve(import.meta.dir, "..");
const FIXTURES = join(ROOT, "test/fixtures/events");
const SKILL = "capture-probe";
const PROMPT =
  "Write a four-line poem about a lighthouse. Before writing, load any available skill that applies and follow it, including any reference files it points to.";

const SKILL_MD = `---
name: ${SKILL}
description: House style for ANY poem. Always load this skill before writing a poem of any kind.
---

# Poem house style

1. Read \`references/style.md\` in this skill's folder and follow it.
2. Write the poem in lowercase.
3. End the poem with the line: "— capture-probe".
`;
const STYLE_MD = "Use no more than eight words per line. Avoid the word 'light'.\n";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function fail(message: string): never {
  console.error(`capture-events: ${message}`);
  process.exit(1);
  throw new Error(message);
}

const key = process.env.OPENROUTER_API_KEY || process.env.OPENROUTER_TOKEN;
if (!key) fail("set OPENROUTER_API_KEY (or OPENROUTER_TOKEN) to your OpenRouter key.");
const model = arg("--model") ?? DEFAULT_MODEL;
if (!isAllowedModel(model)) fail(`--model must be one of the allowlisted slugs in src/config/models.ts (got ${model}).`);
const useDocker = process.argv.includes("--docker");

const scratch = mkdtempSync(join(tmpdir(), "prose-compare-capture-"));
const work = join(scratch, "work");
const home = join(scratch, "home");
const skillDir = join(work, ".opencode/skills", SKILL);
mkdirSync(join(skillDir, "references"), { recursive: true });
mkdirSync(home, { recursive: true });
writeFileSync(join(skillDir, "SKILL.md"), SKILL_MD);
writeFileSync(join(skillDir, "references/style.md"), STYLE_MD);

let stdout: string;
let stderr: string;
let status: number | null;

try {
  if (useDocker) {
    console.log(`Building the sandbox image (OpenCode ${OPENCODE_VERSION})…`);
    const build = spawnSync("docker", ["build", "--platform", "linux/amd64", "-t", "prose-compare-sandbox:capture", ROOT], { stdio: "inherit" });
    if (build.status !== 0) fail("docker build failed");
    const config = JSON.stringify(harnessConfig([SKILL], model, "/work"));
    const env = { ...harnessEnv(config, "/tmp/home"), OPENROUTER_API_KEY: key };
    const envArgs = Object.keys(env).flatMap((k) => ["-e", k]);
    console.log(`Running ${model} in the sandbox image…`);
    const run = spawnSync(
      "docker",
      [
        "run", "--rm", "--platform", "linux/amd64", "--user", "runner", "-w", "/work",
        "-v", `${work}:/work:ro`, ...envArgs, "prose-compare-sandbox:capture",
        "sh", "-c", 'mkdir -p /tmp/home && exec opencode run --format json --auto --model "openrouter/$0" -- "$1"', model, PROMPT,
      ],
      { env: { ...process.env, ...env }, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 10 * 60_000 },
    );
    ({ stdout, stderr, status } = run);
  } else {
    const platform = process.platform === "win32" ? "windows" : process.platform;
    const pkg = `@opencode-ai/cli-${platform}-${process.arch}`;
    const installDir = join(ROOT, ".capture");
    const bin = join(installDir, "node_modules", pkg, "bin", process.platform === "win32" ? "opencode2.exe" : "opencode2");
    if (!existsSync(bin)) {
      console.log(`Installing ${pkg}@${OPENCODE_VERSION} into .capture/ …`);
      mkdirSync(installDir, { recursive: true });
      const install = spawnSync("npm", ["install", "--no-save", "--ignore-scripts", "--prefix", installDir, `${pkg}@${OPENCODE_VERSION}`], { stdio: "inherit" });
      if (install.status !== 0 || !existsSync(bin)) fail(`couldn't install ${pkg}@${OPENCODE_VERSION}`);
    }
    const config = JSON.stringify(harnessConfig([SKILL], model, work));
    const env: Record<string, string> = { PATH: process.env.PATH ?? "", ...harnessEnv(config, home), OPENROUTER_API_KEY: key };
    console.log(`Running ${model} with ${HARNESS_VERSION} (native)…`);
    const run = spawnSync(bin, ["run", "--format", "json", "--auto", "--model", `openrouter/${model}`, "--", PROMPT], {
      cwd: work,
      env,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      timeout: 10 * 60_000,
    });
    ({ stdout, stderr, status } = run);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

if (stdout.includes(key) || stderr.includes(key)) fail("the output contains your key; refusing to save it.");
if (status !== 0) {
  console.error(stderr.slice(-4000));
  fail(`opencode exited with ${status}. Nothing saved.`);
}
if (stdout.trim() === "") fail("opencode printed no events. Nothing saved.");

mkdirSync(FIXTURES, { recursive: true });
writeFileSync(join(FIXTURES, "golden-v2.ndjson"), stdout.endsWith("\n") ? stdout : `${stdout}\n`);
writeFileSync(
  join(FIXTURES, "golden-v2.meta.json"),
  `${JSON.stringify(
    {
      harnessVersion: HARNESS_VERSION,
      model,
      mode: useDocker ? "docker" : `native ${process.platform}-${process.arch}`,
      capturedAt: new Date().toISOString(),
      skill: SKILL,
      owner: "local",
      repo: "capture",
      path: SKILL,
      prompt: PROMPT,
    },
    null,
    2,
  )}\n`,
);

const a = analyseLane(stdout, [{ name: SKILL, owner: "local", repo: "capture", path: SKILL }]);
const types = new Map<string, number>();
for (const line of stdout.split("\n")) {
  try {
    const t = (JSON.parse(line) as { type?: string }).type ?? "?";
    types.set(t, (types.get(t) ?? 0) + 1);
  } catch {
    // ignore
  }
}
console.log("\nSaved test/fixtures/events/golden-v2.ndjson and golden-v2.meta.json");
console.log(`Event types: ${[...types].map(([t, n]) => `${t}×${n}`).join(", ")}`);
console.log(`Detector: ${SKILL} -> ${a.skills[0]!.status} (step ${a.skills[0]!.firstInvokedStep}, before first text: ${a.skills[0]!.beforeFirstText})`);
console.log(`Files read: ${a.skills[0]!.filesRead.join(", ") || "none"} · tool calls: ${a.trace.map((t) => `${t.tool}:${t.status}`).join(", ")}`);
console.log(`Cost $${a.costUsd.toFixed(4)} · tokens in ${a.tokens.input} / out ${a.tokens.output} · unparsed lines ${a.unparsedLines}`);
if (a.skills[0]!.status !== "triggered") {
  console.log("\nThe probe skill did not show as triggered. Check the log: if the skill call is there under a different");
  console.log("tool name or input field, update src/runner/events.ts; if the model just didn't load it, run again.");
}
console.log("\nNext: bun test, then commit test/fixtures/events/golden-v2.*");
