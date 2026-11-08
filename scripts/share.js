'use strict';
/**
 * Share Campus OS with any device, anywhere, over HTTPS — while this computer runs it.
 *
 *   share-online.bat            (Windows, double-click)
 *   npm run share               (any OS)
 *
 * Starts a free Cloudflare quick tunnel, reads its https://….trycloudflare.com
 * address and starts Campus OS configured for it (PUBLIC_URL + TRUST_PROXY).
 * HTTPS means phones get the microphone, "Hey Campus", push and app install.
 * The address changes every time; it stops working when you close this window.
 */
const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PORT = process.env.PORT || '3100';
const TUNNEL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

function hasCloudflared() {
  const probe = spawnSync('cloudflared', ['--version'], { encoding: 'utf8', shell: process.platform === 'win32' });
  return probe.status === 0;
}

if (!hasCloudflared()) {
  console.log('\n  Sharing needs Cloudflare\'s free "cloudflared" tool. Install it once:\n');
  console.log(process.platform === 'win32' ? '    winget install --id Cloudflare.cloudflared' : '    https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/');
  console.log('\n  Then close this window, open a new one and run this again.\n');
  process.exit(1);
}

console.log('\n  Opening a secure link…');
const tunnel = spawn('cloudflared', ['tunnel', '--no-autoupdate', '--url', `http://localhost:${PORT}`], { shell: process.platform === 'win32' });
let server = null;
let found = false;

const giveUp = setTimeout(() => {
  if (found) return;
  console.error('\n  Cloudflare did not hand out a link within 40 seconds. Check your internet connection and try again.\n');
  stop(1);
}, 40_000);

function onOutput(chunk) {
  if (found) return;
  const match = TUNNEL_PATTERN.exec(String(chunk));
  if (!match) return;
  found = true;
  clearTimeout(giveUp);
  start(match[0]);
}
tunnel.stdout.on('data', onOutput);
tunnel.stderr.on('data', onOutput);
tunnel.on('exit', (code) => {
  if (!found) console.error(`\n  The tunnel stopped (code ${code}).\n`);
  stop(code || 0);
});

function start(url) {
  server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, PUBLIC_URL: url, TRUST_PROXY: '1' },
  });
  server.on('exit', (code) => stop(code || 0));
  setTimeout(() => {
    console.log('  ┌──────────────────────────────────────────────────────────────');
    console.log(`  │  Open on any device:  ${url}`);
    console.log('  │  Works while this window stays open. Ctrl+C to stop sharing.');
    console.log('  └──────────────────────────────────────────────────────────────\n');
  }, 1200);
}

function stop(code) {
  clearTimeout(giveUp);
  try {
    server?.kill();
  } catch {
    /* already stopped */
  }
  try {
    tunnel.kill();
  } catch {
    /* already stopped */
  }
  setTimeout(() => process.exit(code), 300);
}

process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
