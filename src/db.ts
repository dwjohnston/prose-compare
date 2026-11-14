// D1 rows and R2 blob keys (SPEC.md "Data model and permanent storage").
import type { SnapshotRecord } from "./skills/snapshot";
import type { InvocationStatus } from "./runner/events";

export type ComparisonStatus = "queued" | "running" | "done" | "failed";
export type LaneStatus = "queued" | "running" | "done" | "failed" | "skipped";

export interface ComparisonRow {
  id: string;
  prompt: string;
  model: string;
  harness_version: string;
  status: ComparisonStatus;
  created_at: string;
  total_cost_usd: number;
  hidden: number;
  rerun_of: string | null;
}

export interface LaneRow {
  id: string;
  comparison_id: string;
  label: string | null;
  order: number;
  status: LaneStatus;
  tokens_input: number | null;
  tokens_output: number | null;
  cost_usd: number | null;
  duration_ms: number | null;
  output_blob: string | null;
  events_blob: string | null;
  trace_blob: string | null;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
}

export interface SnapshotRow {
  id: string;
  content_sha256: string;
  owner: string;
  repo: string;
  path: string;
  commit_sha: string;
  name: string;
  display_name: string;
  description: string;
  files_blob: string;
}

export interface LaneSkillRow {
  lane_id: string;
  skill_snapshot_id: string;
  order: number;
  invocation_status: InvocationStatus | null;
  first_invoked_step: number | null;
  before_first_text: number | null;
  files_read: string | null;
}

export const blobKeys = (laneId: string) => ({
  events: `lanes/${laneId}/events.ndjson`,
  output: `lanes/${laneId}/output.md`,
  trace: `lanes/${laneId}/trace.json`,
});

export function newId(length = 10): string {
  const alphabet = "abcdefghijkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
}

export async function findSnapshot(db: D1Database, owner: string, repo: string, path: string, commitSha: string): Promise<SnapshotRow | null> {
  return db
    .prepare("SELECT * FROM skill_snapshot WHERE owner = ? AND repo = ? AND path = ? AND commit_sha = ?")
    .bind(owner, repo, path, commitSha)
    .first<SnapshotRow>();
}

