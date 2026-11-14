// Model output -> sanitised HTML (SPEC.md threat #5). Defence in depth, any one layer is enough on its own
// for script injection:
//   1. Raw HTML in the markdown is never passed through: html tokens are escaped and shown as text.
//   2. Links keep only http(s)/mailto/#fragment hrefs; images become plain links (no remote loads, no
//      tracking pixels for viewers).
//   3. The page is served from a separate origin with a CSP that allows no script at all and sandboxes
//      the document (src/render/worker.ts), and the app frames it with a sandbox attribute.
import { Marked, type Tokens } from "marked";

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function safeHref(href: string | null | undefined): string | null {
  if (!href) return null;
  // Strip whitespace/control characters browsers ignore inside schemes ("java\nscript:").
  const cleaned = href.replace(/[\u0000- \u007f-\u009f]/g, "");
  if (cleaned.startsWith("#")) return cleaned;
  let url: URL;
  try {
    url = new URL(cleaned);
  } catch {
    return null; // relative links have no meaning on the render origin
  }
  if (url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:") return url.href;
  return null;
}

const marked = new Marked({
  gfm: true,
  breaks: false,
  async: false,
  renderer: {
    html({ text }: Tokens.HTML | Tokens.Tag) {
      return escapeHtml(text);
    },
    link(this: { parser: { parseInline(tokens: Tokens.Generic[]): string } }, { href, title, tokens }: Tokens.Link) {
      const inner = this.parser.parseInline(tokens);
      const safe = safeHref(href);
      if (!safe) return inner;
      const t = title ? ` title="${escapeHtml(title)}"` : "";
      return `<a href="${escapeHtml(safe)}"${t} target="_blank" rel="noopener noreferrer nofollow ugc">${inner}</a>`;
    },
    image({ href, text }: Tokens.Image) {
      const safe = safeHref(href);
      const label = escapeHtml(text || "image");
      if (!safe) return `[${label}]`;
      return `<a href="${escapeHtml(safe)}" target="_blank" rel="noopener noreferrer nofollow ugc">[image: ${label}]</a>`;
    },
  },
});

export function renderMarkdown(markdown: string): string {
  return marked.parse(markdown, { async: false }) as string;
}

export const RENDER_CSP = (frameAncestors: string) =>
  [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    "img-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    `frame-ancestors ${frameAncestors}`,
    "sandbox allow-popups allow-popups-to-escape-sandbox",
  ].join("; ");

export function outputPage(bodyHtml: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Output</title>
<style>
body{font:16px/1.6 Georgia,"Times New Roman",serif;color:#1d1d1f;margin:0;padding:20px 24px;max-width:46em}
pre,code{font:13px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;background:#f4f4f5;border-radius:4px}
pre{padding:10px;overflow:auto}code{padding:1px 3px}pre code{padding:0;background:none}
blockquote{margin:0;padding-left:14px;border-left:3px solid #d4d4d8;color:#52525b}
table{border-collapse:collapse}td,th{border:1px solid #d4d4d8;padding:4px 8px}
a{color:#1d4ed8}h1,h2,h3{line-height:1.25}.empty{color:#71717a;font-style:italic}
@media (prefers-color-scheme:dark){body{background:#18181b;color:#e4e4e7}pre,code{background:#27272a}a{color:#93c5fd}}
</style></head><body>${bodyHtml}</body></html>`;
}
