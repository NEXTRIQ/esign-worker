/** Signing links are credentials; anything that may end up in logs goes through this. */
const SIGNING_PATH = /\/s\/[A-Za-z0-9_-]{16,}/g;

export function redactTokens(text: string): string {
  return text.replace(SIGNING_PATH, "/s/[redacted]");
}
