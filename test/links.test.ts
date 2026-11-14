import { describe, expect, test } from "bun:test";

import { LinkError, parseGithubLink, refCandidates } from "../src/github/links";

describe("parseGithubLink", () => {
  test("repo root", () => {
    expect(parseGithubLink("https://github.com/acme/skills")).toEqual({ owner: "acme", repo: "skills", kind: "root", rest: [] });
    expect(parseGithubLink("https://github.com/acme/skills.git/").repo).toBe("skills");
  });
  test("tree folder and blob SKILL.md", () => {
    expect(parseGithubLink("https://github.com/acme/skills/tree/main/writing/plain").rest).toEqual(["main", "writing", "plain"]);
    const blob = parseGithubLink("https://github.com/acme/skills/blob/feature/x/writing/plain/SKILL.md");
    expect(blob.kind).toBe("blob");
    expect(refCandidates(blob)).toEqual([
      { ref: "feature", path: "x/writing/plain" },
      { ref: "feature/x", path: "writing/plain" },
      { ref: "feature/x/writing", path: "plain" },
      { ref: "feature/x/writing/plain", path: "" },
    ]);
  });
  test("rejects other hosts, blobs that aren't SKILL.md, dot segments and credentials", () => {
    for (const bad of [
      "https://gitlab.com/acme/skills",
      "https://github.com.evil.example/acme/skills",
      "https://github.com/acme/skills/blob/main/README.md",
      "https://github.com/acme/skills/tree/main/a/%2e%2e/b",
      "https://github.com/acme/skills/tree/main/a/..%2fb/..",
      "https://user:pw@github.com/acme/skills",
      "https://github.com/acme/skills/issues/1",
      "https://github.com/acme",
      "javascript:alert(1)",
      "not a url",
    ]) {
      expect(() => parseGithubLink(bad)).toThrow(LinkError);
    }
  });
});
