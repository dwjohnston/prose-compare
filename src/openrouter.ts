// Credit display (SPEC.md "Access and cost"): limit_remaining from OpenRouter's GET /api/v1/key.
import type { Env } from "./env";

export interface Credit {
  /** USD left on the key's limit; null if the key has no limit set. */
  limitRemaining: number | null;
  limit: number | null;
  usage: number | null;
  floor: number;
  /** Whether submitting is allowed on credit grounds. */
  ok: boolean;
  reason?: string;
}

let cache: { at: number; value: Credit } | undefined;
const TTL_MS = 30_000;

export async function getCredit(
  env: Pick<Env, "OPENROUTER_TOKEN" | "CREDIT_FLOOR_USD">,
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response> = (i, init) => fetch(i, init),
  now = Date.now(),
): Promise<Credit> {
  if (cache && now - cache.at < TTL_MS) return cache.value;
  const configured = Number(env.CREDIT_FLOOR_USD);
  const floor = env.CREDIT_FLOOR_USD !== undefined && Number.isFinite(configured) && configured >= 0 ? configured : 1;
  let value: Credit;
  if (!env.OPENROUTER_TOKEN) {
    value = { limitRemaining: null, limit: null, usage: null, floor, ok: false, reason: "OPENROUTER_TOKEN isn't set." };
  } else {
    try {
      const res = await fetchImpl("https://openrouter.ai/api/v1/key", { headers: { authorization: `Bearer ${env.OPENROUTER_TOKEN}` } });
      if (!res.ok) throw new Error(`OpenRouter returned ${res.status}`);
      const data = ((await res.json()) as { data?: Record<string, unknown> }).data ?? {};
      const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
      const limitRemaining = n(data.limit_remaining);
      const ok = limitRemaining === null || limitRemaining >= floor;
      value = { limitRemaining, limit: n(data.limit), usage: n(data.usage), floor, ok };
      if (!ok) value.reason = `Remaining credit ($${limitRemaining!.toFixed(2)}) is below the $${floor.toFixed(2)} floor.`;
    } catch (e) {
      // Fail closed: if we can't see the balance, don't spend.
      value = { limitRemaining: null, limit: null, usage: null, floor, ok: false, reason: `Couldn't read the OpenRouter balance (${(e as Error).message}).` };
    }
  }
  cache = { at: now, value };
  return value;
}

export function resetCreditCache(): void {
  cache = undefined;
}

// Cost fallback. The golden event log shows OpenCode V2 reports `cost: 0` in step_finish for models declared
// through our `providers.openrouter.models` config (it has no pricing for them), so lane cost is estimated
// from OpenRouter's public per-token prices (GET /api/v1/models) when OpenCode reports none.
export interface Pricing {
  prompt: number;
  completion: number;
  cacheRead: number;
  cacheWrite: number;
}

let pricingCache: { at: number; prices: Map<string, Pricing> } | undefined;
const PRICING_TTL_MS = 6 * 3600_000;

export async function modelPricing(
  slug: string,
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response> = (i, init) => fetch(i, init),
  now = Date.now(),
): Promise<Pricing | undefined> {
  if (!pricingCache || now - pricingCache.at > PRICING_TTL_MS) {
    const res = await fetchImpl("https://openrouter.ai/api/v1/models");
    if (!res.ok) return pricingCache?.prices.get(slug);
    const data = ((await res.json()) as { data?: { id: string; pricing?: Record<string, string> }[] }).data ?? [];
    const prices = new Map<string, Pricing>();
    for (const m of data) {
      const p = m.pricing ?? {};
      const n = (v: string | undefined) => (v !== undefined && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : undefined);
      const prompt = n(p.prompt);
      const completion = n(p.completion);
      if (prompt === undefined || completion === undefined) continue;
      prices.set(m.id, { prompt, completion, cacheRead: n(p.input_cache_read) ?? prompt, cacheWrite: n(p.input_cache_write) ?? prompt });
    }
    pricingCache = { at: now, prices };
  }
  return pricingCache.prices.get(slug);
}

export function estimateCost(
  p: Pricing,
  t: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number },
): number {
  return t.input * p.prompt + (t.output + t.reasoning) * p.completion + t.cacheRead * p.cacheRead + t.cacheWrite * p.cacheWrite;
}

export function resetPricingCache(): void {
  pricingCache = undefined;
}
