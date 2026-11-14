// Parse `opencode run --format json` NDJSON and detect skill invocation (SPEC.md "Skill invocation
// detection"). The only trigger signal is a `tool_use` event for the `skill` tool; output text is never
// parsed for it.
//
// Event shape (V2 `opencode2 run --format json`, packages/cli/src/run/noninteractive.ts):
//   {type:"step_start",  timestamp, sessionID, part:{id, messageID, type:"step-start"}}
//   {type:"tool_use",    timestamp, sessionID, part:{id, messageID, type:"tool", tool, state:{status:"completed"|"error", input, output?, error?}}}
//   {type:"text",        timestamp, sessionID, part:{id, messageID, type:"text", text}}
//   {type:"step_finish", timestamp, sessionID, part:{messageID, type:"step-finish", reason, cost, tokens}}
//   {type:"error",       timestamp, sessionID, error:{name?, message?, data?:{message?}}}
// Skill tool input is `{ id }` in V2 (packages/core/src/tool/plugin/skill.ts) and `{ name }` in V1; both are
// accepted. Read input is `{ path }` in V2 and `{ filePath }` in V1; webfetch input is `{ url }`.
//
// This was written against a PROVISIONAL fixture (test/fixtures/events/provisional-v2.ndjson). Once
// scripts/capture-events.ts has produced test/fixtures/events/golden-v2.ndjson, the golden test asserts
// against the real thing; adjust the field lookups below if it disagrees.
import { SKILLS_DIR, WORK_DIR } from "../config/harness";

export type InvocationStatus = "triggered" | "load_failed" | "not_triggered" | "fetched_instead";

export interface LaneSkillRef {
  /** Normalised name = skill ID in the sandbox. */
  name: string;
  owner: string;
  repo: string;
  /** Folder path in the repo ("" = root). */
  path: string;
}

export interface TraceEntry {
  seq: number;
  step: number;
  tool: string;
  status: "completed" | "error";
  /** Skill ID, URL or path, depending on the tool. */
  target: string;
  error?: string;
}

export interface SkillDetection {
  name: string;
  status: InvocationStatus;
  /** Step (1-based) of the first completed load, or of the first attempt if it failed. */
  firstInvokedStep: number | null;
  /** True if the skill loaded before any answer text was emitted. */
  beforeFirstText: boolean | null;
  /** Supporting files read, relative to the skill folder. */
  filesRead: string[];
}

export interface LaneAnalysis {
  skills: SkillDetection[];
  /** `skill` calls naming a skill outside the lane. */
  anomalies: { name: string; step: number; status: string }[];
  trace: TraceEntry[];
  output: string;
  tokens: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number };
  costUsd: number;
  steps: number;
  errors: string[];
  unparsedLines: number;
}

type Json = Record<string, unknown>;

export function parseNdjson(text: string): { events: Json[]; unparsed: number } {
  const events: Json[] = [];
  let unparsed = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      const value: unknown = JSON.parse(trimmed);
      if (value && typeof value === "object" && !Array.isArray(value) && typeof (value as Json).type === "string")
        events.push(value as Json);
      else unparsed++;
    } catch {
      unparsed++;
    }
  }
  return { events, unparsed };
}

const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** Name of the skill a `skill` tool call asked for. */
export function skillCallName(input: Json): string | undefined {
  return str(input.id) ?? str(input.name);
}

function targetOf(tool: string, input: Json): string {
  if (tool === "skill") return skillCallName(input) ?? "";
  if (tool === "webfetch") return str(input.url) ?? "";
  if (tool === "read") return str(input.path) ?? str(input.filePath) ?? "";
  return str(input.url) ?? str(input.path) ?? str(input.filePath) ?? str(input.command) ?? str(input.pattern) ?? "";
}

/** Map a read path to (skill name, file inside the skill), if it is under the skills folder. */
export function skillFileOf(path: string): { name: string; file: string } | undefined {
  let p = path.replace(/\\/g, "/");
  const rel = SKILLS_DIR.slice(WORK_DIR.length + 1);
  if (p.startsWith(`${SKILLS_DIR}/`)) p = p.slice(SKILLS_DIR.length + 1);
  else if (p.startsWith(`./${rel}/`)) p = p.slice(rel.length + 3);
  else if (p.startsWith(`${rel}/`)) p = p.slice(rel.length + 1);
  else if (p.startsWith("skill://")) p = p.slice("skill://".length);
  else return undefined;
  const [name, ...rest] = p.split("/").filter((s) => s !== "");
  if (!name) return undefined;
  return { name, file: rest.join("/") || "SKILL.md" };
}

