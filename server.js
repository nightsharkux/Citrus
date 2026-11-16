'use strict';
/**
 * Citrus server entry point.
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

if (!config.persistence.durable) {
  console.warn(`WARNING: running on ${config.persistence.platform} without a hosted database. Accounts and data are lost whenever the server restarts or is redeployed. Set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN (see docs/DEPLOYMENT.md), or CAMPUS_PERSISTENT_DISK=1 if the storage folder is on a permanent volume.`);
}

const RETRY_MS = Number(process.env.CAMPUS_STARTUP_RETRY_MS) || 5_000;
let db;
let app;
let startupError = null;
let triedAt = 0;

/** Open the database, bring it up to date, add first-run data and build the app. */
function start() {
  db ||= openConfiguredDatabase(config);
  runMigrations(db, { log });
  seed(db, config, log);
  app = createApp({ config, db });
  startupError = null;
}

try {
  start();
} catch (error) {
  // Elsewhere a failed start should stop the process. On Vercel a crash leaves no message, so log it
  // and answer with a short explanation instead.
  if (!process.env.VERCEL) throw error;
  startupError = error;
  triedAt = Date.now();
  console.error('Citrus could not start:', error);
}

/**
 * An instance that could not start (say, while another one was updating the database right after a deploy) tries
 * again on a later request, at most every few seconds, instead of answering 503 for as long as it lives.
 */
function handler(req, res) {
  if (startupError && Date.now() - triedAt >= RETRY_MS) {
    triedAt = Date.now();
    try {
      start();
      console.log('Citrus started on a later try');
      app.maintenance.start();
    } catch (error) {
      startupError = error;
      console.error('Citrus still could not start:', error);
    }
  }
  if (startupError) {
    res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Retry-After': '5' });
    res.end('Citrus could not start. It tries again in a few seconds; the reason is in the deployment logs.');
    return undefined;
  }
  return app.handler(req, res);
}
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
    else console.log('  Other devices:      set HOST=0.0.0.0 in .env to open Citrus from phones on the same Wi-Fi');
    if (config.hosted) console.log(`  Public address:     ${config.publicUrl}`);
    console.log('\n  Keep this window open while people use Citrus. Press Ctrl+C to stop.\n');
    // Prepare knowledge indexes before the first question arrives.
    setTimeout(() => {
      try {
        app?.deps.ai.warm();
      } catch (error) {
        console.error('Citrus could not prepare the knowledge index:', error.message);
      }
    }, 50).unref();
  });
  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') console.error(`\n  Port ${config.port} is already in use. Is Citrus already running? Close it or set another PORT in .env.\n`);
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
module.exports = Object.defineProperties((req, res) => handler(req, res), {
  server: { value: server, enumerable: true },
  handler: { value: handler, enumerable: true },
  config: { value: config, enumerable: true },
  db: { get: () => db, enumerable: true },
  app: { get: () => app, enumerable: true },
});
