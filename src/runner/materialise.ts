// Turn validated skill snapshots into the exact files written into the sandbox
// (SPEC.md "Run pipeline" step 4). Pure, so the hostile-skill suite can test it without a sandbox.
import { SKILLS_DIR } from "../config/harness";
import { assertSafeRelativePath, assertUniqueNames, normaliseSkillName, SkillError, type SkillFile, validateFolder } from "../skills/rules";

export interface LaneSkillInput {
  /** Normalised skill name: folder and skill ID. */
  name: string;
  files: readonly SkillFile[];
}

export interface PlannedFile {
  absolutePath: string;
  bytes: Uint8Array;
}

export interface MaterialisePlan {
  /** Directories to create, parents first. Always includes SKILLS_DIR, even for a baseline lane. */
  directories: string[];
  files: PlannedFile[];
}

/**
 * Re-checks every rule (snapshots are stored data, so don't trust them blindly), then maps each file to
 * SKILLS_DIR/<name>/<path> and confirms the result stays inside that skill's folder.
 */
export function planMaterialise(skills: readonly LaneSkillInput[]): MaterialisePlan {
  assertUniqueNames(skills.map((s) => s.name));
  const directories = new Set<string>([SKILLS_DIR]);
  const files: PlannedFile[] = [];
  for (const skill of skills) {
    if (normaliseSkillName(skill.name) !== skill.name) throw new SkillError(`Skill folder name is not normalised: ${skill.name}`);
    validateFolder(skill.files);
    const base = `${SKILLS_DIR}/${skill.name}`;
    directories.add(base);
    for (const file of skill.files) {
      assertSafeRelativePath(file.path);
      const absolutePath = normalisePosix(`${base}/${file.path}`);
      if (!absolutePath.startsWith(`${base}/`)) throw new SkillError(`Path escapes the skill folder: ${file.path}`);
      const parts = file.path.split("/");
      for (let i = 1; i < parts.length; i++) directories.add(`${base}/${parts.slice(0, i).join("/")}`);
      files.push({ absolutePath, bytes: file.bytes });
    }
  }
  return {
    directories: [...directories].sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b)),
    files,
  };
}

/** Resolve `.` and `..` the way a POSIX filesystem would (without following symlinks). */
export function normalisePosix(path: string): string {
  const out: string[] = [];
  for (const seg of path.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return `/${out.join("/")}`;
}
