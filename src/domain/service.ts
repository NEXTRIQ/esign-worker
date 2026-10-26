import { z } from "zod";
import type { Config } from "../config";
import type { Mailer } from "../email/mailer";
import { invitationEmail, ownerCompletionEmail, signerCompletionEmail } from "../email/templates";
import { hmacSha256Hex, sha256Hex } from "../lib/crypto";
import { uuidv7 } from "../lib/ids";
import { buildSignedPdf, inspectPdf, PdfError } from "../pdf/signed-pdf";
import { auditTrail, consentText, type Evidence } from "./evidence";
import {
  ConflictError,
  DAY_MS,
  effectiveStatus,
  failureForStatus,
  NotFoundError,
  SigningError,
  ValidationError,
  type SigningRequest,
} from "./model";
import * as repo from "./repository";
import {
  MAX_SIGNATURE_SVG_LENGTH,
  parseSignatureSvg,
  SignatureSvgError,
  type SignatureSvg,
} from "./signature-svg";
import { generateSigningToken, hashSigningToken, isWellFormedToken } from "./token";

export interface Deps {
  db: D1Database;
  bucket: R2Bucket;
  mailer: Mailer;
  config: Config;
  now: () => Date;
  /** Runs work after the response (ctx.waitUntil). When absent, the work is awaited. */
  defer?: (work: Promise<unknown>) => void;
}

// Titles and names end up in email subjects and PDF text: no control characters.
const singleLine = (max: number) =>
  z
    .string()
    .trim()
    .min(1, "is required")
    .max(max, `must be at most ${max} characters`)
    .refine((s) => !/\p{Cc}/u.test(s), "must not contain control characters");

const CreateRequestSchema = z.object({
  title: singleLine(200),
  signer_name: singleLine(120),
  signer_email: z.email("must be a valid email address").max(254),
  message: z
    .string()
    .trim()
    .max(2000, "must be at most 2000 characters")
    .optional()
    .transform((m) => m || null),
  expires_in_days: z.coerce
    .number()
    .int("must be a whole number")
    .min(1, "must be at least 1")
    .optional(),
});

const SignFormSchema = z.object({
  name: singleLine(120).refine((s) => s.length >= 2, "Please type your full name."),
  consent: z.literal("yes", "Please confirm that you agree to sign."),
  document_sha256: z.string().regex(/^[0-9a-f]{64}$/, "is invalid"),
  signature_svg: z
    .string()
    .max(MAX_SIGNATURE_SVG_LENGTH)
    .optional()
    .transform((s) => s?.trim() || undefined),
});

function fieldErrors(error: z.ZodError): ValidationError {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? "form");
    fields[key] ??= issue.message;
  }
  return new ValidationError(fields);
}

export function signingUrl(config: Config, token: string): string {
  return `${config.publicBaseUrl}/s/${token}`;
}

export function signedFilename(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
  return `${slug || "document"}-signed.pdf`;
}

async function readObject(bucket: R2Bucket, key: string): Promise<Uint8Array<ArrayBuffer> | null> {
  const object = await bucket.get(key);
  return object ? new Uint8Array(await object.arrayBuffer()) : null;
}

/** Runs best-effort side effects (email) without letting them fail the main operation. */
async function settle(deps: Deps, work: () => Promise<void>): Promise<void> {
  const guarded = work().catch((error: unknown) => {
    console.error("background task failed", error instanceof Error ? error.name : "unknown");
  });
  if (deps.defer) deps.defer(guarded);
  else await guarded;
}

// ---------------------------------------------------------------------------
// Admin operations

export interface CreatedRequest {
  request: SigningRequest;
  signingUrl: string;
  invitation: "sent" | "failed";
}