/** Does a fetched URL point at this skill's own files on GitHub? ("Fetched instead") */
export function urlRefersToSkill(url: string, skill: LaneSkillRef): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const host = u.hostname.toLowerCase();
  const path = decodeURIComponent(u.pathname).toLowerCase();
  const repo = `/${skill.owner}/${skill.repo}`.toLowerCase();
  const skillPath = skill.path.toLowerCase();
  const hasSkillPath = (rest: string) => skillPath === "" || rest.includes(`/${skillPath}/`) || rest.endsWith(`/${skillPath}`);
  if (host === "github.com" || host === "www.github.com" || host === "raw.githubusercontent.com") {
    if (!(path === repo || path.startsWith(`${repo}/`))) return false;
    return hasSkillPath(path.slice(repo.length));
  }
  if (host === "api.github.com") {
    const prefix = `/repos${repo}`;
    if (!path.startsWith(`${prefix}/`) && path !== prefix) return false;
    return hasSkillPath(path.slice(prefix.length));
  }
  return false;
}

export function analyseLane(ndjson: string, laneSkills: readonly LaneSkillRef[]): LaneAnalysis {
  const { events, unparsed } = parseNdjson(ndjson);
  const inLane = new Map(laneSkills.map((s) => [s.name, s]));
  const trace: TraceEntry[] = [];
  const anomalies: LaneAnalysis["anomalies"] = [];
  const errors: string[] = [];
  const tokens = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
  let costUsd = 0;
  let step = 0;
  let firstTextSeq: number | null = null;
  const textByMessage = new Map<string, string[]>();
  const messageOrder: string[] = [];

  const perSkill = new Map<string, { completed?: { step: number; seq: number }; failed?: { step: number; seq: number }; files: Set<string> }>();
  for (const s of laneSkills) perSkill.set(s.name, { files: new Set() });
  const webfetches: string[] = [];

  events.forEach((event, seq) => {
    const part = obj(event.part);
    switch (event.type) {
      case "step_start":
        step++;
        break;
      case "step_finish": {
        costUsd += num(part.cost);
        const t = obj(part.tokens);
        const cache = obj(t.cache);
        tokens.input += num(t.input);
        tokens.output += num(t.output);
        tokens.reasoning += num(t.reasoning);
        tokens.cacheRead += num(cache.read);
        tokens.cacheWrite += num(cache.write);
        break;
      }
      case "text": {
        const text = str(part.text) ?? "";
        if (text.trim() !== "" && firstTextSeq === null) firstTextSeq = seq;
        const messageID = str(part.messageID) ?? "";
        if (!textByMessage.has(messageID)) {
          textByMessage.set(messageID, []);
          messageOrder.push(messageID);
        }
        textByMessage.get(messageID)!.push(text);
        break;
      }
      case "tool_use": {
        const tool = str(part.tool) ?? "unknown";
        const state = obj(part.state);
        const status = state.status === "completed" ? "completed" : state.status === "error" ? "error" : undefined;
        if (!status) break; // only finished calls count
        const input = obj(state.input);
        const target = targetOf(tool, input);
        const entry: TraceEntry = { seq, step: Math.max(step, 1), tool, status, target };
        if (status === "error") entry.error = str(state.error) ?? str(obj(state.error).message) ?? "error";
        trace.push(entry);
        if (tool === "skill") {
          const name = skillCallName(input) ?? "";
          const rec = perSkill.get(name);
          if (!rec) anomalies.push({ name, step: entry.step, status });
          else if (status === "completed") rec.completed ??= { step: entry.step, seq };
          else rec.failed ??= { step: entry.step, seq };
        } else if (tool === "read" && status === "completed") {
          const hit = skillFileOf(target);
          if (hit) perSkill.get(hit.name)?.files.add(hit.file);
        } else if (tool === "webfetch") {
          webfetches.push(target);
        }
        break;
      }
      case "error": {
        const e = obj(event.error);
        errors.push(str(obj(e.data).message) ?? str(e.message) ?? str(e.name) ?? "error");
        break;
      }
    }
  });

  const skills: SkillDetection[] = laneSkills.map((s) => {
    const rec = perSkill.get(s.name)!;
    const filesRead = [...rec.files].filter((f) => f !== "SKILL.md").sort();
    if (rec.completed) {
      return {
        name: s.name,
        status: "triggered",
        firstInvokedStep: rec.completed.step,
        beforeFirstText: firstTextSeq === null || rec.completed.seq < firstTextSeq,
        filesRead,
      };
    }
    if (rec.failed) return { name: s.name, status: "load_failed", firstInvokedStep: rec.failed.step, beforeFirstText: null, filesRead };
    const fetched = webfetches.some((url) => urlRefersToSkill(url, s));
    return { name: s.name, status: fetched ? "fetched_instead" : "not_triggered", firstInvokedStep: null, beforeFirstText: null, filesRead };
  });

  // The answer is the text of the last assistant message that produced any.
  let output = "";
  for (let i = messageOrder.length - 1; i >= 0; i--) {
    const joined = textByMessage.get(messageOrder[i]!)!.join("");
    if (joined.trim() !== "") {
      output = joined.trim();
      break;
    }
  }

  return { skills, anomalies, trace, output, tokens, costUsd, steps: step, errors, unparsedLines: unparsed };
}
