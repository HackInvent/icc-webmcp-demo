import {
  createHmac,
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";

const SCRYPT_KEY_LENGTH = 32;
const DEFAULT_SCRYPT = Object.freeze({ N: 16_384, r: 8, p: 1 });

function encode(value) {
  return Buffer.from(value).toString("base64url");
}

function decode(value) {
  return Buffer.from(value, "base64url");
}

function constantTimeEqual(left, right) {
  const leftBuffer = Buffer.isBuffer(left) ? left : Buffer.from(left);
  const rightBuffer = Buffer.isBuffer(right) ? right : Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

export function hashAccessCode(accessCode, options = {}) {
  if (typeof accessCode !== "string" || accessCode.length < 8 || accessCode.length > 200) {
    throw new Error("The access code must contain between 8 and 200 characters.");
  }
  const parameters = {
    N: options.N ?? DEFAULT_SCRYPT.N,
    r: options.r ?? DEFAULT_SCRYPT.r,
    p: options.p ?? DEFAULT_SCRYPT.p,
  };
  const salt = options.salt ?? randomBytes(18);
  const derived = scryptSync(accessCode, salt, SCRYPT_KEY_LENGTH, {
    ...parameters,
    maxmem: 64 * 1024 * 1024,
  });
  return [
    "scrypt",
    parameters.N,
    parameters.r,
    parameters.p,
    encode(salt),
    encode(derived),
  ].join("$");
}

export function verifyAccessCode(accessCode, encodedHash) {
  if (typeof accessCode !== "string" || accessCode.length > 200) return false;
  const parts = typeof encodedHash === "string" ? encodedHash.split("$") : [];
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [N, r, p] = parts.slice(1, 4).map(Number);
  if (
    !Number.isInteger(N) || N < 1_024 || N > 1_048_576 ||
    !Number.isInteger(r) || r < 1 || r > 32 ||
    !Number.isInteger(p) || p < 1 || p > 16
  ) return false;
  try {
    const salt = decode(parts[4]);
    const expected = decode(parts[5]);
    if (salt.length < 12 || expected.length !== SCRYPT_KEY_LENGTH) return false;
    const actual = scryptSync(accessCode, salt, expected.length, {
      N,
      r,
      p,
      maxmem: 128 * 1024 * 1024,
    });
    return constantTimeEqual(actual, expected);
  } catch {
    return false;
  }
}

export class SessionCodec {
  constructor({ secret, ttlMinutes, now = () => Date.now() }) {
    this.secret = Buffer.from(secret);
    this.ttlMs = ttlMinutes * 60_000;
    this.now = now;
  }

  issue() {
    const issuedAt = this.now();
    const payload = encode(JSON.stringify({
      version: 1,
      sid: randomUUID(),
      issuedAt,
      expiresAt: issuedAt + this.ttlMs,
    }));
    const signature = this.#sign(payload);
    return {
      token: `${payload}.${signature}`,
      session: this.verify(`${payload}.${signature}`),
    };
  }

  verify(token) {
    if (typeof token !== "string" || token.length > 2_000) return null;
    const [payload, signature, extra] = token.split(".");
    if (!payload || !signature || extra) return null;
    const expected = this.#sign(payload);
    if (!constantTimeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
    try {
      const parsed = JSON.parse(decode(payload).toString("utf8"));
      if (
        parsed?.version !== 1 ||
        typeof parsed.sid !== "string" ||
        typeof parsed.issuedAt !== "number" ||
        typeof parsed.expiresAt !== "number" ||
        parsed.expiresAt <= this.now() ||
        parsed.issuedAt > this.now() + 60_000
      ) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  #sign(payload) {
    return createHmac("sha256", this.secret).update(payload).digest("base64url");
  }
}

export function parseCookies(header) {
  const cookies = {};
  if (typeof header !== "string") return cookies;
  for (const pair of header.split(";")) {
    const separator = pair.indexOf("=");
    if (separator <= 0) continue;
    const name = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    if (!name || Object.hasOwn(cookies, name)) continue;
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      cookies[name] = value;
    }
  }
  return cookies;
}

export function serializeSessionCookie(name, token, config) {
  const attributes = [
    `${name}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${Math.floor(config.sessionTtlMinutes * 60)}`,
  ];
  if (config.secureCookies) attributes.push("Secure");
  return attributes.join("; ");
}

export function serializeExpiredCookie(name, secure) {
  const attributes = [
    `${name}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    "Max-Age=0",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
  ];
  if (secure) attributes.push("Secure");
  return attributes.join("; ");
}

export class SlidingWindowLimiter {
  constructor({ limit, windowMs, now = () => Date.now() }) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
    this.entries = new Map();
  }

  attempt(key) {
    const now = this.now();
    const cutoff = now - this.windowMs;
    const recent = (this.entries.get(key) ?? []).filter((value) => value > cutoff);
    if (recent.length >= this.limit) {
      this.entries.set(key, recent);
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((recent[0] + this.windowMs - now) / 1_000)),
      };
    }
    recent.push(now);
    this.entries.set(key, recent);
    return { allowed: true, retryAfterSeconds: 0 };
  }

  reset(key) {
    this.entries.delete(key);
  }

  cleanup() {
    const cutoff = this.now() - this.windowMs;
    for (const [key, values] of this.entries) {
      const recent = values.filter((value) => value > cutoff);
      if (recent.length === 0) this.entries.delete(key);
      else this.entries.set(key, recent);
    }
  }
}
