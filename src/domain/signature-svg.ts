/**
 * Parser and sanitiser for drawn signatures.
 *
 * The signing page submits the drawing as a tiny SVG. That input is
 * attacker-controlled, so instead of trying to strip dangerous parts from
 * arbitrary SVG, this accepts a strict allowlist (`svg`, `g`, `path` and a
 * handful of presentation attributes), rejects everything else with a clear
 * reason, and re-serialises a canonical SVG from the parsed values. The
 * original input is never stored or rendered.
 */

export const MAX_SIGNATURE_SVG_LENGTH = 64 * 1024;
const MAX_PATHS = 500;
const MAX_PATH_DATA_LENGTH = 32 * 1024;
const DEFAULT_STROKE_WIDTH = 2;
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

export class SignatureSvgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignatureSvgError";
  }
}

export interface SignaturePath {
  d: string;
  strokeWidth: number;
}

export interface SignatureSvg {
  viewBox: { minX: number; minY: number; width: number; height: number };
  paths: SignaturePath[];
  /** Canonical re-serialisation of the parsed drawing. */
  svg: string;
}

type ElementName = "svg" | "g" | "path";

const STROKE_ATTRIBUTES = ["fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin"];
const ALLOWED_ATTRIBUTES: Record<ElementName, ReadonlySet<string>> = {
  svg: new Set(["xmlns", "viewBox", "width", "height", ...STROKE_ATTRIBUTES]),
  g: new Set(STROKE_ATTRIBUTES),
  path: new Set(["d", ...STROKE_ATTRIBUTES]),
};

