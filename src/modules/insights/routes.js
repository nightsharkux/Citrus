'use strict';
/**
 * Lecture insights: while a lecture is captioned, Citrus picks out the points
 * worth remembering (definitions, formulas, examples, what the lecturer stressed,
 * announcements, questions) in small steps, so students get live notes and the
 * lecturer gets a record of what was covered and what was unclear.
 *
 *   GET    /api/workspaces/:id/insights                 key points, my marks, study notes
 *   POST   /api/workspaces/:id/insights/extract         (speaker) look at the new captions now
 *   POST   /api/workspaces/:id/insights                 (speaker) add a point by hand
 *   DELETE /api/workspaces/:id/insights/:iid            (speaker)
 *   POST   /api/workspaces/:id/insights/:iid/mark       { mark: 'saved' | 'unclear', on }
 *   POST   /api/workspaces/:id/insights/digest          (speaker) make and share study notes
 *
 * Work is driven by the speaker's browser (it asks every minute or so), not by
 * a background job, so it also runs on hosts that stop work after each request.
 * Each step looks only at captions it has not seen yet and is told what was
 * already captured, which keeps it quick, cheap and free of repeats.
 */
const { text, oneOf, id } = require('../../lib/validate');
const { forbidden, notFound, badRequest } = require('../../http/errors');
const prompts = require('../../ai/prompts');
const { KINDS, parseInsights, dropRepeats, basicInsights, cleanPoint } = require('./extract');

const MIN_CHARS = 500;     // wait for about 40 seconds of speech before a look
const FORCE_MIN = 80;      // "capture now" and the final pass accept less
const MIN_GAP_MS = 20_000; // never look more often than this
const LOCK_MS = 90_000;    // a look that never finished stops blocking after this

