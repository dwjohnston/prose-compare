// Parse a GitHub skill link (SPEC.md "Run pipeline" step 1).
// Accepted forms:
//   https://github.com/<owner>/<repo>                      -> repo root, default branch
//   https://github.com/<owner>/<repo>/tree/<ref...>/<path> -> folder
//   https://github.com/<owner>/<repo>/blob/<ref...>/<path>/SKILL.md -> the folder holding SKILL.md
// A ref may contain slashes, so the ref/path split is left to the resolver, which tries each split
// against the GitHub API.

export class LinkError extends Error {
  override name = "LinkError";
}

export interface ParsedLink {
  owner: string;
  repo: string;
  kind: "root" | "tree" | "blob";
  /** Path segments after /tree/ or /blob/: "<ref segments...>/<path segments...>". Empty for root. */
  rest: string[];
}

const NAME = /^[A-Za-z0-9_.-]{1,100}$/;

export function parseGithubLink(input: string): ParsedLink {
  // The URL parser silently resolves "..", "%2e%2e" and friends; refuse them before it gets the chance.
  if (/(^|[/\\]|%2f|%5c)(\.|%2e){1,2}($|[/\\?#]|%2f|%5c)/i.test(input.trim().replace(/^[a-z]+:\/\//i, "")))
    throw new LinkError("Link path must not contain '.' or '..' segments");
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new LinkError("Not a URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new LinkError("Link must be http(s)");
  const host = url.hostname.toLowerCase();
  if (host !== "github.com" && host !== "www.github.com") throw new LinkError("Link must be on github.com");
  if (url.username || url.password) throw new LinkError("Link must not contain credentials");

  const segments = url.pathname
    .split("/")
    .filter((s) => s !== "")
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        throw new LinkError("Malformed link path");
      }
    });
  const [owner, rawRepo, kind, ...rest] = segments;
  if (!owner || !rawRepo) throw new LinkError("Link must name an owner and a repository");
  const repo = rawRepo.replace(/\.git$/, "");
  if (!NAME.test(owner) || !NAME.test(repo) || owner === "." || owner === ".." || repo === "." || repo === "..")
    throw new LinkError("Invalid owner or repository name");

  if (kind === undefined) return { owner, repo, kind: "root", rest: [] };
  if (kind !== "tree" && kind !== "blob")
    throw new LinkError("Link must be a repo root, a /tree/ folder, or a /blob/ SKILL.md file");
  if (rest.length === 0) throw new LinkError("Link is missing a ref");
  for (const segment of rest) {
    if (segment === "." || segment === ".." || segment.includes("\\") || segment.includes("\0"))
      throw new LinkError("Link path must not contain '.', '..', backslashes or NUL");
  }
  if (kind === "blob" && rest[rest.length - 1] !== "SKILL.md")
    throw new LinkError("A /blob/ link must point at a SKILL.md file");
  return { owner, repo, kind, rest };
}

/** Candidate (ref, path) splits for a tree/blob link, shortest ref first. */
export function refCandidates(link: ParsedLink, maxRefSegments = 4): { ref: string; path: string }[] {
  if (link.kind === "root") return [];
  const segments = link.kind === "blob" ? link.rest.slice(0, -1) : link.rest;
  const out: { ref: string; path: string }[] = [];
  for (let i = 1; i <= Math.min(segments.length, maxRefSegments); i++) {
    out.push({ ref: segments.slice(0, i).join("/"), path: segments.slice(i).join("/") });
  }
  return out;
}
