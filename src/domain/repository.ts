import type { EventType, RequestEvent, SigningRequest, Status, StoredStatus } from "./model";

/**
 * All SQL lives here. Every state change is a conditional UPDATE (`WHERE
 * status IN (...)`) so concurrent requests cannot both win; callers check the
 * number of changed rows instead of reading first and writing after.
 */

interface SigningRequestRow {
  id: string;
  title: string;
  message: string | null;
  signer_name: string;
  signer_email: string;
  document_key: string;
  document_sha256: string;
  document_size: number;
  document_pages: number;
  status: StoredStatus;
  created_at: string;
  expires_at: string;
  viewed_at: string | null;
  revoked_at: string | null;
  signed_at: string | null;
  signed_name: string | null;
  signed_ip_hash: string | null;
  signed_user_agent: string | null;
  consent_text: string | null;
  signed_document_key: string | null;
  signed_document_sha256: string | null;
  signed_document_size: number | null;
  evidence_json: string | null;
}

const COLUMNS = `id, title, message, signer_name, signer_email, document_key, document_sha256,
  document_size, document_pages, status, created_at, expires_at, viewed_at, revoked_at,
  signed_at, signed_name, signed_ip_hash, signed_user_agent, consent_text,
  signed_document_key, signed_document_sha256, signed_document_size, evidence_json`;

function fromRow(row: SigningRequestRow): SigningRequest {
  return {
    id: row.id,
    title: row.title,
    message: row.message,
    signerName: row.signer_name,
    signerEmail: row.signer_email,
    documentKey: row.document_key,
    documentSha256: row.document_sha256,
    documentSize: row.document_size,
    documentPages: row.document_pages,
    status: row.status,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    viewedAt: row.viewed_at,
    revokedAt: row.revoked_at,
    signed:
      row.status === "signed" && row.signed_at !== null
        ? {
            signedAt: row.signed_at,
            signedName: row.signed_name ?? "",
            ipHash: row.signed_ip_hash ?? "",
            userAgent: row.signed_user_agent ?? "",
            consentText: row.consent_text ?? "",
            documentKey: row.signed_document_key ?? "",
            documentSha256: row.signed_document_sha256 ?? "",
            documentSize: row.signed_document_size ?? 0,
            evidenceJson: row.evidence_json ?? "{}",
          }
        : null,
  };
}

function eventStatement(
  db: D1Database,
  requestId: string,
  type: EventType,
  at: string,
  detail?: Record<string, unknown>,
): D1PreparedStatement {
  return db
    .prepare("INSERT INTO events (request_id, type, at, detail) VALUES (?, ?, ?, ?)")
    .bind(requestId, type, at, detail ? JSON.stringify(detail) : null);
}

export interface NewSigningRequest {
  id: string;
  tokenHash: string;
  title: string;
  message: string | null;
  signerName: string;
  signerEmail: string;
  documentKey: string;
  documentSha256: string;
  documentSize: number;
  documentPages: number;
  createdAt: string;
  expiresAt: string;
}

