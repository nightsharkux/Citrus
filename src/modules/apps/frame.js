'use strict';
/**
 * The page a made tool runs in. The tool's own markup sits inside a page that supplies the Campus OS look (four
 * looks to choose from), and the response headers lock it down: it may run its own script and nothing else. No
 * network, no storage, no cookies, no forms, no access to the app around it (a sandbox with its own origin).
 */

const LOOKS = ['glass', 'bold', 'minimal', 'night'];

/** CSP for the tool page: scripts and styles from the page itself only, and a sandbox with no same-origin access. */
const TOOL_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  'media-src data: blob:',
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'self'",
  'sandbox allow-scripts',
].join('; ');

/** Remove what a tool must never contain. The CSP blocks these anyway; this keeps the stored code honest. */
function cleanToolHtml(html) {
  return String(html || '')
    .replace(/<\/?(?:html|head|body|iframe|frame|object|embed|base|link|meta|form|portal)\b[^>]*>/gi, '')
    .replace(/<script\b[^>]*\bsrc\s*=[^>]*>\s*<\/script>/gi, '')
    .replace(/\son\w+\s*=\s*"javascript:[^"]*"/gi, '')
    .slice(0, 80_000)
    .trim();
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** The four looks, from the edition's colours. Each sets the same variables, so any tool works with any look. */
function themeCss(palette = {}) {
  const accent = palette.accent || '#5b5bd6';
  const [a1, a2, a3] = palette.aurora || [accent, '#f2557a', '#8b6cff'];
  return `
:root { --accent: ${accent}; --accent-2: ${a3}; --radius: 22px; color-scheme: light dark;
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; }
html[data-look="glass"] { --bg: radial-gradient(1200px 700px at 10% -10%, ${a1}55, transparent 60%), radial-gradient(900px 600px at 110% 10%, ${a3}44, transparent 60%), linear-gradient(160deg, #f7f7fb, #eceef6);
  --text: #16181d; --muted: #5b6270; --surface: rgba(255,255,255,.6); --line: rgba(20,22,30,.1); }
html[data-look="bold"] { --bg: linear-gradient(140deg, ${a1}, ${a2} 55%, ${a3}); --text: #fff; --muted: rgba(255,255,255,.78); --surface: rgba(255,255,255,.16); --line: rgba(255,255,255,.28); --accent: #fff; }
html[data-look="minimal"] { --bg: #fafafa; --text: #111317; --muted: #6b7280; --surface: #ffffff; --line: #e5e7eb; }
html[data-look="night"] { --bg: #000; --text: #f5f5f7; --muted: #8e8e93; --surface: rgba(255,255,255,.07); --line: rgba(255,255,255,.12); --accent: ${a1}; }
@media (prefers-color-scheme: dark) {
  html[data-look="glass"] { --bg: radial-gradient(1200px 700px at 10% -10%, ${a1}40, transparent 60%), radial-gradient(900px 600px at 110% 10%, ${a3}33, transparent 60%), linear-gradient(160deg, #101218, #0b0c10);
    --text: #f2f3f5; --muted: #a1a7b3; --surface: rgba(30,32,40,.55); --line: rgba(255,255,255,.1); }
  html[data-look="minimal"] { --bg: #0e0f12; --text: #f2f3f5; --muted: #9aa0aa; --surface: #17191d; --line: #2a2d33; }
}
* { box-sizing: border-box; }
html, body { margin: 0; min-height: 100%; }
body { min-height: 100vh; background: var(--bg); background-attachment: fixed; color: var(--text); display: grid; place-items: center; padding: clamp(16px, 4vw, 48px);
  -webkit-font-smoothing: antialiased; line-height: 1.45; }
.tool { width: min(1100px, 100%); display: grid; gap: 18px; justify-items: center; text-align: center; }
.card { width: 100%; padding: clamp(16px, 3vw, 32px); border-radius: var(--radius); background: var(--surface); border: 1px solid var(--line);
  -webkit-backdrop-filter: blur(24px) saturate(170%); backdrop-filter: blur(24px) saturate(170%); box-shadow: 0 20px 60px -24px rgba(0,0,0,.35); }
.big { font-size: clamp(56px, 16vw, 260px); font-weight: 700; letter-spacing: -0.04em; line-height: 1; font-variant-numeric: tabular-nums; }
.title { font-size: clamp(22px, 3.4vw, 40px); font-weight: 700; letter-spacing: -0.02em; margin: 0; }
.muted { color: var(--muted); }
.row { display: flex; flex-wrap: wrap; gap: 10px; justify-content: center; align-items: center; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; width: 100%; }
button { font: inherit; font-weight: 600; padding: 12px 22px; border-radius: 999px; border: 0; cursor: pointer; background: var(--accent); color: ${'#fff'};
  transition: transform .2s cubic-bezier(.32,.72,0,1), opacity .2s; }
html[data-look="bold"] button { color: #111; }
button:hover { transform: translateY(-1px); } button:active { transform: scale(.97); }
button.secondary { background: var(--surface); color: var(--text); border: 1px solid var(--line); }
input, select, textarea { font: inherit; color: var(--text); background: var(--surface); border: 1px solid var(--line); border-radius: 14px; padding: 12px 14px; min-width: 0; }
input:focus, select:focus, textarea:focus, button:focus-visible { outline: 3px solid color-mix(in srgb, var(--accent) 45%, transparent); outline-offset: 2px; }
`;
}

/** The whole tool page for one look. */
function toolPage({ name, html, look = 'glass', palette }) {
  const chosen = LOOKS.includes(look) ? look : 'glass';
  return `<!doctype html><html lang="en" data-look="${chosen}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(name || 'Tool')}</title><style>${themeCss(palette)}</style></head><body>${cleanToolHtml(html)}</body></html>`;
}

module.exports = { LOOKS, TOOL_CSP, toolPage, cleanToolHtml, themeCss };
