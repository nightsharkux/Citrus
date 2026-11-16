#!/usr/bin/env node
'use strict';
/**
 * Citrus device simulator — behaves like a classroom puck, card reader or
 * door light so you can test the whole hardware flow without hardware.
 *
 *   node hardware/simulator.js --url http://localhost:3100 --id dev_1 --secret <secret>
 *
 * It long-polls for commands and prints them. Type at the prompt:
 *   tap <UID>        simulate a card tap, e.g. "tap 04A1B2C3D4"
 *   ask <question>   simulate a spoken question to the puck
 *   end              press the "end session" button
 *   status           send a status report
 *   quit
 * Or run a single action:  ... --tap 04A1B2C3D4   |   ... --ask "What is a hash map?"
 */
const readline = require('node:readline');
const { signedHeaders } = require('../src/modules/devices/protocol');

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const URL_BASE = (opt('url', process.env.CAMPUS_URL || 'http://localhost:3100')).replace(/\/$/, '');
const DEVICE_ID = opt('id', process.env.CAMPUS_DEVICE_ID);
const SECRET = opt('secret', process.env.CAMPUS_DEVICE_SECRET);
if (!DEVICE_ID || !SECRET) {
  console.error('Usage: node hardware/simulator.js --url http://localhost:3100 --id dev_1 --secret <secret>');
  process.exit(1);
}

const LIGHT = { open: '\x1b[42m  OPEN  \x1b[0m', quiet: '\x1b[43m  QUIET  \x1b[0m', do_not_disturb: '\x1b[41m  DO NOT DISTURB  \x1b[0m', consultation: '\x1b[44m  CONSULTATION  \x1b[0m' };

async function call(path, body = {}) {
  const raw = JSON.stringify(body);
  const fullPath = `/api/v1/device/${path}`;
  const res = await fetch(URL_BASE + fullPath, { method: 'POST', headers: signedHeaders({ deviceId: DEVICE_ID, secret: SECRET, method: 'POST', path: fullPath, body: raw }), body: raw });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${res.status} ${data.error || 'request failed'}`);
  return data;
}

function show(command) {
  const p = command.payload || {};
  switch (command.type) {
    case 'room.status': return `Door light → ${LIGHT[p.status] || p.status}${p.note ? ` (${p.note})` : ''}`;
    case 'display.message': return `Display: “${p.text}”`;
    case 'class.pulse': return `Puck light → ${({ good: 'GREEN (following)', watch: 'AMBER (some unsure)', trouble: 'RED (explain again)', quiet: 'WHITE (waiting for answers)', off: 'OFF (lecture over)' })[p.status] || p.status}${p.answered ? `  ${p.following} following · ${p.unsure} unsure · ${p.lost} lost` : ''}`;
    case 'speak': return `Speaker: “${p.text}”`;
    case 'session.started': return `Session started by ${p.lecturer}${p.course ? ` for ${p.course}` : ''}`;
    case 'session.ended': return 'Session ended';
    case 'nfc.pair': return `Pairing mode: ask ${p.name} to tap their card`;
    default: return `${command.type} ${JSON.stringify(p)}`;
  }
}

async function heartbeatLoop() {
  let first = true;
  for (;;) {
    try {
      const hb = await call('heartbeat', { firmware: 'simulator-1.0', capabilities: ['nfc', 'speaker', 'microphone', 'light'], wait: first ? 0 : 25 });
      if (first) {
        console.log(`Connected as ${hb.device.name} (${hb.device.kind}) in ${hb.device.room || 'no room'}${hb.room ? ` — room is ${hb.room.status}` : ''}`);
        first = false;
      }
      for (const c of hb.commands) {
        console.log(`\n  ⇢ ${show(c)}`);
        await call(`commands/${c.id}/ack`, { result: 'ok' });
      }
      if (hb.commands.length) rl?.prompt();
    } catch (error) {
      console.error(`\nHeartbeat failed: ${error.message}. Retrying in 5 s…`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

async function event(type, data) {
  const r = await call('events', { type, data });
  console.log(`  ⇠ ${type}: ${JSON.stringify(r)}`);
  return r;
}

let rl = null;
async function main() {
  if (opt('tap')) return event('nfc.tap', { uid: opt('tap') });
  if (opt('ask')) return event('voice.query', { text: opt('ask') });

  heartbeatLoop();
  rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'device> ' });
  rl.prompt();
  rl.on('line', async (line) => {
    const [cmd, ...rest] = line.trim().split(/\s+/);
    try {
      if (cmd === 'tap') await event('nfc.tap', { uid: rest[0] || '04A1B2C3D4' });
      else if (cmd === 'ask') await event('voice.query', { text: rest.join(' ') });
      else if (cmd === 'end') await event('button.press', { button: 'end' });
      else if (cmd === 'status') await event('status', { temperature: 41, uptime: process.uptime() | 0 });
      else if (cmd === 'quit' || cmd === 'exit') process.exit(0);
      else if (cmd) console.log('Commands: tap <UID> · ask <question> · end · status · quit');
    } catch (error) {
      console.error(`  ✕ ${error.message}`);
    }
    rl.prompt();
  });
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