export function insertSnapshotStmt(db: D1Database, r: SnapshotRecord): D1PreparedStatement {
  return db
    .prepare(
      `INSERT OR IGNORE INTO skill_snapshot (id, content_sha256, owner, repo, path, commit_sha, name, display_name, description, files_blob)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(r.id, r.contentSha256, r.owner, r.repo, r.path, r.commitSha, r.name, r.displayName, r.description, r.filesBlob);
}

export interface NewLane {
  id: string;
  label: string | null;
  snapshotIds: string[];
}

export async function createComparison(
  db: D1Database,
  c: { id: string; prompt: string; model: string; harnessVersion: string; rerunOf: string | null; lanes: NewLane[] },
): Promise<void> {
  const stmts: D1PreparedStatement[] = [
    db
      .prepare("INSERT INTO comparison (id, prompt, model, harness_version, status, rerun_of) VALUES (?, ?, ?, ?, 'queued', ?)")
      .bind(c.id, c.prompt, c.model, c.harnessVersion, c.rerunOf),
  ];
  c.lanes.forEach((lane, order) => {
    stmts.push(
      db.prepare(`INSERT INTO lane (id, comparison_id, label, "order", status) VALUES (?, ?, ?, ?, 'queued')`).bind(lane.id, c.id, lane.label, order),
    );
    lane.snapshotIds.forEach((sid, i) => {
      stmts.push(db.prepare(`INSERT INTO lane_skill (lane_id, skill_snapshot_id, "order") VALUES (?, ?, ?)`).bind(lane.id, sid, i));
    });
  });
  await db.batch(stmts);
}

export interface ComparisonView {
  comparison: ComparisonRow;
  lanes: (LaneRow & { skills: (LaneSkillRow & { snapshot: SnapshotRow })[] })[];
  /** Every snapshot used in any lane, in first-seen order (drives the summary table's columns). */
  snapshots: SnapshotRow[];
}

export async function getComparison(db: D1Database, id: string): Promise<ComparisonView | null> {
  const comparison = await db.prepare("SELECT * FROM comparison WHERE id = ?").bind(id).first<ComparisonRow>();
  if (!comparison) return null;
  const [lanes, skills] = await db.batch([
    db.prepare(`SELECT * FROM lane WHERE comparison_id = ? ORDER BY "order"`).bind(id),
    db
      .prepare(
        `SELECT ls.*, s.id AS s_id, s.content_sha256, s.owner, s.repo, s.path, s.commit_sha, s.name, s.display_name, s.description, s.files_blob
         FROM lane_skill ls JOIN lane l ON l.id = ls.lane_id JOIN skill_snapshot s ON s.id = ls.skill_snapshot_id
         WHERE l.comparison_id = ? ORDER BY l."order", ls."order"`,
      )
      .bind(id),
  ]);
  const snapshots = new Map<string, SnapshotRow>();
  const byLane = new Map<string, (LaneSkillRow & { snapshot: SnapshotRow })[]>();
  for (const r of (skills!.results ?? []) as Record<string, unknown>[]) {
    const snapshot: SnapshotRow = {
      id: r.s_id as string,
      content_sha256: r.content_sha256 as string,
      owner: r.owner as string,
      repo: r.repo as string,
      path: r.path as string,
      commit_sha: r.commit_sha as string,
      name: r.name as string,
      display_name: r.display_name as string,
      description: r.description as string,
      files_blob: r.files_blob as string,
    };
    if (!snapshots.has(snapshot.id)) snapshots.set(snapshot.id, snapshot);
    const list = byLane.get(r.lane_id as string) ?? [];
    list.push({
      lane_id: r.lane_id as string,
      skill_snapshot_id: r.skill_snapshot_id as string,
      order: r.order as number,
      invocation_status: r.invocation_status as InvocationStatus | null,
      first_invoked_step: r.first_invoked_step as number | null,
      before_first_text: r.before_first_text as number | null,
      files_read: r.files_read as string | null,
      snapshot,
    });
    byLane.set(r.lane_id as string, list);
  }
  return {
    comparison,
    lanes: ((lanes!.results ?? []) as LaneRow[]).map((l) => ({ ...l, skills: byLane.get(l.id) ?? [] })),
    snapshots: [...snapshots.values()],
  };
}

/** Claim a queued lane. Returns false if another delivery already claimed it. */
export async function claimLane(db: D1Database, laneId: string): Promise<boolean> {
  const res = await db
    .prepare(`UPDATE lane SET status = 'running', started_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND status = 'queued'`)
    .bind(laneId)
    .run();
  return (res.meta.changes ?? 0) === 1;
}

export interface LaneResult {
  laneId: string;
  comparisonId: string;
  status: "done" | "failed";
  tokensInput: number;
  tokensOutput: number;
  costUsd: number;
  durationMs: number;
  error: string | null;
  blobs: { events: string; output: string; trace: string } | null;
  skills: { snapshotId: string; status: InvocationStatus; firstInvokedStep: number | null; beforeFirstText: boolean | null; filesRead: string[] }[];
}

export async function finishLane(db: D1Database, r: LaneResult): Promise<void> {
  const stmts: D1PreparedStatement[] = [
    db
      .prepare(
        `UPDATE lane SET status = ?, tokens_input = ?, tokens_output = ?, cost_usd = ?, duration_ms = ?, error = ?,
           events_blob = ?, output_blob = ?, trace_blob = ?, finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ?`,
      )
      .bind(r.status, r.tokensInput, r.tokensOutput, r.costUsd, r.durationMs, r.error, r.blobs?.events ?? null, r.blobs?.output ?? null, r.blobs?.trace ?? null, r.laneId),
    ...r.skills.map((s) =>
      db
        .prepare(`UPDATE lane_skill SET invocation_status = ?, first_invoked_step = ?, before_first_text = ?, files_read = ? WHERE lane_id = ? AND skill_snapshot_id = ?`)
        .bind(s.status, s.firstInvokedStep, s.beforeFirstText === null ? null : s.beforeFirstText ? 1 : 0, JSON.stringify(s.filesRead), r.laneId, s.snapshotId),
    ),
    db.prepare("UPDATE comparison SET total_cost_usd = total_cost_usd + ? WHERE id = ?").bind(r.costUsd, r.comparisonId),
    db.prepare(COMPARISON_STATUS_SQL).bind(r.comparisonId),
  ];
  if (r.costUsd > 0) stmts.push(db.prepare("INSERT INTO ledger_entry (id, lane_id, cost_usd) VALUES (?, ?, ?)").bind(newId(16), r.laneId, r.costUsd));
  await db.batch(stmts);
}

/**
 * Delete a comparison's rows and lane blobs. Skill snapshots stay unless no other lane references them;
 * a snapshot's files blob goes only when no remaining snapshot shares its content hash.
 */
export async function deleteComparison(db: D1Database, blobs: R2Bucket, id: string): Promise<boolean> {
  const view = await getComparison(db, id);
  if (!view) return false;
  const laneIds = view.lanes.map((l) => l.id);
  const laneBlobs = laneIds.flatMap((l) => Object.values(blobKeys(l)));
  const snapshotIds = view.snapshots.map((s) => s.id);
  const stmts: D1PreparedStatement[] = [
    db.prepare("DELETE FROM lane_skill WHERE lane_id IN (SELECT id FROM lane WHERE comparison_id = ?)").bind(id),
    db.prepare("DELETE FROM lane WHERE comparison_id = ?").bind(id),
    db.prepare("DELETE FROM comparison WHERE id = ?").bind(id),
  ];
  await db.batch(stmts);
  if (laneBlobs.length) await blobs.delete(laneBlobs);

  for (const sid of snapshotIds) {
    const used = await db.prepare("SELECT 1 FROM lane_skill WHERE skill_snapshot_id = ? LIMIT 1").bind(sid).first();
    if (used) continue;
    const snap = view.snapshots.find((s) => s.id === sid)!;
    await db.prepare("DELETE FROM skill_snapshot WHERE id = ?").bind(sid).run();
    const shared = await db.prepare("SELECT 1 FROM skill_snapshot WHERE content_sha256 = ? LIMIT 1").bind(snap.content_sha256).first();
    if (!shared) await blobs.delete(snap.files_blob);
  }
  return true;
}

/** Lanes whose consumer died mid-run would otherwise sit in "running" forever. */
export async function reapStaleLanes(db: D1Database, comparisonId: string, maxAgeMs: number): Promise<void> {
  const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
  const res = await db
    .prepare(
      `UPDATE lane SET status = 'failed', error = 'The run did not report back (lost sandbox or consumer).',
         finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE comparison_id = ? AND status = 'running' AND started_at < ?`,
    )
    .bind(comparisonId, cutoff)
    .run();
  if ((res.meta.changes ?? 0) > 0) await db.prepare(COMPARISON_STATUS_SQL).bind(comparisonId).run();
}

/** Comparison status follows its lanes: running until none are queued/running, then done unless all failed. */
const COMPARISON_STATUS_SQL = `UPDATE comparison SET status = CASE
    WHEN EXISTS (SELECT 1 FROM lane WHERE comparison_id = ?1 AND status IN ('queued', 'running')) THEN 'running'
    WHEN NOT EXISTS (SELECT 1 FROM lane WHERE comparison_id = ?1 AND status = 'done') THEN 'failed'
    ELSE 'done' END
  WHERE id = ?1`;

export async function spendTotal(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS total FROM ledger_entry").first<{ total: number }>();
  return row?.total ?? 0;
}