export async function createSigningRequest(
  deps: Deps,
  input: { pdf: Uint8Array; fields: unknown },
): Promise<CreatedRequest> {
  const { config } = deps;
  const parsed = CreateRequestSchema.safeParse(input.fields);
  if (!parsed.success) throw fieldErrors(parsed.error);
  const fields = parsed.data;

  const expiresInDays = fields.expires_in_days ?? config.defaultExpiryDays;
  if (expiresInDays > config.maxExpiryDays) {
    throw new ValidationError({ expires_in_days: `must be at most ${config.maxExpiryDays}` });
  }
  if (input.pdf.length > config.maxPdfBytes) {
    throw new ValidationError({ file: `must be at most ${config.maxPdfBytes} bytes` });
  }
  let pages: number;
  try {
    ({ pages } = await inspectPdf(input.pdf));
  } catch (error) {
    if (error instanceof PdfError) throw new ValidationError({ file: error.message });
    throw error;
  }

  const now = deps.now();
  const id = uuidv7(now.getTime());
  const token = generateSigningToken();
  const documentSha256 = await sha256Hex(input.pdf);
  const documentKey = `documents/${id}/original.pdf`;

  // R2 verifies the checksum on upload, so a corrupted upload fails here.
  await deps.bucket.put(documentKey, input.pdf, {
    sha256: documentSha256,
    httpMetadata: { contentType: "application/pdf" },
  });
  try {
    await repo.insertRequest(deps.db, {
      id,
      tokenHash: await hashSigningToken(token),
      title: fields.title,
      message: fields.message,
      signerName: fields.signer_name,
      signerEmail: fields.signer_email,
      documentKey,
      documentSha256,
      documentSize: input.pdf.length,
      documentPages: pages,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + expiresInDays * DAY_MS).toISOString(),
    });
  } catch (error) {
    await deps.bucket.delete(documentKey).catch(() => undefined);
    throw error;
  }

  const request = await repo.findById(deps.db, id);
  if (!request) throw new Error("request vanished after insert");
  const url = signingUrl(config, token);

  // Sent inline (not deferred) so the caller learns whether the invitation went out.
  let invitation: CreatedRequest["invitation"] = "sent";
  try {
    await deps.mailer.send(
      invitationEmail({
        orgName: config.orgName,
        signerName: request.signerName,
        signerEmail: request.signerEmail,
        title: request.title,
        message: request.message,
        signingUrl: url,
        expiresAt: request.expiresAt,
      }),
    );
    await repo.recordEvent(deps.db, id, "invitation_sent", deps.now().toISOString());
  } catch (error) {
    invitation = "failed";
    await repo.recordEvent(deps.db, id, "invitation_failed", deps.now().toISOString(), {
      error: error instanceof Error ? error.name : "unknown",
    });
  }

  return { request, signingUrl: url, invitation };
}

export async function revokeSigningRequest(deps: Deps, id: string): Promise<SigningRequest> {
  const request = await repo.findById(deps.db, id);
  if (!request) throw new NotFoundError();
  const status = effectiveStatus(request, deps.now());
  if (status === "signed" || status === "revoked") throw new ConflictError(status);

  if (!(await repo.markRevoked(deps.db, id, deps.now().toISOString()))) {
    // Lost a race with a signature or another revoke.
    const current = await repo.findById(deps.db, id);
    throw new ConflictError(current ? effectiveStatus(current, deps.now()) : "revoked");
  }
  const revoked = await repo.findById(deps.db, id);
  if (!revoked) throw new NotFoundError();
  return revoked;
}

// ---------------------------------------------------------------------------
// Signer operations

/** Resolves a signing token to its request. Malformed tokens never reach the database. */
export async function findByToken(deps: Deps, token: string): Promise<SigningRequest | null> {
  if (!isWellFormedToken(token)) return null;
  return repo.findByTokenHash(deps.db, await hashSigningToken(token));
}

/** Records the first view. Returns the request as it is after that. */
export async function recordView(deps: Deps, request: SigningRequest): Promise<SigningRequest> {
  if (request.status !== "open" || effectiveStatus(request, deps.now()) !== "open") return request;
  const at = deps.now().toISOString();
  return (await repo.markViewed(deps.db, request.id, at))
    ? { ...request, status: "viewed", viewedAt: at }
    : ((await repo.findById(deps.db, request.id)) ?? request);
}

/**
 * Returns the stored original, or null if it no longer matches the hash
 * fixed at send time. A signer must never be shown, or sign, other bytes than
 * the ones that were sent.
 */
export async function loadVerifiedOriginal(
  deps: Deps,
  request: SigningRequest,
): Promise<Uint8Array<ArrayBuffer> | null> {
  const bytes = await readObject(deps.bucket, request.documentKey);
  if (bytes && (await sha256Hex(bytes)) === request.documentSha256) return bytes;
  // Logged by request id only; the token must never appear in logs.
  console.error(`stored document for request ${request.id} does not match its hash`);
  await repo.recordEvent(deps.db, request.id, "tamper_detected", deps.now().toISOString(), {
    object: bytes ? "modified" : "missing",
  });
  return null;
}

export async function loadVerifiedSigned(
  deps: Deps,
  request: SigningRequest,
): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!request.signed) return null;
  const bytes = await readObject(deps.bucket, request.signed.documentKey);
  if (bytes && (await sha256Hex(bytes)) === request.signed.documentSha256) return bytes;
  console.error(`signed document for request ${request.id} does not match its hash`);
  return null;
}

export interface ClientInfo {
  ip: string | null;
  userAgent: string | null;
}

