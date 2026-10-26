import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { adminHeaders, BASE_URL, createViaApi, makePdf, SIGNER } from "../helpers/fixtures";

const api = (path: string, init?: RequestInit) => SELF.fetch(`${BASE_URL}/api${path}`, init);

describe("admin authentication", () => {
  it("rejects requests without a bearer token", async () => {
    const response = await api("/requests");
    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toContain("Bearer");
  });

  it("rejects a wrong token", async () => {
    const response = await api("/requests", {
      headers: { Authorization: "Bearer not-the-admin-token" },
    });
    expect(response.status).toBe(401);
  });

  it("rejects other schemes", async () => {
    const response = await api("/requests", {
      headers: { Authorization: "Basic YWRtaW46YWRtaW4=" },
    });
    expect(response.status).toBe(401);
  });

  it("accepts the configured token", async () => {
    expect((await api("/requests", { headers: adminHeaders() })).status).toBe(200);
  });
});

describe("POST /api/requests", () => {
  it("creates a request and returns the signing link once", async () => {
    const { body } = await createViaApi({ title: "Service agreement", expires_in_days: "7" });
    expect(body).toMatchObject({
      title: "Service agreement",
      status: "open",
      signer: { name: "Jane Doe", email: "signer@example.com" },
      document: { pages: 1 },
      invitation: "sent",
      signed: null,
    });
    expect(body.signing_url).toMatch(/^https:\/\/sign\.example\.com\/s\/[A-Za-z0-9_-]{43}$/);
    const created = Date.parse(String(body.created_at));
    expect(Date.parse(String(body.expires_at)) - created).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("never returns the signing link again", async () => {
    const { id, token } = await createViaApi();
    const detail = await (await api(`/requests/${id}`, { headers: adminHeaders() })).text();
    expect(detail).not.toContain(token);
  });

  it("rejects files that are not PDFs", async () => {
    const form = new FormData();
    form.set("file", new File(["hello"], "a.pdf", { type: "application/pdf" }));
    form.set("title", "Not a PDF");
    form.set("signer_name", SIGNER.signer_name);
    form.set("signer_email", SIGNER.signer_email);
    const response = await api("/requests", {
      method: "POST",
      headers: adminHeaders(),
      body: form,
    });
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: "validation_failed",
      fields: { file: "file is not a PDF" },
    });
  });

  it("validates fields", async () => {
    const form = new FormData();
    form.set("file", new File([await makePdf()], "a.pdf"));
    form.set("title", "Bad\r\nSubject: injected");
    form.set("signer_name", "");
    form.set("signer_email", "not-an-email");
    form.set("expires_in_days", "365");
    const response = await api("/requests", {
      method: "POST",
      headers: adminHeaders(),
      body: form,
    });
    expect(response.status).toBe(422);
    const { fields } = await response.json<{ fields: Record<string, string> }>();
    expect(Object.keys(fields).sort()).toEqual(["signer_email", "signer_name", "title"]);
  });

  it("enforces the maximum expiry", async () => {
    const form = new FormData();
    form.set("file", new File([await makePdf()], "a.pdf"));
    for (const [k, v] of Object.entries({ title: "T", ...SIGNER, expires_in_days: "61" }))
      form.set(k, v);
    const response = await api("/requests", {
      method: "POST",
      headers: adminHeaders(),
      body: form,
    });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      fields: { expires_in_days: "must be at most 60" },
    });
  });

  it("requires multipart/form-data", async () => {
    const response = await api("/requests", {
      method: "POST",
      headers: { ...adminHeaders(), "Content-Type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(415);
  });
});

describe("listing, details and revocation", () => {
  it("lists newest first with cursor pagination and status filter", async () => {
    const a = await createViaApi({ title: "First" });
    const b = await createViaApi({ title: "Second" });
    const c = await createViaApi({ title: "Third" });
    await api(`/requests/${b.id}/revoke`, { method: "POST", headers: adminHeaders() });

    const page1 = await (
      await api("/requests?limit=2", { headers: adminHeaders() })
    ).json<{
      data: { id: string }[];
      next_cursor: string | null;
    }>();
    expect(page1.data.map((r) => r.id)).toEqual([c.id, b.id]);
    expect(page1.next_cursor).not.toBeNull();

    const page2 = await (
      await api(`/requests?limit=2&cursor=${page1.next_cursor}`, { headers: adminHeaders() })
    ).json<{ data: { id: string }[]; next_cursor: string | null }>();
    expect(page2.data.map((r) => r.id)).toEqual([a.id]);
    expect(page2.next_cursor).toBeNull();

    const revoked = await (
      await api("/requests?status=revoked", { headers: adminHeaders() })
    ).json<{
      data: { id: string; status: string }[];
    }>();
    expect(revoked.data).toEqual([expect.objectContaining({ id: b.id, status: "revoked" })]);
  });

  it("rejects invalid list parameters", async () => {
    expect((await api("/requests?limit=0", { headers: adminHeaders() })).status).toBe(422);
    expect((await api("/requests?status=deleted", { headers: adminHeaders() })).status).toBe(422);
    expect((await api("/requests?cursor=%%%", { headers: adminHeaders() })).status).toBe(422);
  });

  it("returns details with the event log", async () => {
    const { id } = await createViaApi();
    const detail = await (
      await api(`/requests/${id}`, { headers: adminHeaders() })
    ).json<{
      events: { type: string }[];
    }>();
    expect(detail.events.map((e) => e.type)).toEqual(["created", "invitation_sent"]);
  });

  it("returns 404 for unknown or malformed ids", async () => {
    expect(
      (await api("/requests/00000000-0000-4000-8000-000000000000", { headers: adminHeaders() }))
        .status,
    ).toBe(404);
    expect((await api("/requests/not-a-uuid", { headers: adminHeaders() })).status).toBe(404);
  });

  it("revokes once", async () => {
    const { id, token } = await createViaApi();
    const first = await api(`/requests/${id}/revoke`, { method: "POST", headers: adminHeaders() });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ status: "revoked" });

    const second = await api(`/requests/${id}/revoke`, { method: "POST", headers: adminHeaders() });
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ error: "conflict", status: "revoked" });

    const page = await SELF.fetch(`${BASE_URL}/s/${token}`);
    expect(page.status).toBe(410);
    expect(await page.text()).toContain("Request withdrawn");
  });

  it("refuses signed artefacts before signing", async () => {
    const { id } = await createViaApi();
    expect((await api(`/requests/${id}/signed.pdf`, { headers: adminHeaders() })).status).toBe(409);
    expect((await api(`/requests/${id}/evidence.json`, { headers: adminHeaders() })).status).toBe(
      409,
    );
  });
});
