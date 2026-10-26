import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { SigningError, ValidationError } from "../../src/domain/model";
import { listEvents } from "../../src/domain/repository";
import {
  createSigningRequest,
  findByToken,
  recordView,
  revokeSigningRequest,
  signWithToken,
} from "../../src/domain/service";
import { makePdf, SIGNER, testDeps, tokenFromUrl } from "../helpers/fixtures";

const CLIENT = { ip: "198.51.100.23", userAgent: "ExampleBrowser/1.0" };

async function setup(fields: Record<string, string> = {}) {
  const deps = testDeps();
  const created = await createSigningRequest(deps, {
    pdf: await makePdf(),
    fields: { title: "Service agreement", ...SIGNER, ...fields },
  });
  const token = tokenFromUrl(created.signingUrl);
  const form = {
    name: "Jane Doe",
    consent: "yes",
    document_sha256: created.request.documentSha256,
  };
  return { deps, created, token, form, id: created.request.id };
}

async function reasonOf(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  if (!(error instanceof SigningError))
    throw new Error(`expected SigningError, got ${String(error)}`);
  return error.reason;
}

describe("creating requests", () => {
  it("stores only the token hash", async () => {
    const { token, id } = await setup();
    const row = await env.DB.prepare("SELECT * FROM signing_requests WHERE id = ?")
      .bind(id)
      .first();
    expect(JSON.stringify(row)).not.toContain(token);
  });

  it("emails the signing link to the signer", async () => {
    const { deps, token } = await setup({ message: "Please review section 4." });
    expect(deps.mailer.sent).toHaveLength(1);
    expect(deps.mailer.sent[0]).toMatchObject({
      to: "signer@example.com",
      subject: "Please sign: Service agreement",
    });
    expect(deps.mailer.sent[0]?.text).toContain(`https://sign.example.com/s/${token}`);
    expect(deps.mailer.sent[0]?.text).toContain("Please review section 4.");
  });

  it("still creates the request when the invitation cannot be sent", async () => {
    const deps = testDeps();
    deps.mailer.failWith = new Error("provider down");
    const created = await createSigningRequest(deps, {
      pdf: await makePdf(),
      fields: { title: "T", ...SIGNER },
    });
    expect(created.invitation).toBe("failed");
    const events = await listEvents(env.DB, created.request.id);
    expect(events.map((e) => e.type)).toEqual(["created", "invitation_failed"]);
  });
});

describe("state machine", () => {
  it("signs an open request exactly once", async () => {
    const { deps, token, form } = await setup();
    const signed = await signWithToken(deps, token, form, CLIENT);
    expect(signed.status).toBe("signed");
    expect(await reasonOf(signWithToken(deps, token, form, CLIENT))).toBe("already_signed");
  });

  it("allows only one of two concurrent signatures to win", async () => {
    const { deps, token, form, id } = await setup();
    const results = await Promise.allSettled([
      signWithToken(deps, token, form, CLIENT),
      signWithToken(deps, token, form, CLIENT),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected");
    expect((rejected as PromiseRejectedResult).reason).toBeInstanceOf(SigningError);

    const signedEvents = (await listEvents(env.DB, id)).filter((e) => e.type === "signed");
    expect(signedEvents).toHaveLength(1);
    // The loser's PDF upload is cleaned up; only the winner's remains.
    const objects = await env.DOCUMENTS.list({ prefix: `signed/${id}/` });
    expect(objects.objects).toHaveLength(1);
  });

  it("refuses to sign after expiry", async () => {
    const { deps, token, form } = await setup({ expires_in_days: "3" });
    deps.clock.advanceDays(3);
    expect(await reasonOf(signWithToken(deps, token, form, CLIENT))).toBe("expired");
  });

  it("does not record views after expiry", async () => {
    const { deps, token } = await setup({ expires_in_days: "1" });
    deps.clock.advanceDays(2);
    const request = await findByToken(deps, token);
    expect((await recordView(deps, request!)).status).toBe("open");
  });

  it("refuses to sign a revoked request", async () => {
    const { deps, token, form, id } = await setup();
    await revokeSigningRequest(deps, id);
    expect(await reasonOf(signWithToken(deps, token, form, CLIENT))).toBe("revoked");
  });

  it("does not revoke a signed request", async () => {
    const { deps, token, form, id } = await setup();
    await signWithToken(deps, token, form, CLIENT);
    await expect(revokeSigningRequest(deps, id)).rejects.toMatchObject({ status: "signed" });
  });

  it("validates the form before doing any work", async () => {
    const { deps, token, form } = await setup();
    const error = await signWithToken(deps, token, { ...form, consent: "no" }, CLIENT).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).fields).toHaveProperty("consent");
  });
});