export async function insertRequest(db: D1Database, r: NewSigningRequest): Promise<void> {
  await db.batch([
    db
      .prepare(
        `INSERT INTO signing_requests (id, token_hash, title, message, signer_name, signer_email,
           document_key, document_sha256, document_size, document_pages, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        r.id,
        r.tokenHash,
        r.title,
        r.message,
        r.signerName,
        r.signerEmail,
        r.documentKey,
        r.documentSha256,
        r.documentSize,
        r.documentPages,
        r.createdAt,
        r.expiresAt,
      ),
    eventStatement(db, r.id, "created", r.createdAt, { document_sha256: r.documentSha256 }),
  ]);
}

export async function findByTokenHash(
  db: D1Database,
  tokenHash: string,
): Promise<SigningRequest | null> {
  const row = await db
    .prepare(`SELECT ${COLUMNS} FROM signing_requests WHERE token_hash = ?`)
    .bind(tokenHash)
    .first<SigningRequestRow>();
  return row ? fromRow(row) : null;
}

export async function findById(db: D1Database, id: string): Promise<SigningRequest | null> {
  const row = await db
    .prepare(`SELECT ${COLUMNS} FROM signing_requests WHERE id = ?`)
    .bind(id)
    .first<SigningRequestRow>();
  return row ? fromRow(row) : null;
}

export interface ListOptions {
  limit: number;
  /** Keyset cursor: the (created_at, id) of the last item of the previous page. */
  after?: { createdAt: string; id: string } | undefined;
  /** Filters on the effective status, so `expired` and `open` are mutually exclusive. */
  status?: Status | undefined;
  now: string;
}

export async function listRequests(
  db: D1Database,
  options: ListOptions,
): Promise<SigningRequest[]> {
  const where: string[] = [];
  const params: (string | number)[] = [];
  switch (options.status) {
    case undefined:
      break;
    case "expired":
      where.push("status IN ('open', 'viewed') AND expires_at <= ?");
      params.push(options.now);
      break;
    case "open":
    case "viewed":
      where.push("status = ? AND expires_at > ?");
      params.push(options.status, options.now);
      break;
    default:
      where.push("status = ?");
      params.push(options.status);
  }
  if (options.after) {
    where.push("(created_at, id) < (?, ?)");
    params.push(options.after.createdAt, options.after.id);
  }
  const sql = `SELECT ${COLUMNS} FROM signing_requests
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY created_at DESC, id DESC LIMIT ?`;
  const { results } = await db
    .prepare(sql)
    .bind(...params, options.limit)
    .all<SigningRequestRow>();
  return results.map(fromRow);
}

export async function listEvents(db: D1Database, requestId: string): Promise<RequestEvent[]> {
  const { results } = await db
    .prepare("SELECT type, at, detail FROM events WHERE request_id = ? ORDER BY id")
    .bind(requestId)
    .all<{ type: EventType; at: string; detail: string | null }>();
  return results.map((e) => ({
    type: e.type,
    at: e.at,
    detail: e.detail ? (JSON.parse(e.detail) as Record<string, unknown>) : null,
  }));
}

export async function recordEvent(
  db: D1Database,
  requestId: string,
  type: EventType,
  at: string,
  detail?: Record<string, unknown>,
): Promise<void> {
  await eventStatement(db, requestId, type, at, detail).run();
}

/** Returns true if this call moved the request from open to viewed. */
export async function markViewed(db: D1Database, id: string, at: string): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE signing_requests SET status = 'viewed', viewed_at = ?
       WHERE id = ? AND status = 'open' AND expires_at > ?`,
    )
    .bind(at, id, at)
    .run();
  if (result.meta.changes !== 1) return false;
  await recordEvent(db, id, "viewed", at);
  return true;
}

/** Returns true if this call revoked the request. */
export async function markRevoked(db: D1Database, id: string, at: string): Promise<boolean> {
  const [update] = await db.batch([
    db
      .prepare(
        `UPDATE signing_requests SET status = 'revoked', revoked_at = ?
         WHERE id = ? AND status IN ('open', 'viewed')`,
      )
      .bind(at, id),
    // Only logged if the update above took effect (same transaction).
    db
      .prepare(
        `INSERT INTO events (request_id, type, at)
         SELECT id, 'revoked', ? FROM signing_requests
         WHERE id = ? AND status = 'revoked' AND revoked_at = ?
           AND NOT EXISTS (SELECT 1 FROM events WHERE request_id = ? AND type = 'revoked')`,
      )
      .bind(at, id, at, id),
  ]);
  return update?.meta.changes === 1;
}

export interface SignedUpdate {
  id: string;
  signedAt: string;
  signedName: string;
  ipHash: string;
  userAgent: string;
  consentText: string;
  signedDocumentKey: string;
  signedDocumentSha256: string;
  signedDocumentSize: number;
  evidenceJson: string;
}

/**
 * Returns true if this call signed the request. The update only matches a
 * request that is still signable at `signedAt`, so a revoke or another
 * signature that landed in the meantime makes this a no-op.
 */
export async function markSigned(db: D1Database, s: SignedUpdate): Promise<boolean> {
  const [update] = await db.batch([
    db
      .prepare(
        `UPDATE signing_requests SET status = 'signed', signed_at = ?, signed_name = ?,
           signed_ip_hash = ?, signed_user_agent = ?, consent_text = ?, signed_document_key = ?,
           signed_document_sha256 = ?, signed_document_size = ?, evidence_json = ?
         WHERE id = ? AND status IN ('open', 'viewed') AND expires_at > ?`,
      )
      .bind(
        s.signedAt,
        s.signedName,
        s.ipHash,
        s.userAgent,
        s.consentText,
        s.signedDocumentKey,
        s.signedDocumentSha256,
        s.signedDocumentSize,
        s.evidenceJson,
        s.id,
        s.signedAt,
      ),
    // The signed document key is unique per attempt, so this only matches the winner.
    db
      .prepare(
        `INSERT INTO events (request_id, type, at, detail)
         SELECT id, 'signed', ?, ? FROM signing_requests
         WHERE id = ? AND status = 'signed' AND signed_document_key = ?
           AND NOT EXISTS (SELECT 1 FROM events WHERE request_id = ? AND type = 'signed')`,
      )
      .bind(
        s.signedAt,
        JSON.stringify({ signed_document_sha256: s.signedDocumentSha256 }),
        s.id,
        s.signedDocumentKey,
        s.id,
      ),
  ]);
  return update?.meta.changes === 1;
}
