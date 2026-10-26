import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app-env";
import {
  effectiveStatus,
  NotFoundError,
  ValidationError,
  type RequestEvent,
  type SigningRequest,
} from "../domain/model";
import { listEvents, listRequests, findById } from "../domain/repository";
import {
  createSigningRequest,
  loadVerifiedSigned,
  revokeSigningRequest,
  signedFilename,
} from "../domain/service";
import { constantTimeEqual } from "../lib/crypto";

export const adminRoutes = new Hono<AppEnv>();

const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  const header = c.req.header("Authorization") ?? "";
  const match = /^Bearer (.+)$/.exec(header);
  if (!match || !(await constantTimeEqual(match[1] ?? "", c.get("deps").config.adminToken))) {
    c.header("WWW-Authenticate", 'Bearer realm="esign-worker"');
    return c.json({ error: "unauthorized" }, 401);
  }
  return next();
};

adminRoutes.use("*", requireAdmin);

function toApi(request: SigningRequest, now: Date) {
  return {
    id: request.id,
    title: request.title,
    status: effectiveStatus(request, now),
    signer: { name: request.signerName, email: request.signerEmail },
    message: request.message,
    document: {
      sha256: request.documentSha256,
      size: request.documentSize,
      pages: request.documentPages,
    },
    created_at: request.createdAt,
    expires_at: request.expiresAt,
    viewed_at: request.viewedAt,
    revoked_at: request.revokedAt,
    signed: request.signed
      ? {
          at: request.signed.signedAt,
          name: request.signed.signedName,
          document_sha256: request.signed.documentSha256,
          document_size: request.signed.documentSize,
        }
      : null,
  };
}

function eventsToApi(events: RequestEvent[]) {
  return events.map((e) => ({ type: e.type, at: e.at, ...(e.detail ? { detail: e.detail } : {}) }));
}

async function requireRequest(db: D1Database, id: string): Promise<SigningRequest> {
  const request = z.uuid().safeParse(id).success ? await findById(db, id) : null;
  if (!request) throw new NotFoundError();
  return request;
}

adminRoutes.post("/requests", async (c) => {
  const deps = c.get("deps");
  const contentType = c.req.header("Content-Type") ?? "";
  if (!contentType.startsWith("multipart/form-data")) {
    return c.json({ error: "unsupported_media_type", message: "Send multipart/form-data" }, 415);
  }
  const body = await c.req.parseBody();
  const file = body.file;
  if (!(file instanceof File)) throw new ValidationError({ file: "a PDF file is required" });
  if (file.size > deps.config.maxPdfBytes) {
    return c.json({ error: "payload_too_large", max_bytes: deps.config.maxPdfBytes }, 413);
  }

  const fields = Object.fromEntries(Object.entries(body).filter(([, v]) => typeof v === "string"));
  const created = await createSigningRequest(deps, {
    pdf: new Uint8Array(await file.arrayBuffer()),
    fields,
  });
  return c.json(
    {
      ...toApi(created.request, deps.now()),
      // Returned once and never stored: the admin can share it manually if email fails.
      signing_url: created.signingUrl,
      invitation: created.invitation,
    },
    201,
  );
});

const ListQuerySchema = z.object({
  status: z.enum(["open", "viewed", "signed", "revoked", "expired"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(200).optional(),
});

function encodeCursor(request: SigningRequest): string {
  return btoa(JSON.stringify([request.createdAt, request.id])).replace(/=+$/, "");
}

function decodeCursor(cursor: string): { createdAt: string; id: string } {
  try {
    const value: unknown = JSON.parse(atob(cursor));
    if (Array.isArray(value) && value.length === 2 && value.every((v) => typeof v === "string")) {
      return { createdAt: value[0] as string, id: value[1] as string };
    }
  } catch {
    // Fall through to the validation error.
  }
  throw new ValidationError({ cursor: "is invalid" });
}

adminRoutes.get("/requests", async (c) => {
  const deps = c.get("deps");
  const parsed = ListQuerySchema.safeParse(c.req.query());
  if (!parsed.success) {
    throw new ValidationError(
      Object.fromEntries(parsed.error.issues.map((i) => [String(i.path[0] ?? "query"), i.message])),
    );
  }
  const { status, limit, cursor } = parsed.data;
  const now = deps.now();
  // Fetch one extra row to know whether there is a next page.
  const rows = await listRequests(deps.db, {
    status,
    limit: limit + 1,
    after: cursor ? decodeCursor(cursor) : undefined,
    now: now.toISOString(),
  });
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return c.json({
    data: page.map((r) => toApi(r, now)),
    next_cursor: rows.length > limit && last ? encodeCursor(last) : null,
  });
});

adminRoutes.get("/requests/:id", async (c) => {
  const deps = c.get("deps");
  const request = await requireRequest(deps.db, c.req.param("id"));
  return c.json({
    ...toApi(request, deps.now()),
    events: eventsToApi(await listEvents(deps.db, request.id)),
  });
});

adminRoutes.post("/requests/:id/revoke", async (c) => {
  const deps = c.get("deps");
  await requireRequest(deps.db, c.req.param("id"));
  const revoked = await revokeSigningRequest(deps, c.req.param("id"));
  return c.json(toApi(revoked, deps.now()));
});

adminRoutes.get("/requests/:id/signed.pdf", async (c) => {
  const deps = c.get("deps");
  const request = await requireRequest(deps.db, c.req.param("id"));
  if (!request.signed)
    return c.json({ error: "not_signed", status: effectiveStatus(request, deps.now()) }, 409);
  const bytes = await loadVerifiedSigned(deps, request);
  if (!bytes) return c.json({ error: "integrity_check_failed" }, 500);
  c.header("Content-Type", "application/pdf");
  c.header("Content-Disposition", `attachment; filename="${signedFilename(request.title)}"`);
  return c.body(bytes);
});

adminRoutes.get("/requests/:id/evidence.json", async (c) => {
  const deps = c.get("deps");
  const request = await requireRequest(deps.db, c.req.param("id"));
  if (!request.signed)
    return c.json({ error: "not_signed", status: effectiveStatus(request, deps.now()) }, 409);
  // Returned verbatim: this is the exact record that was stored at signing time.
  c.header("Content-Type", "application/json; charset=utf-8");
  return c.body(request.signed.evidenceJson);
});
