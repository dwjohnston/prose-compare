import { describe, expect, test } from "bun:test";

import { LIMITS } from "../src/config/limits";
import { GithubClient } from "../src/github/fetcher";
import { LinkError } from "../src/github/links";
import { SkillError } from "../src/skills/rules";
import { contentHash, snapshotOf } from "../src/skills/snapshot";
import { makeSha, type MockRepo, mockGithub, skillMd } from "./helpers/mock-github";

const MAIN = makeSha("main");
const FEATURE = makeSha("feature/x");

const repo: MockRepo = {
  owner: "acme",
  repo: "skills",
  refs: { main: MAIN, "feature/x": FEATURE },
  tree: {
    "SKILL.md": { type: "file", content: skillMd("Root Skill", "At the repo root") },
    "writing/plain/SKILL.md": { type: "file", content: skillMd("Plain English!", "Rewrite in plain English") },
    "writing/plain/references/words.md": { type: "file", content: "use: use\nutilise: use\n" },
    "writing/nofm/SKILL.md": { type: "file", content: "# no frontmatter\n" },
    "writing/nodesc/SKILL.md": { type: "file", content: "---\nname: x\n---\nbody" },
    "writing/big/SKILL.md": { type: "file", content: skillMd("big", "too big") },
    "writing/big/blob.bin": { type: "file", content: new Uint8Array(LIMITS.maxSkillBytes) },
    ...Object.fromEntries(
      Array.from({ length: LIMITS.maxSkillFiles + 1 }, (_, i) => [`writing/many/f${i}.md`, { type: "file" as const, content: "x" }]),
    ),
    "writing/many/SKILL.md": { type: "file", content: skillMd("many", "too many files") },
  },
};

const client = () => new GithubClient({ fetch: mockGithub([repo, { owner: "acme", repo: "secret", private: true, refs: {}, tree: {} }]).fetch });

describe("resolve", () => {
  test("pins a tree link to the commit SHA and splits ref/path", async () => {
    expect(await client().resolve("https://github.com/acme/skills/tree/main/writing/plain")).toEqual({
      owner: "acme",
      repo: "skills",
      path: "writing/plain",
      commitSha: MAIN,
    });
  });
  test("handles refs with slashes", async () => {
    const r = await client().resolve("https://github.com/acme/skills/blob/feature/x/writing/plain/SKILL.md");
    expect(r).toMatchObject({ path: "writing/plain", commitSha: FEATURE });
  });
  test("repo root uses the default branch", async () => {
    expect(await client().resolve("https://github.com/acme/skills")).toMatchObject({ path: "", commitSha: MAIN });
  });
  test("private and unknown repos and refs fail at resolve time", async () => {
    await expect(client().resolve("https://github.com/acme/secret")).rejects.toThrow(LinkError);
    await expect(client().resolve("https://github.com/acme/nope")).rejects.toThrow(LinkError);
    await expect(client().resolve("https://github.com/acme/skills/tree/nobranch/writing")).rejects.toThrow(LinkError);
  });
});

describe("fetchSkill", () => {
  test("fetches each file at the pinned SHA and names the folder after the normalised name", async () => {
    const gh = mockGithub([repo]);
    const c = new GithubClient({ fetch: gh.fetch });
    const skill = await c.fetchSkill(await c.resolve("https://github.com/acme/skills/tree/main/writing/plain"));
    expect(skill.name).toBe("plain-english");
    expect(skill.displayName).toBe("Plain English!");
    expect(skill.files.map((f) => f.path)).toEqual(["SKILL.md", "references/words.md"]);
    const contentCalls = gh.calls.filter((c) => c.includes("/contents"));
    expect(contentCalls.every((c) => c.endsWith(`?ref=${MAIN}`))).toBe(true);
    // one listing per folder + one request per file
    expect(contentCalls.length).toBe(4);
  });
  test("frontmatter is required", async () => {
    const c = client();
    await expect(c.fetchSkill({ owner: "acme", repo: "skills", path: "writing/nofm", commitSha: MAIN })).rejects.toThrow("frontmatter");
    await expect(c.fetchSkill({ owner: "acme", repo: "skills", path: "writing/nodesc", commitSha: MAIN })).rejects.toThrow("description");
  });
  test("size and file-count caps", async () => {
    const c = client();
    await expect(c.fetchSkill({ owner: "acme", repo: "skills", path: "writing/big", commitSha: MAIN })).rejects.toThrow("larger than");
    await expect(c.fetchSkill({ owner: "acme", repo: "skills", path: "writing/many", commitSha: MAIN })).rejects.toThrow("more than");
  });
});

describe("snapshots", () => {
  test("content hash ignores provenance and file order; id includes provenance", async () => {
    const c = client();
    const skill = await c.fetchSkill({ owner: "acme", repo: "skills", path: "writing/plain", commitSha: MAIN });
    const a = await snapshotOf(skill);
    const b = await snapshotOf({ ...skill, owner: "other", files: [...skill.files].reverse() });
    expect(a.record.contentSha256).toBe(b.record.contentSha256);
    expect(a.record.filesBlob).toBe(`skills/${a.record.contentSha256}.json`);
    expect(a.record.id).not.toBe(b.record.id);
    expect(await contentHash(skill.files)).toBe(a.record.contentSha256);
  });
  test("error type", () => {
    expect(new SkillError("x")).toBeInstanceOf(Error);
  });
});
