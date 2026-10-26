/**
 * Small wrappers around Web Crypto. Everything here runs in the Workers
 * runtime without Node.js compatibility flags.
 */

const encoder = new TextEncoder();

type Bytes = Uint8Array | ArrayBuffer;

export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function toBase64(bytes: Uint8Array): string {
  // Chunked to stay below the argument limit of String.fromCharCode.apply.
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function toHex(bytes: Bytes): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let hex = "";
  for (const byte of view) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

export function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

export async function sha256Hex(data: Bytes | string): Promise<string> {
  const input = typeof data === "string" ? encoder.encode(data) : data;
  return toHex(await crypto.subtle.digest("SHA-256", input));
}

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return toHex(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
}

/**
 * Compares two secrets without leaking where they differ, or their lengths:
 * both sides are hashed first, so the final comparison is always over two
 * 32-byte digests.
 */
export async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const [da, db] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(da, db);
}
