import type { MiddlewareHandler } from "hono";

/** For HTML pages: only our own stylesheet, script and same-origin PDF frame. */
export const PAGE_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "frame-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join("; ");

/** For PDFs shown inside our own signing page. */
export const EMBEDDED_PDF_CSP = "frame-ancestors 'self'";

/** For everything else (JSON, downloads, assets). */
const DEFAULT_CSP =
  "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

/**
 * Applied to every response. Routes may set a looser CSP, frame or cache
 * policy explicitly; anything they do not set falls back to the strict default.
 */
export const securityHeaders: MiddlewareHandler = async (c, next) => {
  await next();
  const headers = c.res.headers;
  // Signing URLs carry the token; never leak it to other origins via Referer.
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  headers.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains");
  headers.set("X-Robots-Tag", "noindex, nofollow");
  if (!headers.has("Content-Security-Policy")) headers.set("Content-Security-Policy", DEFAULT_CSP);
  if (!headers.has("X-Frame-Options")) headers.set("X-Frame-Options", "DENY");
  // Pages and documents are personal; no shared cache may keep them.
  if (!headers.has("Cache-Control")) headers.set("Cache-Control", "no-store");
};
