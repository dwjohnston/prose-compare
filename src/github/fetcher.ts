// Resolve a GitHub link to a commit SHA and fetch the skill folder one file at a time through the
// contents API at that SHA (SPEC.md "Run pipeline" steps 1-2). No archives, no git clone.
import { LIMITS } from "../config/limits";
import { assertSafeRelativePath, normaliseSkillName, SkillError, type SkillFile, validateFolder } from "../skills/rules";
import { LinkError, type ParsedLink, parseGithubLink, refCandidates } from "./links";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface GithubOptions {
  fetch?: FetchLike;
  /** Optional read-only token: unauthenticated calls share a 60/hour limit per egress IP. */
  token?: string;
  apiBase?: string;
}

export interface ResolvedLink {
  owner: string;
  repo: string;
  /** Folder path inside the repo, "" for the root. */
  path: string;
  commitSha: string;
}

export interface FetchedSkill extends ResolvedLink {
  /** Frontmatter `name` as written. */
  displayName: string;
  /** Normalised name: the skill ID and folder name in the sandbox. */
  name: string;
  description: string;
  files: SkillFile[];
}

const SHA = /^[0-9a-f]{40}$/;

export class GithubClient {
  readonly #fetch: FetchLike;
  readonly #token: string | undefined;
  readonly #api: string;
  calls = 0;

  constructor(options: GithubOptions = {}) {
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#token = options.token;
    this.#api = options.apiBase ?? "https://api.github.com";
  }

