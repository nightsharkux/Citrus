'use strict';
/**
 * Retrieval over the institution's approved knowledge library.
 *
 * Indexes are rebuilt automatically when the library changes (detected with a
 * cheap signature query), so callers never need to invalidate anything.
 * Swap `search()` for a vector index here if you want semantic retrieval —
 * the rest of the app only depends on the returned shape.
 */
const fs = require('node:fs');
const { buildIndex, search } = require('../lib/search');

/**
 * Packs bundled with the edition (public university pages, timetable documents) are read straight from their
 * files, so they are always current with the deployment and nobody has to import them. They are searched together
 * with the entries an administrator adds. Their ids are negative so they never collide with database rows.
 */
function readPacks(files, read = (file) => fs.readFileSync(file, 'utf8')) {
  const docs = [];
  for (const file of files) {
    let text = '';
    try {
      text = read(file);
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let r;
      try {
        r = JSON.parse(line);
      } catch {
        continue;
      }
      if (!r || typeof r.title !== 'string' || typeof r.content !== 'string') continue;
      docs.push({
        id: -(docs.length + 1),
        title: r.title,
        content: r.content,
        category: String(r.category || ''),
        source_url: Array.isArray(r.sources) && r.sources[0]?.url ? String(r.sources[0].url) : String(r.source_url || ''),
        tags: Array.isArray(r.tags) ? r.tags.join(',') : '',
        volatility: r.volatility || 'stable',
        observed_on: r.observed_on || null,
      });
    }
  }
  return docs;
}

function createRetrieval(db, { packs = [], read, academic = null } = {}) {
  const cache = new Map();
  let packDocs = null;
  const bundled = () => {
    packDocs ||= readPacks(packs, read);
    return packDocs;
  };

  function indexFor(institutionId) {
    const sig = db.get('SELECT COUNT(*) n, MAX(id) maxId, MAX(updated) changed FROM institution_knowledge WHERE institution_id = ?', institutionId);
    const signature = `${sig.n}:${sig.maxId}:${sig.changed}`;
    const cached = cache.get(institutionId);
    if (cached && cached.signature === signature) return cached.index;
    const docs = db.all(
      `SELECT id, title, content, category, source_url, tags, volatility, observed_on
       FROM institution_knowledge WHERE institution_id = ?`,
      institutionId,
    );
    const index = buildIndex([...docs, ...bundled()]);
    cache.set(institutionId, { signature, index });
    return index;
  }

  /** @returns {Array<{id,title,content,category,source_url,volatility,observed_on,score}>} */
  function find(institutionId, query, { limit = 4, profile } = {}) {
    // BM25 scores depend on library size. A fixed cutoff drops real matches
    // in a new library with just one or two entries.
    // An entry an administrator imported from a bundled pack would otherwise appear twice.
    const seen = new Set();
    // A schedule question must not fall back to superseded website/calendar copies.
    if (academic?.handles(query)) return academic.find(query, { profile, limit });
    return search(indexFor(institutionId), query, { limit: limit * 2, minScore: 0 })
      .filter((hit) => {
        const key = `${hit.title}|${hit.source_url}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, limit);
  }

  return { find, bundledCount: () => bundled().length + (academic?.count() || 0) };
}

/** Shape a hit for clients: short excerpt, source link and freshness hint. */
function toSource(hit, n) {
  return {
    n,
    id: hit.id,
    title: hit.title,
    excerpt: hit.content.length > 280 ? `${hit.content.slice(0, 277)}…` : hit.content,
    url: hit.source_page && /\.pdf(?:\?|$)/i.test(hit.source_url) ? `${hit.source_url.split('#')[0]}#page=${hit.source_page}` : hit.source_url || null,
    category: hit.category || null,
    checkLive: !!hit.volatility && hit.volatility !== 'stable',
    observedOn: hit.observed_on || null,
    ...(hit.academic ? { sourceId: hit.source_id, sourcePage: hit.source_page || null, extraction: hit.extraction || null,
      partialPage: !!hit.partial_page, snapshot: true } : {}),
  };
}

module.exports = { createRetrieval, toSource };
