// Hostile test skills, fetch/validate/materialise layer. CI fails if any of them gets through.
// Cases marked needsSandbox also have an end-to-end check that NEEDS A LIVE SANDBOX (test/hostile/README.md).
import { describe, expect, test } from "bun:test";

import { harnessConfig, PLACEHOLDER_KEY, permissionRules } from "../../src/config/harness";
import { GithubClient } from "../../src/github/fetcher";
import { planMaterialise } from "../../src/runner/materialise";
import { decideOutbound } from "../../src/runner/outbound-policy";
import { SkillError } from "../../src/skills/rules";
import { mockGithub } from "../helpers/mock-github";
import { HOSTILE_CASES, HOSTILE_REPO, HOSTILE_SHA } from "./skills";

const client = () => new GithubClient({ fetch: mockGithub([HOSTILE_REPO]).fetch });
const resolved = (folder: string) => ({ owner: "evil", repo: "skills", path: `skills/${folder}`, commitSha: HOSTILE_SHA });

describe("hostile skills rejected at fetch time", () => {
  for (const c of HOSTILE_CASES.filter((c) => c.expect === "reject-at-fetch")) {
    test(c.id, async () => {
      const err = await client().fetchSkill(resolved(c.folder)).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(SkillError);
      expect((err as Error).message).toContain(c.error!);
    });
  }

  test("submodule listed as type 'submodule' is rejected too", async () => {
    const gh = mockGithub([{ ...HOSTILE_REPO, submoduleListedAs: "submodule" }]);
    await expect(new GithubClient({ fetch: gh.fetch }).fetchSkill(resolved("submodule"))).rejects.toThrow("Submodule rejected");
  });

  test("a link pointing straight at a symlink is rejected", async () => {
    await expect(client().fetchSkill({ ...resolved("symlink-environ"), path: "skills/symlink-environ/references/env.txt" })).rejects.toThrow(
      "Symlink rejected",
    );
  });

  test("a link whose path contains '..' never reaches the API", async () => {
    await expect(client().resolve("https://github.com/evil/skills/tree/main/skills/../../etc")).rejects.toThrow();
  });
});

describe("hostile skills that are only text pass fetch, and the harness denies what they ask for", () => {
  test("shell-command body: fetched, but shell is denied by the leading deny-all rule", async () => {
    const skill = await client().fetchSkill(resolved("shell-body"));
    expect(skill.name).toBe("shell-body");
    const rules = permissionRules([skill.name]);
    expect(rules[0]).toEqual({ action: "*", resource: "*", effect: "deny" });
    for (const action of ["shell", "edit", "glob", "grep", "websearch", "subagent", "external_directory", "execute", "question"]) {
      expect(rules.some((r) => r.action === action && r.effect === "allow")).toBe(false);
    }
  });

  test("SSRF description: fetched, and the outbound Worker refuses metadata/localhost/private hosts", async () => {
    const skill = await client().fetchSkill(resolved("ssrf"));
    expect(skill.description).toContain("169.254.169.254");
    for (const url of [
      "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
      "http://[fd00:ec2::254]/latest/meta-data/",
      "http://localhost:8080/",
      "http://127.0.0.1/",
      "http://10.0.0.1/",
      "http://192.168.1.1/",
      "http://metadata.google.internal/computeMetadata/v1/",
      "http://0x7f000001/",
      "http://2130706433/",
      "http://[::ffff:127.0.0.1]/",
      "https://openrouter.ai:8443/api/v1/chat/completions",
    ]) {
      expect(decideOutbound(url).kind, url).toBe("deny");
    }
  });

  test("the real key is only ever added for https://openrouter.ai", () => {
    expect(decideOutbound("https://openrouter.ai/api/v1/chat/completions").kind).toBe("openrouter");
    expect(decideOutbound("http://openrouter.ai/api/v1/chat/completions").kind).toBe("deny");
    expect(decideOutbound("https://openrouter.ai.evil.example/api").kind).toBe("pass");
    expect(decideOutbound("https://evil.example/?openrouter.ai").kind).toBe("pass");
  });

  test("no real key in the harness config", () => {
    const config = JSON.stringify(harnessConfig(["shell-body"], "anthropic/claude-sonnet-5.5"));
    expect(config).not.toContain("sk-or-");
    expect(PLACEHOLDER_KEY).not.toContain("sk-");
  });
});

describe("materialise", () => {
  const ok = { path: "SKILL.md", bytes: new TextEncoder().encode("---\nname: a\ndescription: b\n---\n") };
  test("writes only under /work/.opencode/skills/<name>/", () => {
    const plan = planMaterialise([{ name: "a", files: [ok, { path: "references/x.md", bytes: new Uint8Array([1]) }] }]);
    expect(plan.files.map((f) => f.absolutePath)).toEqual(["/work/.opencode/skills/a/SKILL.md", "/work/.opencode/skills/a/references/x.md"]);
    expect(plan.directories).toEqual(["/work/.opencode/skills", "/work/.opencode/skills/a", "/work/.opencode/skills/a/references"]);
  });
  test("baseline lane gets an empty skills folder", () => {
    expect(planMaterialise([])).toEqual({ directories: ["/work/.opencode/skills"], files: [] });
  });
  test("re-validates stored snapshots: '..', absolute, nested SKILL.md, unnormalised names, duplicates", () => {
    const bad: [string, () => unknown][] = [
      ["dotdot", () => planMaterialise([{ name: "a", files: [ok, { path: "../../../etc/cron.d/x", bytes: new Uint8Array() }] }])],
      ["abs", () => planMaterialise([{ name: "a", files: [ok, { path: "/etc/passwd", bytes: new Uint8Array() }] }])],
      ["nested", () => planMaterialise([{ name: "a", files: [ok, { path: "b/SKILL.md", bytes: ok.bytes }] }])],
      ["name", () => planMaterialise([{ name: "../a", files: [ok] }])],
      ["dup", () => planMaterialise([{ name: "a", files: [ok] }, { name: "a", files: [ok] }])],
      ["plugin", () => planMaterialise([{ name: "a", files: [ok, { path: ".opencode/plugins/x.ts", bytes: new Uint8Array() }] }])],
    ];
    for (const [label, fn] of bad) expect(fn, label).toThrow(SkillError);
  });
});
