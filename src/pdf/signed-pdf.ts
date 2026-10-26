import { LineCapStyle, PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { evidenceRows, type Evidence } from "../domain/evidence";
import type { SignatureSvg } from "../domain/signature-svg";
import { toWinAnsi, wrapText } from "./text";

const A4 = { width: 595.28, height: 841.89 };
const MARGIN = 56;
const LABEL_WIDTH = 130;
const INK = rgb(0.1, 0.1, 0.12);
const MUTED = rgb(0.38, 0.38, 0.42);
const RULE = rgb(0.82, 0.82, 0.85);
const SIGNATURE_INK = rgb(0.05, 0.1, 0.35);

export class PdfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PdfError";
  }
}

/**
 * Rejects anything the signing flow could not stamp later: non-PDFs,
 * encrypted files and files pdf-lib cannot parse. Checked at upload time so
 * that a signer never ends up with a link that fails at the last step.
 */
export async function inspectPdf(bytes: Uint8Array): Promise<{ pages: number }> {
  if (bytes.length < 5 || new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-") {
    throw new PdfError("file is not a PDF");
  }
  let pages: number;
  try {
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    // Walking the page tree also catches files whose header parses but whose structure is broken.
    pages = doc.getPageCount();
  } catch (error) {
    const encrypted = error instanceof Error && error.name === "EncryptedPDFError";
    throw new PdfError(encrypted ? "encrypted PDFs are not supported" : "PDF could not be parsed");
  }
  if (pages === 0) throw new PdfError("PDF has no pages");
  return { pages };
}

interface Fonts {
  regular: PDFFont;
  bold: PDFFont;
  mono: PDFFont;
  script: PDFFont;
}

/** Writes top-to-bottom and starts a new page when the current one is full. */
class PageWriter {
  page: PDFPage;
  y: number;

  constructor(
    private readonly doc: PDFDocument,
    private readonly fonts: Fonts,
  ) {
    this.page = this.addPage();
    this.y = A4.height - MARGIN;
  }

  private addPage(): PDFPage {
    return this.doc.addPage([A4.width, A4.height]);
  }

  ensure(height: number): void {
    if (this.y - height >= MARGIN) return;
    this.page = this.addPage();
    this.y = A4.height - MARGIN;
  }

  text(
    value: string,
    options: { font?: PDFFont; size?: number; color?: typeof INK; x?: number } = {},
  ) {
    const size = options.size ?? 10;
    this.ensure(size * 1.4);
    this.y -= size;
    this.page.drawText(toWinAnsi(value), {
      x: options.x ?? MARGIN,
      y: this.y,
      size,
      font: options.font ?? this.fonts.regular,
      color: options.color ?? INK,
    });
    this.y -= size * 0.4;
  }

  paragraph(value: string, size = 9, color = MUTED): void {
    for (const line of wrapText(value, this.fonts.regular, size, A4.width - 2 * MARGIN)) {
      this.text(line, { size, color });
    }
  }

  row(label: string, value: string, monospace = false): void {
    const size = 9;
    const font = monospace ? this.fonts.mono : this.fonts.regular;
    const lines = wrapText(value, font, size, A4.width - 2 * MARGIN - LABEL_WIDTH);
    const lineHeight = size * 1.45;
    this.ensure(lines.length * lineHeight + 6);
    let y = this.y - size;
    this.page.drawText(toWinAnsi(label), {
      x: MARGIN,
      y,
      size,
      font: this.fonts.bold,
      color: MUTED,
    });
    for (const line of lines) {
      this.page.drawText(line, { x: MARGIN + LABEL_WIDTH, y, size, font, color: INK });
      y -= lineHeight;
    }
    this.y = y + lineHeight - size * 0.45 - 6;
  }

  rule(): void {
    this.ensure(12);
    this.y -= 6;
    this.page.drawLine({
      start: { x: MARGIN, y: this.y },
      end: { x: A4.width - MARGIN, y: this.y },
      thickness: 0.5,
      color: RULE,
    });
    this.y -= 8;
  }

  space(height: number): void {
    this.y -= height;
  }
}

