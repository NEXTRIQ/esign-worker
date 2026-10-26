import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { auditTrail, consentText, evidenceRows, type Evidence } from "../../src/domain/evidence";
import { parseSignatureSvg } from "../../src/domain/signature-svg";
import { buildSignedPdf, inspectPdf, PdfError } from "../../src/pdf/signed-pdf";
import { toWinAnsi } from "../../src/pdf/text";
import { makePdf, pageText } from "../helpers/fixtures";

const DOC_HASH = "a".repeat(64);
const IP_HASH = "b".repeat(64);

function evidence(overrides: Partial<Evidence> = {}): Evidence {
  return {
    version: 1,
    request_id: "00000000-0000-4000-8000-000000000001",
    issuer: "Acme B.V.",
    document: { title: "Service agreement", sha256: DOC_HASH, size: 1234, pages: 2 },
    signer: { requested_name: "Jane Doe", email: "signer@example.com", typed_name: "Jane Doe" },
    signature: { method: "typed_name", drawing_sha256: null },
    signed_at: "2026-03-02T09:30:00.000Z",
    ip_hash: IP_HASH,
    user_agent: "Mozilla/5.0 (X11; Linux x86_64) ExampleBrowser/1.0",
    consent_text: consentText("Service agreement", DOC_HASH),
    events: [
      { type: "created", at: "2026-03-02T09:00:00.000Z" },
      { type: "invitation_sent", at: "2026-03-02T09:00:01.000Z" },
      { type: "viewed", at: "2026-03-02T09:20:00.000Z" },
      { type: "signed", at: "2026-03-02T09:30:00.000Z" },
    ],
    ...overrides,
  };
}

describe("inspectPdf", () => {
  it("accepts a PDF and counts its pages", async () => {
    expect(await inspectPdf(await makePdf(3))).toEqual({ pages: 3 });
  });

  it("rejects files that are not PDFs", async () => {
    await expect(inspectPdf(new TextEncoder().encode("hello world"))).rejects.toThrow(PdfError);
    await expect(inspectPdf(new TextEncoder().encode("%PDF-1.7 garbage"))).rejects.toThrow(
      /could not be parsed/,
    );
  });
});

describe("evidence rows", () => {
  it("lists every fact needed to verify the signature", () => {
    const rows = Object.fromEntries(evidenceRows(evidence()).map((r) => [r.label, r.value]));
    expect(rows).toMatchObject({
      "Document SHA-256": DOC_HASH,
      Signer: "Jane Doe <signer@example.com>",
      "Name typed by signer": "Jane Doe",
      "Signed at (UTC)": "2026-03-02T09:30:00.000Z",
      "IP address (HMAC)": IP_HASH,
      "User agent": "Mozilla/5.0 (X11; Linux x86_64) ExampleBrowser/1.0",
    });
    expect(rows.Consent).toContain(DOC_HASH);
    expect(rows["Drawing SHA-256"]).toBeUndefined();
  });

  it("includes the drawing hash when a signature was drawn", () => {
    const rows = evidenceRows(
      evidence({ signature: { method: "typed_name_and_drawing", drawing_sha256: "c".repeat(64) } }),
    );
    expect(rows.find((r) => r.label === "Drawing SHA-256")?.value).toBe("c".repeat(64));
    expect(rows.find((r) => r.label === "Method")?.value).toContain("signature drawn");
  });

  it("builds the audit trail without duplicating the signature event", () => {
    const trail = auditTrail(
      [
        { type: "created", at: "t1", detail: null },
        { type: "signed", at: "t2", detail: null },
      ],
      "t3",
    );
    expect(trail).toEqual([
      { type: "created", at: "t1" },
      { type: "signed", at: "t3" },
    ]);
  });
});

describe("buildSignedPdf", () => {
  it("appends an evidence page and stamps every original page", async () => {
    const original = await makePdf(2);
    const signed = await buildSignedPdf({ original, evidence: evidence(), drawing: null });
    // updateMetadata: false, or pdf-lib overwrites the producer while loading.
    const doc = await PDFDocument.load(signed, { updateMetadata: false });

    expect(doc.getPageCount()).toBe(3);
    expect(doc.getProducer()).toBe("esign-worker");

    for (const page of doc.getPages().slice(0, 2)) {
      const text = pageText(page);
      expect(text).toContain("Signed electronically by Jane Doe on 2026-03-02T09:30:00.000Z");
      expect(text).toContain("Evidence on page 3");
    }

    const evidencePage = pageText(doc.getPage(2));
    expect(evidencePage).toContain("Signature evidence");
    expect(evidencePage).toContain("not a");
    expect(evidencePage).toContain(DOC_HASH);
    expect(evidencePage).toContain(IP_HASH);
    expect(evidencePage).toContain("Jane Doe <signer@example.com>");
    expect(evidencePage).toContain("2026-03-02T09:30:00.000Z");
    expect(evidencePage).toContain("ExampleBrowser/1.0");
    expect(evidencePage).toContain("invitation sent");
  });

  it("leaves the original pages' content in place", async () => {
    const original = await makePdf(1);
    const signed = await PDFDocument.load(
      await buildSignedPdf({ original, evidence: evidence(), drawing: null }),
    );
    expect(pageText(signed.getPage(0))).toContain(
      "Sample service agreement between Acme B.V. and Jane Doe",
    );
  });

  it("draws a sanitised signature drawing", async () => {
    const drawing = parseSignatureSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 200"><path d="M10 100 L200 50 L400 150"/></svg>',
    );
    const withDrawing = await buildSignedPdf({
      original: await makePdf(1),
      evidence: evidence({
        signature: { method: "typed_name_and_drawing", drawing_sha256: "c".repeat(64) },
      }),
      drawing,
    });
    const doc = await PDFDocument.load(withDrawing);
    expect(doc.getPageCount()).toBe(2);
    expect(pageText(doc.getPage(1))).toContain("c".repeat(64));
  });

  it("continues on another page when the evidence does not fit", async () => {
    const events = Array.from({ length: 80 }, (_, i) => ({
      type: "viewed",
      at: `2026-03-02T09:${String(i % 60).padStart(2, "0")}:00.000Z`,
    }));
    const doc = await PDFDocument.load(
      await buildSignedPdf({
        original: await makePdf(1),
        evidence: evidence({ events }),
        drawing: null,
      }),
    );
    expect(doc.getPageCount()).toBeGreaterThan(2);
    expect(pageText(doc.getPage(doc.getPageCount() - 1))).toContain("To verify");
  });

  it("renders names outside the standard font's character set", async () => {
    const signed = await buildSignedPdf({
      original: await makePdf(1),
      evidence: evidence({
        signer: {
          requested_name: "Zoë Łukasz",
          email: "signer@example.com",
          typed_name: "Zoë Łukasz 王",
        },
      }),
      drawing: null,
    });
    const text = pageText((await PDFDocument.load(signed)).getPage(1));
    expect(text).toContain("Zoë ?ukasz ?");
  });
});

describe("toWinAnsi", () => {
  it("keeps Latin-1, folds diacritics and replaces the rest", () => {
    expect(toWinAnsi("Café Müller")).toBe("Café Müller");
    expect(toWinAnsi("Łódź")).toBe("?ódz");
    expect(toWinAnsi("Ša – “x”")).toBe("Ša – “x”");
    expect(toWinAnsi("名前\tline\nbreak")).toBe("?? line break");
  });
});
