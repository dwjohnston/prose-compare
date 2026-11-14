import { describe, expect, test } from "bun:test";

import { decodeCursor, encodeCursor } from "../src/db";

describe("results list cursor", () => {
  test("round-trips", () => {
    const c = encodeCursor({ created_at: "2026-11-14T09:00:00.123Z", id: "abcd2345ef" });
    expect(decodeCursor(c)).toEqual({ createdAt: "2026-11-14T09:00:00.123Z", id: "abcd2345ef" });
  });
  test("rejects junk instead of passing it to SQL", () => {
    for (const bad of ["", "x", "2026-11-14~abc", "2026-11-14T09:00:00Z~ABC'--", "2026-11-14T09:00:00Z"]) {
      expect(decodeCursor(bad)).toBeNull();
    }
  });
});
