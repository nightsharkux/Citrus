'use strict';
/**
 * Draws the Citrus slice mark into the files that cannot draw it themselves:
 *   public/icons/{general,oth}-{192,512}.png   the app icons (a dark tile with the mark), made with the installed
 *                                              Microsoft Edge or Chrome in headless mode
 *   android/app/src/main/res/drawable/ic_ring.xml   the Android launcher icon (a vector, scaled into the safe zone)
 *
 *   node scripts/make-brand-assets.js
 *
 * The browser icon (/brand/mark.svg) and the marks in the pages are served from src/lib/brand-mark.js directly.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { markSvg, SEGMENTS, RING, GRADIENT, OPACITY, SIZE } = require('../src/lib/brand-mark');

const root = path.resolve(__dirname, '..');
const TILE = '#0E0B1A';

// ---- Android: a vector drawable. The adaptive icon keeps its picture inside a 66 dp circle of the 108 dp square.
function androidVector() {
  const dp = 62; // the mark's size inside the 108 dp square
  const view = Math.round((SIZE * 108) / dp);
  const shift = Math.round((view - SIZE) / 2);
  const gradient = (attr) => `        <aapt:attr name="android:${attr}">\n            <gradient android:type="linear" android:startX="0" android:startY="0" android:endX="${SIZE}" android:endY="${SIZE}">\n${GRADIENT.map(([o, c]) => `                <item android:color="#FF${c.slice(1)}" android:offset="${o}" />`).join('\n')}\n            </gradient>\n        </aapt:attr>`;
  return `<?xml version="1.0" encoding="utf-8"?>
<!-- The Citrus slice mark, for the launcher icon (adaptive icon foreground, 108 x 108 with a 66 x 66 safe circle).
     Made by scripts/make-brand-assets.js from src/lib/brand-mark.js: do not edit by hand. -->
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    xmlns:aapt="http://schemas.android.com/aapt"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="${view}"
    android:viewportHeight="${view}">
    <group android:translateX="${shift}" android:translateY="${shift}">
        <path android:fillType="evenOdd" android:pathData="${RING}">
${gradient('fillColor')}
        </path>
${SEGMENTS.map((d) => `        <path android:fillAlpha="${OPACITY}" android:pathData="${d}">\n${gradient('fillColor')}\n        </path>`).join('\n')}
    </group>
</vector>
`;
}

// ---- PNG icons: render the mark on the tile with a headless browser.
function findBrowser() {
  const candidates = [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  return candidates.find((p) => fs.existsSync(p));
}

function renderPng(browser, size, file) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'citrus-icon-'));
  const page = path.join(dir, 'icon.html');
  // The mark fills about 62% of the tile, inside the 80% circle that "maskable" icons keep safe.
  fs.writeFileSync(page, `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;width:${size}px;height:${size}px;background:${TILE};display:grid;place-items:center;overflow:hidden}svg{width:62%;height:62%}</style>${markSvg('Citrus')}`);
  const result = spawnSync(browser, ['--headless', '--disable-gpu', '--hide-scrollbars', `--window-size=${size},${size}`, `--screenshot=${file}`, `file:///${page.replace(/\\/g, '/')}`], { encoding: 'utf8' });
  fs.rmSync(dir, { recursive: true, force: true });
  if (result.status !== 0 || !fs.existsSync(file)) throw new Error(`Could not draw ${file}: ${result.stderr || result.error}`);
}

fs.writeFileSync(path.join(root, 'android/app/src/main/res/drawable/ic_ring.xml'), androidVector());
console.log('android/app/src/main/res/drawable/ic_ring.xml');

const browser = findBrowser();
if (!browser) {
  console.log('No Edge or Chrome found: the PNG icons were not redrawn.');
} else {
  for (const edition of ['general', 'oth']) {
    for (const size of [192, 512]) {
      const file = path.join(root, 'public/icons', `${edition}-${size}.png`);
      renderPng(browser, size, file);
      console.log(path.relative(root, file));
    }
  }
}
