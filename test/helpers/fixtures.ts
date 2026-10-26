import { env, SELF } from "cloudflare:test";
import {
  decodePDFRawStream,
  PDFArray,
  PDFDocument,
  PDFRawStream,
  StandardFonts,
  type PDFPage,
} from "pdf-lib";
import { loadConfig } from "../../src/config";
import type { Deps } from "../../src/domain/service";
import type { EmailMessage, Mailer } from "../../src/email/mailer";

export const BASE_URL = "https://sign.example.com";

export function adminHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${env.ADMIN_TOKEN}` };
}

/** A small, obviously fictional PDF. */
export async function makePdf(pages = 1): Promise<Uint8Array<ArrayBuffer>> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) {
    const page = doc.addPage([595.28, 841.89]);
    page.drawText(`Sample service agreement between Acme B.V. and Jane Doe, page ${i + 1}`, {
      x: 56,
      y: 780,
      size: 11,
      font,
    });
  }
  return new Uint8Array(await doc.save());
}

export class RecordingMailer implements Mailer {
  readonly sent: EmailMessage[] = [];
  failWith: Error | null = null;

  send(message: EmailMessage): Promise<void> {
    if (this.failWith) return Promise.reject(this.failWith);
    this.sent.push(message);
    return Promise.resolve();
  }
}

export class Clock {
  constructor(private current: Date = new Date("2026-03-02T09:00:00.000Z")) {}
  now = (): Date => new Date(this.current);
  advanceDays(days: number): void {
    this.current = new Date(this.current.getTime() + days * 24 * 60 * 60 * 1000);
  }
}

export function testDeps(
  overrides: Partial<Deps> = {},
): Deps & { mailer: RecordingMailer; clock: Clock } {
  const clock = new Clock();
  const mailer = new RecordingMailer();
  return {
    db: env.DB,
    bucket: env.DOCUMENTS,
    config: loadConfig(env),
    now: clock.now,
    ...overrides,
    mailer,
    clock,
  };
}

export const SIGNER = { signer_name: "Jane Doe", signer_email: "signer@example.com" };

export function tokenFromUrl(url: string): string {
  const token = /\/s\/([A-Za-z0-9_-]{43})$/.exec(url)?.[1];
  if (!token) throw new Error(`no token in ${url}`);
  return token;
}

export async function createViaApi(
  fields: Record<string, string> = {},
  pdf?: Uint8Array<ArrayBuffer>,
): Promise<{ id: string; token: string; body: Record<string, unknown> }> {
  const form = new FormData();
  form.set(
    "file",
    new File([pdf ?? (await makePdf())], "agreement.pdf", { type: "application/pdf" }),
  );
  for (const [key, value] of Object.entries({ title: "Service agreement", ...SIGNER, ...fields })) {
    form.set(key, value);
  }
  const response = await SELF.fetch(`${BASE_URL}/api/requests`, {
    method: "POST",
    headers: adminHeaders(),
    body: form,
  });
  if (response.status !== 201)
    throw new Error(`create failed: ${response.status} ${await response.text()}`);
  const body: Record<string, unknown> = await response.json();
  return { id: String(body.id), token: tokenFromUrl(String(body.signing_url)), body };
}

/** Extracts the CSRF token and document hash the signing page embeds in its form. */
export function formValues(html: string): { csrf: string; documentSha256: string } {
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1];
  const documentSha256 = /name="document_sha256" value="([0-9a-f]{64})"/.exec(html)?.[1];
  if (!csrf || !documentSha256) throw new Error("signing form not found");
  return { csrf, documentSha256 };
}

/**
 * Text drawn with pdf-lib's standard fonts is written as hex strings in the
 * content streams; decoding those is enough to assert what a page says.
 */
export function pageText(page: PDFPage): string {
  const contents = page.node.Contents();
  const streams =
    contents instanceof PDFArray
      ? contents.asArray().map((ref) => page.doc.context.lookup(ref))
      : [contents];
  let text = "";
  for (const stream of streams) {
    if (!(stream instanceof PDFRawStream)) continue;
    const raw = new TextDecoder("latin1").decode(decodePDFRawStream(stream).decode());
    for (const [, hex = ""] of raw.matchAll(/<([0-9A-Fa-f]*)>\s*Tj/g)) {
      text += hex.replace(/../g, (pair) => String.fromCharCode(parseInt(pair, 16))) + "\n";
    }
  }
  return text;
}
