'use strict';
/**
 * BM25 full-text ranking for the knowledge library. Small, dependency-free and
 * good enough for a few thousand records. Replace with an embedding index in
 * src/ai/retrieval.js if you need semantic search.
 */
const STOPWORDS = new Set((
  'a an and are as at be but by can do does for from has have how i if in into is it its me my no not of on or our ' +
  'so that the their then there these this to was we were what when where which who why will with you your ' +
  'der die das und ist im in den dem des ein eine einer zu mit von für auf an wie was wo wann ich du sie es nicht'
).split(' '));

function tokenize(text) {
  return String(text)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
    .map(stem);
}

/** Very light stemming: enough to match "lectures"/"lecture", "exams"/"exam". */
function stem(token) {
  if (token.length > 4 && token.endsWith('ies')) return token.slice(0, -3) + 'y';
  if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1);
  return token;
}

function buildIndex(docs, fields = (d) => `${d.title} ${d.title} ${d.tags || ''} ${d.content}`) {
  const postings = new Map();
  const lengths = [];
  docs.forEach((doc, i) => {
    const terms = tokenize(fields(doc));
    lengths[i] = terms.length;
    const counts = new Map();
    for (const t of terms) counts.set(t, (counts.get(t) || 0) + 1);
    for (const [t, tf] of counts) {
      if (!postings.has(t)) postings.set(t, []);
      postings.get(t).push([i, tf]);
    }
  });
  const avg = lengths.reduce((a, b) => a + b, 0) / Math.max(1, lengths.length);
  return { docs, postings, lengths, avg };
}

function search(index, query, { limit = 5, k1 = 1.4, b = 0.75, minScore = 0.5 } = {}) {
  const terms = [...new Set(tokenize(query))];
  if (!terms.length || !index.docs.length) return [];
  const scores = new Map();
  const N = index.docs.length;
  for (const term of terms) {
    const list = index.postings.get(term);
    if (!list) continue;
    const idf = Math.log(1 + (N - list.length + 0.5) / (list.length + 0.5));
    for (const [i, tf] of list) {
      const norm = tf * (k1 + 1) / (tf + k1 * (1 - b + b * index.lengths[i] / index.avg));
      scores.set(i, (scores.get(i) || 0) + idf * norm);
    }
  }
  return [...scores.entries()]
    .filter(([, s]) => s >= minScore)
    .sort((x, y) => y[1] - x[1])
    .slice(0, limit)
    .map(([i, score]) => ({ ...index.docs[i], score: Math.round(score * 100) / 100 }));
}

module.exports = { tokenize, buildIndex, search };
