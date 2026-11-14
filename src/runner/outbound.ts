// The sandbox's only way out (SPEC.md "Architecture"). The container starts with enableInternet: false
// and every HTTP/HTTPS request it makes is intercepted to this entrypoint. The real OPENROUTER_TOKEN
// lives only here, in Worker secrets, and is added only for https://openrouter.ai.
import { WorkerEntrypoint } from "cloudflare:workers";

import type { Env } from "../env";
import { decideOutbound } from "./outbound-policy";

/** Headers a sandboxed client could use to smuggle or spoof credentials or routing. */
const STRIP_ALWAYS = ["cookie", "proxy-authorization", "cf-connecting-ip", "x-forwarded-for", "x-real-ip"];

export class Outbound extends WorkerEntrypoint<Env> {
  override async fetch(request: Request): Promise<Response> {
    const decision = decideOutbound(request.url);
    if (decision.kind === "deny") {
      console.log(JSON.stringify({ outbound: "deny", host: safeHost(request.url), reason: decision.reason }));
      return new Response(`Blocked by the sandbox network policy: ${decision.reason}\n`, { status: 403 });
    }
    const headers = new Headers(request.headers);
    for (const h of STRIP_ALWAYS) headers.delete(h);
    if (decision.kind === "openrouter") {
      // Replace whatever placeholder OpenCode sent. The real key never enters the sandbox.
      headers.delete("x-api-key");
      headers.set("authorization", `Bearer ${this.env.OPENROUTER_TOKEN}`);
      return fetch(new Request(request, { headers, redirect: "manual" }));
    }
    // Any Authorization the sandbox sends is its own placeholder or junk; never forward it elsewhere.
    headers.delete("authorization");
    headers.delete("x-api-key");
    // Redirects are returned to the client, so each hop is checked again by this policy.
    return fetch(new Request(request, { headers, redirect: "manual" }));
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "invalid";
  }
}
