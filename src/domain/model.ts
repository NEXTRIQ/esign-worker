/** Status as stored in the database. */
export type StoredStatus = "open" | "viewed" | "signed" | "revoked";

/** Status as reported: `expired` is derived from `expiresAt`, never stored. */
export type Status = StoredStatus | "expired";

export interface SigningRequest {
  id: string;
  title: string;
  message: string | null;
  signerName: string;
  signerEmail: string;
  documentKey: string;
  documentSha256: string;
  documentSize: number;
  documentPages: number;
  status: StoredStatus;
  createdAt: string;
  expiresAt: string;
  viewedAt: string | null;
  revokedAt: string | null;
  signed: SignedDetails | null;
}

export interface SignedDetails {
  signedAt: string;
  signedName: string;
  ipHash: string;
  userAgent: string;
  consentText: string;
  documentKey: string;
  documentSha256: string;
  documentSize: number;
  evidenceJson: string;
}

export type EventType =
  | "created"
  | "invitation_sent"
  | "invitation_failed"
  | "viewed"
  | "signed"
  | "revoked"
  | "tamper_detected"
  | "completion_sent"
  | "completion_failed";

export interface RequestEvent {
  type: EventType;
  at: string;
  detail: Record<string, unknown> | null;
}

/**
 * Deriving `expired` instead of storing it means no cron job is needed and a
 * request can never be signed a moment after its deadline because a sweeper
 * has not run yet.
 */
export function effectiveStatus(
  request: Pick<SigningRequest, "status" | "expiresAt">,
  now: Date,
): Status {
  if (request.status === "signed" || request.status === "revoked") return request.status;
  return Date.parse(request.expiresAt) <= now.getTime() ? "expired" : request.status;
}

export function isSignable(status: Status): status is "open" | "viewed" {
  return status === "open" || status === "viewed";
}

/** The signer may download the signed PDF via their link for a limited period. */
export function canDownloadSigned(
  request: SigningRequest,
  now: Date,
  downloadDays: number,
): boolean {
  if (request.status !== "signed" || !request.signed) return false;
  return Date.parse(request.signed.signedAt) + downloadDays * DAY_MS > now.getTime();
}

export const DAY_MS = 24 * 60 * 60 * 1000;

export type SigningFailure = "already_signed" | "expired" | "revoked" | "document_changed";

/** An expected outcome for the signer, not a programming error. */
export class SigningError extends Error {
  constructor(readonly reason: SigningFailure) {
    super(`Signing refused: ${reason}`);
    this.name = "SigningError";
  }
}

export function failureForStatus(status: Status): SigningFailure | null {
  switch (status) {
    case "signed":
      return "already_signed";
    case "expired":
      return "expired";
    case "revoked":
      return "revoked";
    case "open":
    case "viewed":
      return null;
  }
}

/** Input that failed validation; `fields` maps form/API field names to messages. */
export class ValidationError extends Error {
  constructor(readonly fields: Record<string, string>) {
    super(`Validation failed: ${Object.keys(fields).join(", ")}`);
    this.name = "ValidationError";
  }
}

export class NotFoundError extends Error {
  constructor() {
    super("Not found");
    this.name = "NotFoundError";
  }
}

/** The operation conflicts with the current state (for example revoking a signed request). */
export class ConflictError extends Error {
  constructor(readonly status: Status) {
    super(`Conflict with status ${status}`);
    this.name = "ConflictError";
  }
}
