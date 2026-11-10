'use strict';
/**
 * Import a knowledge file into the approved library from the command line, without the browser.
 *
 *   node --env-file=.env scripts/import-knowledge.js path/to/file.txt [institution-id]
 *
 * Accepts the CampusOS university document corpus (.txt, one entry per PDF page, with file and page in each entry),
 * a .jsonl file, or plain text / Markdown. Importing the same corpus again updates the entries instead of duplicating them.
 */
const fs = require('node:fs');
const path = require('node:path');
const { loadConfig } = require('../src/config');
const { openConfiguredDatabase } = require('../src/db/database');
const { runMigrations } = require('../src/db/migrate');
const { parseJsonl, parseText, parseCorpus, isCorpus } = require('../src/modules/knowledge/routes');

const file = process.argv[2];
if (!file || !fs.existsSync(file)) {
  console.error('Usage: node --env-file=.env scripts/import-knowledge.js <file> [institution-id]');
  process.exit(1);
}
const content = fs.readFileSync(file, 'utf8');
const records = /\.jsonl?$/i.test(file) ? parseJsonl(content) : isCorpus(content) ? parseCorpus(content) : parseText(content, path.basename(file).replace(/\.[^.]+$/, ''));
if (!records.length) {
  console.error('Nothing to import. Check the file format.');
  process.exit(1);
}

const db = openConfiguredDatabase(loadConfig());
runMigrations(db, { log: () => {} });
const institution = Number(process.argv[3]) || db.get('SELECT id FROM institutions ORDER BY id LIMIT 1')?.id;
if (!institution) {
  console.error('No institution yet. Run setup-admin.js first.');
  process.exit(1);
}
const now = new Date().toISOString();
let added = 0;
let updated = 0;
db.transaction(() => {
  for (const r of records) {
    const existing = r.externalId && db.get('SELECT id FROM institution_knowledge WHERE institution_id = ? AND external_id = ?', institution, r.externalId);
    if (existing) {
      db.run('UPDATE institution_knowledge SET title = ?, content = ?, category = ?, source_url = ?, tags = ?, volatility = ?, observed_on = ?, updated = ? WHERE id = ?', r.title, r.content, r.category, r.sourceUrl, r.tags, r.volatility, r.observedOn, now, existing.id);
      updated += 1;
    } else {
      db.run('INSERT INTO institution_knowledge(institution_id, title, content, category, source_url, tags, volatility, external_id, observed_on, updated) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', institution, r.title, r.content, r.category, r.sourceUrl, r.tags, r.volatility, r.externalId, r.observedOn, now);
      added += 1;
    }
  }
});
db.close();
console.log(`${path.basename(file)}: ${added} added, ${updated} updated (${records.length} entries).`);
