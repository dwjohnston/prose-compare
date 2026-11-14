// App + API routes (SPEC.md "UX" and "Access and cost").
import { checkDeleteGate, checkSubmitGate, clearCookie, isSignedIn, login, passwordRequired } from "./auth";
import { HARNESS_VERSION } from "./config/harness";
import { LIMITS } from "./config/limits";
import { DEFAULT_MODEL, MODELS } from "./config/models";
import { blobKeys, cancelComparison, decodeCursor, deleteComparison, getComparison, listComparisons, reapStaleLanes, spendTotal } from "./db";
import type { Env } from "./env";
import { LinkError } from "./github/links";
import { getCredit } from "./openrouter";
import { siblingOrigin } from "./render/worker";
import { SkillError } from "./skills/rules";
import { InputError, parseSubmitBody, rerunComparison, resolveLink, submitComparison } from "./submit";
import { appCsp, page } from "./web/pages";

const ID = /^[a-z0-9]{8,32}$/;

export function renderOrigin(request: Request, env: Pick<Env, "RENDER_ORIGIN">): string | null {
  if (env.RENDER_ORIGIN) return env.RENDER_ORIGIN.replace(/\/+$/, "");
  return siblingOrigin(new URL(request.url), "prose-compare", "prose-compare-render");
}

function securityHeaders(headers: Headers, csp: string): void {
  headers.set("content-security-policy", csp);
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "same-origin");
  headers.set("x-frame-options", "DENY");
  headers.set("cross-origin-opener-policy", "same-origin");
}

