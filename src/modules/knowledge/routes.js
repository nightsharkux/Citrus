'use strict';
/**
 * Approved knowledge library (what the assistant may cite) and the
 * institution's AI provider choice. Administrators only.
 */
const fs = require('node:fs');
const path = require('node:path');
const { text, id, oneOf, httpUrl } = require('../../lib/validate');
const { badRequest, notFound, unavailable } = require('../../http/errors');
const { connectionTestPrompt } = require('../../ai/prompts');

const VOLATILITY = ['stable', 'term-specific', 'dynamic'];

/** Parse JSONL records in the format of resources/*.jsonl. */
function parseJsonl(content) {
  const records = [];
  for (const line of String(content).split(/\r?\n/)) {
    if (!line.trim()) continue;
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    if (!r || typeof r.title !== 'string' || typeof r.content !== 'string') continue;
    records.push({
      externalId: r.id ? String(r.id).slice(0, 80) : null,
      title: r.title.slice(0, 120),
      content: r.content.slice(0, 7000),
      category: String(r.category || '').slice(0, 80),
      sourceUrl: Array.isArray(r.sources) && r.sources[0]?.url ? String(r.sources[0].url).slice(0, 500) : String(r.source_url || '').slice(0, 500),
      tags: Array.isArray(r.tags) ? r.tags.join(',').slice(0, 200) : '',
      volatility: VOLATILITY.includes(r.volatility) ? r.volatility : 'stable',
      observedOn: r.observed_on ? String(r.observed_on).slice(0, 10) : null,
    });
  }
  return records;
}

/** Split plain text / Markdown into sections by heading or blank-line paragraphs. */
function parseText(content, fallbackTitle) {
  const sections = [];
  let current = { title: fallbackTitle, lines: [] };
  for (const line of String(content).split(/\r?\n/)) {
    const heading = /^#{1,3}\s+(.+)/.exec(line);
    if (heading) {
      if (current.lines.join('').trim()) sections.push(current);
      current = { title: heading[1].trim(), lines: [] };
    } else current.lines.push(line);
  }
  if (current.lines.join('').trim()) sections.push(current);
  return sections.map((s, i) => ({ externalId: null, title: (sections.length > 1 && s.title === fallbackTitle ? `${fallbackTitle} (${i + 1})` : s.title).slice(0, 120), content: s.lines.join('\n').trim().slice(0, 7000), category: '', sourceUrl: '', tags: '', volatility: 'stable', observedOn: null }));
}

