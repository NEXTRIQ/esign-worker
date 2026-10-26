import { describe, expect, it } from "vitest";
import {
  CSRF_MAX_AGE_SECONDS,
  isCrossSiteRequest,
  issueCsrfToken,
  verifyCsrfToken,
} from "../../src/lib/csrf";

const SECRET = "unit-test-secret-0123456789abcdef0123456789";
const REQUEST_ID = "00000000-0000-4000-8000-000000000001";
const NOW = new Date("2026-03-02T09:00:00.000Z");
const later = (seconds: number) => new Date(NOW.getTime() + seconds * 1000);

describe("CSRF tokens", () => {
  it("verify for the request they were issued for", async () => {
    const token = await issueCsrfToken(SECRET, REQUEST_ID, NOW);
    expect(await verifyCsrfToken(SECRET, REQUEST_ID, token, later(60))).toBe(true);
  });

  it("are bound to one signing request", async () => {
    const token = await issueCsrfToken(SECRET, REQUEST_ID, NOW);
    expect(await verifyCsrfToken(SECRET, "00000000-0000-4000-8000-000000000002", token, NOW)).toBe(
      false,
    );
  });

  it("are bound to the server secret", async () => {
    const token = await issueCsrfToken(`${SECRET}x`, REQUEST_ID, NOW);
    expect(await verifyCsrfToken(SECRET, REQUEST_ID, token, NOW)).toBe(false);
  });

  it("cannot be re-dated", async () => {
    const token = await issueCsrfToken(SECRET, REQUEST_ID, NOW);
    const [issuedAt, mac] = token.split(".");
    const forged = `${Number(issuedAt) + 3600}.${mac}`;
    expect(await verifyCsrfToken(SECRET, REQUEST_ID, forged, later(3600))).toBe(false);
  });

  it("expire", async () => {
    const token = await issueCsrfToken(SECRET, REQUEST_ID, NOW);
    expect(await verifyCsrfToken(SECRET, REQUEST_ID, token, later(CSRF_MAX_AGE_SECONDS))).toBe(
      true,
    );
    expect(await verifyCsrfToken(SECRET, REQUEST_ID, token, later(CSRF_MAX_AGE_SECONDS + 1))).toBe(
      false,
    );
  });

  it("are not accepted from the future beyond clock skew", async () => {
    const token = await issueCsrfToken(SECRET, REQUEST_ID, later(600));
    expect(await verifyCsrfToken(SECRET, REQUEST_ID, token, NOW)).toBe(false);
  });

  it("reject missing and malformed values", async () => {
    for (const value of [
      undefined,
      "",
      "abc",
      "123.",
      `x.${"a".repeat(64)}`,
      `1.${"g".repeat(64)}`,
    ]) {
      expect(await verifyCsrfToken(SECRET, REQUEST_ID, value, NOW)).toBe(false);
    }
  });
});

describe("cross-site detection", () => {
  const origin = "https://sign.example.com";
  const check = (headers: Record<string, string>) =>
    isCrossSiteRequest(new Headers(headers), origin);

  it("allows same-origin requests", () => {
    expect(check({ "Sec-Fetch-Site": "same-origin", Origin: origin })).toBe(false);
  });

  it("allows Origin: null, which browsers send under Referrer-Policy: no-referrer", () => {
    expect(check({ "Sec-Fetch-Site": "same-origin", Origin: "null" })).toBe(false);
  });

  it("allows clients that send no fetch metadata (the CSRF token still applies)", () => {
    expect(check({})).toBe(false);
  });

  it("blocks cross-site and same-site requests", () => {
    expect(check({ "Sec-Fetch-Site": "cross-site" })).toBe(true);
    expect(check({ "Sec-Fetch-Site": "same-site" })).toBe(true);
  });

  it("blocks a foreign Origin", () => {
    expect(check({ Origin: "https://attacker.example" })).toBe(true);
    expect(check({ Origin: "http://sign.example.com" })).toBe(true);
  });
});
