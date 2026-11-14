// Asserts detection against the GOLDEN event log captured from the pinned OpenCode by
// scripts/capture-events.ts. Skipped until that file is committed.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

import { HARNESS_VERSION } from "../src/config/harness";
import { analyseLane } from "../src/runner/events";

const dir = `${import.meta.dir}/fixtures/events`;
const logPath = `${dir}/golden-v2.ndjson`;
const metaPath = `${dir}/golden-v2.meta.json`;
const present = existsSync(logPath) && existsSync(metaPath);

describe.skipIf(!present)("golden event log", () => {
  const log = present ? readFileSync(logPath, "utf8") : "";
  const meta = present
    ? (JSON.parse(readFileSync(metaPath, "utf8")) as { harnessVersion: string; skill: string; owner: string; repo: string; path: string })
    : { harnessVersion: "", skill: "", owner: "", repo: "", path: "" };

  test("was captured with the pinned harness", () => {
    expect(meta.harnessVersion).toBe(HARNESS_VERSION);
  });
  test("the test skill shows as triggered from tool_use events", () => {
    const a = analyseLane(log, [{ name: meta.skill, owner: meta.owner, repo: meta.repo, path: meta.path }]);
    expect(a.unparsedLines).toBe(0);
    expect(a.skills[0]!.status).toBe("triggered");
    expect(a.skills[0]!.beforeFirstText).toBe(true);
    expect(a.output.length).toBeGreaterThan(0);
    expect(a.steps).toBeGreaterThan(0);
  });
});
