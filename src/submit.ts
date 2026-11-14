// Submit and "Run again": validate, resolve every link to a pinned SHA, fetch + snapshot each skill,
// create the rows, enqueue one message per lane.
import { HARNESS_VERSION } from "./config/harness";
import { LIMITS } from "./config/limits";
import { isAllowedModel } from "./config/models";
import { createComparison, findSnapshot, getComparison, insertSnapshotStmt, type NewLane, newId, type SnapshotRow } from "./db";
import type { Env } from "./env";
import { GithubClient } from "./github/fetcher";
import { LinkError } from "./github/links";
import { assertUniqueNames, SkillError } from "./skills/rules";
import { snapshotOf } from "./skills/snapshot";

export class InputError extends Error {
  override name = "InputError";
  constructor(
    message: string,
    readonly where?: { lane?: number; link?: number },
  ) {
    super(message);
  }
}

export interface SubmitBody {
  prompt: string;
  model: string;
  lanes: { label: string | null; links: string[] }[];
  /** Tell every lane's model to load all of that lane's skills first. */
  forceSkills: boolean;
  /** Comparison this was started from with "Run again", if any. */
  rerunOf: string | null;
}

export function parseSubmitBody(raw: unknown): SubmitBody {
  const body = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (prompt === "") throw new InputError("Enter a prompt.");
  if (prompt.length > LIMITS.maxPromptChars) throw new InputError(`The prompt is longer than ${LIMITS.maxPromptChars} characters.`);
  const model = typeof body.model === "string" ? body.model : "";
  if (!isAllowedModel(model)) throw new InputError("Pick a model from the list.");
  if (!Array.isArray(body.lanes) || body.lanes.length === 0) throw new InputError("Add at least one lane.");
  if (body.lanes.length > LIMITS.maxLanes) throw new InputError(`At most ${LIMITS.maxLanes} lanes.`);
  const lanes = body.lanes.map((rawLane, i) => {
    const lane = (rawLane && typeof rawLane === "object" ? rawLane : {}) as Record<string, unknown>;
    const label = typeof lane.label === "string" && lane.label.trim() !== "" ? lane.label.trim().slice(0, LIMITS.maxLabelChars) : null;
    const links = Array.isArray(lane.links) ? lane.links.filter((l): l is string => typeof l === "string" && l.trim() !== "").map((l) => l.trim()) : [];
    if (links.length > LIMITS.maxSkillsPerLane) throw new InputError(`At most ${LIMITS.maxSkillsPerLane} skills per lane.`, { lane: i });
    if (new Set(links).size !== links.length) throw new InputError("The same link appears twice in one lane.", { lane: i });
    return { label, links };
  });
  const rerunOf = typeof body.rerunOf === "string" && /^[a-z0-9]{8,32}$/.test(body.rerunOf) ? body.rerunOf : null;
  return { prompt, model, lanes, forceSkills: body.forceSkills === true, rerunOf };
}

export interface ResolvedSkillInfo {
  owner: string;
  repo: string;
  path: string;
  commitSha: string;
  name: string;
  displayName: string;
  description: string;
}

function infoOf(s: SnapshotRow): ResolvedSkillInfo {
  return { owner: s.owner, repo: s.repo, path: s.path, commitSha: s.commit_sha, name: s.name, displayName: s.display_name, description: s.description };
}

/** Resolve a link to a pinned snapshot, fetching and storing it if this (repo, path, SHA) is new. */
export async function snapshotForLink(env: Env, gh: GithubClient, link: string): Promise<SnapshotRow> {
  const resolved = await gh.resolve(link);
  const existing = await findSnapshot(env.DB, resolved.owner, resolved.repo, resolved.path, resolved.commitSha);
  if (existing) return existing;
  const skill = await gh.fetchSkill(resolved);
  const { record, blob } = await snapshotOf(skill);
  if (!(await env.BLOBS.head(record.filesBlob))) {
    await env.BLOBS.put(record.filesBlob, blob, { httpMetadata: { contentType: "application/json" } });
  }
  await insertSnapshotStmt(env.DB, record).run();
  return (await findSnapshot(env.DB, record.owner, record.repo, record.path, record.commitSha))!;
}

/** Compose-page preview: what a link resolves to. Fetches and stores the snapshot too, so submit is quick. */
export async function resolveLink(env: Env, link: string): Promise<ResolvedSkillInfo> {
  const gh = new GithubClient({ token: env.GITHUB_TOKEN });
  return infoOf(await snapshotForLink(env, gh, link));
}

export async function submitComparison(env: Env, body: SubmitBody): Promise<string> {
  const gh = new GithubClient({ token: env.GITHUB_TOKEN });
  const cache = new Map<string, Promise<SnapshotRow>>();
  const lanes: NewLane[] = [];
  for (const [i, lane] of body.lanes.entries()) {
    const snaps: SnapshotRow[] = [];
    for (const [j, link] of lane.links.entries()) {
      try {
        if (!cache.has(link)) cache.set(link, snapshotForLink(env, gh, link));
        snaps.push(await cache.get(link)!);
      } catch (e) {
        if (e instanceof LinkError || e instanceof SkillError) throw new InputError(e.message, { lane: i, link: j });
        throw e;
      }
    }
    try {
      assertUniqueNames(snaps.map((s) => s.name));
    } catch (e) {
      throw new InputError((e as Error).message, { lane: i });
    }
    lanes.push({ id: newId(16), label: lane.label, snapshotIds: snaps.map((s) => s.id) });
  }
  const id = newId();
  await createComparison(env.DB, { id, prompt: body.prompt, model: body.model, harnessVersion: HARNESS_VERSION, rerunOf: body.rerunOf, forceSkills: body.forceSkills, lanes });
  await env.LANES.sendBatch(lanes.map((l) => ({ body: { laneId: l.id } })));
  return id;
}

/** Run again: same prompt, model and pinned skill snapshots, as a new comparison. No GitHub calls. */
export async function rerunComparison(env: Env, sourceId: string): Promise<string | null> {
  const view = await getComparison(env.DB, sourceId);
  if (!view) return null;
  const lanes: NewLane[] = view.lanes.map((l) => ({ id: newId(16), label: l.label, snapshotIds: l.skills.map((s) => s.snapshot.id) }));
  const id = newId();
  await createComparison(env.DB, {
    id,
    prompt: view.comparison.prompt,
    model: view.comparison.model,
    harnessVersion: HARNESS_VERSION,
    rerunOf: sourceId,
    forceSkills: view.comparison.force_skills === 1,
    lanes,
  });
  await env.LANES.sendBatch(lanes.map((l) => ({ body: { laneId: l.id } })));
  return id;
}
