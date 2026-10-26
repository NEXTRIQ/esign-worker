import { html } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import type { SigningRequest } from "../domain/model";
import { consentText } from "../domain/evidence";

type Html = HtmlEscapedString | Promise<HtmlEscapedString>;

/** All interpolations in `html` templates are HTML-escaped unless they are templates themselves. */
function layout(title: string, orgName: string, body: Html, withScript = false): Html {
  return html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="color-scheme" content="light dark" />
        <meta name="robots" content="noindex, nofollow" />
        <title>${title} - ${orgName}</title>
        <link rel="stylesheet" href="/assets/sign.css" />
      </head>
      <body>
        <main class="container">
          <p class="issuer">${orgName}</p>
          ${body}
        </main>
        ${withScript ? html`<script src="/assets/sign.js" defer></script>` : ""}
      </body>
    </html>`;
}

function formatUtc(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

export interface SignPageInput {
  orgName: string;
  request: SigningRequest;
  token: string;
  csrf: string;
  values?: { name?: string };
  errors?: Record<string, string>;
}

const FIELD_LABELS: Record<string, string> = {
  name: "Full name",
  consent: "Consent",
  signature_svg: "Drawn signature",
  document_sha256: "Document",
};

export function signPage(input: SignPageInput): Html {
  const { request, token, errors = {} } = input;
  const base = `/s/${token}`;
  const errorList = Object.entries(errors);
  const nameError = errors.name;
  const body = html`
    <h1>Review and sign: ${request.title}</h1>
    <p>
      ${input.orgName} has asked you, ${request.signerName}, to sign this document. The link is
      valid until ${formatUtc(request.expiresAt)}.
    </p>
    ${request.message ? html`<blockquote>${request.message}</blockquote>` : ""}

    <section class="card" aria-labelledby="document-heading">
      <h2 id="document-heading">Document</h2>
      <iframe
        class="pdf-frame"
        src="${base}/document"
        title="Document to sign: ${request.title}"
      ></iframe>
      <p class="small">
        <a href="${base}/document" target="_blank" rel="noopener">Open the document in a new tab</a>
        (${request.documentPages} ${request.documentPages === 1 ? "page" : "pages"})
      </p>
      <p class="small muted">
        SHA-256 fingerprint: <span class="hash">${request.documentSha256}</span>
      </p>
    </section>

    <section class="card" aria-labelledby="sign-heading">
      <h2 id="sign-heading">Sign</h2>
      ${errorList.length
        ? html`<div class="errors" role="alert" tabindex="-1">
            <strong>Please check the following:</strong>
            <ul>
              ${errorList.map(
                ([field, message]) => html`<li>${FIELD_LABELS[field] ?? field}: ${message}</li>`,
              )}
            </ul>
          </div>`
        : ""}
      <form method="post" action="${base}" novalidate>
        <input type="hidden" name="csrf" value="${input.csrf}" />
        <input type="hidden" name="document_sha256" value="${request.documentSha256}" />

        <div class="field">
          <label for="name">Full name</label>
          <p class="hint" id="name-hint">Type your name as your signature.</p>
          <input
            type="text"
            id="name"
            name="name"
            autocomplete="name"
            required
            maxlength="120"
            value="${input.values?.name ?? ""}"
            aria-describedby="name-hint${nameError ? " name-error" : ""}"
            ${nameError ? html`aria-invalid="true"` : ""}
          />
          ${nameError ? html`<p class="field-error" id="name-error">${nameError}</p>` : ""}
        </div>

        <div class="field pad" data-signature-pad hidden>
          <label for="signature-canvas">Draw your signature (optional)</label>
          <p class="hint" id="pad-hint">
            Use your mouse, finger or stylus. Your typed name is required either way.
          </p>
          <canvas
            id="signature-canvas"
            width="600"
            height="200"
            role="img"
            aria-label="Signature drawing area"
            aria-describedby="pad-hint"
          ></canvas>
          <div class="pad-actions">
            <button type="button" class="secondary" data-clear disabled>Clear drawing</button>
          </div>
          <input type="hidden" name="signature_svg" value="" />
        </div>

        <div class="field consent">
          <input type="checkbox" id="consent" name="consent" value="yes" required />
          <label for="consent">${consentText(request.title, request.documentSha256)}</label>
        </div>

        <button type="submit" class="primary">Sign document</button>
        <p class="small muted notice">
          When you sign, your typed name, the time, your email address, a keyed hash of your IP
          address and your browser's user agent are recorded and added to the signed PDF as
          evidence.
        </p>
      </form>
    </section>
  `;
  return layout(`Sign ${request.title}`, input.orgName, body, true);
}

export function signedPage(input: {
  orgName: string;
  request: SigningRequest;
  token: string;
  canDownload: boolean;
}): Html {
  const { request } = input;
  const body = html`
    <h1>Signed: ${request.title}</h1>
    <div class="card" role="status">
      <p>
        This document was signed by ${request.signed?.signedName ?? request.signerName} on
        ${request.signed ? formatUtc(request.signed.signedAt) : ""}. A copy has been sent to
        ${request.signerEmail}.
      </p>
      ${input.canDownload
        ? html`<p>
            <a class="button primary" href="/s/${input.token}/download">Download signed PDF</a>
          </p>`
        : html`<p class="muted">The download period for this link has ended.</p>`}
    </div>
  `;
  return layout("Document signed", input.orgName, body);
}

export type StatusKind =
  | "not_found"
  | "expired"
  | "revoked"
  | "document_changed"
  | "forbidden"
  | "form_expired"
  | "error";

const STATUS_TEXT: Record<StatusKind, { title: string; text: string }> = {
  not_found: {
    title: "Link not found",
    text: "This signing link is invalid or no longer available. Check that you copied the complete link from the email.",
  },
  expired: {
    title: "Link expired",
    text: "This signing link has expired. Ask the sender for a new one.",
  },
  revoked: {
    title: "Request withdrawn",
    text: "The sender has withdrawn this signing request. No signature is needed.",
  },
  document_changed: {
    // Deliberately unspecific: the signer only needs to know what to do next.
    title: "Document unavailable",
    text: "This document can no longer be signed through this link because it does not match the version that was sent. Ask the sender for a new link.",
  },
  forbidden: {
    title: "Request blocked",
    text: "This request was blocked because it did not come from the signing page. Open your link and try again.",
  },
  form_expired: {
    title: "Page expired",
    text: "The signing page was open for too long. Go back, reload the page and sign again.",
  },
  error: {
    title: "Something went wrong",
    text: "The request could not be completed. Please try again later.",
  },
};

export function statusPage(orgName: string, kind: StatusKind): Html {
  const { title, text } = STATUS_TEXT[kind];
  return layout(
    title,
    orgName,
    html`<h1>${title}</h1>
      <div class="card"><p>${text}</p></div>`,
  );
}
