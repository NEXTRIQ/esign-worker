/**
 * Static assets for the signing page, served by the Worker itself so the
 * page needs no third-party origins and the CSP can stay at 'self'.
 */

export const STYLESHEET = `
:root {
  color-scheme: light dark;
  --bg: #f6f7f9;
  --surface: #ffffff;
  --ink: #16181d;
  --muted: #5b616e;
  --border: #d5d9e0;
  --accent: #1f4fd1;
  --accent-ink: #ffffff;
  --error: #b42318;
  --error-bg: #fef3f2;
  --focus: #1f4fd1;
  --radius: 10px;
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  line-height: 1.5;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #111317;
    --surface: #1a1d23;
    --ink: #eceef2;
    --muted: #a3a9b6;
    --border: #343944;
    --accent: #7ea2ff;
    --accent-ink: #0d1020;
    --error: #ff9b91;
    --error-bg: #2a1614;
    --focus: #7ea2ff;
  }
}
*, *::before, *::after { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font-size: 1rem; }
.container { max-width: 52rem; margin: 0 auto; padding: 1.5rem 1rem 3rem; }
.issuer { color: var(--muted); font-size: 0.875rem; margin: 0 0 1rem; }
h1 { font-size: 1.5rem; line-height: 1.25; margin: 0 0 0.5rem; }
h2 { font-size: 1.125rem; margin: 0 0 0.75rem; }
p { margin: 0 0 0.75rem; }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 1.25rem; margin: 1rem 0; }
.muted { color: var(--muted); }
.notice { margin-top: 1rem; }
.small { font-size: 0.875rem; }
.hash { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.8125rem; overflow-wrap: anywhere; }
blockquote { margin: 0.75rem 0; padding: 0.5rem 0.75rem; border-left: 3px solid var(--border); color: var(--muted); white-space: pre-line; }
.pdf-frame { display: block; width: 100%; height: min(75vh, 56rem); border: 1px solid var(--border); border-radius: 6px; background: #fff; }
label { display: block; font-weight: 600; margin-bottom: 0.25rem; }
.hint { color: var(--muted); font-size: 0.875rem; margin: 0 0 0.5rem; }
.field { margin: 0 0 1.25rem; }
input[type="text"] { width: 100%; font: inherit; padding: 0.625rem 0.75rem; border: 1px solid var(--border); border-radius: 6px; background: var(--bg); color: var(--ink); }
.consent { display: flex; gap: 0.625rem; align-items: flex-start; }
.consent input { width: 1.25rem; height: 1.25rem; margin: 0.15rem 0 0; flex: none; accent-color: var(--accent); }
.consent label { font-weight: 400; margin: 0; }
.pad canvas { display: block; width: 100%; aspect-ratio: 3 / 1; border: 1px dashed var(--border); border-radius: 6px; background: var(--bg); color: var(--ink); touch-action: none; cursor: crosshair; }
.pad-actions { display: flex; justify-content: flex-end; margin-top: 0.375rem; }
button, .button { display: inline-block; font: inherit; font-weight: 600; text-decoration: none; padding: 0.75rem 1.25rem; border-radius: 6px; border: 1px solid transparent; cursor: pointer; }
.primary { background: var(--accent); color: var(--accent-ink); }
.secondary { background: transparent; color: var(--ink); border-color: var(--border); padding: 0.375rem 0.75rem; font-weight: 500; font-size: 0.875rem; }
button:disabled { opacity: 0.5; cursor: default; }
a { color: var(--accent); }
:focus-visible { outline: 3px solid var(--focus); outline-offset: 2px; }
.errors { border: 1px solid var(--error); background: var(--error-bg); color: var(--error); border-radius: 6px; padding: 0.75rem 1rem; margin-bottom: 1.25rem; }
.errors ul { margin: 0.25rem 0 0; padding-left: 1.25rem; }
.field-error { color: var(--error); font-size: 0.875rem; margin: 0.25rem 0 0; }
[hidden] { display: none !important; }
@media (max-width: 30rem) {
  h1 { font-size: 1.25rem; }
  .card { padding: 1rem; }
  .pdf-frame { height: 60vh; }
  button.primary { width: 100%; }
}
`.trim();

/**
 * Progressive enhancement: turns the hidden signature section into a drawing
 * pad and serialises strokes into a minimal SVG in a hidden field. Without
 * JavaScript the section stays hidden and the typed name is the signature.
 */
export const SIGNATURE_SCRIPT = `
(function () {
  "use strict";
  var pad = document.querySelector("[data-signature-pad]");
  if (!pad || !window.PointerEvent) return;
  var canvas = pad.querySelector("canvas");
  var input = pad.querySelector("input[name=signature_svg]");
  var clear = pad.querySelector("[data-clear]");
  var ctx = canvas && canvas.getContext("2d");
  if (!ctx || !input || !clear) return;

  var W = 600, H = 200, MIN_STEP = 1.5;
  var strokes = [];
  var current = null;
  pad.hidden = false;

  function clamp(v, max) { return Math.min(max, Math.max(0, Math.round(v * 10) / 10)); }
  function point(e) {
    var r = canvas.getBoundingClientRect();
    return [clamp((e.clientX - r.left) * W / r.width, W), clamp((e.clientY - r.top) * H / r.height, H)];
  }
  function redraw() {
    ctx.setTransform(canvas.width / W, 0, 0, canvas.height / H, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.lineWidth = 2.5;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = getComputedStyle(canvas).color;
    strokes.forEach(function (s) {
      ctx.beginPath();
      ctx.moveTo(s[0][0], s[0][1]);
      for (var i = 1; i < s.length; i++) ctx.lineTo(s[i][0], s[i][1]);
      if (s.length === 1) ctx.lineTo(s[0][0] + 0.1, s[0][1]);
      ctx.stroke();
    });
  }
  function resize() {
    var r = canvas.getBoundingClientRect();
    var dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(r.width * dpr);
    canvas.height = Math.round(r.height * dpr);
    redraw();
  }
  function serialise() {
    input.value = strokes.length === 0 ? "" :
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + " " + H + '">' +
      strokes.map(function (s) {
        var pts = s.length === 1 ? [s[0], [s[0][0] + 0.1, s[0][1]]] : s;
        return '<path d="M' + pts.map(function (p) { return p[0] + " " + p[1]; }).join(" L") + '" stroke-width="2.5"/>';
      }).join("") + "</svg>";
    clear.disabled = strokes.length === 0;
  }

  canvas.addEventListener("pointerdown", function (e) {
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    current = [point(e)];
    strokes.push(current);
    redraw();
  });
  canvas.addEventListener("pointermove", function (e) {
    if (!current) return;
    var p = point(e), last = current[current.length - 1];
    if (Math.abs(p[0] - last[0]) + Math.abs(p[1] - last[1]) < MIN_STEP) return;
    current.push(p);
    redraw();
  });
  function end() { if (current) { current = null; serialise(); } }
  canvas.addEventListener("pointerup", end);
  canvas.addEventListener("pointercancel", end);
  clear.addEventListener("click", function () { strokes = []; serialise(); redraw(); });
  window.addEventListener("resize", resize);
  resize();
  serialise();
})();
`.trim();
