import type { LaneSandbox } from "./runner/sandbox";

export interface LaneMessage {
  laneId: string;
}

export interface Env {
  DB: D1Database;
  BLOBS: R2Bucket;
  LANES: Queue<LaneMessage>;
  SANDBOX: DurableObjectNamespace<LaneSandbox>;
  LOGIN_LIMITER: RateLimit;
  ASSETS?: Fetcher;

  // vars
  REQUIRE_PASSWORD?: string;
  CREDIT_FLOOR_USD?: string;
  LANE_TIMEOUT_MS?: string;
  RENDER_ORIGIN?: string;

  // secrets (wrangler secret put)
  OPENROUTER_TOKEN: string;
  APP_PASSWORD_HASH?: string;
  /** Optional read-only GitHub token; unauthenticated API calls share a low per-IP limit. */
  GITHUB_TOKEN?: string;
}
