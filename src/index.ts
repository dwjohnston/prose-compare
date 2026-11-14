// Worker entry: app + API (fetch), lane runner (queue), and the classes wrangler binds.
import { handleRequest } from "./app";
import type { Env, LaneMessage } from "./env";
import { handleLaneBatch } from "./queue";

export { Outbound } from "./runner/outbound";
export { LaneSandbox } from "./runner/sandbox";

export default {
  fetch(request, env) {
    return handleRequest(request, env);
  },
  queue(batch, env) {
    return handleLaneBatch(batch, env);
  },
} satisfies ExportedHandler<Env & { ASSETS: Fetcher }, LaneMessage>;