export async function signWithToken(
  deps: Deps,
  token: string,
  form: unknown,
  client: ClientInfo,
): Promise<SigningRequest> {
  const { config } = deps;
  const request = await findByToken(deps, token);
  if (!request) throw new NotFoundError();
  const now = deps.now();
  const failure = failureForStatus(effectiveStatus(request, now));
  if (failure) throw new SigningError(failure);

  const parsed = SignFormSchema.safeParse(form);
  if (!parsed.success) throw fieldErrors(parsed.error);
  const input = parsed.data;
  // The page embeds the hash the signer was shown. If it differs, they reviewed something else.
  if (input.document_sha256 !== request.documentSha256) throw new SigningError("document_changed");

  let drawing: SignatureSvg | null = null;
  if (input.signature_svg) {
    try {
      drawing = parseSignatureSvg(input.signature_svg);
    } catch (error) {
      if (error instanceof SignatureSvgError) {
        throw new ValidationError({
          signature_svg: `The drawn signature was rejected: ${error.message}.`,
        });
      }
      throw error;
    }
  }

  const original = await loadVerifiedOriginal(deps, request);
  if (!original) throw new SigningError("document_changed");

  const signedAt = now.toISOString();
  const consent = consentText(request.title, request.documentSha256);
  const evidence: Evidence = {
    version: 1,
    request_id: request.id,
    issuer: config.orgName,
    document: {
      title: request.title,
      sha256: request.documentSha256,
      size: request.documentSize,
      pages: request.documentPages,
    },
    signer: {
      requested_name: request.signerName,
      email: request.signerEmail,
      typed_name: input.name,
    },
    signature: {
      method: drawing ? "typed_name_and_drawing" : "typed_name",
      drawing_sha256: drawing ? await sha256Hex(drawing.svg) : null,
    },
    signed_at: signedAt,
    // Keyed hash: lets an operator check "same IP as..." claims with the
    // secret, without the database holding raw IP addresses.
    ip_hash: await hmacSha256Hex(config.appSecret, `ip:v1|${client.ip ?? "unknown"}`),
    user_agent: (client.userAgent ?? "").slice(0, 512),
    consent_text: consent,
    events: auditTrail(await repo.listEvents(deps.db, request.id), signedAt),
  };

  const signedPdf = await buildSignedPdf({ original, evidence, drawing });
  const signedSha256 = await sha256Hex(signedPdf);
  const record: Evidence = {
    ...evidence,
    signed_document: { sha256: signedSha256, size: signedPdf.length },
  };
  // A unique key per attempt: if two submissions race, the loser's upload can
  // never overwrite the winner's PDF.
  const signedKey = `signed/${request.id}/${crypto.randomUUID()}.pdf`;
  await deps.bucket.put(signedKey, signedPdf, {
    sha256: signedSha256,
    httpMetadata: { contentType: "application/pdf" },
  });

  const won = await repo.markSigned(deps.db, {
    id: request.id,
    signedAt,
    signedName: input.name,
    ipHash: evidence.ip_hash,
    userAgent: evidence.user_agent,
    consentText: consent,
    signedDocumentKey: signedKey,
    signedDocumentSha256: signedSha256,
    signedDocumentSize: signedPdf.length,
    evidenceJson: JSON.stringify(record),
  });
  if (!won) {
    await deps.bucket.delete(signedKey).catch(() => undefined);
    const current = await repo.findById(deps.db, request.id);
    throw new SigningError(
      (current && failureForStatus(effectiveStatus(current, deps.now()))) ?? "already_signed",
    );
  }

  const signed = await repo.findById(deps.db, request.id);
  if (!signed) throw new NotFoundError();
  await settle(deps, () => sendCompletionEmails(deps, signed, token, signedPdf));
  return signed;
}

async function sendCompletionEmails(
  deps: Deps,
  request: SigningRequest,
  token: string,
  signedPdf: Uint8Array,
): Promise<void> {
  const { config } = deps;
  if (!request.signed) return;
  const filename = signedFilename(request.title);
  const messages = [
    {
      recipient: "signer",
      message: signerCompletionEmail({
        orgName: config.orgName,
        signerName: request.signed.signedName,
        signerEmail: request.signerEmail,
        title: request.title,
        downloadUrl: `${signingUrl(config, token)}/download`,
        downloadDays: config.downloadDays,
        signedPdf,
        filename,
      }),
    },
  ];
  if (config.ownerEmail) {
    messages.push({
      recipient: "owner",
      message: ownerCompletionEmail({
        ownerEmail: config.ownerEmail,
        signerName: request.signed.signedName,
        signerEmail: request.signerEmail,
        title: request.title,
        requestId: request.id,
        signedAt: request.signed.signedAt,
        signedSha256: request.signed.documentSha256,
        signedPdf,
        filename,
      }),
    });
  }
  for (const { recipient, message } of messages) {
    try {
      await deps.mailer.send(message);
      await repo.recordEvent(deps.db, request.id, "completion_sent", deps.now().toISOString(), {
        recipient,
      });
    } catch (error) {
      await repo.recordEvent(deps.db, request.id, "completion_failed", deps.now().toISOString(), {
        recipient,
        error: error instanceof Error ? error.name : "unknown",
      });
    }
  }
}
