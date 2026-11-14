// Password gate (SPEC.md "Access and cost"):
// - REQUIRE_PASSWORD fails closed: unset, or any value except "false", means the password is required.
// - APP_PASSWORD_HASH is a bcrypt hash, checked on the server (bun scripts/hash-password.ts makes one).
// - Session: signed HttpOnly, Secure, SameSite=Strict cookie, checked by the API on every call.
// - Brute force: 5 attempts a minute per IP (Workers rate-limit binding).
import bcrypt from "bcryptjs";

import type { Env } from "./env";

export const COOKIE = "pc_session";
const SESSION_TTL_S = 7 * 24 * 3600;
const enc = new TextEncoder();

export function passwordRequired(env: Pick<Env, "REQUIRE_PASSWORD">): boolean {
  return env.REQUIRE_PASSWORD !== "false";
}

export async function verifyPassword(password: string, hash: string | undefined): Promise<boolean> {
  if (!hash || !/^\$2[aby]\$\d{2}\$.{53}$/.test(hash)) return false;
  if (password.length === 0 || password.length > 256) return false;
  return bcrypt.compare(password, hash);
}

/**
 * The cookie-signing key is derived from APP_PASSWORD_HASH, so there's no extra secret to manage and
 * changing the password signs everyone out.
 */
async function signingKey(passwordHash: string): Promise<CryptoKey> {
  const material = await crypto.subtle.digest("SHA-256", enc.encode(`prose-compare session v1\n${passwordHash}`));
  return crypto.subtle.importKey("raw", material, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

function b64url(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function fromB64url(s: string): Uint8Array | null {
  try {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

export async function issueSession(passwordHash: string, now = Date.now()): Promise<string> {
  const payload = `v1.${Math.floor(now / 1000) + SESSION_TTL_S}`;
  const sig = await crypto.subtle.sign("HMAC", await signingKey(passwordHash), enc.encode(payload));
  return `${payload}.${b64url(sig)}`;
}

export async function verifySession(token: string | undefined, passwordHash: string | undefined, now = Date.now()): Promise<boolean> {
  if (!token || !passwordHash) return false;
  const m = /^(v1\.(\d{1,12}))\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!m) return false;
  if (Number(m[2]) * 1000 <= now) return false;
  const sig = fromB64url(m[3]!);
  if (!sig) return false;
  return crypto.subtle.verify("HMAC", await signingKey(passwordHash), sig, enc.encode(m[1]!));
}

export function sessionCookie(token: string): string {
  return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_TTL_S}`;
}

export function clearCookie(): string {
  return `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

export function readCookie(request: Request, name = COOKIE): string | undefined {
  const header = request.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return undefined;
}

export async function isSignedIn(request: Request, env: Pick<Env, "APP_PASSWORD_HASH">): Promise<boolean> {
  return verifySession(readCookie(request), env.APP_PASSWORD_HASH);
}

export type GateResult = { ok: true } | { ok: false; status: number; reason: string };

/** Gate for anything that spends credit or GitHub quota (submit, resolve, run again). */
export async function checkSubmitGate(request: Request, env: Pick<Env, "REQUIRE_PASSWORD" | "APP_PASSWORD_HASH">): Promise<GateResult> {
  if (!passwordRequired(env)) return { ok: true };
  if (!env.APP_PASSWORD_HASH) return { ok: false, status: 503, reason: "A password is required but APP_PASSWORD_HASH isn't set." };
  if (!(await isSignedIn(request, env))) return { ok: false, status: 401, reason: "Sign in to run comparisons." };
  return { ok: true };
}

/** Delete always needs a signed-in session, whatever REQUIRE_PASSWORD says. */
export async function checkDeleteGate(request: Request, env: Pick<Env, "APP_PASSWORD_HASH">): Promise<GateResult> {
  if (!env.APP_PASSWORD_HASH) return { ok: false, status: 403, reason: "Deleting needs APP_PASSWORD_HASH to be set." };
  if (!(await isSignedIn(request, env))) return { ok: false, status: 401, reason: "Sign in to delete." };
  return { ok: true };
}

export async function login(
  request: Request,
  env: Pick<Env, "APP_PASSWORD_HASH" | "LOGIN_LIMITER">,
  password: string,
): Promise<{ ok: true; cookie: string } | { ok: false; status: number; reason: string }> {
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const { success } = await env.LOGIN_LIMITER.limit({ key: `login:${ip}` });
  if (!success) return { ok: false, status: 429, reason: "Too many attempts. Wait a minute and try again." };
  if (!env.APP_PASSWORD_HASH) return { ok: false, status: 503, reason: "APP_PASSWORD_HASH isn't set." };
  if (!(await verifyPassword(password, env.APP_PASSWORD_HASH))) return { ok: false, status: 401, reason: "Wrong password." };
  return { ok: true, cookie: sessionCookie(await issueSession(env.APP_PASSWORD_HASH)) };
}
