import { constantTimeEqual, hmacSha256Hex } from "./crypto";

/**
 * CSRF protection for the public signing form.
 *
 * The form must work without JavaScript and without cookies, so this uses a
 * stateless synchronizer token: an HMAC over the signing request id and the
 * time the form was rendered. A token is only valid for the request it was
 * issued for, and only for a limited time.
 *
 * It is combined with Fetch Metadata (`Sec-Fetch-Site`) and `Origin` checks.
 * Note that signing pages send `Referrer-Policy: no-referrer`, which makes
 * browsers send `Origin: null` on same-origin form posts, so a missing or
 * "null" origin cannot be treated as an attack on its own.
 */

export const CSRF_MAX_AGE_SECONDS = 2 * 60 * 60;
const CLOCK_SKEW_SECONDS = 60;

function mac(secret: string, requestId: string, issuedAt: number): Promise<string> {
  // The "csrf:v1" label separates this use of the secret from others.
  return hmacSha256Hex(secret, `csrf:v1|${requestId}|${issuedAt}`);
}

export async function issueCsrfToken(
  secret: string,
  requestId: string,
  now: Date,
): Promise<string> {
  const issuedAt = Math.floor(now.getTime() / 1000);
  return `${issuedAt}.${await mac(secret, requestId, issuedAt)}`;
}

export async function verifyCsrfToken(
  secret: string,
  requestId: string,
  token: string | undefined,
  now: Date,
  maxAgeSeconds = CSRF_MAX_AGE_SECONDS,
): Promise<boolean> {
  const match = /^(\d{1,12})\.([0-9a-f]{64})$/.exec(token ?? "");
  if (!match) return false;
  const issuedAt = Number(match[1]);
  const age = Math.floor(now.getTime() / 1000) - issuedAt;
  if (age > maxAgeSeconds || age < -CLOCK_SKEW_SECONDS) return false;
  return constantTimeEqual(match[2] ?? "", await mac(secret, requestId, issuedAt));
}

/** True when the browser tells us the request was initiated by another site. */
export function isCrossSiteRequest(headers: Headers, expectedOrigin: string): boolean {
  const site = headers.get("Sec-Fetch-Site");
  if (site !== null && site !== "same-origin" && site !== "none") return true;
  const origin = headers.get("Origin");
  if (origin !== null && origin !== "null" && origin !== expectedOrigin) return true;
  return false;
}