describe("tamper detection", () => {
  it("refuses when the stored PDF no longer matches the hash fixed at send time", async () => {
    const { deps, token, form, id, created } = await setup();
    const tampered = await makePdf(2);
    await env.DOCUMENTS.put(created.request.documentKey, tampered);

    expect(await reasonOf(signWithToken(deps, token, form, CLIENT))).toBe("document_changed");
    const events = await listEvents(env.DB, id);
    expect(events.at(-1)).toMatchObject({
      type: "tamper_detected",
      detail: { object: "modified" },
    });
    expect((await findByToken(deps, token))?.status).toBe("open");
  });

  it("refuses when the stored PDF is missing", async () => {
    const { deps, token, form, created } = await setup();
    await env.DOCUMENTS.delete(created.request.documentKey);
    expect(await reasonOf(signWithToken(deps, token, form, CLIENT))).toBe("document_changed");
  });

  it("refuses when the form was rendered for a different document hash", async () => {
    const { deps, token, form } = await setup();
    const stale = { ...form, document_sha256: "f".repeat(64) };
    expect(await reasonOf(signWithToken(deps, token, stale, CLIENT))).toBe("document_changed");
  });
});

describe("evidence", () => {
  it("stores a keyed IP hash, never the address", async () => {
    const { deps, token, form, id } = await setup();
    await signWithToken(deps, token, form, CLIENT);
    const row = await env.DB.prepare("SELECT * FROM signing_requests WHERE id = ?")
      .bind(id)
      .first();
    expect(JSON.stringify(row)).not.toContain(CLIENT.ip);
    expect(row?.signed_ip_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("sends the signed PDF to the signer and the owner", async () => {
    const { deps, token, form, id } = await setup();
    await signWithToken(deps, token, form, CLIENT);
    const [, toSigner, toOwner] = deps.mailer.sent;
    expect(toSigner).toMatchObject({
      to: "signer@example.com",
      subject: "Signed: Service agreement",
    });
    expect(toSigner?.text).toContain(`/s/${token}/download`);
    expect(toOwner).toMatchObject({ to: "owner@example.com" });
    expect(toOwner?.text).not.toContain(token);
    for (const message of [toSigner, toOwner]) {
      expect(message?.attachments?.[0]).toMatchObject({
        filename: "service-agreement-signed.pdf",
        contentType: "application/pdf",
      });
    }
    const types = (await listEvents(env.DB, id)).map((e) => e.type);
    expect(types).toEqual([
      "created",
      "invitation_sent",
      "signed",
      "completion_sent",
      "completion_sent",
    ]);
  });
});

describe("database guarantees", () => {
  it("makes signed requests immutable", async () => {
    const { deps, token, form, id } = await setup();
    await signWithToken(deps, token, form, CLIENT);
    await expect(
      env.DB.prepare("UPDATE signing_requests SET signed_name = 'Someone Else' WHERE id = ?")
        .bind(id)
        .run(),
    ).rejects.toThrow(/immutable/);
    await expect(
      env.DB.prepare("DELETE FROM signing_requests WHERE id = ?").bind(id).run(),
    ).rejects.toThrow(/cannot be deleted/);
  });

  it("fixes the document hash at creation", async () => {
    const { id } = await setup();
    await expect(
      env.DB.prepare("UPDATE signing_requests SET document_sha256 = ? WHERE id = ?")
        .bind("0".repeat(64), id)
        .run(),
    ).rejects.toThrow(/fixed at creation/);
  });

  it("allows only forward status transitions", async () => {
    const { deps, token, id } = await setup();
    await recordView(deps, (await findByToken(deps, token))!);
    await expect(
      env.DB.prepare("UPDATE signing_requests SET status = 'open' WHERE id = ?").bind(id).run(),
    ).rejects.toThrow(/invalid status transition/);
  });

  it("keeps the event log append-only", async () => {
    const { id } = await setup();
    await expect(
      env.DB.prepare("DELETE FROM events WHERE request_id = ?").bind(id).run(),
    ).rejects.toThrow(/append-only/);
    await expect(
      env.DB.prepare("UPDATE events SET at = 'x' WHERE request_id = ?").bind(id).run(),
    ).rejects.toThrow(/append-only/);
  });
});
