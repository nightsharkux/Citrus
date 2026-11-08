'use strict';
/** Quick installation check: Node version, edition, feature registry, database and AI configuration. */
const { siteConfig } = require('../config/site');
const catalog = require('../config/capabilities');
const { loadConfig } = require('../src/config');
const { makeProviders } = require('../src/ai/providers');
const fs = require('node:fs');
const { networkUrls, listensOnNetwork } = require('../src/lib/network');

const [major, minor] = process.versions.node.split('.').map(Number);
const ok = (cond, label, optional = false) => console.log(`${cond ? '✔' : optional ? '·' : '✖'} ${label}`);

const site = siteConfig();
const config = loadConfig();
ok(major > 22 || (major === 22 && minor >= 13), `Node ${process.version} (needs 22.13+)`);
ok(true, `${site.name} ${site.version} — edition "${site.id}"`);

const counts = {};
for (const group of catalog) for (const item of group.items) counts[item.status] = (counts[item.status] || 0) + 1;
ok(true, `Features: ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')}`);

ok(fs.existsSync(config.dbPath), `Database ${fs.existsSync(config.dbPath) ? 'found' : 'will be created'} at ${config.dbPath}`);
ok(!!process.env.CAMPUS_ADMIN_PASSWORD || fs.existsSync(config.dbPath), 'Administrator configured (CAMPUS_ADMIN_PASSWORD or existing database)');

const providers = makeProviders();
for (const p of providers.list().filter((x) => x.id !== 'off')) ok(p.ready, `AI provider ${p.label}${p.ready ? ` configured (${p.model}); connection untested` : `: ${p.missing}`}`, true);
ok(!!config.oidc.issuer, `Single sign-on ${config.oidc.issuer ? `→ ${config.oidc.issuer}` : 'not configured (optional)'}`, true);
ok(!!config.moodle.url, `Moodle ${config.moodle.url || 'not configured (optional)'}`, true);
if (config.hosted) {
  ok(true, `Hosted on Vercel at ${config.publicUrl}`);
} else if (listensOnNetwork(config.host)) {
  const urls = networkUrls(config.host, config.port);
  ok(true, urls.length ? `Open on your network: ${urls.join(', ')} (links follow each visitor's address)` : 'Listening on all interfaces, but no network connection was found');
} else {
  ok(true, `This computer only (HOST=${config.host}). Set HOST=0.0.0.0 to open Campus OS on other devices.`, true);
}

/** Read saved choices without opening a writable database or running migrations. */
async function checkAi() {
  if (!fs.existsSync(config.dbPath)) return;
  const { DatabaseSync } = require('node:sqlite');
  const { withHelpers } = require('../src/db/database');
  const { createAiService } = require('../src/ai/service');
  const { connectionTestPrompt } = require('../src/ai/prompts');
  const db = withHelpers(new DatabaseSync(config.dbPath, { readOnly: true }));
  try {
    if (!db.hasTable('institution_ai_settings')) {
      ok(false, 'AI settings need database migrations (run npm start)');
      process.exitCode = 1;
      return;
    }
    const ai = createAiService({ db });
    for (const institution of db.all('SELECT id FROM institutions ORDER BY id')) {
      const user = { id: `check:${institution.id}`, institution_id: institution.id };
      const status = ai.status(user);
      ok(status.aiEnabled, `Institution ${institution.id}: ${status.provider} · ${status.description}`, true);
      const entries = db.get('SELECT COUNT(*) n FROM institution_knowledge WHERE institution_id = ?', institution.id).n;
      ok(entries > 0, `Institution ${institution.id}: ${entries} knowledge entries${entries ? '' : ' (add approved sources in Admin → AI & knowledge)'}`, true);
      if (!process.argv.includes('--ai')) continue;
      if (!status.aiEnabled) {
        ok(false, `Institution ${institution.id}: select a configured provider before testing AI`);
        process.exitCode = 1;
        continue;
      }
      try {
        await ai.complete({ user, system: connectionTestPrompt(), prompt: 'Connection test from Campus OS.', maxTokens: 20 });
        ok(true, `Institution ${institution.id}: ${status.label} (${status.model}) answered a live request`);
      } catch (error) {
        ok(false, `Institution ${institution.id}: ${error.message}`);
        process.exitCode = 1;
      }
    }
  } finally {
    db.close();
  }
}

checkAi().catch(() => {
  ok(false, 'Could not read AI settings; check the database and run migrations');
  process.exitCode = 1;
});
