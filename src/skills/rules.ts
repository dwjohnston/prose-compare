// Skill folder rules (SPEC.md "Run pipeline" steps 2-3 and threat #2).
import { parse as parseYaml } from "yaml";

import { LIMITS } from "../config/limits";

export class SkillError extends Error {
  override name = "SkillError";
}

/** Directory or file names that configure a harness. Never allowed inside a skill folder. */
const FORBIDDEN_SEGMENTS = new Set([".opencode", ".claude", ".agents", ".git", "node_modules"]);
const FORBIDDEN_BASENAMES = new Set(["opencode.json", "opencode.jsonc", "agents.md", "claude.md"]);

/**
 * Validate a path relative to the skill folder. Rejects absolute paths, `..` and `.` segments,
 * backslashes, control characters, empty segments, harness config files and anything too deep or long.
 */
export function assertSafeRelativePath(path: string): void {
  if (path.length === 0) throw new SkillError("Empty file path");
  if (path.length > LIMITS.maxPathChars) throw new SkillError(`Path too long: ${truncate(path)}`);
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path) || path.startsWith("~"))
    throw new SkillError(`Absolute path rejected: ${truncate(path)}`);
  if (path.includes("\\")) throw new SkillError(`Backslash in path rejected: ${truncate(path)}`);
  // biome-ignore lint: control characters are exactly what we're rejecting
  if (/[\u0000-\u001f\u007f]/.test(path)) throw new SkillError("Control character in path rejected");
  const segments = path.split("/");
  if (segments.length > LIMITS.maxSkillDepth) throw new SkillError(`Path too deep: ${truncate(path)}`);
  for (const segment of segments) {
    if (segment === "") throw new SkillError(`Empty path segment rejected: ${truncate(path)}`);
    if (segment === "..") throw new SkillError(`'..' in path rejected: ${truncate(path)}`);
    if (segment === ".") throw new SkillError(`'.' in path rejected: ${truncate(path)}`);
    if (FORBIDDEN_SEGMENTS.has(segment.toLowerCase()))
      throw new SkillError(`Harness config folder not allowed in a skill: ${truncate(path)}`);
  }
  const base = segments[segments.length - 1]!.toLowerCase();
  if (FORBIDDEN_BASENAMES.has(base)) throw new SkillError(`Harness config file not allowed in a skill: ${truncate(path)}`);
}

/** Skill IDs come from the folder name in V2, so the folder is named after the normalised `name`. */
export function normaliseSkillName(name: string): string {
  const id = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, LIMITS.maxSkillNameChars)
    .replace(/-+$/g, "");
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id)) throw new SkillError(`Skill name "${truncate(name)}" has no usable characters`);
  return id;
}

export interface Frontmatter {
  name: string;
  description: string;
}

/** `SKILL.md` needs YAML frontmatter with string `name` and `description`. */
export function parseFrontmatter(markdown: string): Frontmatter {
  const text = markdown.replace(/^﻿/, "");
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!match) throw new SkillError("SKILL.md must start with YAML frontmatter (--- ... ---)");
  let data: unknown;
  try {
    data = parseYaml(match[1]!, { maxAliasCount: 0, prettyErrors: false });
  } catch (e) {
    throw new SkillError(`SKILL.md frontmatter is not valid YAML: ${(e as Error).message.split("\n")[0]}`);
  }
  if (typeof data !== "object" || data === null || Array.isArray(data))
    throw new SkillError("SKILL.md frontmatter must be a YAML mapping");
  const { name, description } = data as Record<string, unknown>;
  if (typeof name !== "string" || name.trim() === "") throw new SkillError("SKILL.md frontmatter needs a string `name`");
  if (typeof description !== "string" || description.trim() === "")
    throw new SkillError("SKILL.md frontmatter needs a string `description`");
  if (description.length > LIMITS.maxDescriptionChars) throw new SkillError("SKILL.md description is too long");
  return { name: name.trim(), description: description.trim() };
}

export interface SkillFile {
  path: string;
  bytes: Uint8Array;
}

/**
 * Whole-folder checks once every file is fetched: file count and size caps, SKILL.md at the root,
 * no nested SKILL.md (one link = one skill), and every path safe.
 */
export function validateFolder(files: readonly SkillFile[]): Frontmatter {
  if (files.length > LIMITS.maxSkillFiles) throw new SkillError(`Skill has more than ${LIMITS.maxSkillFiles} files`);
  let total = 0;
  const seen = new Set<string>();
  for (const file of files) {
    assertSafeRelativePath(file.path);
    const key = file.path.toLowerCase();
    if (seen.has(key)) throw new SkillError(`Duplicate path (case-insensitive): ${truncate(file.path)}`);
    seen.add(key);
    total += file.bytes.byteLength;
    if (file.path !== "SKILL.md" && file.path.split("/").pop()!.toUpperCase() === "SKILL.MD")
      throw new SkillError(`Nested SKILL.md rejected: ${truncate(file.path)}`);
  }
  if (total > LIMITS.maxSkillBytes) throw new SkillError(`Skill folder is larger than ${LIMITS.maxSkillBytes / 1024} KB`);
  const skillMd = files.find((f) => f.path === "SKILL.md");
  if (!skillMd) throw new SkillError("Skill folder has no SKILL.md at its root");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(skillMd.bytes);
  } catch {
    throw new SkillError("SKILL.md is not valid UTF-8");
  }
  return parseFrontmatter(text);
}

/** Reject two skills with the same (normalised) name in one lane. */
export function assertUniqueNames(names: readonly string[]): void {
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) throw new SkillError(`Two skills in one lane are both named "${name}"`);
    seen.add(name);
  }
}

function truncate(s: string): string {
  return s.length > 80 ? `${s.slice(0, 77)}...` : s;
}
