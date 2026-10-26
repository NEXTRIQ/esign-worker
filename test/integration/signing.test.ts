import { env, SELF } from "cloudflare:test";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/lib/crypto";
import { adminHeaders, BASE_URL, createViaApi, formValues, pageText } from "../helpers/fixtures";

const signingPage = (token: string, path = "") => SELF.fetch(`${BASE_URL}/s/${token}${path}`);

function submit(
  token: string,
  fields: Record<string, string>,
  headers: Record<string, string> = {},
) {
  return SELF.fetch(`${BASE_URL}/s/${token}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Sec-Fetch-Site": "same-origin",
      Origin: "null",
      "CF-Connecting-IP": "203.0.113.7",
      "User-Agent": "ExampleBrowser/1.0",
      ...headers,
    },
    body: new URLSearchParams(fields),
    redirect: "manual",
  });
}

async function openForm(token: string) {
  const response = await signingPage(token);
  expect(response.status).toBe(200);
  return formValues(await response.text());
}

describe("signing page", () => {
  it("renders the form with strict security headers", async () => {
    const { token } = await createViaApi({
      title: "Service agreement",
      message: "Please sign by Friday.",
    });
    const response = await signingPage(token);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/html");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
    const csp = response.headers.get("Content-Security-Policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("unsafe-inline");

    expect(html).toContain("Review and sign: Service agreement");
    expect(html).toContain("Please sign by Friday.");
    expect(html).toContain('name="consent"');
    expect(html).toMatch(/<form method="post" action="\/s\/[A-Za-z0-9_-]{43}"/);
    // The drawing pad is progressive enhancement: hidden until the script enables it.
    expect(html).toMatch(/data-signature-pad\s+hidden/);
    expect(html).not.toMatch(/<script>|style="/);
  });

  it("escapes user-supplied content", async () => {
    const { token } = await createViaApi({ title: '<img src=x onerror="alert(1)">' });
    const html = await (await signingPage(token)).text();
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  });

  it("marks the request as viewed", async () => {
    const { id, token } = await createViaApi();
    await signingPage(token);
    const detail = await (
      await SELF.fetch(`${BASE_URL}/api/requests/${id}`, { headers: adminHeaders() })
    ).json<{
      status: string;
      viewed_at: string | null;
      events: { type: string }[];
    }>();
    expect(detail.status).toBe("viewed");
    expect(detail.viewed_at).not.toBeNull();
    expect(detail.events.map((e) => e.type)).toContain("viewed");
  });

  it("serves the document inline, framable only by itself", async () => {
    const { token, body } = await createViaApi();
    const response = await signingPage(token, "/document");
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/pdf");
    expect(response.headers.get("Content-Disposition")).toContain("inline");
    expect(response.headers.get("X-Frame-Options")).toBe("SAMEORIGIN");
    expect(response.headers.get("Content-Security-Policy")).toBe("frame-ancestors 'self'");
    expect(await sha256Hex(await response.arrayBuffer())).toBe(
      (body.document as { sha256: string }).sha256,
    );
  });

  it("returns 404 for unknown and malformed tokens", async () => {
    expect((await signingPage("A".repeat(43))).status).toBe(404);
    expect((await signingPage("short")).status).toBe(404);
    expect((await signingPage("A".repeat(43), "/document")).status).toBe(404);
  });
});

describe("signing", () => {
  it("signs, stores evidence and offers the signed PDF", async () => {
    const { id, token } = await createViaApi({ title: "Service agreement" });
    const { csrf, documentSha256 } = await openForm(token);

    const response = await submit(token, {
      csrf,
      document_sha256: documentSha256,
      name: "Jane Doe",
      consent: "yes",
    });
    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe(`/s/${token}`);

    const after = await signingPage(token);
    expect(after.status).toBe(200);
    expect(await after.text()).toContain("Download signed PDF");

    const download = await signingPage(token, "/download");
    expect(download.status).toBe(200);
    expect(download.headers.get("Content-Disposition")).toBe(
      'attachment; filename="service-agreement-signed.pdf"',
    );
    const signedBytes = new Uint8Array(await download.arrayBuffer());
    const signedDoc = await PDFDocument.load(signedBytes);
    expect(signedDoc.getPageCount()).toBe(2);
    expect(pageText(signedDoc.getPage(1))).toContain(documentSha256);

    const evidence = await (
      await SELF.fetch(`${BASE_URL}/api/requests/${id}/evidence.json`, { headers: adminHeaders() })
    ).json<Record<string, unknown>>();
    expect(evidence).toMatchObject({
      version: 1,
      request_id: id,
      document: { sha256: documentSha256 },
      signer: { typed_name: "Jane Doe", email: "signer@example.com" },
      signature: { method: "typed_name", drawing_sha256: null },
      user_agent: "ExampleBrowser/1.0",
      signed_document: { sha256: await sha256Hex(signedBytes), size: signedBytes.length },
    });
    expect(evidence.ip_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(evidence)).not.toContain("203.0.113.7");
    expect(evidence.consent_text).toContain(documentSha256);

    const adminPdf = await SELF.fetch(`${BASE_URL}/api/requests/${id}/signed.pdf`, {
      headers: adminHeaders(),
    });
    expect(new Uint8Array(await adminPdf.arrayBuffer())).toEqual(signedBytes);
  });

  it("accepts a drawn signature", async () => {
    const { id, token } = await createViaApi();
    const { csrf, documentSha256 } = await openForm(token);
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 200"><path d="M10 100 L300 40 L590 150" stroke-width="2.5"/></svg>';
    const response = await submit(token, {
      csrf,
      document_sha256: documentSha256,
      name: "Jane Doe",
      consent: "yes",
      signature_svg: svg,
    });
    expect(response.status).toBe(303);
    const evidence = await (
      await SELF.fetch(`${BASE_URL}/api/requests/${id}/evidence.json`, { headers: adminHeaders() })
    ).json<{ signature: { method: string; drawing_sha256: string } }>();
    expect(evidence.signature.method).toBe("typed_name_and_drawing");
    expect(evidence.signature.drawing_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("re-renders the form with errors for invalid input", async () => {
    const { token } = await createViaApi();
    const { csrf, documentSha256 } = await openForm(token);
    const response = await submit(token, { csrf, document_sha256: documentSha256, name: "J" });
    expect(response.status).toBe(422);
    const html = await response.text();
    expect(html).toContain("Please type your full name.");
    expect(html).toContain("Please confirm that you agree to sign.");
    expect(html).toContain('aria-invalid="true"');
  });

  it("rejects a malicious drawing without signing", async () => {
    const { token } = await createViaApi();
    const { csrf, documentSha256 } = await openForm(token);
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1" onload="alert(1)"><path d="M0 0"/></svg>';
    const response = await submit(token, {
      csrf,
      document_sha256: documentSha256,
      name: "Jane Doe",
      consent: "yes",
      signature_svg: svg,
    });
    expect(response.status).toBe(422);
    expect(await response.text()).toContain("event handler attributes are not allowed");
  });

  it("sends a second submission to the signed page", async () => {
    const { token } = await createViaApi();
    const { csrf, documentSha256 } = await openForm(token);
    const fields = { csrf, document_sha256: documentSha256, name: "Jane Doe", consent: "yes" };
    expect((await submit(token, fields)).status).toBe(303);
    const again = await submit(token, fields);
    expect(again.status).toBe(303);
    expect(again.headers.get("Location")).toBe(`/s/${token}`);
  });
});

describe("CSRF protection", () => {
  it("rejects a missing CSRF token", async () => {
    const { token } = await createViaApi();
    const { documentSha256 } = await openForm(token);
    const response = await submit(token, {
      document_sha256: documentSha256,
      name: "Jane Doe",
      consent: "yes",
    });
    expect(response.status).toBe(403);
  });

  it("rejects a CSRF token issued for another request", async () => {
    const victim = await createViaApi();
    const attacker = await createViaApi();
    const { csrf } = await openForm(attacker.token);
    const { documentSha256 } = await openForm(victim.token);
    const response = await submit(victim.token, {
      csrf,
      document_sha256: documentSha256,
      name: "Jane Doe",
      consent: "yes",
    });
    expect(response.status).toBe(403);
  });

  it("rejects cross-site submissions even with a valid token", async () => {
    const { token } = await createViaApi();
    const { csrf, documentSha256 } = await openForm(token);
    const fields = { csrf, document_sha256: documentSha256, name: "Jane Doe", consent: "yes" };
    expect((await submit(token, fields, { "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
    expect((await submit(token, fields, { Origin: "https://attacker.example" })).status).toBe(403);
  });
});

describe("tamper detection over HTTP", () => {
  it("refuses to show or sign a document whose stored bytes changed", async () => {
    const { token, body } = await createViaApi();
    const { csrf, documentSha256 } = await openForm(token);
    await env.DOCUMENTS.put(`documents/${String(body.id)}/original.pdf`, "%PDF-1.7 swapped");

    expect((await signingPage(token, "/document")).status).toBe(409);
    const response = await submit(token, {
      csrf,
      document_sha256: documentSha256,
      name: "Jane Doe",
      consent: "yes",
    });
    expect(response.status).toBe(409);
    expect(await response.text()).toContain("does not match the version that was sent");
  });
});

describe("static assets", () => {
  it("serves the stylesheet and script from the Worker", async () => {
    const css = await SELF.fetch(`${BASE_URL}/assets/sign.css`);
    expect(css.headers.get("Content-Type")).toContain("text/css");
    expect(await css.text()).toContain("prefers-color-scheme: dark");
    const js = await SELF.fetch(`${BASE_URL}/assets/sign.js`);
    expect(js.headers.get("Content-Type")).toContain("javascript");
    expect(await js.text()).toContain("data-signature-pad");
  });
});
