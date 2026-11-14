// Server-rendered page shells. Data goes in a non-executing JSON script block; behaviour lives in
// /static/*.js (CSP script-src 'self', no inline script).
import { escapeHtml } from "../render/markdown";

/** JSON safe to embed inside <script type="application/json">. */
export function embedJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

export function page(opts: { title: string; script: string; data: unknown }): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(opts.title)}</title>
<link rel="stylesheet" href="/static/app.css">
<script type="application/json" id="page-data">${embedJson(opts.data)}</script>
<script type="module" src="/static/${opts.script}"></script>
</head>
<body>
<header class="top"><nav class="nav"><a href="/" class="brand">Prose Skill Comparer</a><a href="/">New comparison</a><a href="/results">All results</a></nav><span id="auth-slot"></span></header>
<main id="app"><noscript>This page needs JavaScript.</noscript></main>
</body>
</html>`;
}

export function appCsp(renderOrigin: string | null): string {
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self'",
    "connect-src 'self'",
    `frame-src ${renderOrigin ?? "'none'"}`,
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}
