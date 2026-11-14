// In-memory GitHub REST API that mimics the parts of the contents API the fetcher uses, including the
// awkward cases: symlinks (listed as "symlink"; fetching a symlink to a file returns the *target's*
// content and path), submodules (listed as "file" with download_url null, or as "submodule").
import { bytesToBase64 } from "../../src/github/fetcher";

export type Node =
  | { type: "file"; content: string | Uint8Array }
  | { type: "symlink"; target: string }
  | { type: "submodule"; url: string }
  /** Simulates an API listing that returns an entry name the real API never would (e.g. with ".."). */
  | { type: "raw-entry"; dir: string; entry: Record<string, unknown> };

export interface MockRepo {
  owner: string;
  repo: string;
  defaultBranch?: string;
  private?: boolean;
  /** ref name -> commit sha */
  refs: Record<string, string>;
  /** path -> node, at every sha (tests don't need history). */
  tree: Record<string, Node>;
  submoduleListedAs?: "file" | "submodule";
}

const SHA_OF = (s: string) => s.padEnd(40, "0").slice(0, 40);

export function makeSha(seed: string): string {
  let h = 0;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return SHA_OF(h.toString(16));
}

function blobSha(path: string): string {
  return makeSha(`blob:${path}`);
}

export function mockGithub(repos: MockRepo[]) {
  const calls: string[] = [];
  const fetchImpl = async (input: string): Promise<Response> => {
    const url = new URL(input);
    calls.push(url.pathname + url.search);
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (parts[0] !== "repos") return json(404, { message: "Not Found" });
    const repo = repos.find((r) => r.owner === parts[1] && r.repo === parts[2]);
    if (!repo) return json(404, { message: "Not Found" });
    const rest = parts.slice(3);
    if (rest.length === 0) return json(200, { default_branch: repo.defaultBranch ?? "main", private: repo.private ?? false });
    if (rest[0] === "commits") {
      const ref = rest.slice(1).join("/");
      const sha = /^[0-9a-f]{40}$/.test(ref) && Object.values(repo.refs).includes(ref) ? ref : repo.refs[ref];
      return sha ? json(200, { sha }) : json(422, { message: "No commit found" });
    }
    if (rest[0] === "contents") {
      const path = rest.slice(1).join("/");
      return contents(repo, path, json);
    }
    return json(404, { message: "Not Found" });
  };
  return { fetch: fetchImpl, calls };
}

function entryFor(repo: MockRepo, path: string, name: string): Record<string, unknown> {
  const node = repo.tree[path];
  const base = { name, path, sha: blobSha(path) };
  if (!node) return { ...base, type: "dir", size: 0, download_url: null };
  switch (node.type) {
    case "file":
      return { ...base, type: "file", size: size(node.content), download_url: `https://raw.example/${path}` };
    case "symlink":
      return { ...base, type: "symlink", size: node.target.length, download_url: `https://raw.example/${path}` };
    case "submodule":
      return repo.submoduleListedAs === "submodule"
        ? { ...base, type: "submodule", size: 0, download_url: null }
        : { ...base, type: "file", size: 0, download_url: null };
    case "raw-entry":
      return node.entry;
  }
}

function contents(repo: MockRepo, path: string, json: (s: number, b: unknown) => Response): Response {
  const node = repo.tree[path];
  if (node?.type === "file") {
    return json(200, {
      type: "file",
      encoding: "base64",
      name: path.split("/").pop(),
      path,
      sha: blobSha(path),
      size: size(node.content),
      content: bytesToBase64(typeof node.content === "string" ? new TextEncoder().encode(node.content) : node.content),
    });
  }
  if (node?.type === "symlink") {
    const target = repo.tree[node.target];
    if (target?.type === "file") {
      // GitHub serves a symlink-to-file as the target file, with the target's path and sha.
      return json(200, {
        type: "file",
        encoding: "base64",
        name: node.target.split("/").pop(),
        path: node.target,
        sha: blobSha(node.target),
        size: size(target.content),
        content: bytesToBase64(typeof target.content === "string" ? new TextEncoder().encode(target.content) : target.content),
      });
    }
    return json(200, { type: "symlink", target: node.target, path, name: path.split("/").pop(), sha: blobSha(path) });
  }
  if (node?.type === "submodule") return json(200, { type: "submodule", path, submodule_git_url: node.url });
  // Directory: list direct children.
  const prefix = path === "" ? "" : `${path}/`;
  const children = new Map<string, string>();
  for (const [key, node] of Object.entries(repo.tree)) {
    if (node.type === "raw-entry") {
      if (node.dir === path) children.set(`raw:${key}`, key);
      continue;
    }
    if (!key.startsWith(prefix)) continue;
    const name = key.slice(prefix.length).split("/")[0]!;
    children.set(name, prefix + name);
  }
  if (children.size === 0) return json(404, { message: "Not Found" });
  const list = [...children.entries()].map(([name, full]) =>
    name.startsWith("raw:") ? (repo.tree[full] as { entry: Record<string, unknown> }).entry : entryFor(repo, full, name),
  );
  return json(200, list);
}

function size(c: string | Uint8Array): number {
  return typeof c === "string" ? new TextEncoder().encode(c).byteLength : c.byteLength;
}

export function skillMd(name: string, description: string, body = "Write plainly."): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;
}
