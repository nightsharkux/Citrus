'use strict';
/**
 * Campus OS server entry point.
 *
 *   node --env-file=.env server.js
 *
 * Requiring this file (as the tests do) builds the app without listening.
 */
const http = require('node:http');
const { loadConfig } = require('./src/config');
const { openConfiguredDatabase } = require('./src/db/database');
const { runMigrations } = require('./src/db/migrate');
const { seed } = require('./src/db/seed');
const { createApp } = require('./src/app');

const config = loadConfig();
// Run directly (npm start) the process listens itself. On Vercel it must not: the platform calls the
// exported function for each request.
const standalone = require.main === module;
const onVercel = !!process.env.VERCEL;
const log = standalone || onVercel ? console.log : () => {};

let db;
let app;
let startupError;
try {
  db = openConfiguredDatabase(config);
  runMigrations(db, { log });
  seed(db, config, log);
  app = createApp({ config, db });
} catch (error) {
  // Elsewhere a failed start should stop the process. On Vercel a crash leaves no message, so log it
  // and answer every request with a short explanation instead.
  if (!process.env.VERCEL) throw error;
  startupError = error;
  console.error('Campus OS could not start:', error);
}

const handler = startupError
  ? (req, res) => {
    res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end('Campus OS could not start. The reason is in the deployment logs.');
  }
  : app.handler;
const server = http.createServer(handler);

if (onVercel) app?.maintenance.start();

if (standalone) {
  app?.maintenance.start();
  server.listen(config.port, config.host, () => {
    const { networkUrls, listensOnNetwork } = require('./src/lib/network');
    const local = `http://${listensOnNetwork(config.host) ? 'localhost' : config.host}:${config.port}`;
    console.log(`\n  ${config.site.name} ${config.site.version}\n`);
    console.log(`  On this computer:   ${local}`);
    const others = networkUrls(config.host, config.port);
    if (others.length) others.forEach((url, i) => console.log(`  ${i ? '                    ' : 'On your network:    '}${url}`));
    else console.log('  Other devices:      set HOST=0.0.0.0 in .env to open Campus OS from phones on the same Wi-Fi');
    if (config.hosted) console.log(`  Public address:     ${config.publicUrl}`);
    console.log('\n  Keep this window open while people use Campus OS. Press Ctrl+C to stop.\n');
    // Prepare knowledge indexes before the first question arrives.
    setTimeout(() => {
      try {
        app?.deps.ai.warm();
      } catch (error) {
        console.error('Campus OS could not prepare the knowledge index:', error.message);
      }
    }, 50).unref();
  });
  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') console.error(`\n  Port ${config.port} is already in use. Is Campus OS already running? Close it or set another PORT in .env.\n`);
    else console.error(error);
    process.exit(1);
  });
  const shutdown = () => {
    server.close(() => {
      db?.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Vercel calls the default export as (req, res) for every request. The function also carries the pieces
// the tests use: const { server, db } = require('./server').
module.exports = Object.assign((req, res) => handler(req, res), { server, db, handler, app, config });
