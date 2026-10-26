import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AppEnv } from "../app-env";
import {
  canDownloadSigned,
  effectiveStatus,
  failureForStatus,
  NotFoundError,
  SigningError,
  ValidationError,
  type SigningFailure,
  type SigningRequest,
} from "../domain/model";
import {
  findByToken,
  loadVerifiedOriginal,
  loadVerifiedSigned,
  recordView,
  signedFilename,
  signWithToken,
} from "../domain/service";
import { MAX_SIGNATURE_SVG_LENGTH } from "../domain/signature-svg";
import { isCrossSiteRequest, issueCsrfToken, verifyCsrfToken } from "../lib/csrf";
import { EMBEDDED_PDF_CSP, PAGE_CSP } from "../lib/headers";
import { STYLESHEET, SIGNATURE_SCRIPT } from "../views/assets";
import { signedPage, signPage, statusPage, type StatusKind } from "../views/pages";

export const publicRoutes = new Hono<AppEnv>();

type Ctx = Context<AppEnv>;

const FAILURE_PAGES: Record<
  Exclude<SigningFailure, "already_signed">,
  { kind: StatusKind; status: 409 | 410 }
> = {
  expired: { kind: "expired", status: 410 },
  revoked: { kind: "revoked", status: 410 },
  document_changed: { kind: "document_changed", status: 409 },
};

function page(
  c: Ctx,
  body: ReturnType<typeof statusPage>,
  status: 200 | 403 | 404 | 409 | 410 | 422 = 200,
) {
  c.header("Content-Security-Policy", PAGE_CSP);
  return c.html(body, status);
}

function showStatus(c: Ctx, kind: StatusKind, status: 403 | 404 | 409 | 410) {
  return page(c, statusPage(c.get("deps").config.orgName, kind), status);
}

/** Signed requests are handled by each route; other failures share these pages. */
function showFailure(c: Ctx, failure: Exclude<SigningFailure, "already_signed">) {
  return showStatus(c, FAILURE_PAGES[failure].kind, FAILURE_PAGES[failure].status);
}

function pdfResponse(
  c: Ctx,
  bytes: Uint8Array<ArrayBuffer>,
  filename: string,
  disposition: "inline" | "attachment",
) {
  if (disposition === "inline") {
    c.header("Content-Security-Policy", EMBEDDED_PDF_CSP);
    c.header("X-Frame-Options", "SAMEORIGIN");
  }
  c.header("Content-Type", "application/pdf");
  c.header("Content-Disposition", `${disposition}; filename="${filename}"`);
  return c.body(bytes);
}

async function renderSignPage(
  c: Ctx,
  request: SigningRequest,
  token: string,
  extra: { values?: { name?: string }; errors?: Record<string, string> } = {},
) {
  const { config, now } = c.get("deps");
  const csrf = await issueCsrfToken(config.appSecret, request.id, now());
  return page(
    c,
    signPage({ orgName: config.orgName, request, token, csrf, ...extra }),
    extra.errors ? 422 : 200,
  );
}

function renderSigned(c: Ctx, request: SigningRequest, token: string) {
  const { config, now } = c.get("deps");
  return page(
    c,
    signedPage({
      orgName: config.orgName,
      request,
      token,
      canDownload: canDownloadSigned(request, now(), config.downloadDays),
    }),
  );
}

publicRoutes.get("/assets/sign.css", (c) => {
  c.header("Cache-Control", "public, max-age=3600");
  c.header("Content-Type", "text/css; charset=utf-8");
  return c.body(STYLESHEET);
});

publicRoutes.get("/assets/sign.js", (c) => {
  c.header("Cache-Control", "public, max-age=3600");
  c.header("Content-Type", "text/javascript; charset=utf-8");
  return c.body(SIGNATURE_SCRIPT);
});

publicRoutes.get("/s/:token", async (c) => {
  const deps = c.get("deps");
  const token = c.req.param("token");
  const request = await findByToken(deps, token);
  if (!request) return showStatus(c, "not_found", 404);

  const status = effectiveStatus(request, deps.now());
  if (status === "signed") return renderSigned(c, request, token);
  const failure = failureForStatus(status);
  if (failure && failure !== "already_signed") return showFailure(c, failure);

  return renderSignPage(c, await recordView(deps, request), token);
});

publicRoutes.post(
  "/s/:token",
  // Name, hashes and a drawing: anything much larger is not a real submission.
  bodyLimit({
    maxSize: MAX_SIGNATURE_SVG_LENGTH + 16 * 1024,
    onError: (c) => c.text("Payload too large", 413),
  }),
  async (c) => {
    const deps = c.get("deps");
    const token = c.req.param("token");
    if (isCrossSiteRequest(c.req.raw.headers, new URL(deps.config.publicBaseUrl).origin)) {
      return showStatus(c, "forbidden", 403);
    }

    const request = await findByToken(deps, token);
    if (!request) return showStatus(c, "not_found", 404);

    const body = await c.req.parseBody();
    const field = (name: string) => (typeof body[name] === "string" ? body[name] : undefined);
    if (!(await verifyCsrfToken(deps.config.appSecret, request.id, field("csrf"), deps.now()))) {
      return showStatus(c, "form_expired", 403);
    }

    try {
      await signWithToken(
        deps,
        token,
        {
          name: field("name"),
          consent: field("consent"),
          document_sha256: field("document_sha256"),
          signature_svg: field("signature_svg"),
        },
        {
          ip: c.req.header("CF-Connecting-IP") ?? null,
          userAgent: c.req.header("User-Agent") ?? null,
        },
      );
    } catch (error) {
      if (error instanceof ValidationError) {
        return renderSignPage(c, request, token, {
          values: { name: field("name") ?? "" },
          errors: error.fields,
        });
      }
      if (error instanceof SigningError) {
        // A double submit lands on the signed page instead of an error.
        if (error.reason === "already_signed") return c.redirect(`/s/${token}`, 303);
        return showFailure(c, error.reason);
      }
      if (error instanceof NotFoundError) return showStatus(c, "not_found", 404);
      throw error;
    }
    // Post/redirect/get: reloading the result page must not resubmit the form.
    return c.redirect(`/s/${token}`, 303);
  },
);

publicRoutes.get("/s/:token/document", async (c) => {
  const deps = c.get("deps");
  const request = await findByToken(deps, c.req.param("token"));
  if (!request) return showStatus(c, "not_found", 404);
  // Only the unsigned original is served here; signed copies go through /download.
  const failure = failureForStatus(effectiveStatus(request, deps.now()));
  if (failure === "already_signed") return showStatus(c, "not_found", 404);
  if (failure) return showFailure(c, failure);

  const bytes = await loadVerifiedOriginal(deps, request);
  if (!bytes) return showStatus(c, "document_changed", 409);
  return pdfResponse(c, bytes, "document.pdf", "inline");
});

publicRoutes.get("/s/:token/download", async (c) => {
  const deps = c.get("deps");
  const request = await findByToken(deps, c.req.param("token"));
  if (!request || !canDownloadSigned(request, deps.now(), deps.config.downloadDays)) {
    return showStatus(c, "not_found", 404);
  }
  const bytes = await loadVerifiedSigned(deps, request);
  if (!bytes) return showStatus(c, "document_changed", 409);
  return pdfResponse(c, bytes, signedFilename(request.title), "attachment");
});
