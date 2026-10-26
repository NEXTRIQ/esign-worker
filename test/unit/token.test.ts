import { describe, expect, it } from "vitest";
import { generateSigningToken, hashSigningToken, isWellFormedToken } from "../../src/domain/token";
import { constantTimeEqual, hmacSha256Hex, sha256Hex } from "../../src/lib/crypto";

describe("signing tokens", () => {
  it("are 43 base64url characters (32 random bytes)", () => {
    const token = generateSigningToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(isWellFormedToken(token)).toBe(true);
  });

  it("do not repeat", () => {
    const tokens = new Set(Array.from({ length: 1000 }, generateSigningToken));
    expect(tokens.size).toBe(1000);
  });

  it("are stored as their SHA-256 hex digest", async () => {
    const token = generateSigningToken();
    const hash = await hashSigningToken(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(await sha256Hex(token));
    expect(hash).not.toContain(token);
  });

  it("rejects malformed tokens before any lookup", () => {
    expect(isWellFormedToken("")).toBe(false);
    expect(isWellFormedToken("a".repeat(42))).toBe(false);
    expect(isWellFormedToken("a".repeat(44))).toBe(false);
    expect(isWellFormedToken(`${"a".repeat(42)}=`)).toBe(false);
    expect(isWellFormedToken(`${"a".repeat(42)}/`)).toBe(false);
  });
});

describe("crypto helpers", () => {
  it("computes SHA-256 test vectors", async () => {
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(await sha256Hex(new Uint8Array())).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("computes HMAC-SHA256 test vectors (RFC 4231, case 2)", async () => {
    expect(await hmacSha256Hex("Jefe", "what do ya want for nothing?")).toBe(
      "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
    );
  });

  it("compares secrets of any length", async () => {
    expect(await constantTimeEqual("secret-value", "secret-value")).toBe(true);
    expect(await constantTimeEqual("secret-value", "secret-valuE")).toBe(false);
    expect(await constantTimeEqual("secret-value", "secret")).toBe(false);
    expect(await constantTimeEqual("", "")).toBe(true);
  });
});
