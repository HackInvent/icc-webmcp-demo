import { describe, expect, it } from "vitest";
import {
  hashAccessCode,
  SessionCodec,
  SlidingWindowLimiter,
  verifyAccessCode,
} from "../server/security.mjs";

describe("server authentication primitives", () => {
  it("stores access codes as salted scrypt hashes", () => {
    const first = hashAccessCode("a-long-test-code", { N: 1_024 });
    const second = hashAccessCode("a-long-test-code", { N: 1_024 });
    expect(first).not.toBe(second);
    expect(first).not.toContain("a-long-test-code");
    expect(verifyAccessCode("a-long-test-code", first)).toBe(true);
    expect(verifyAccessCode("wrong-code", first)).toBe(false);
    expect(verifyAccessCode("a-long-test-code", `${first}tampered`)).toBe(false);
  });

  it("signs stateless sessions and rejects tampering or expiry", () => {
    let now = 1_000_000;
    const codec = new SessionCodec({
      secret: "a-test-session-secret-that-is-definitely-long-enough",
      ttlMinutes: 1,
      now: () => now,
    });
    const issued = codec.issue();
    expect(codec.verify(issued.token)).toMatchObject({ sid: issued.session.sid });
    expect(codec.verify(`${issued.token}x`)).toBeNull();
    now += 60_001;
    expect(codec.verify(issued.token)).toBeNull();
  });

  it("enforces a sliding attempt window", () => {
    let now = 10_000;
    const limiter = new SlidingWindowLimiter({
      limit: 2,
      windowMs: 1_000,
      now: () => now,
    });
    expect(limiter.attempt("ip").allowed).toBe(true);
    expect(limiter.attempt("ip").allowed).toBe(true);
    expect(limiter.attempt("ip")).toMatchObject({ allowed: false, retryAfterSeconds: 1 });
    now += 1_001;
    expect(limiter.attempt("ip").allowed).toBe(true);
  });
});
