import type { PDFFont } from "pdf-lib";

/**
 * The evidence page uses the PDF standard fonts, which only cover WinAnsi
 * (roughly Latin-1). Embedding a Unicode font would add hundreds of
 * kilobytes to the Worker, so text is folded to WinAnsi here instead:
 * accents are kept where Latin-1 has them, other diacritics are stripped and
 * anything else becomes "?". The evidence JSON always keeps the exact text.
 */

// Characters outside Latin-1 that WinAnsi (CP1252) still encodes.
const WIN_ANSI_EXTRAS = new Set("€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ");

function isWinAnsi(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return (
    (code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff) || WIN_ANSI_EXTRAS.has(char)
  );
}

export function toWinAnsi(text: string): string {
  let out = "";
  for (const char of text.replace(/[\t\r\n]+/g, " ")) {
    if (isWinAnsi(char)) {
      out += char;
      continue;
    }
    const stripped = char.normalize("NFKD").replace(/\p{M}/gu, "");
    out += [...stripped].every(isWinAnsi) && stripped !== "" ? stripped : "?";
  }
  return out;
}

/** Greedy word wrap; words longer than a line (hashes, user agents) are split. */
export function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const fits = (s: string) => font.widthOfTextAtSize(s, size) <= maxWidth;
  const lines: string[] = [];
  let line = "";
  for (const word of toWinAnsi(text).split(" ")) {
    const candidate = line === "" ? word : `${line} ${word}`;
    if (fits(candidate)) {
      line = candidate;
      continue;
    }
    if (line !== "") lines.push(line);
    let rest = word;
    while (rest !== "" && !fits(rest)) {
      let cut = rest.length - 1;
      while (cut > 1 && !fits(rest.slice(0, cut))) cut--;
      lines.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    line = rest;
  }
  if (line !== "") lines.push(line);
  return lines;
}
