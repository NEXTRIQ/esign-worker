import { randomBytes, toHex } from "./crypto";

let lastMs = 0;
let sequence = 0;

/**
 * UUIDv7 (RFC 9562): time-ordered, so ids sort like their creation time and
 * act as a stable tie-breaker for keyset pagination. Within one millisecond a
 * 12-bit counter keeps ids from the same isolate monotonic.
 */
export function uuidv7(now: number = Date.now()): string {
  if (now <= lastMs) {
    sequence = (sequence + 1) & 0xfff;
    if (sequence === 0) lastMs += 1; // Counter overflow: borrow the next millisecond.
    now = lastMs;
  } else {
    lastMs = now;
    sequence = (randomBytes(2)[0] ?? 0) << 2; // Random start with room to count up.
  }
  const bytes = randomBytes(16);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, Math.floor(now / 2 ** 32) & 0xffff);
  view.setUint32(2, now >>> 0);
  view.setUint16(6, 0x7000 | sequence);
  bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f);
  const hex = toHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
