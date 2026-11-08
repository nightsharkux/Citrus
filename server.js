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
const { openDatabase } = require('./src/db/database');
const { runMigrations } = require('./src/db/migrate');
const { seed } = require('./src/db/seed');
const { createApp } = require('./src/app');

const config = loadConfig();
const db = openDatabase(config.dbPath);
const log = require.main === module ? console.log : () => {};
runMigrations(db, { log });
seed(db, config, log);

const app = createApp({ config, db });
const server = http.createServer(app.handler);
const handler = app.handler;

if (require.main === module) {
  app.maintenance.start();
  server.listen(config.port, config.host, () => {
    const { networkUrls, listensOnNetwork } = require('./src/lib/network');
    const local = `http://${listensOnNetwork(config.host) ? 'localhost' : config.host}:${config.port}`;
    console.log(`\n  ${config.site.name} ${config.site.version}\n`);
    console.log(`  On this computer:   ${local}`);
    const others = networkUrls(config.host, config.port);
    if (others.length) others.forEach((url, i) => console.log(`  ${i ? '                    ' : 'On your network:    '}${url}`));
    else console.log('  Other devices:      set HOST=0.0.0.0 in .env to open Campus OS from phones on the same Wi-Fi');
    if (config.publicUrlExplicit && config.publicUrl !== local) console.log(`  Public address:     ${config.publicUrl}`);
    console.log('\n  Keep this window open while people use Campus OS. Press Ctrl+C to stop.\n');
  });
  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') console.error(`\n  Port ${config.port} is already in use. Is Campus OS already running? Close it or set another PORT in .env.\n`);
    else console.error(error);
    process.exit(1);
  });
  const shutdown = () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { server, db, handler, app, config };
