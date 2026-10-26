-- Signing requests and their append-only event log.
--
-- Timestamps are ISO 8601 strings in UTC (`2026-01-31T12:00:00.000Z`), which
-- sort lexicographically in time order.

CREATE TABLE signing_requests (
  id                     TEXT PRIMARY KEY,
  -- SHA-256 (hex) of the signing token. The token itself is never stored.
  token_hash             TEXT NOT NULL UNIQUE,
  title                  TEXT NOT NULL,
  message                TEXT,
  signer_name            TEXT NOT NULL,
  signer_email           TEXT NOT NULL,
  document_key           TEXT NOT NULL,
  -- Fixed at send time; the stored PDF must still match it when signing.
  document_sha256        TEXT NOT NULL,
  document_size          INTEGER NOT NULL,
  document_pages         INTEGER NOT NULL,
  -- `expired` is not stored: it is derived from expires_at at read time.
  status                 TEXT NOT NULL DEFAULT 'open'
                           CHECK (status IN ('open', 'viewed', 'signed', 'revoked')),
  created_at             TEXT NOT NULL,
  expires_at             TEXT NOT NULL,
  viewed_at              TEXT,
  revoked_at             TEXT,
  signed_at              TEXT,
  signed_name            TEXT,
  signed_ip_hash         TEXT,
  signed_user_agent      TEXT,
  consent_text           TEXT,
  signed_document_key    TEXT,
  signed_document_sha256 TEXT,
  signed_document_size   INTEGER,
  evidence_json          TEXT,

  CHECK (expires_at > created_at),
  CHECK (status <> 'revoked' OR revoked_at IS NOT NULL),
  CHECK (
    status <> 'signed' OR (
      signed_at IS NOT NULL AND signed_name IS NOT NULL AND signed_ip_hash IS NOT NULL
      AND consent_text IS NOT NULL AND signed_document_key IS NOT NULL
      AND signed_document_sha256 IS NOT NULL AND evidence_json IS NOT NULL
    )
  )
);

CREATE INDEX signing_requests_created_at ON signing_requests (created_at DESC, id DESC);
CREATE INDEX signing_requests_status ON signing_requests (status, created_at DESC);

CREATE TABLE events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL REFERENCES signing_requests (id),
  type       TEXT NOT NULL CHECK (type IN (
               'created', 'invitation_sent', 'invitation_failed', 'viewed', 'signed',
               'revoked', 'tamper_detected', 'completion_sent', 'completion_failed'
             )),
  at         TEXT NOT NULL,
  -- Small JSON object with context. Never contains the signing token.
  detail     TEXT
);

CREATE INDEX events_request ON events (request_id, id);

-- Defence in depth: the application only issues the transitions below, but
-- the database refuses everything else, so a bug or a manual query cannot
-- rewrite evidence.

-- Fields that define what is being signed, and by whom, never change.
CREATE TRIGGER signing_requests_fixed_fields
BEFORE UPDATE ON signing_requests
WHEN NEW.id IS NOT OLD.id
  OR NEW.token_hash IS NOT OLD.token_hash
  OR NEW.title IS NOT OLD.title
  OR NEW.message IS NOT OLD.message
  OR NEW.signer_name IS NOT OLD.signer_name
  OR NEW.signer_email IS NOT OLD.signer_email
  OR NEW.document_key IS NOT OLD.document_key
  OR NEW.document_sha256 IS NOT OLD.document_sha256
  OR NEW.document_size IS NOT OLD.document_size
  OR NEW.document_pages IS NOT OLD.document_pages
  OR NEW.created_at IS NOT OLD.created_at
  OR NEW.expires_at IS NOT OLD.expires_at
BEGIN
  SELECT RAISE(ABORT, 'signing request fields are fixed at creation');
END;

-- Signed and revoked are final states.
CREATE TRIGGER signing_requests_final_states
BEFORE UPDATE ON signing_requests
WHEN OLD.status IN ('signed', 'revoked')
BEGIN
  SELECT RAISE(ABORT, 'signing request is final and immutable');
END;

-- Only forward transitions: open -> viewed -> signed | revoked.
CREATE TRIGGER signing_requests_transitions
BEFORE UPDATE OF status ON signing_requests
WHEN NOT (
  NEW.status = OLD.status
  OR (OLD.status = 'open' AND NEW.status IN ('viewed', 'signed', 'revoked'))
  OR (OLD.status = 'viewed' AND NEW.status IN ('signed', 'revoked'))
)
BEGIN
  SELECT RAISE(ABORT, 'invalid status transition');
END;

CREATE TRIGGER signing_requests_no_delete_signed
BEFORE DELETE ON signing_requests
WHEN OLD.status = 'signed'
BEGIN
  SELECT RAISE(ABORT, 'signed requests cannot be deleted');
END;

CREATE TRIGGER events_no_update
BEFORE UPDATE ON events
BEGIN
  SELECT RAISE(ABORT, 'events are append-only');
END;

CREATE TRIGGER events_no_delete
BEFORE DELETE ON events
BEGIN
  SELECT RAISE(ABORT, 'events are append-only');
END;
