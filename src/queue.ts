// Queue consumer: one message per lane; the consumer runs the lane in its own sandbox and stores the
// results (SPEC.md "Architecture" and "Run pipeline" step 7).
import { blobKeys, claimLane, finishLane, getComparison, type LaneResult } from "./db";
import type { Env, LaneMessage } from "./env";
import { lanePrompt } from "./config/harness";
import { estimateCost, modelPricing } from "./openrouter";
import { analyseLane } from "./runner/events";
import type { LaneRunResult } from "./runner/sandbox";
import { decodeFiles } from "./skills/snapshot";

const DEFAULT_TIMEOUT_MS = 8 * 60_000;

export async function handleLaneBatch(batch: MessageBatch<LaneMessage>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    try {
      await runLane(message.body.laneId, env);
    } catch (e) {
      console.error(JSON.stringify({ lane: message.body.laneId, error: String(e) }));
    }
    // Never redeliver: a retry would spend credit again. Failures are recorded on the lane.
    message.ack();
  }
}

export async function runLane(laneId: string, env: Env): Promise<void> {
  const lane = await env.DB.prepare("SELECT comparison_id FROM lane WHERE id = ?").bind(laneId).first<{ comparison_id: string }>();
  if (!lane) return; // deleted before it ran
  if (!(await claimLane(env.DB, laneId))) return; // already claimed by another delivery
  await env.DB.prepare("UPDATE comparison SET status = 'running' WHERE id = ? AND status = 'queued'").bind(lane.comparison_id).run();

  const view = await getComparison(env.DB, lane.comparison_id);
  const laneView = view?.lanes.find((l) => l.id === laneId);
  if (!view || !laneView) return;

  const base: Omit<LaneResult, "status" | "error" | "blobs" | "skills"> = {
    laneId,
    comparisonId: view.comparison.id,
    tokensInput: 0,
    tokensOutput: 0,
    costUsd: 0,
    durationMs: 0,
  };

  let run: LaneRunResult;
  try {
    const skills = await Promise.all(
      laneView.skills.map(async (s) => {
        const obj = await env.BLOBS.get(s.snapshot.files_blob);
        if (!obj) throw new Error(`Skill snapshot blob missing: ${s.snapshot.files_blob}`);
        return { name: s.snapshot.name, files: decodeFiles(await obj.text()) };
      }),
    );
    const timeoutMs = Number(env.LANE_TIMEOUT_MS) > 0 ? Number(env.LANE_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS;
    const stub = env.SANDBOX.get(env.SANDBOX.idFromName(laneId));
    const prompt = lanePrompt(view.comparison.prompt, skills.map((s) => s.name), view.comparison.force_skills === 1);
    run = await stub.run({ laneId, model: view.comparison.model, prompt, skills, timeoutMs });
  } catch (e) {
    await finishLane(env.DB, {
      ...base,
      status: "failed",
      error: `Sandbox error: ${String(e).slice(0, 500)}`,
      blobs: null,
      skills: [],
    });
    return;
  }

  const analysis = analyseLane(
    run.events,
    laneView.skills.map((s) => ({ name: s.snapshot.name, owner: s.snapshot.owner, repo: s.snapshot.repo, path: s.snapshot.path })),
  );
  // OpenCode reports cost 0 for our config-declared models (see golden log); estimate from OpenRouter prices.
  let costUsd = analysis.costUsd;
  let costEstimated = false;
  if (costUsd === 0 && analysis.tokens.input + analysis.tokens.output > 0) {
    const pricing = await modelPricing(view.comparison.model).catch(() => undefined);
    if (pricing) {
      costUsd = estimateCost(pricing, analysis.tokens);
      costEstimated = true;
    }
  }
  const keys = blobKeys(laneId);
  await Promise.all([
    env.BLOBS.put(keys.events, run.events, { httpMetadata: { contentType: "application/x-ndjson" } }),
    env.BLOBS.put(keys.output, analysis.output, { httpMetadata: { contentType: "text/markdown; charset=utf-8" } }),
    env.BLOBS.put(
      keys.trace,
      JSON.stringify({ trace: analysis.trace, anomalies: analysis.anomalies, errors: analysis.errors, steps: analysis.steps, eventsTruncated: run.eventsTruncated, costEstimated }),
      { httpMetadata: { contentType: "application/json" } },
    ),
  ]);

  let error: string | null = null;
  if (run.timedOut) error = `Timed out after ${Math.round(run.durationMs / 1000)}s`;
  else if (run.exitCode !== 0) error = analysis.errors.at(-1) ?? `opencode exited with ${run.exitCode}: ${run.stderrTail.slice(-500)}`;

  await finishLane(env.DB, {
    ...base,
    status: error ? "failed" : "done",
    error,
    tokensInput: analysis.tokens.input,
    tokensOutput: analysis.tokens.output,
    costUsd,
    durationMs: run.durationMs,
    blobs: keys,
    skills: laneView.skills.map((s, i) => {
      const d = analysis.skills[i]!;
      return { snapshotId: s.snapshot.id, status: d.status, firstInvokedStep: d.firstInvokedStep, beforeFirstText: d.beforeFirstText, filesRead: d.filesRead };
    }),
  });
}
