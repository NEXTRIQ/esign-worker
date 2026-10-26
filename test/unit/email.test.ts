import { afterEach, describe, expect, it, vi } from "vitest";
import { EmailDeliveryError, HttpMailer, LogMailer } from "../../src/email/mailer";
import { invitationEmail } from "../../src/email/templates";
import { redactTokens } from "../../src/lib/redact";

const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcd";

describe("HttpMailer", () => {
  it("posts a Resend-compatible payload with base64 attachments", async () => {
    const fetchStub = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}", { status: 200 }));
    const mailer = new HttpMailer({
      apiUrl: "https://email.example.com/emails",
      apiKey: "test-key",
      from: "Acme B.V. <signing@example.com>",
      fetch: fetchStub,
    });

    await mailer.send({
      to: "signer@example.com",
      subject: "Signed: Service agreement",
      text: "Body",
      attachments: [
        {
          filename: "a.pdf",
          contentType: "application/pdf",
          content: new Uint8Array([37, 80, 68, 70]),
        },
      ],
    });

    const [url, init] = fetchStub.mock.calls[0] ?? [];
    expect(url).toBe("https://email.example.com/emails");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer test-key");
    expect(JSON.parse(init?.body as string)).toEqual({
      from: "Acme B.V. <signing@example.com>",
      to: ["signer@example.com"],
      subject: "Signed: Service agreement",
      text: "Body",
      attachments: [{ filename: "a.pdf", content: "JVBERg==", content_type: "application/pdf" }],
    });
  });

  it("throws on a non-2xx response without exposing the body", async () => {
    const mailer = new HttpMailer({
      apiUrl: "https://email.example.com/emails",
      apiKey: "test-key",
      from: "signing@example.com",
      fetch: () => Promise.resolve(new Response("rejected: signer@example.com", { status: 422 })),
    });
    const error = await mailer
      .send({ to: "signer@example.com", subject: "s", text: "t" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EmailDeliveryError);
    expect(String(error)).not.toContain("signer@example.com");
  });
});

describe("LogMailer", () => {
  afterEach(() => vi.restoreAllMocks());

  it("never logs signing tokens", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const message = invitationEmail({
      orgName: "Acme B.V.",
      signerName: "Jane Doe",
      signerEmail: "signer@example.com",
      title: "Service agreement",
      message: null,
      signingUrl: `https://sign.example.com/s/${TOKEN}`,
      expiresAt: "2026-03-16T09:00:00.000Z",
    });
    expect(message.text).toContain(TOKEN);

    await new LogMailer().send(message);
    const logged = log.mock.calls.flat().join(" ");
    expect(logged).not.toContain(TOKEN);
    expect(logged).toContain("/s/[redacted]");
  });
});

describe("redactTokens", () => {
  it("redacts every signing path", () => {
    expect(redactTokens(`/s/${TOKEN}/download and /s/${TOKEN}`)).toBe(
      "/s/[redacted]/download and /s/[redacted]",
    );
  });
});
