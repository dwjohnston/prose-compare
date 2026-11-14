import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { analyseLane, skillFileOf, urlRefersToSkill } from "../src/runner/events";

// PROVISIONAL fixture: hand-written from OpenCode V2 source. See test/fixtures/events/README.md.
const PROVISIONAL = readFileSync(`${import.meta.dir}/fixtures/events/provisional-v2.ndjson`, "utf8");

const lane = [
  { name: "plain-english", owner: "acme", repo: "skills", path: "plain-english" },
  { name: "terse-style", owner: "acme", repo: "skills", path: "terse-style" },
  { name: "broken-skill", owner: "acme", repo: "skills", path: "broken-skill" },
  { name: "fetcher-skill", owner: "acme", repo: "skills", path: "fetcher-skill" },
];

describe("detection table (SPEC.md)", () => {
  const a = analyseLane(PROVISIONAL, lane);
  const by = Object.fromEntries(a.skills.map((s) => [s.name, s]));

  test("Triggered: completed skill call naming the skill", () => {
    expect(by["plain-english"]).toMatchObject({ status: "triggered", firstInvokedStep: 1, beforeFirstText: true });
  });
  test("Supporting files read are recorded", () => {
    expect(by["plain-english"]!.filesRead).toEqual(["references/word-list.md"]);
  });
  test("Load failed: skill call ended in error", () => {
    expect(by["broken-skill"]).toMatchObject({ status: "load_failed", firstInvokedStep: 1 });
  });
  test("Not triggered: in lane, no skill call", () => {
    expect(by["terse-style"]).toMatchObject({ status: "not_triggered", firstInvokedStep: null });
  });
  test("Fetched instead: no skill call but a webfetch of the skill's own URL", () => {
    expect(by["fetcher-skill"]!.status).toBe("fetched_instead");
  });
  test("Other skills named are anomalies", () => {
    expect(a.anomalies).toEqual([{ name: "some-other-skill", step: 2, status: "error" }]);
  });
  test("usage, output and trace", () => {
    expect(a.steps).toBe(3);
    expect(a.costUsd).toBeCloseTo(0.0313, 6);
    expect(a.tokens.input).toBe(14900);
    expect(a.tokens.output).toBe(510);
    expect(a.output).toBe("Here is the rewritten paragraph.\n\nShort words. Clear claims.");
    expect(a.trace.map((t) => `${t.step}:${t.tool}:${t.status}`)).toEqual([
      "1:skill:completed",
      "1:read:completed",
      "1:skill:error",
      "2:skill:error",
      "2:webfetch:completed",
      "2:webfetch:completed",
    ]);
  });
});

describe("edge cases", () => {
  const ev = (o: object) => JSON.stringify(o);
  test("a skill loaded after the answer text didn't shape it", () => {
    const log = [
      ev({ type: "step_start", part: {} }),
      ev({ type: "text", part: { messageID: "m1", text: "Answer first." } }),
      ev({ type: "tool_use", part: { tool: "skill", state: { status: "completed", input: { id: "a" } } } }),
    ].join("\n");
    const [s] = analyseLane(log, [{ name: "a", owner: "o", repo: "r", path: "" }]).skills;
    expect(s).toMatchObject({ status: "triggered", beforeFirstText: false });
  });
  test("V1 skill input field `name` is accepted; running calls and junk lines are ignored", () => {
    const log = [
      "not json",
      ev({ type: "tool_use", part: { tool: "skill", state: { status: "running", input: { name: "a" } } } }),
      ev({ type: "tool_use", part: { tool: "skill", state: { status: "completed", input: { name: "a" } } } }),
    ].join("\n");
    const res = analyseLane(log, [{ name: "a", owner: "o", repo: "r", path: "" }]);
    expect(res.skills[0]!.status).toBe("triggered");
    expect(res.unparsedLines).toBe(1);
    expect(res.trace.length).toBe(1);
  });
  test("output text is never used for detection", () => {
    const log = ev({ type: "text", part: { messageID: "m", text: "I used the skill a. <skill_content name=\"a\">" } });
    expect(analyseLane(log, [{ name: "a", owner: "o", repo: "r", path: "" }]).skills[0]!.status).toBe("not_triggered");
  });
  test("errors are collected", () => {
    const log = ev({ type: "error", error: { name: "APIError", data: { message: "Insufficient credits" } } });
    expect(analyseLane(log, []).errors).toEqual(["Insufficient credits"]);
  });
  test("skillFileOf and urlRefersToSkill", () => {
    expect(skillFileOf("/work/.opencode/skills/a/references/x.md")).toEqual({ name: "a", file: "references/x.md" });
    expect(skillFileOf(".opencode/skills/a/SKILL.md")).toEqual({ name: "a", file: "SKILL.md" });
    expect(skillFileOf("/etc/passwd")).toBeUndefined();
    const s = { name: "x", owner: "Acme", repo: "Skills", path: "writing/plain" };
    expect(urlRefersToSkill("https://github.com/acme/skills/blob/main/writing/plain/SKILL.md", s)).toBe(true);
    expect(urlRefersToSkill("https://raw.githubusercontent.com/acme/skills/abc/writing/plain/SKILL.md", s)).toBe(true);
    expect(urlRefersToSkill("https://api.github.com/repos/acme/skills/contents/writing/plain/SKILL.md", s)).toBe(true);
    expect(urlRefersToSkill("https://github.com/acme/skills/blob/main/writing/other/SKILL.md", s)).toBe(false);
    expect(urlRefersToSkill("https://example.com/acme/skills/writing/plain", s)).toBe(false);
  });
});