// Only absolute and relative path commands, numbers and separators. Arcs are
// allowed by SVG but never produced by a pen, so they are rejected too.
const PATH_DATA = /^[MmLlHhVvCcSsQqTtZz0-9eE.,\s+-]+$/;
const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const COLOR = /^(?:none|#[0-9a-fA-F]{3}|#[0-9a-fA-F]{6})$/;
const TAG =
  /^<(\/?)([A-Za-z][A-Za-z0-9:._-]*)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>$/;
const ATTRIBUTE = /\s+([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function parseNumber(value: string, what: string): number {
  const trimmed = value.trim().replace(/px$/, "");
  if (!NUMBER.test(trimmed)) throw new SignatureSvgError(`${what} is not a number`);
  const n = Number(trimmed);
  if (!Number.isFinite(n)) throw new SignatureSvgError(`${what} is not a finite number`);
  return n;
}

function checkAttribute(element: ElementName, name: string, value: string): void {
  const lower = name.toLowerCase();
  // Explicit reasons for the classic SVG injection vectors, before the generic allowlist.
  if (lower.startsWith("on"))
    throw new SignatureSvgError("event handler attributes are not allowed");
  if (lower === "href" || lower.endsWith(":href"))
    throw new SignatureSvgError("links are not allowed");
  if (lower === "style") throw new SignatureSvgError("inline styles are not allowed");
  if (!ALLOWED_ATTRIBUTES[element].has(name)) {
    throw new SignatureSvgError(`attribute "${name}" is not allowed on <${element}>`);
  }
  switch (name) {
    case "xmlns":
      if (value !== SVG_NAMESPACE) throw new SignatureSvgError("unexpected namespace");
      return;
    case "fill":
    case "stroke":
      if (!COLOR.test(value)) throw new SignatureSvgError(`${name} must be "none" or a hex colour`);
      return;
    case "stroke-linecap":
      if (!["butt", "round", "square"].includes(value))
        throw new SignatureSvgError("invalid stroke-linecap");
      return;
    case "stroke-linejoin":
      if (!["miter", "round", "bevel"].includes(value))
        throw new SignatureSvgError("invalid stroke-linejoin");
      return;
    case "d":
      if (value.length > MAX_PATH_DATA_LENGTH) throw new SignatureSvgError("path data is too long");
      if (!PATH_DATA.test(value) || !/^\s*[Mm]/.test(value)) {
        throw new SignatureSvgError("path data contains unsupported commands");
      }
      return;
    default:
      return; // Numeric attributes are validated where they are used.
  }
}

function parseAttributes(element: ElementName, source: string): Map<string, string> {
  const attributes = new Map<string, string>();
  for (const match of source.matchAll(ATTRIBUTE)) {
    const name = match[1] ?? "";
    const value = match[2] ?? match[3] ?? "";
    if (attributes.has(name)) throw new SignatureSvgError(`duplicate attribute "${name}"`);
    checkAttribute(element, name, value);
    attributes.set(name, value);
  }
  return attributes;
}

function strokeWidthOf(attributes: Map<string, string>, inherited: number): number {
  const raw = attributes.get("stroke-width");
  if (raw === undefined) return inherited;
  const width = parseNumber(raw, "stroke-width");
  if (width <= 0 || width > 50) throw new SignatureSvgError("stroke-width is out of range");
  return width;
}

function format(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

export function parseSignatureSvg(input: string): SignatureSvg {
  if (input.length > MAX_SIGNATURE_SVG_LENGTH)
    throw new SignatureSvgError("signature is too large");
  // No DOCTYPE, entities, comments, CDATA or processing instructions: none are
  // needed for a drawing and all of them have a history of parser exploits.
  if (/<[!?]/.test(input) || input.includes("&")) {
    throw new SignatureSvgError("markup declarations and entities are not allowed");
  }

  const stack: { name: ElementName; strokeWidth: number }[] = [];
  const paths: SignaturePath[] = [];
  let viewBox: SignatureSvg["viewBox"] | null = null;
  let rootClosed = false;

  for (const [token] of input.trim().matchAll(/<[^>]*>|[^<]+/g)) {
    if (!token.startsWith("<")) {
      if (token.trim() !== "") throw new SignatureSvgError("text content is not allowed");
      continue;
    }
    const tag = TAG.exec(token);
    if (!tag) throw new SignatureSvgError("malformed tag");
    const [, closing, rawName = "", attributeSource = "", selfClosing] = tag;
    const lower = rawName.toLowerCase();
    if (lower === "script") throw new SignatureSvgError("script elements are not allowed");
    if (lower === "foreignobject") throw new SignatureSvgError("foreignObject is not allowed");
    if (rawName !== "svg" && rawName !== "g" && rawName !== "path") {
      throw new SignatureSvgError(`element <${rawName}> is not allowed`);
    }
    const name: ElementName = rawName;

    if (closing) {
      if (attributeSource.trim() !== "" || selfClosing)
        throw new SignatureSvgError("malformed closing tag");
      if (stack.pop()?.name !== name) throw new SignatureSvgError("mismatched closing tag");
      if (stack.length === 0) rootClosed = true;
      continue;
    }

    if (rootClosed) throw new SignatureSvgError("content after the root element");
    const parent = stack.at(-1);
    if ((name === "svg") !== (parent === undefined)) {
      throw new SignatureSvgError("the root element must be a single <svg>");
    }
    if (parent?.name === "path") throw new SignatureSvgError("<path> cannot have children");

    const attributes = parseAttributes(name, attributeSource);
    const strokeWidth = strokeWidthOf(attributes, parent?.strokeWidth ?? DEFAULT_STROKE_WIDTH);

    if (name === "svg") {
      const parts = (attributes.get("viewBox") ?? "").trim().split(/[\s,]+/);
      if (parts.length !== 4)
        throw new SignatureSvgError("a viewBox with four numbers is required");
      const [minX = 0, minY = 0, width = 0, height = 0] = parts.map((p) =>
        parseNumber(p, "viewBox"),
      );
      if (!(width > 0 && height > 0 && width <= 10_000 && height <= 10_000)) {
        throw new SignatureSvgError("viewBox size is out of range");
      }
      viewBox = { minX, minY, width, height };
    }

    if (name === "path") {
      const d = attributes.get("d");
      if (d === undefined) throw new SignatureSvgError("<path> requires a d attribute");
      paths.push({ d: d.trim().replace(/\s+/g, " "), strokeWidth });
      if (paths.length > MAX_PATHS) throw new SignatureSvgError("too many strokes");
    }

    if (!selfClosing) stack.push({ name, strokeWidth });
    else if (name === "svg") rootClosed = true;
  }

  if (!viewBox || !rootClosed || stack.length > 0)
    throw new SignatureSvgError("incomplete svg document");
  if (paths.length === 0) throw new SignatureSvgError("the signature is empty");

  const vb = [viewBox.minX, viewBox.minY, viewBox.width, viewBox.height].map(format).join(" ");
  const body = paths
    .map((p) => `<path d="${p.d}" stroke-width="${format(p.strokeWidth)}"/>`)
    .join("");
  return {
    viewBox,
    paths,
    svg:
      `<svg xmlns="${SVG_NAMESPACE}" viewBox="${vb}" fill="none" stroke="#000000" ` +
      `stroke-linecap="round" stroke-linejoin="round">${body}</svg>`,
  };
}