function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  const headers = new Headers({ "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra });
  securityHeaders(headers, "default-src 'none'; frame-ancestors 'none'");
  return new Response(JSON.stringify(data), { status, headers });
}

const error = (status: number, message: string, where?: unknown) => json({ error: message, ...(where ? { where } : {}) }, status);

function html(body: string, csp: string): Response {
  const headers = new Headers({ "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  securityHeaders(headers, csp);
  return new Response(body, { headers });
}

/** State-changing calls must be same-origin JSON (on top of the SameSite=Strict cookie). */
function sameOriginJson(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== new URL(request.url).origin) return false;
  if (request.method === "POST") return (request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json");
  return true;
}

async function readJson(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text.length > 64 * 1024) throw new InputError("Request too large.");
  try {
    return JSON.parse(text);
  } catch {
    throw new InputError("Invalid JSON.");
  }
}

async function configFor(request: Request, env: Env) {
  const [signedIn, credit, spent] = await Promise.all([isSignedIn(request, env), getCredit(env), spendTotal(env.DB).catch(() => null)]);
  return {
    models: MODELS,
    defaultModel: DEFAULT_MODEL,
    limits: { maxLanes: LIMITS.maxLanes, maxSkillsPerLane: LIMITS.maxSkillsPerLane, maxPromptChars: LIMITS.maxPromptChars, maxLabelChars: LIMITS.maxLabelChars },
    harnessVersion: HARNESS_VERSION,
    passwordRequired: passwordRequired(env),
    canSignIn: Boolean(env.APP_PASSWORD_HASH),
    signedIn,
    credit,
    spentUsd: spent,
  };
}

export async function handleRequest(request: Request, env: Env & { ASSETS: Fetcher }): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  try {
    if (path.startsWith("/static/")) {
      const res = await env.ASSETS.fetch(new Request(new URL(path.slice("/static".length), url.origin), { method: "GET" }));
      const headers = new Headers(res.headers);
      securityHeaders(headers, "default-src 'none'");
      return new Response(res.body, { status: res.status, headers });
    }

    if (method !== "GET" && method !== "HEAD" && !sameOriginJson(request)) return error(403, "Cross-origin or non-JSON request refused.");

    // Pages
    if (method === "GET" && path === "/") {
      return html(page({ title: "Prose Skill Comparer", script: "compose.js", data: await configFor(request, env) }), appCsp(null));
    }
    let m = /^\/c\/([^/]+)$/.exec(path);
    if (method === "GET" && m) {
      if (!ID.test(m[1]!)) return html(page({ title: "Not found", script: "results.js", data: { missing: true } }), appCsp(null));
      const origin = renderOrigin(request, env);
      const data = { id: m[1], renderOrigin: origin, signedIn: await isSignedIn(request, env), passwordRequired: passwordRequired(env), canSignIn: Boolean(env.APP_PASSWORD_HASH) };
      return html(page({ title: "Comparison", script: "results.js", data }), appCsp(origin));
    }

    // Auth
    if (method === "POST" && path === "/api/login") {
      const body = (await readJson(request)) as { password?: unknown };
      const res = await login(request, env, typeof body?.password === "string" ? body.password : "");
      if (!res.ok) return error(res.status, res.reason);
      return json({ ok: true }, 200, { "set-cookie": res.cookie });
    }
    if (method === "POST" && path === "/api/logout") return json({ ok: true }, 200, { "set-cookie": clearCookie() });

    if (method === "GET" && path === "/api/config") return json(await configFor(request, env));

    // All results, newest first. Results are public by link, so the list is public too.
    if (method === "GET" && path === "/results") {
      const data = { signedIn: await isSignedIn(request, env), canSignIn: Boolean(env.APP_PASSWORD_HASH) };
      return html(page({ title: "All results", script: "list.js", data }), appCsp(null));
    }
    if (method === "GET" && path === "/api/comparisons") {
      const raw = url.searchParams.get("cursor");
      const cursor = decodeCursor(raw);
      if (raw && !cursor) return error(400, "Bad cursor.");
      const limit = Number(url.searchParams.get("limit") ?? 25) || 25;
      return json(await listComparisons(env.DB, { cursor, limit }));
    }

    if (method === "POST" && path === "/api/resolve") {
      const gate = await checkSubmitGate(request, env);
      if (!gate.ok) return error(gate.status, gate.reason);
      const body = (await readJson(request)) as { url?: unknown };
      if (typeof body?.url !== "string") return error(400, "Missing url.");
      return json(await resolveLink(env, body.url));
    }

    if (method === "POST" && path === "/api/comparisons") {
      const gate = await checkSubmitGate(request, env);
      if (!gate.ok) return error(gate.status, gate.reason);
      const credit = await getCredit(env);
      if (!credit.ok) return error(402, credit.reason ?? "Submissions are disabled.");
      const body = parseSubmitBody(await readJson(request));
      return json({ id: await submitComparison(env, body) }, 201);
    }

    m = /^\/api\/comparisons\/([^/]+)\/cancel$/.exec(path);
    if (method === "POST" && m && ID.test(m[1]!)) {
      const gate = await checkSubmitGate(request, env);
      if (!gate.ok) return error(gate.status, gate.reason);
      const view = await getComparison(env.DB, m[1]!);
      if (!view || view.comparison.hidden) return error(404, "Comparison not found.");
      const { skipped, running } = await cancelComparison(env.DB, m[1]!);
      // Each running lane's sandbox stops its run and tears down; the consumer then records it as cancelled.
      const results = await Promise.allSettled(running.map((laneId) => env.SANDBOX.get(env.SANDBOX.idFromName(laneId)).cancel()));
      const signalled = results.filter((r) => r.status === "fulfilled").length;
      return json({ ok: true, skipped, signalled, failedToSignal: running.length - signalled });
    }

    m = /^\/api\/comparisons\/([^/]+)(\/rerun)?$/.exec(path);
    if (m && ID.test(m[1]!)) {
      const id = m[1]!;
      if (method === "GET" && !m[2]) {
        const timeout = Number(env.LANE_TIMEOUT_MS) > 0 ? Number(env.LANE_TIMEOUT_MS) : 480_000;
        await reapStaleLanes(env.DB, id, timeout + 10 * 60_000);
        const view = await getComparison(env.DB, id);
        if (!view || view.comparison.hidden) return error(404, "Comparison not found.");
        return json(view);
      }
      if (method === "POST" && m[2]) {
        const gate = await checkSubmitGate(request, env);
        if (!gate.ok) return error(gate.status, gate.reason);
        const credit = await getCredit(env);
        if (!credit.ok) return error(402, credit.reason ?? "Submissions are disabled.");
        const newId = await rerunComparison(env, id);
        return newId ? json({ id: newId }, 201) : error(404, "Comparison not found.");
      }
      if (method === "DELETE" && !m[2]) {
        const gate = await checkDeleteGate(request, env);
        if (!gate.ok) return error(gate.status, gate.reason);
        return (await deleteComparison(env.DB, env.BLOBS, id)) ? json({ ok: true }) : error(404, "Comparison not found.");
      }
    }

    m = /^\/api\/lanes\/([^/]+)\/(trace|output)$/.exec(path);
    if (method === "GET" && m && ID.test(m[1]!)) {
      const keys = blobKeys(m[1]!);
      const obj = await env.BLOBS.get(m[2] === "trace" ? keys.trace : keys.output);
      if (!obj) return error(404, "Not available yet.");
      if (m[2] === "trace") return json(JSON.parse(await obj.text()));
      // Raw output, for the plain-text fallback when no render origin is configured. Never HTML.
      const headers = new Headers({ "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      securityHeaders(headers, "default-src 'none'; sandbox; frame-ancestors 'none'");
      return new Response(obj.body, { headers });
    }

    return error(404, "Not found.");
  } catch (e) {
    if (e instanceof InputError) return error(400, e.message, e.where);
    if (e instanceof LinkError || e instanceof SkillError) return error(400, e.message);
    console.error(JSON.stringify({ path, error: String(e), stack: (e as Error).stack }));
    return error(500, "Something went wrong.");
  }
}
