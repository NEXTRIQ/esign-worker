import type { RequestEvent } from "./model";

/**
 * The evidence record of one signature. It is rendered onto the appended
 * evidence page, stored (with the hash of the resulting PDF) as immutable
 * JSON, and returned by the admin API.
 */
export interface Evidence {
  version: 1;
  request_id: string;
  issuer: string;
  document: { title: string; sha256: string; size: number; pages: number };
  signer: { requested_name: string; email: string; typed_name: string };
  signature: { method: "typed_name" | "typed_name_and_drawing"; drawing_sha256: string | null };
  signed_at: string;
  /** HMAC-SHA256 of the client IP with a server-side secret; the IP itself is not kept. */
  ip_hash: string;
  user_agent: string;
  consent_text: string;
  /** The request's history up to and including the signature. */
  events: { type: string; at: string }[];
  /** Hash of the final signed PDF. Absent while that PDF is being built. */
  signed_document?: { sha256: string; size: number };
}

export function consentText(title: string, documentSha256: string): string {
  return (
    `I have reviewed the document "${title}" (SHA-256 ${documentSha256}) ` +
    "and agree to sign it electronically with the name I typed."
  );
}

export function auditTrail(events: RequestEvent[], signedAt: string): Evidence["events"] {
  return [
    ...events.filter((e) => e.type !== "signed").map((e) => ({ type: e.type, at: e.at })),
    { type: "signed", at: signedAt },
  ];
}

export interface EvidenceRow {
  label: string;
  value: string;
  monospace?: boolean;
}

/** The rows printed on the evidence page, in order. Kept separate so it can be tested without parsing PDFs. */
export function evidenceRows(e: Evidence): EvidenceRow[] {
  return [
    { label: "Document", value: e.document.title },
    { label: "Document SHA-256", value: e.document.sha256, monospace: true },
    {
      label: "Pages / size",
      value: `${e.document.pages} pages, ${e.document.size} bytes (original)`,
    },
    { label: "Request ID", value: e.request_id, monospace: true },
    { label: "Requested by", value: e.issuer },
    { label: "Signer", value: `${e.signer.requested_name} <${e.signer.email}>` },
    { label: "Name typed by signer", value: e.signer.typed_name },
    {
      label: "Method",
      value:
        "Personal link sent by email; consent checkbox ticked; name typed" +
        (e.signature.method === "typed_name_and_drawing" ? "; signature drawn" : ""),
    },
    { label: "Signed at (UTC)", value: e.signed_at },
    { label: "IP address (HMAC)", value: e.ip_hash, monospace: true },
    { label: "User agent", value: e.user_agent || "(not provided)" },
    { label: "Consent", value: e.consent_text },
    ...(e.signature.drawing_sha256
      ? [{ label: "Drawing SHA-256", value: e.signature.drawing_sha256, monospace: true }]
      : []),
  ];
}
