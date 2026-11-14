import { describe, expect, test } from "bun:test";
import bcrypt from "bcryptjs";

import { checkDeleteGate, checkSubmitGate, issueSession, login, passwordRequired, sessionCookie, verifyPassword, verifySession } from "../src/auth";

const HASH = bcrypt.hashSync("correct horse", 4);
const OTHER_HASH = bcrypt.hashSync("something else", 4);

function limiter(allow = true) {
  const keys: string[] = [];
  return { keys, limit: async ({ key }: { key: string }) => (keys.push(key), { success: allow }) } as unknown as RateLimit & { keys: string[] };
}

const req = (cookie?: string) => new Request("https://app.example/api/comparisons", { headers: cookie ? { cookie, "cf-connecting-ip": "203.0.113.9" } : { "cf-connecting-ip": "203.0.113.9" } });

describe("REQUIRE_PASSWORD fails closed", () => {
  test("only the exact string 'false' turns it off", () => {
    expect(passwordRequired({})).toBe(true);
    expect(passwordRequired({ REQUIRE_PASSWORD: "" })).toBe(true);
    expect(passwordRequired({ REQUIRE_PASSWORD: "true" })).toBe(true);
    expect(passwordRequired({ REQUIRE_PASSWORD: "FALSE" })).toBe(true);
    expect(passwordRequired({ REQUIRE_PASSWORD: "0" })).toBe(true);
    expect(passwordRequired({ REQUIRE_PASSWORD: "no" })).toBe(true);
    expect(passwordRequired({ REQUIRE_PASSWORD: "false" })).toBe(false);
  });
  test("required but no hash configured: submit refused", async () => {
    expect(await checkSubmitGate(req(), {})).toMatchObject({ ok: false, status: 503 });
  });
  test("password off: submit allowed without a session, delete still needs one", async () => {
    expect(await checkSubmitGate(req(), { REQUIRE_PASSWORD: "false" })).toEqual({ ok: true });
    expect((await checkDeleteGate(req(), { APP_PASSWORD_HASH: HASH })).ok).toBe(false);
    expect((await checkDeleteGate(req(), {})).ok).toBe(false);
  });
});

describe("password and session", () => {
  test("bcrypt verify", async () => {
    expect(await verifyPassword("correct horse", HASH)).toBe(true);
    expect(await verifyPassword("wrong", HASH)).toBe(false);
    expect(await verifyPassword("correct horse", undefined)).toBe(false);
    expect(await verifyPassword("correct horse", "plaintext")).toBe(false);
  });
  test("signed cookie: valid, tampered, expired, other key", async () => {
    const token = await issueSession(HASH);
    expect(await verifySession(token, HASH)).toBe(true);
    expect(await verifySession(token, OTHER_HASH)).toBe(false);
    const [v, exp, sig] = token.split(".");
    expect(await verifySession(`${v}.${Number(exp) + 9999}.${sig}`, HASH)).toBe(false);
    expect(await verifySession(`${v}.${exp}.${sig!.slice(0, -2)}AA`, HASH)).toBe(false);
    expect(await verifySession(token, HASH, Date.now() + 8 * 24 * 3600 * 1000)).toBe(false);
    expect(await verifySession(undefined, HASH)).toBe(false);
  });
  test("cookie attributes", () => {
    const c = sessionCookie("x");
    for (const attr of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/"]) expect(c).toContain(attr);
  });
  test("API gate checks the cookie on every call", async () => {
    const token = await issueSession(HASH);
    expect(await checkSubmitGate(req(`pc_session=${token}`), { APP_PASSWORD_HASH: HASH })).toEqual({ ok: true });
    expect(await checkSubmitGate(req(`pc_session=${token}x`), { APP_PASSWORD_HASH: HASH })).toMatchObject({ ok: false, status: 401 });
    expect(await checkSubmitGate(req(), { APP_PASSWORD_HASH: HASH })).toMatchObject({ ok: false, status: 401 });
    expect(await checkDeleteGate(req(`pc_session=${token}`), { APP_PASSWORD_HASH: HASH })).toEqual({ ok: true });
  });
});

describe("login rate limit", () => {
  test("attempts are rate-limited per IP before the password is checked", async () => {
    const l = limiter(false);
    const res = await login(req(), { APP_PASSWORD_HASH: HASH, LOGIN_LIMITER: l }, "correct horse");
    expect(res).toMatchObject({ ok: false, status: 429 });
    expect(l.keys).toEqual(["login:203.0.113.9"]);
  });
  test("right and wrong password", async () => {
    expect((await login(req(), { APP_PASSWORD_HASH: HASH, LOGIN_LIMITER: limiter() }, "correct horse")).ok).toBe(true);
    expect(await login(req(), { APP_PASSWORD_HASH: HASH, LOGIN_LIMITER: limiter() }, "nope")).toMatchObject({ ok: false, status: 401 });
  });
});
