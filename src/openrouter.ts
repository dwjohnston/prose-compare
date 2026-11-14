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
