// Content-addressed skill snapshots (SPEC.md "Data model": skill_snapshot, R2 blobs by content hash).
import { bytesToBase64, base64ToBytes, type FetchedSkill } from "../github/fetcher";
import type { SkillFile } from "./rules";

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** sha256 over the sorted files: "<path>\0<byteLength>\0<bytes>" for each. Independent of where it came from. */
export async function contentHash(files: readonly SkillFile[]): Promise<string> {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  for (const f of sorted) {
    parts.push(enc.encode(`${f.path}\0${f.bytes.byteLength}\0`), f.bytes);
  }
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const buf = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    buf.set(p, o);
    o += p.byteLength;
  }
  return sha256Hex(buf);
}

export interface SnapshotRecord {
  id: string;
  contentSha256: string;
  owner: string;
  repo: string;
  path: string;
  commitSha: string;
  name: string;
  displayName: string;
  description: string;
  filesBlob: string;
}

export async function snapshotOf(skill: FetchedSkill): Promise<{ record: SnapshotRecord; blob: string }> {
  const contentSha256 = await contentHash(skill.files);
  const id = await sha256Hex(`${skill.owner}/${skill.repo}/${skill.path}@${skill.commitSha}\n${contentSha256}`);
  return {
    record: {
      id,
      contentSha256,
      owner: skill.owner,
      repo: skill.repo,
      path: skill.path,
      commitSha: skill.commitSha,
      name: skill.name,
      displayName: skill.displayName,
      description: skill.description,
      filesBlob: `skills/${contentSha256}.json`,
    },
    blob: encodeFiles(skill.files),
  };
}

export function encodeFiles(files: readonly SkillFile[]): string {
  return JSON.stringify({ files: files.map((f) => ({ path: f.path, base64: bytesToBase64(f.bytes) })) });
}

export function decodeFiles(json: string): SkillFile[] {
  const parsed = JSON.parse(json) as { files?: { path: string; base64: string }[] };
  if (!Array.isArray(parsed.files)) throw new Error("Malformed skill blob");
  return parsed.files.map((f) => ({ path: f.path, bytes: base64ToBytes(f.base64) }));
}
