import { describe, expect, it } from "vitest";
import { parseSignatureSvg, SignatureSvgError } from "../../src/domain/signature-svg";

const NS = 'xmlns="http://www.w3.org/2000/svg"';
const valid = `<svg ${NS} viewBox="0 0 600 200"><path d="M10 10 L20 20 L30 15" stroke-width="2.5"/></svg>`;

function rejects(svg: string, reason: RegExp) {
  expect(() => parseSignatureSvg(svg)).toThrow(SignatureSvgError);
  expect(() => parseSignatureSvg(svg)).toThrow(reason);
}

describe("parseSignatureSvg", () => {
  it("accepts what the signing page produces", () => {
    const parsed = parseSignatureSvg(valid);
    expect(parsed.viewBox).toEqual({ minX: 0, minY: 0, width: 600, height: 200 });
    expect(parsed.paths).toEqual([{ d: "M10 10 L20 20 L30 15", strokeWidth: 2.5 }]);
  });

  it("accepts groups, inherited stroke widths and curve commands", () => {
    const parsed = parseSignatureSvg(
      `<svg ${NS} viewBox="0 0 100 50" stroke-width="3"><g stroke="#112233" fill="none">` +
        `<path d="M1 1 C 2 2, 3 3, 4 4 Q5 5 6 6 Z"/><path d="m1 1 l2 2" stroke-width="1"/></g></svg>`,
    );
    expect(parsed.paths.map((p) => p.strokeWidth)).toEqual([3, 1]);
  });

  it("re-serialises a canonical document instead of keeping the input", () => {
    const parsed = parseSignatureSvg(
      `  <svg ${NS}   viewBox="0,0,600,200" ><path   d="M1  1   L2 2" /></svg>  `,
    );
    expect(parsed.svg).toBe(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 200" fill="none" stroke="#000000" ` +
        `stroke-linecap="round" stroke-linejoin="round"><path d="M1 1 L2 2" stroke-width="2"/></svg>`,
    );
  });

  it("rejects script elements", () => {
    rejects(`<svg ${NS} viewBox="0 0 1 1"><script>alert(1)</script></svg>`, /script/);
    rejects(`<svg ${NS} viewBox="0 0 1 1"><SCRIPT/></svg>`, /script/);
  });

  it("rejects event handler attributes", () => {
    rejects(
      `<svg ${NS} viewBox="0 0 1 1" onload="alert(1)"><path d="M0 0"/></svg>`,
      /event handler/,
    );
    rejects(`<svg ${NS} viewBox="0 0 1 1"><path d="M0 0" onclick='x()'/></svg>`, /event handler/);
    rejects(
      `<svg ${NS} viewBox="0 0 1 1"><path d="M0 0" ONMOUSEOVER="x()"/></svg>`,
      /event handler/,
    );
  });

  it("rejects links", () => {
    rejects(`<svg ${NS} viewBox="0 0 1 1"><path d="M0 0" href="javascript:x()"/></svg>`, /links/);
    rejects(
      `<svg ${NS} viewBox="0 0 1 1"><path d="M0 0" xlink:href="https://example.com"/></svg>`,
      /links/,
    );
    rejects(
      `<svg ${NS} viewBox="0 0 1 1"><a href="https://example.com"><path d="M0 0"/></a></svg>`,
      /links|not allowed/,
    );
  });

  it("rejects foreignObject", () => {
    rejects(
      `<svg ${NS} viewBox="0 0 1 1"><foreignObject><div/></foreignObject></svg>`,
      /foreignObject/,
    );
  });

  it("rejects other elements, styles and unknown attributes", () => {
    rejects(`<svg ${NS} viewBox="0 0 1 1"><image href="x.png"/></svg>`, /not allowed/);
    rejects(`<svg ${NS} viewBox="0 0 1 1"><use/></svg>`, /<use> is not allowed/);
    rejects(`<svg ${NS} viewBox="0 0 1 1" style="x"><path d="M0 0"/></svg>`, /styles/);
    rejects(
      `<svg ${NS} viewBox="0 0 1 1"><path d="M0 0" transform="scale(2)"/></svg>`,
      /transform/,
    );
    rejects(`<svg ${NS} viewBox="0 0 1 1"><path d="M0 0" fill="url(#x)"/></svg>`, /hex colour/);
  });

  it("rejects DOCTYPE, entities, comments, CDATA and processing instructions", () => {
    rejects(`<!DOCTYPE svg [<!ENTITY x "y">]>${valid}`, /declarations/);
    rejects(`<?xml version="1.0"?>${valid}`, /declarations/);
    rejects(valid.replace("<path", "<!-- c --><path"), /declarations/);
    rejects(valid.replace("M10", "M&#49;0"), /entities/);
  });

  it("rejects malformed and structurally wrong documents", () => {
    rejects(`<svg ${NS} viewBox="0 0 1 1"><path d="M0 0"></svg>`, /mismatched|incomplete/);
    rejects(`<svg ${NS} viewBox="0 0 1 1"><path d=M0/></svg>`, /malformed/);
    rejects(`<g><path d="M0 0"/></g>`, /root element/);
    rejects(`${valid}${valid}`, /after the root/);
    rejects(`<svg ${NS} viewBox="0 0 1 1">hello<path d="M0 0"/></svg>`, /text content/);
    rejects(`<svg ${NS} viewBox="0 0 1 1" viewBox="0 0 2 2"><path d="M0 0"/></svg>`, /duplicate/);
    rejects(`<svg ${NS}><path d="M0 0"/></svg>`, /viewBox/);
    rejects(`<svg ${NS} viewBox="0 0 0 10"><path d="M0 0"/></svg>`, /out of range/);
    rejects(`<svg ${NS} viewBox="0 0 1 1"></svg>`, /empty/);
  });

  it("rejects path data with arcs or other characters", () => {
    rejects(`<svg ${NS} viewBox="0 0 1 1"><path d="M0 0 A 1 1 0 0 1 2 2"/></svg>`, /unsupported/);
    rejects(`<svg ${NS} viewBox="0 0 1 1"><path d="L0 0"/></svg>`, /unsupported/);
    rejects(`<svg ${NS} viewBox="0 0 1 1"><path d="M0 0 url(x)"/></svg>`, /unsupported/);
  });

  it("enforces size limits", () => {
    rejects(`<svg ${NS} viewBox="0 0 1 1">${" ".repeat(70 * 1024)}</svg>`, /too large/);
    const many = Array.from({ length: 501 }, () => '<path d="M0 0"/>').join("");
    rejects(`<svg ${NS} viewBox="0 0 1 1">${many}</svg>`, /too many/);
  });
});