function register(router, { db, access, ai, bus, audit, notifier }) {
  const isoNow = () => new Date().toISOString();
  const member = (user, wid) => {
    const w = access.workspaceMember(user, id(wid));
    if (!w) throw forbidden('You are not a member of this space');
    return w;
  };
  const speaker = (user, w) => access.teachesWorkspace(user, w) || w.creator_id === user.id;
  const needSpeaker = (user, w) => {
    if (!speaker(user, w)) throw forbidden('Only the lecturer or space owner can do this');
  };
  const jsonOr = (value, fallback) => {
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  };

  const shape = (row, mine = new Set(), unclear = null) => ({
    id: row.id, kind: row.kind, title: row.title, body: row.body, formula: row.formula, importance: row.importance, topic: row.topic, source: row.source, created: row.created,
    saved: mine.has(`${row.id}:saved`), unclear: mine.has(`${row.id}:unclear`),
    ...(unclear ? { unclearCount: unclear.get(row.id) || 0 } : {}),
  });

  const state = (wid) => {
    db.run('INSERT OR IGNORE INTO lecture_insight_state(workspace_id) VALUES(?)', wid);
    return db.get('SELECT * FROM lecture_insight_state WHERE workspace_id = ?', wid);
  };

  function insertPoints(w, points, { from = 0, to = 0, topic = '' }) {
    const at = isoNow();
    return points.map((p) => {
      const insightId = db.insert(
        `INSERT INTO lecture_insights(workspace_id, kind, title, body, formula, importance, topic, source, from_caption, to_caption, created)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        w.id, p.kind, p.title, p.body, p.formula, p.importance, topic, p.source, from, to, at,
      );
      const row = shape({ ...p, id: insightId, topic, created: at });
      bus.publish(`workspace:${w.id}`, 'insight', { workspaceId: w.id, insight: row });
      return row;
    });
  }

  /**
   * Look at the captions that arrived since the last look and keep what matters.
   * Returns { added, waiting?, error? }. Never throws for AI trouble: the lecture goes on.
   */
  async function lookAtNewCaptions(user, w, { force = false } = {}) {
    const st = state(w.id);
    const now = Date.now();
    if (!force && now - st.last_run < MIN_GAP_MS) return { added: [], waiting: 'recent' };
    const claimed = db.run('UPDATE lecture_insight_state SET running_since = ? WHERE workspace_id = ? AND running_since < ?', now, w.id, now - LOCK_MS).changes;
    if (!claimed) return { added: [], waiting: 'busy' };

    let outcome = { added: [], waiting: 'short' };
    let lastRun = st.last_run;
    try {
      const rows = db.all('SELECT id, text FROM live_captions WHERE workspace_id = ? AND id > ? ORDER BY id LIMIT 150', w.id, st.last_caption);
      const transcript = rows.map((r) => r.text).join(' ');
      if (transcript.length < (force ? FORCE_MIN : MIN_CHARS)) return outcome;
      lastRun = now;

      const known = db.all('SELECT title FROM lecture_insights WHERE workspace_id = ? ORDER BY id DESC LIMIT 30', w.id).map((r) => r.title).reverse();
      let parsed = null;
      if (ai.status(user).aiEnabled) {
        try {
          const reply = await ai.complete({
            user, task: 'summary', maxTokens: 900,
            system: prompts.lectureInsightsPrompt({ title: w.title, topic: st.topic, known: known.slice(-20) }),
            prompt: prompts.referenceBlock('TRANSCRIPT', transcript.slice(-7000)),
          });
          parsed = parseInsights(reply, 'ai');
        } catch (error) {
          // Rate limit or provider trouble: keep the captions for the next look instead of losing them.
          return { added: [], error: error.message || 'The assistant is busy', retry: true };
        }
        parsed ||= basicInsights(transcript);
      } else {
        parsed = basicInsights(transcript);
      }
      const points = dropRepeats(parsed.points, known);
      const from = rows[0].id;
      const to = rows[rows.length - 1].id;
      const topic = parsed.topic || st.topic;
      const added = db.transaction(() => {
        const inserted = insertPoints(w, points, { from, to, topic });
        db.run('UPDATE lecture_insight_state SET last_caption = ?, topic = ? WHERE workspace_id = ?', to, topic, w.id);
        return inserted;
      });
      outcome = { added, topic, source: points[0]?.source || (ai.status(user).aiEnabled ? 'ai' : 'basic') };
      return outcome;
    } finally {
      db.run('UPDATE lecture_insight_state SET running_since = 0, last_run = ? WHERE workspace_id = ?', lastRun, w.id);
    }
  }

  // ---------------------------------------------------------------- reading

  router.get('/api/workspaces/:id/insights', (ctx) => {
    const u = ctx.user;
    const w = member(u, ctx.params.id);
    const manage = speaker(u, w);
    const after = Number(ctx.query.get('after') || 0) || 0;
    const rows = db.all('SELECT * FROM lecture_insights WHERE workspace_id = ? AND id > ? ORDER BY id LIMIT 400', w.id, after);
    const mine = new Set(db.all('SELECT insight_id, mark FROM lecture_insight_marks WHERE user_id = ? AND insight_id IN (SELECT id FROM lecture_insights WHERE workspace_id = ?)', u.id, w.id).map((m) => `${m.insight_id}:${m.mark}`));
    const unclear = manage
      ? new Map(db.all("SELECT insight_id, COUNT(*) n FROM lecture_insight_marks WHERE mark = 'unclear' AND insight_id IN (SELECT id FROM lecture_insights WHERE workspace_id = ?) GROUP BY insight_id", w.id).map((r) => [r.insight_id, r.n]))
      : null;
    const d = db.get('SELECT * FROM lecture_digests WHERE workspace_id = ?', w.id);
    const st = db.get('SELECT topic FROM lecture_insight_state WHERE workspace_id = ?', w.id);
    return {
      live: !!w.live,
      canManage: manage,
      aiEnabled: ai.status(u).aiEnabled,
      topic: st?.topic || '',
      insights: rows.map((r) => shape(r, mine, unclear)),
      digest: d ? {
        summary: d.summary, glossary: jsonOr(d.glossary, []), questions: jsonOr(d.questions, []), source: d.source, created: d.created,
        ...(manage ? { followUps: jsonOr(d.follow_ups, []) } : {}),
      } : null,
    };
  });

  // ---------------------------------------------------------------- speaker

  router.post('/api/workspaces/:id/insights/extract', async (ctx) => {
    const w = member(ctx.user, ctx.params.id);
    needSpeaker(ctx.user, w);
    const b = await ctx.json().catch(() => ({}));
    return lookAtNewCaptions(ctx.user, w, { force: !!b.force });
  });

  router.post('/api/workspaces/:id/insights', async (ctx) => {
    const w = member(ctx.user, ctx.params.id);
    needSpeaker(ctx.user, w);
    const b = await ctx.json();
    const point = cleanPoint({
      kind: oneOf(b.kind || 'important', KINDS, 'Type'),
      title: text(b.title, { min: 3, max: 90, label: 'Title' }),
      body: text(b.body, { max: 400, optional: true }),
      formula: text(b.formula, { max: 200, optional: true }),
      importance: 3,
    }, 'lecturer');
    const topic = db.get('SELECT topic FROM lecture_insight_state WHERE workspace_id = ?', w.id)?.topic || '';
    const last = db.get('SELECT MAX(id) n FROM live_captions WHERE workspace_id = ?', w.id).n || 0;
    const [row] = insertPoints(w, [point], { from: last, to: last, topic });
    audit(ctx.user, 'lecture_insight_added', `space ${w.id}`);
    ctx.status = 201;
    return { insight: row };
  });

  router.delete('/api/workspaces/:id/insights/:iid', (ctx) => {
    const w = member(ctx.user, ctx.params.id);
    needSpeaker(ctx.user, w);
    const removed = db.run('DELETE FROM lecture_insights WHERE id = ? AND workspace_id = ?', id(ctx.params.iid), w.id).changes;
    if (!removed) throw notFound('Point not found');
    bus.publish(`workspace:${w.id}`, 'insight.removed', { workspaceId: w.id, id: Number(ctx.params.iid) });
    return { ok: true };
  });

  // ---------------------------------------------------------------- everyone

  router.post('/api/workspaces/:id/insights/:iid/mark', async (ctx) => {
    const w = member(ctx.user, ctx.params.id);
    const row = db.get('SELECT id FROM lecture_insights WHERE id = ? AND workspace_id = ?', id(ctx.params.iid), w.id);
    if (!row) throw notFound('Point not found');
    const b = await ctx.json();
    const mark = oneOf(b.mark, ['saved', 'unclear'], 'Mark');
    if (b.on === false) db.run('DELETE FROM lecture_insight_marks WHERE insight_id = ? AND user_id = ? AND mark = ?', row.id, ctx.user.id, mark);
    else db.run('INSERT OR IGNORE INTO lecture_insight_marks(insight_id, user_id, mark, created) VALUES(?, ?, ?, ?)', row.id, ctx.user.id, mark, isoNow());
    return { ok: true, mark, on: b.on !== false };
  });

  // ---------------------------------------------------------------- study notes

  function parseDigest(reply) {
    const s = String(reply || '');
    const a = s.indexOf('{');
    const z = s.lastIndexOf('}');
    if (a < 0 || z <= a) return null;
    try {
      const j = JSON.parse(s.slice(a, z + 1));
      const clip = (v, n) => String(v ?? '').trim().slice(0, n);
      const summary = clip(j.summary, 4000);
      if (!summary) return null;
      return {
        summary,
        glossary: (Array.isArray(j.glossary) ? j.glossary : []).map((g) => ({ term: clip(g?.term, 80), meaning: clip(g?.meaning, 300) })).filter((g) => g.term && g.meaning).slice(0, 12),
        questions: (Array.isArray(j.questions) ? j.questions : []).map((q) => ({ question: clip(q?.question, 300), answer: clip(q?.answer, 500) })).filter((q) => q.question).slice(0, 8),
        followUps: (Array.isArray(j.followUps) ? j.followUps : []).map((f) => clip(f, 240)).filter(Boolean).slice(0, 6),
      };
    } catch {
      return null;
    }
  }

  /** Without AI: an outline from the captured points. Plain and labelled as such. */
  function basicDigest(points, unclear) {
    const lines = points.filter((p) => p.importance >= 2).slice(0, 14).map((p) => `- **${p.title}**${p.body ? `: ${p.body}` : ''}`);
    return {
      summary: lines.join('\n') || 'No key points were captured.',
      glossary: points.filter((p) => p.kind === 'definition').slice(0, 10).map((p) => ({ term: p.title, meaning: p.body || p.title })),
      questions: [],
      followUps: [
        ...points.filter((p) => (unclear.get(p.id) || 0) > 0).sort((a, b) => unclear.get(b.id) - unclear.get(a.id)).slice(0, 3).map((p) => `${unclear.get(p.id)} student${unclear.get(p.id) === 1 ? '' : 's'} marked “${p.title}” as unclear.`),
        ...points.filter((p) => p.kind === 'question').slice(0, 3).map((p) => `A question came up: ${p.title}`),
      ],
    };
  }

  router.post('/api/workspaces/:id/insights/digest', async (ctx) => {
    const u = ctx.user;
    const w = member(u, ctx.params.id);
    needSpeaker(u, w);
    await lookAtNewCaptions(u, w, { force: true }).catch(() => {}); // pick up anything said since the last look
    const points = db.all('SELECT * FROM lecture_insights WHERE workspace_id = ? ORDER BY id LIMIT 120', w.id);
    if (!points.length) throw badRequest('No key points have been captured yet. Start live captions and speak for a few minutes first.');
    const unclear = new Map(db.all("SELECT insight_id, COUNT(*) n FROM lecture_insight_marks WHERE mark = 'unclear' AND insight_id IN (SELECT id FROM lecture_insights WHERE workspace_id = ?) GROUP BY insight_id", w.id).map((r) => [r.insight_id, r.n]));

    let digest = null;
    let source = 'basic';
    if (ai.status(u).aiEnabled) {
      const transcript = db.all('SELECT text FROM live_captions WHERE workspace_id = ? ORDER BY id', w.id).map((c) => c.text).join(' ').slice(-12_000);
      try {
        const reply = await ai.complete({
          user: u, task: 'summary', maxTokens: 1800,
          system: prompts.lectureDigestPrompt({ title: w.title }),
          prompt: prompts.referenceBlock('KEY_POINTS', points.map((p) => ({ kind: p.kind, title: p.title, body: p.body, formula: p.formula, unclearVotes: unclear.get(p.id) || 0 })))
            + `\n${prompts.referenceBlock('TRANSCRIPT', transcript)}`,
        });
        digest = parseDigest(reply);
        if (digest) source = 'ai';
      } catch {
        digest = null;
      }
    }
    digest ||= basicDigest(points, unclear);
    db.run(
      `INSERT INTO lecture_digests(workspace_id, summary, glossary, questions, follow_ups, source, author_id, created) VALUES(?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(workspace_id) DO UPDATE SET summary = excluded.summary, glossary = excluded.glossary, questions = excluded.questions, follow_ups = excluded.follow_ups, source = excluded.source, author_id = excluded.author_id, created = excluded.created`,
      w.id, digest.summary, JSON.stringify(digest.glossary), JSON.stringify(digest.questions), JSON.stringify(digest.followUps), source, u.id, isoNow(),
    );
    const others = db.all('SELECT user_id FROM workspace_members WHERE workspace_id = ? AND user_id != ?', w.id, u.id).map((r) => r.user_id);
    if (others.length) notifier.notify(others, { kind: 'course', title: `${w.title}: study notes ready`, body: 'Key points, terms and self-check questions from the lecture.', link: `/spaces/${w.id}/live` });
    bus.publish(`workspace:${w.id}`, 'insight.digest', { workspaceId: w.id });
    audit(u, 'lecture_digest_created', `space ${w.id} (${source})`);
    return { digest: { ...digest, source, created: isoNow() } };
  });
}

module.exports = { register };