function register(router, { db, config, ai, audit }) {
  const isoNow = () => new Date().toISOString();

  function upsert(user, records) {
    let added = 0;
    let updated = 0;
    db.transaction(() => {
      for (const r of records) {
        const existing = r.externalId && db.get('SELECT id FROM institution_knowledge WHERE institution_id = ? AND external_id = ?', user.institution_id, r.externalId);
        if (existing) {
          db.run('UPDATE institution_knowledge SET title = ?, content = ?, category = ?, source_url = ?, tags = ?, volatility = ?, observed_on = ?, updated = ? WHERE id = ?', r.title, r.content, r.category, r.sourceUrl, r.tags, r.volatility, r.observedOn, isoNow(), existing.id);
          updated += 1;
        } else {
          db.run(
            'INSERT INTO institution_knowledge(institution_id, title, content, category, source_url, tags, volatility, external_id, observed_on, updated) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            user.institution_id, r.title, r.content, r.category, r.sourceUrl, r.tags, r.volatility, r.externalId, r.observedOn, isoNow(),
          );
          added += 1;
        }
      }
    });
    return { added, updated };
  }

  // --- AI provider ---

  router.get('/api/ai/settings', (ctx) => ({ ...ai.status(ctx.user), providers: ai.providers() }), { roles: ['admin'] });

  router.patch('/api/ai/settings', async (ctx) => {
    const b = await ctx.json();
    const status = ai.setProvider(ctx.user, String(b.provider || ''));
    audit(ctx.user, 'ai_provider_changed', status.provider);
    return { ...status, providers: ai.providers() };
  }, { roles: ['admin'] });

  router.post('/api/ai/test', async (ctx) => {
    if (!ai.status(ctx.user).aiEnabled) throw unavailable('The selected AI provider is not configured');
    const started = Date.now();
    const answer = await ai.complete({ user: ctx.user, system: connectionTestPrompt(), prompt: 'Connection test from Campus OS.', maxTokens: 20 });
    return { ok: true, answer: answer.slice(0, 180), latencyMs: Date.now() - started, ...ai.status(ctx.user) };
  }, { roles: ['admin'] });

  // --- Knowledge library ---

  router.get('/api/knowledge', (ctx) => ({
    knowledge: db.all('SELECT * FROM institution_knowledge WHERE institution_id = ? ORDER BY category, title', ctx.user.institution_id),
    pack: config.site.knowledgePack ? { file: path.basename([].concat(config.site.knowledgePack)[0]), bundled: ai.bundledCount() } : null,
  }), { roles: ['admin'] });

  router.post('/api/knowledge', async (ctx) => {
    const b = await ctx.json();
    const knowledgeId = db.insert(
      'INSERT INTO institution_knowledge(institution_id, title, content, category, source_url, tags, volatility, updated) VALUES(?, ?, ?, ?, ?, ?, ?, ?)',
      ctx.user.institution_id,
      text(b.title, { min: 3, max: 120, label: 'Title' }),
      text(b.content, { min: 5, max: 7000, label: 'Content' }),
      text(b.category, { max: 80, optional: true }),
      httpUrl(b.source_url, { label: 'Source link' }),
      text(b.tags, { max: 200, optional: true }),
      oneOf(b.volatility || 'stable', VOLATILITY, 'Freshness'),
      isoNow(),
    );
    audit(ctx.user, 'knowledge_added', knowledgeId);
    ctx.status = 201;
    return { id: knowledgeId };
  }, { roles: ['admin'] });

  router.patch('/api/knowledge/:id', async (ctx) => {
    const row = db.get('SELECT * FROM institution_knowledge WHERE id = ? AND institution_id = ?', id(ctx.params.id), ctx.user.institution_id);
    if (!row) throw notFound('Entry not found');
    const b = await ctx.json();
    db.run(
      'UPDATE institution_knowledge SET title = ?, content = ?, category = ?, source_url = ?, volatility = ?, updated = ? WHERE id = ?',
      text(b.title ?? row.title, { min: 3, max: 120, label: 'Title' }),
      text(b.content ?? row.content, { min: 5, max: 7000, label: 'Content' }),
      text(b.category ?? row.category, { max: 80, optional: true }),
      httpUrl(b.source_url ?? row.source_url, { label: 'Source link' }),
      oneOf(b.volatility ?? row.volatility, VOLATILITY, 'Freshness'),
      isoNow(), row.id,
    );
    return { ok: true };
  }, { roles: ['admin'] });

  router.delete('/api/knowledge/:id', (ctx) => {
    db.run('DELETE FROM institution_knowledge WHERE id = ? AND institution_id = ?', id(ctx.params.id), ctx.user.institution_id);
    audit(ctx.user, 'knowledge_deleted', ctx.params.id);
    return { ok: true };
  }, { roles: ['admin'] });

  router.post('/api/knowledge/import', async (ctx) => {
    const b = await ctx.json(2_000_000);
    const format = oneOf(b.format, ['jsonl', 'text'], 'Format');
    const records = format === 'jsonl' ? parseJsonl(b.content) : parseText(b.content, text(b.title, { min: 3, max: 120, label: 'Title' }));
    if (!records.length) throw badRequest('Nothing to import. Check the file format.');
    const result = upsert(ctx.user, records.slice(0, 2000));
    audit(ctx.user, 'knowledge_imported', `${result.added} added, ${result.updated} updated`);
    return result;
  }, { roles: ['admin'] });

  /** Import the public reference pack bundled with this edition (e.g. OTH public information). */
  router.post('/api/knowledge/import-pack', (ctx) => {
    if (!config.site.knowledgePack) throw badRequest('This edition has no bundled knowledge pack');
    const file = path.join(config.root, [].concat(config.site.knowledgePack)[0]);
    const result = upsert(ctx.user, parseJsonl(fs.readFileSync(file, 'utf8')));
    audit(ctx.user, 'knowledge_pack_imported', `${path.basename(file)}: ${result.added} added, ${result.updated} updated`);
    return result;
  }, { roles: ['admin'] });

  router.get('/api/knowledge/settings', (ctx) => ({ institution: db.get('SELECT id, name, slug FROM institutions WHERE id = ?', ctx.user.institution_id) }), { roles: ['admin'] });

  router.patch('/api/knowledge/settings', async (ctx) => {
    const b = await ctx.json();
    db.run('UPDATE institutions SET name = ? WHERE id = ?', text(b.name, { min: 3, max: 120, label: 'University name' }), ctx.user.institution_id);
    audit(ctx.user, 'institution_renamed', b.name);
    return { ok: true };
  }, { roles: ['admin'] });
}

module.exports = { register, parseJsonl, parseText };
