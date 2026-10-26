import { randomBytes, sha256Hex, toBase64Url } from "../lib/crypto";

/** 32 random bytes encode to exactly 43 base64url characters (no padding). */
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * Signing tokens are bearer capabilities: whoever holds the link can sign.
 * 256 bits of entropy makes guessing infeasible, so no further secret is
 * needed in the URL.
 */
export function generateSigningToken(): string {
  return toBase64Url(randomBytes(32));
}

/**
 * Only this hash is stored. A database leak therefore does not reveal usable
 * links, and lookups by hash avoid comparing secrets in application code.
 * A plain (unsalted) hash is enough because the input is high-entropy.
 */
export function hashSigningToken(token: string): Promise<string> {
  return sha256Hex(token);
}

export function isWellFormedToken(token: string): boolean {
  return TOKEN_PATTERN.test(token);
}
