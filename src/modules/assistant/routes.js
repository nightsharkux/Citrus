'use strict';
/**
 * Personal assistant with conversation threads.
 *
 * POST /api/assistant/messages streams Server-Sent Events when the client sends
 * `Accept: text/event-stream`:
 *   event: thread   { id, title }
 *   event: sources  { sources: [...] }     numbered citations from the knowledge library
 *   event: visual   { kind, content }      optional illustration cue (see src/ai/visuals.js)
 *   event: delta    { text }               incremental answer text
 *   event: done     { messageId }
 *   event: error    { message }
 * Without that header it returns the whole answer as JSON.
 */
const { text, id, optionalId } = require('../../lib/validate');
const { notFound, unavailable } = require('../../http/errors');
const { assistantPrompt } = require('../../ai/prompts');
const { extractVisual, createVisualExtractor } = require('../../ai/visuals');

function register(router, { db, ai, site, buildContext }) {
  const isoNow = () => new Date().toISOString();
  const assistantName = site.assistant;
  const parseVisual = (json) => {
    try {
      return json ? JSON.parse(json) : null;
    } catch {
      return null;
    }
  };

  const threadFor = (user, threadId) => {
    const t = db.get('SELECT * FROM assistant_threads WHERE id = ? AND user_id = ?', id(threadId), user.id);
    if (!t) throw notFound('Conversation not found');
    return t;
  };

  const listThreads = (user) => db.all(
    `SELECT t.id, t.title, t.updated, (SELECT content FROM assistant_messages m WHERE m.thread_id = t.id ORDER BY m.id DESC LIMIT 1) AS last
     FROM assistant_threads t WHERE t.user_id = ? ORDER BY t.updated DESC LIMIT 50`,
    user.id,
  ).map((t) => ({ ...t, last: t.last ? t.last.slice(0, 120) : '' }));

  router.get('/api/assistant', (ctx) => ({
    status: ai.status(ctx.user),
    name: assistantName,
    threads: listThreads(ctx.user),
  }));

  router.get('/api/assistant/threads/:id', (ctx) => {
    const t = threadFor(ctx.user, ctx.params.id);
    const messages = db.all('SELECT id, role, content, sources, visual, created FROM assistant_messages WHERE thread_id = ? ORDER BY id', t.id)
      .map((m) => ({ ...m, sources: JSON.parse(m.sources || '[]'), visual: parseVisual(m.visual) }));
    return { thread: t, messages };
  });

  router.patch('/api/assistant/threads/:id', async (ctx) => {
    const t = threadFor(ctx.user, ctx.params.id);
    const b = await ctx.json();
    db.run('UPDATE assistant_threads SET title = ? WHERE id = ?', text(b.title, { min: 1, max: 80, label: 'Title' }), t.id);
    return { ok: true };
  });

  router.delete('/api/assistant/threads/:id', (ctx) => {
    const t = threadFor(ctx.user, ctx.params.id);
    db.run('DELETE FROM assistant_threads WHERE id = ?', t.id);
    return { ok: true };
  });

  router.delete('/api/assistant/threads', (ctx) => {
    db.run('DELETE FROM assistant_threads WHERE user_id = ?', ctx.user.id);
    return { ok: true };
  });

  router.post('/api/assistant/messages', async (ctx) => {
    const user = ctx.user;
    const b = await ctx.json();
    const prompt = text(b.prompt, { min: 1, max: 4000, label: 'Message' });
    if (!ai.status(user).aiEnabled) throw unavailable(user.role === 'admin' ? 'No AI provider is connected yet. Choose one in Admin → AI & knowledge.' : 'The assistant is not connected yet. Your university administrator can enable it.');

    const threadId = optionalId(b.thread_id, 'Conversation');
    const thread = threadId
      ? threadFor(user, threadId)
      : db.get('SELECT * FROM assistant_threads WHERE id = ?', db.insert('INSERT INTO assistant_threads(user_id, title, created, updated) VALUES(?, ?, ?, ?)', user.id, prompt.replace(/\s+/g, ' ').slice(0, 60), isoNow(), isoNow()));

    const history = db.all('SELECT role, content FROM assistant_messages WHERE thread_id = ? ORDER BY id DESC LIMIT 12', thread.id).reverse();
    db.run('INSERT INTO assistant_messages(thread_id, role, content, created) VALUES(?, ?, ?, ?)', thread.id, 'user', prompt, isoNow());
    db.run('UPDATE assistant_threads SET updated = ? WHERE id = ?', isoNow(), thread.id);

    const { sources, references } = ai.retrieveContext(user, [...history.slice(-2).filter((h) => h.role === 'user').map((h) => h.content), prompt].join(' '));
    const system = assistantPrompt({ site, user, assistantName, context: buildContext(user), sources: references });

    const save = (raw, visual = null) => {
      const answer = raw.trim();
      const used = sources.filter((s) => answer.includes(`[${s.n}]`));
      const messageId = db.insert(
        'INSERT INTO assistant_messages(thread_id, role, content, sources, visual, created) VALUES(?, ?, ?, ?, ?, ?)',
        thread.id, 'assistant', answer, JSON.stringify(used), visual ? JSON.stringify(visual) : null, isoNow(),
      );
      db.run('UPDATE assistant_threads SET updated = ? WHERE id = ?', isoNow(), thread.id);
      return { messageId, used };
    };

    const wantsStream = String(ctx.req.headers.accept || '').includes('text/event-stream');
    if (!wantsStream) {
      const { visual, text: answer } = extractVisual(await ai.complete({ user, system, prompt, history }));
      const { messageId, used } = save(answer, visual);
      return { thread: { id: thread.id, title: thread.title }, message: { id: messageId, role: 'assistant', content: answer.trim(), sources: used, visual } };
    }

    const res = ctx.res;
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const controller = new AbortController();
    const abort = () => controller.abort();
    res.on('close', abort);

    send('thread', { id: thread.id, title: thread.title });
    send('sources', { sources });
    let answer = '';
    const cues = createVisualExtractor();
    const emit = (piece) => {
      if (!piece) return;
      answer += piece;
      send('delta', { text: piece });
    };
    try {
      let announced = false;
      for await (const delta of ai.stream({ user, system, prompt, history, signal: controller.signal })) {
        emit(cues.push(delta));
        if (!announced && cues.visual) {
          announced = true;
          send('visual', cues.visual);
        }
      }
      emit(cues.end());
      if (answer.trim()) {
        const { messageId, used } = save(answer, cues.visual);
        send('done', { messageId, sources: used, visual: cues.visual });
      } else if (!controller.signal.aborted) {
        send('error', { message: 'The assistant returned an empty answer. Please try again.' });
      }
    } catch (error) {
      if (answer.trim()) save(answer, cues.visual);
      if (!controller.signal.aborted) send('error', { message: error.status ? error.message : 'The assistant could not finish this answer.' });
    }
    res.off('close', abort);
    res.end();
  });

  /** Knowledge search for everyone (Campus guide search box). */
  router.get('/api/knowledge/search', (ctx) => {
    const q = String(ctx.query.get('q') || '').trim().slice(0, 200);
    return { results: q.length < 2 ? [] : ai.retrieve(ctx.user, q, 8) };
  });
}

module.exports = { register };
