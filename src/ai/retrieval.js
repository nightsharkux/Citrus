'use strict';
/**
 * Retrieval over the institution's approved knowledge library.
 *
 * Indexes are rebuilt automatically when the library changes (detected with a
 * cheap signature query), so callers never need to invalidate anything.
 * Swap `search()` for a vector index here if you want semantic retrieval —
 * the rest of the app only depends on the returned shape.
 */
const { buildIndex, search } = require('../lib/search');

function createRetrieval(db) {
  const cache = new Map();

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
    const index = buildIndex(docs);
    cache.set(institutionId, { signature, index });
    return index;
  }

  /** @returns {Array<{id,title,content,category,source_url,volatility,observed_on,score}>} */
  function find(institutionId, query, { limit = 4 } = {}) {
    // BM25 scores depend on library size. A fixed cutoff drops real matches
    // in a new library with just one or two entries.
    return search(indexFor(institutionId), query, { limit, minScore: 0 });
  }

  return { find };
}

/** Shape a hit for clients: short excerpt, source link and freshness hint. */
function toSource(hit, n) {
  return {
    n,
    id: hit.id,
    title: hit.title,
    excerpt: hit.content.length > 280 ? `${hit.content.slice(0, 277)}…` : hit.content,
    url: hit.source_url || null,
    category: hit.category || null,
    checkLive: !!hit.volatility && hit.volatility !== 'stable',
    observedOn: hit.observed_on || null,
  };
}

module.exports = { createRetrieval, toSource };