  async #get(path: string): Promise<{ status: number; body: unknown }> {
    this.calls++;
    if (this.calls > 400) throw new SkillError("Too many GitHub API calls for one submission");
    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "prose-compare",
    };
    if (this.#token) headers.authorization = `Bearer ${this.#token}`;
    const res = await this.#fetch(`${this.#api}${path}`, { headers, redirect: "error" });
    if (res.status === 403 || res.status === 429) throw new SkillError("GitHub API rate limit hit; try again later");
    const body = res.status === 404 ? null : await res.json().catch(() => null);
    return { status: res.status, body };
  }

  async commitSha(owner: string, repo: string, ref: string): Promise<string | undefined> {
    const { status, body } = await this.#get(`/repos/${enc(owner)}/${enc(repo)}/commits/${encPath(ref)}`);
    if (status === 404 || status === 422) return undefined;
    if (status !== 200) throw new SkillError(`GitHub returned ${status} resolving ${owner}/${repo}@${ref}`);
    const sha = (body as { sha?: unknown } | null)?.sha;
    if (typeof sha !== "string" || !SHA.test(sha)) throw new SkillError("GitHub returned no commit SHA");
    return sha;
  }

  async defaultBranch(owner: string, repo: string): Promise<string> {
    const { status, body } = await this.#get(`/repos/${enc(owner)}/${enc(repo)}`);
    if (status === 404) throw new LinkError(`Repository ${owner}/${repo} not found (private repos aren't supported)`);
    if (status !== 200) throw new SkillError(`GitHub returned ${status} for ${owner}/${repo}`);
    const info = body as { default_branch?: unknown; private?: unknown };
    if (info.private === true) throw new LinkError("Private repositories aren't supported");
    if (typeof info.default_branch !== "string") throw new SkillError("Repository has no default branch");
    return info.default_branch;
  }

  /** Raw contents API response for a path at a commit. */
  async contents(owner: string, repo: string, path: string, sha: string): Promise<{ status: number; body: unknown }> {
    const p = path === "" ? "" : `/${encPath(path)}`;
    return this.#get(`/repos/${enc(owner)}/${enc(repo)}/contents${p}?ref=${sha}`);
  }

  /** Turn a link into owner/repo/path pinned to a commit SHA. */
  async resolve(input: string | ParsedLink): Promise<ResolvedLink> {
    const link = typeof input === "string" ? parseGithubLink(input) : input;
    if (link.kind === "root") {
      const branch = await this.defaultBranch(link.owner, link.repo);
      const commitSha = await this.commitSha(link.owner, link.repo, branch);
      if (!commitSha) throw new LinkError(`Could not resolve ${link.owner}/${link.repo}@${branch}`);
      return { owner: link.owner, repo: link.repo, path: "", commitSha };
    }
    await this.defaultBranch(link.owner, link.repo); // rejects private/missing repos up front
    for (const { ref, path } of refCandidates(link)) {
      const commitSha = await this.commitSha(link.owner, link.repo, ref);
      if (commitSha) {
        if (path !== "") assertSafeRelativePath(path.replace(/\/+$/, ""));
        return { owner: link.owner, repo: link.repo, path: path.replace(/\/+$/, ""), commitSha };
      }
    }
    throw new LinkError("Could not find that branch, tag or commit in the repository");
  }

  /** Fetch and validate the skill folder at the pinned SHA. */
  async fetchSkill(resolved: ResolvedLink): Promise<FetchedSkill> {
    const { owner, repo, path: root, commitSha } = resolved;
    const files: SkillFile[] = [];
    let bytes = 0;

    const walk = async (relDir: string, depth: number): Promise<void> => {
      if (depth > LIMITS.maxSkillDepth) throw new SkillError("Skill folder is nested too deeply");
      const full = join(root, relDir);
      const { status, body } = await this.contents(owner, repo, full, commitSha);
      if (status === 404) throw new SkillError(`Folder not found at that commit: ${full || "/"}`);
      if (status !== 200) throw new SkillError(`GitHub returned ${status} listing ${full || "/"}`);
      if (!Array.isArray(body)) {
        const type = (body as { type?: unknown } | null)?.type;
        if (type === "symlink") throw new SkillError(`Symlink rejected: ${full}`);
        if (type === "submodule") throw new SkillError(`Submodule rejected: ${full}`);
        throw new SkillError(`Not a folder: ${full || "/"}`);
      }
      for (const raw of body as unknown[]) {
        const entry = raw as { type?: unknown; name?: unknown; path?: unknown; size?: unknown; sha?: unknown; download_url?: unknown; git_url?: unknown };
        if (typeof entry.name !== "string") throw new SkillError("Malformed folder listing");
        const rel = relDir === "" ? entry.name : `${relDir}/${entry.name}`;
        assertSafeRelativePath(rel);
        if (entry.path !== join(root, rel)) throw new SkillError(`Listing path mismatch for ${rel}`);
        switch (entry.type) {
          case "dir":
            await walk(rel, depth + 1);
            break;
          case "file": {
            // Submodules have historically been listed as type "file" with no download URL.
            if (entry.download_url === null || entry.download_url === undefined)
              throw new SkillError(`Submodule rejected: ${rel}`);
            if (files.length >= LIMITS.maxSkillFiles) throw new SkillError(`Skill has more than ${LIMITS.maxSkillFiles} files`);
            if (typeof entry.size === "number") {
              bytes += entry.size;
              if (bytes > LIMITS.maxSkillBytes) throw new SkillError(`Skill folder is larger than ${LIMITS.maxSkillBytes / 1024} KB`);
            }
            files.push({ path: rel, bytes: await this.#fetchFile(owner, repo, join(root, rel), commitSha, entry.sha) });
            break;
          }
          case "symlink":
            throw new SkillError(`Symlink rejected: ${rel}`);
          case "submodule":
            throw new SkillError(`Submodule rejected: ${rel}`);
          default:
            throw new SkillError(`Unsupported entry type for ${rel}`);
        }
      }
    };

    await walk("", 0);
    const fm = validateFolder(files);
    return {
      ...resolved,
      displayName: fm.name,
      name: normaliseSkillName(fm.name),
      description: fm.description,
      files: files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    };
  }

  async #fetchFile(owner: string, repo: string, path: string, sha: string, listedSha: unknown): Promise<Uint8Array> {
    const { status, body } = await this.contents(owner, repo, path, sha);
    if (status !== 200) throw new SkillError(`GitHub returned ${status} for ${path}`);
    const file = body as { type?: unknown; path?: unknown; encoding?: unknown; content?: unknown; sha?: unknown; size?: unknown } | null;
    if (file === null || Array.isArray(file)) throw new SkillError(`Not a file: ${path}`);
    if (file.type === "symlink") throw new SkillError(`Symlink rejected: ${path}`);
    if (file.type === "submodule") throw new SkillError(`Submodule rejected: ${path}`);
    if (file.type !== "file") throw new SkillError(`Not a file: ${path}`);
    // A symlink to a file is served as the target's content under the target's path.
    if (file.path !== path) throw new SkillError(`Symlink rejected: ${path}`);
    if (typeof listedSha === "string" && file.sha !== listedSha) throw new SkillError(`Symlink or changed blob rejected: ${path}`);
    if (file.encoding !== "base64" || typeof file.content !== "string") throw new SkillError(`File too large or not inline: ${path}`);
    const decoded = base64ToBytes(file.content);
    if (decoded.byteLength > LIMITS.maxSkillBytes) throw new SkillError(`File too large: ${path}`);
    return decoded;
  }
}

function join(a: string, b: string): string {
  return a === "" ? b : b === "" ? a : `${a}/${b}`;
}

function enc(s: string): string {
  return encodeURIComponent(s);
}

function encPath(p: string): string {
  return p.split("/").map(encodeURIComponent).join("/");
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
