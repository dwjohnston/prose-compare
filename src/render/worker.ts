// Separate-origin output renderer (wrangler.render.jsonc). Holds no secrets and sets no cookies.
import { outputPage, RENDER_CSP, renderMarkdown } from "./markdown";

interface RenderEnv {
  BLOBS: R2Bucket;
  APP_ORIGIN?: string;
}

const LANE_ID = /^[a-z0-9]{8,32}$/;

export default {
  async fetch(request: Request, env: RenderEnv): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
    const m = /^\/o\/([^/]+)$/.exec(url.pathname);
    if (!m || !LANE_ID.test(m[1]!)) return new Response("Not found", { status: 404 });
    const obj = await env.BLOBS.get(`lanes/${m[1]}/output.md`);
    const body = obj ? renderMarkdown(await obj.text()) : `<p class="empty">No output yet.</p>`;
    const appOrigin = env.APP_ORIGIN || siblingOrigin(url, "prose-compare-render", "prose-compare") || "'none'";
    return new Response(outputPage(body || `<p class="empty">The model returned no text.</p>`), {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": RENDER_CSP(appOrigin),
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
        "cross-origin-resource-policy": "cross-origin",
        "cache-control": obj ? "public, max-age=300" : "no-store",
      },
    });
  },
};

/** prose-compare-render.<sub>.workers.dev -> https://prose-compare.<sub>.workers.dev */
export function siblingOrigin(url: URL, from: string, to: string): string | null {
  const [first, ...rest] = url.hostname.split(".");
  if (first !== from || rest.length < 2) return null;
  return `${url.protocol}//${[to, ...rest].join(".")}`;
}