function drawSignatureBlock(
  w: PageWriter,
  fonts: Fonts,
  evidence: Evidence,
  drawing: SignatureSvg | null,
) {
  const boxWidth = 260;
  const boxHeight = 80;
  w.ensure(boxHeight + 40);
  const top = w.y;
  const page = w.page;

  if (drawing) {
    const { minX, minY, width, height } = drawing.viewBox;
    const scale = Math.min(boxWidth / width, boxHeight / height);
    for (const path of drawing.paths) {
      // drawSvgPath uses SVG coordinates: (x, y) is the top-left corner, y grows downwards.
      page.drawSvgPath(path.d, {
        x: MARGIN - minX * scale,
        y: top + minY * scale,
        scale,
        borderColor: SIGNATURE_INK,
        borderWidth: path.strokeWidth * scale,
        borderLineCap: LineCapStyle.Round,
      });
    }
  } else {
    const name = toWinAnsi(evidence.signer.typed_name);
    const size = Math.min(
      26,
      (26 * boxWidth) / Math.max(1, fonts.script.widthOfTextAtSize(name, 26)),
    );
    page.drawText(name, {
      x: MARGIN,
      y: top - boxHeight + 24,
      size,
      font: fonts.script,
      color: SIGNATURE_INK,
    });
  }

  w.space(boxHeight + 4);
  page.drawLine({
    start: { x: MARGIN, y: w.y },
    end: { x: MARGIN + boxWidth, y: w.y },
    thickness: 0.75,
    color: INK,
  });
  w.space(2);
  w.text(`${evidence.signer.typed_name}, ${evidence.signed_at}`, { size: 9, color: MUTED });
}

function drawFooters(pages: PDFPage[], font: PDFFont, evidence: Evidence, evidencePage: number) {
  const full = toWinAnsi(
    `Signed electronically by ${evidence.signer.typed_name} on ${evidence.signed_at}. ` +
      `Evidence on page ${evidencePage}. Request ${evidence.request_id}.`,
  );
  const size = 6.5;
  for (const page of pages) {
    // Placed in the bottom margin so it rarely overlaps content. Rotated
    // pages are not compensated for (see README, limitations).
    const box = page.getCropBox();
    let text = full;
    while (text.length > 20 && font.widthOfTextAtSize(text, size) > box.width - 36) {
      text = `${text.slice(0, -4)}...`;
    }
    page.drawText(text, { x: box.x + 18, y: box.y + 10, size, font, color: MUTED });
  }
}

/**
 * Builds the signed PDF: the original pages with a one-line footer, followed
 * by an evidence page. The SHA-256 of the result cannot be printed inside the
 * result itself; it is stored in the evidence JSON and the database.
 */
export async function buildSignedPdf(input: {
  original: Uint8Array;
  evidence: Evidence;
  drawing: SignatureSvg | null;
}): Promise<Uint8Array> {
  const { evidence } = input;
  const doc = await PDFDocument.load(input.original, { updateMetadata: false });
  const fonts: Fonts = {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    mono: await doc.embedFont(StandardFonts.Courier),
    script: await doc.embedFont(StandardFonts.TimesRomanItalic),
  };

  const originalPages = doc.getPages();
  drawFooters(originalPages, fonts.regular, evidence, originalPages.length + 1);

  const w = new PageWriter(doc, fonts);
  w.text("Signature evidence", { font: fonts.bold, size: 18 });
  w.space(4);
  w.paragraph(
    "This page was appended when the document was signed. It records how and when the " +
      "signature was given. It is a simple electronic signature with an audit trail, not a " +
      "qualified electronic signature.",
  );
  w.space(10);
  drawSignatureBlock(w, fonts, evidence, input.drawing);
  w.space(8);
  w.rule();

  for (const row of evidenceRows(evidence)) w.row(row.label, row.value, row.monospace);

  w.rule();
  w.text("Audit trail (UTC)", { font: fonts.bold, size: 11 });
  w.space(2);
  for (const event of evidence.events) w.row(event.at, event.type.replace(/_/g, " "));

  w.rule();
  w.paragraph(
    "To verify: the SHA-256 of the original document must equal the value above. The SHA-256 " +
      "of this signed file is recorded by the issuer in the evidence record for the request ID above.",
  );

  doc.setProducer("esign-worker");
  doc.setModificationDate(new Date(evidence.signed_at));
  return doc.save();
}
