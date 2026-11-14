// What the sandbox's outbound Worker does with each request (SPEC.md threats #3 and #4). Pure, so the
// hostile-skill suite tests it without a sandbox.
//
// - openrouter.ai over HTTPS: forward with the real OPENROUTER_TOKEN swapped in.
// - other hosts on ports 80/443: pass on unchanged (web fetches leave from Cloudflare's network).
// - everything else is refused: other ports, non-http(s), and (defence in depth, since a Worker fetch
//   can't reach private networks anyway) loopback/private/link-local/metadata hosts and package
//   registries (so the harness can't pull plugins).
export const OPENROUTER_HOST = "openrouter.ai";

const BLOCKED_HOSTS = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata",
  "instance-data",
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  "npm.pkg.github.com",
  "registry.npmmirror.com",
]);
const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home.arpa", ".intranet", ".corp"];

export type OutboundDecision =
  | { kind: "openrouter" }
  | { kind: "pass" }
  | { kind: "deny"; reason: string };

export function decideOutbound(rawUrl: string): OutboundDecision {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { kind: "deny", reason: "malformed URL" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { kind: "deny", reason: "only http and https" };
  if (url.port !== "" && url.port !== "80" && url.port !== "443") return { kind: "deny", reason: "only ports 80 and 443" };
  const host = url.hostname.toLowerCase().replace(/\.$/, "");

  if (host === OPENROUTER_HOST) {
    // The key is only ever added over HTTPS on the default port.
    if (url.protocol !== "https:" || (url.port !== "" && url.port !== "443"))
      return { kind: "deny", reason: "openrouter.ai only over https:443" };
    return { kind: "openrouter" };
  }

  if (host.startsWith("[")) return { kind: "deny", reason: "IPv6 literals are not allowed" };
  const v4 = parseIpv4(host);
  if (v4 !== undefined) {
    if (isPrivateV4(v4)) return { kind: "deny", reason: "private, loopback or link-local address" };
    return { kind: "pass" };
  }
  if (!host.includes(".")) return { kind: "deny", reason: "single-label host" };
  if (BLOCKED_HOSTS.has(host) || BLOCKED_SUFFIXES.some((s) => host.endsWith(s)))
    return { kind: "deny", reason: "blocked host" };
  return { kind: "pass" };
}

function parseIpv4(host: string): number | undefined {
  // WHATWG URL parsing already turns 0x7f000001, 2130706433 and 127.1 into dotted quads.
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return undefined;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return undefined;
  return ((parts[0]! << 24) >>> 0) + (parts[1]! << 16) + (parts[2]! << 8) + parts[3]!;
}

function inRange(ip: number, base: string, bits: number): boolean {
  const b = parseIpv4(base)!;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ip & mask) >>> 0 === (b & mask) >>> 0;
}

function isPrivateV4(ip: number): boolean {
  return (
    inRange(ip, "0.0.0.0", 8) ||
    inRange(ip, "10.0.0.0", 8) ||
    inRange(ip, "100.64.0.0", 10) ||
    inRange(ip, "127.0.0.0", 8) ||
    inRange(ip, "169.254.0.0", 16) ||
    inRange(ip, "172.16.0.0", 12) ||
    inRange(ip, "192.0.0.0", 24) ||
    inRange(ip, "192.168.0.0", 16) ||
    inRange(ip, "198.18.0.0", 15) ||
    inRange(ip, "224.0.0.0", 4) ||
    inRange(ip, "240.0.0.0", 4)
  );
}
