import { describe, expect, test } from "bun:test";

import { RENDER_CSP, renderMarkdown, safeHref } from "../src/render/markdown";
import { siblingOrigin } from "../src/render/worker";

describe("sanitised markdown", () => {
  const payloads = [
    "<script>alert(1)</script>",
    '<img src=x onerror="alert(1)">',
    "<iframe src=//evil.example></iframe>",
    '<a href="javascript:alert(1)">x</a>',
    "[click](javascript:alert(1))",
    "[click](JaVaScRiPt:alert(1))",
    "[click](java\nscript:alert(1))",
    "[click](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)",
    "![x](https://evil.example/pixel.png)",
    '<svg onload="alert(1)"></svg>',
    "<style>body{display:none}</style>",
    '[x](https://ok.example "a\\" onmouseover=\\"alert(1)")',
  ];
  for (const p of payloads) {
    test(p.slice(0, 40), () => {
      const html = renderMarkdown(p);
      expect(html).not.toMatch(/<(script|img|iframe|svg|style)\b/i);
      // Event-handler attributes on real tags (quoted attribute values stripped first).
      for (const tag of html.match(/<[a-z][^>]*>/gi) ?? []) expect(tag.replace(/"[^"]*"/g, '""')).not.toMatch(/\son\w+\s*=/i);
      expect(html).not.toMatch(/href="(javascript|data|vbscript):/i);
    });
  }
  test("ordinary markdown still renders", () => {
    const html = renderMarkdown("# Title\n\nSome **bold** and a [link](https://example.com).\n\n- a\n- b");
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain('<a href="https://example.com/" target="_blank" rel="noopener noreferrer nofollow ugc">link</a>');
    expect(html).toContain("<li>a</li>");
  });
  test("safeHref", () => {
    expect(safeHref("https://a.example/x")).toBe("https://a.example/x");
    expect(safeHref("mailto:a@b.example")).toBe("mailto:a@b.example");
    expect(safeHref("#top")).toBe("#top");
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref(" javascript:alert(1)")).toBeNull();
    expect(safeHref("/relative")).toBeNull();
  });
  test("CSP allows no script and sandboxes the page", () => {
    const csp = RENDER_CSP("https://app.example");
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toContain("script-src");
    expect(csp).toContain("sandbox");
    expect(csp).toContain("frame-ancestors https://app.example");
  });
  test("render origin derivation", () => {
    expect(siblingOrigin(new URL("https://prose-compare.dj.workers.dev/x"), "prose-compare", "prose-compare-render")).toBe(
      "https://prose-compare-render.dj.workers.dev",
    );
    expect(siblingOrigin(new URL("http://localhost:8787/"), "prose-compare", "prose-compare-render")).toBeNull();
  });
});
