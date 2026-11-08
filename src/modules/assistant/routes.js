'use strict';
/**
 * Personal assistant with conversation threads.
 *
 * POST /api/assistant/messages streams Server-Sent Events when the client sends
 * `Accept: text/event-stream`:
 *   event: thread   { id, title }
 *   event: sources  { sources: [...] }     numbered citations from the knowledge library
 *   event: visual   { kind, content }      optional illustration cue (see src/ai/visuals.js)
 *   event: action   { name, ok, title, detail?, warning?, link?, client?, error?, undoable }
 *                                          something the assistant did for the user (see ./actions.js)
 *   event: delta    { text }               incremental answer text
 *   event: done     { messageId, sources, visual, actions }
 *   event: error    { message }
 * Without that header it returns the whole answer as JSON.
 */
const { text, id, optionalId } = require('../../lib/validate');
const { notFound, unavailable } = require('../../http/errors');
const { assistantPrompt } = require('../../ai/prompts');
const { extractLead, createLeadExtractor } = require('../../ai/actions');
const { createActionRunner } = require('./actions');

/** Long enough for worked examples with formulas; reasoning models also spend this budget thinking. */
const ANSWER_TOKENS = 2600;

function register(router, { db, ai, site, buildContext, config, access, timetable, audit }) {
  const runner = createActionRunner({ db, config, access, timetable, audit });
  const isoNow = () => new Date().toISOString();
  const assistantName = site.assistant;
  const parseJson = (json, fallback = null) => {
    try {
      return json ? JSON.parse(json) : fallback;
    } catch {
      return fallback;
    }
  };

  /** Plain sentence for an answer that was only actions, so the thread (and the model's history) still reads naturally. */
  const summarise = (results) => results.map((r) => (r.ok ? `${r.title}${r.detail ? `: ${r.detail}` : ''}.` : r.error)).join(' ');

  /** What the model sees of its own earlier actions, so a follow-up like "make it an hour later" can refer to the event id. */
  const withActions = (m) => {
    const done = parseJson(m.actions, []).filter((r) => r.ok && r.eventId);
    if (!done.length) return { role: m.role, content: m.content };
    return { role: m.role, content: `${m.content}\n(The app ran: ${done.map((r) => `${r.name} on event id ${r.eventId}, ${r.detail}`).join('; ')}.)` };
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
    const messages = db.all('SELECT id, role, content, sources, visual, actions, created FROM assistant_messages WHERE thread_id = ? ORDER BY id', t.id)
      .map((m) => ({ ...m, sources: JSON.parse(m.sources || '[]'), visual: parseJson(m.visual), actions: parseJson(m.actions, []).map(runner.publicView) }));
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

    const history = db.all('SELECT role, content, actions FROM assistant_messages WHERE thread_id = ? ORDER BY id DESC LIMIT 12', thread.id).reverse().map(withActions);
    db.run('INSERT INTO assistant_messages(thread_id, role, content, created) VALUES(?, ?, ?, ?)', thread.id, 'user', prompt, isoNow());
    db.run('UPDATE assistant_threads SET updated = ? WHERE id = ?', isoNow(), thread.id);

    const { sources, references } = ai.retrieveContext(user, [...history.slice(-2).filter((h) => h.role === 'user').map((h) => h.content), prompt].join(' '));
    const system = assistantPrompt({ site, user, assistantName, context: buildContext(user), sources: references });

    const save = (raw, visual = null, results = []) => {
      const answer = raw.trim();
      const used = sources.filter((s) => answer.includes(`[${s.n}]`));
      const messageId = db.insert(
        'INSERT INTO assistant_messages(thread_id, role, content, sources, visual, actions, created) VALUES(?, ?, ?, ?, ?, ?, ?)',
        thread.id, 'assistant', answer, JSON.stringify(used), visual ? JSON.stringify(visual) : null, results.length ? JSON.stringify(results) : null, isoNow(),
      );
      db.run('UPDATE assistant_threads SET updated = ? WHERE id = ?', isoNow(), thread.id);
      return { messageId, used };
    };

    const wantsStream = String(ctx.req.headers.accept || '').includes('text/event-stream');
    if (!wantsStream) {
      const results = [];
      const lead = extractLead(await ai.complete({ user, system, prompt, history, maxTokens: ANSWER_TOKENS }), (action) => results.push(runner.run(user, action)));
      const answer = lead.text.trim() || summarise(results);
      const { messageId, used } = save(answer, lead.visual, results);
      return { thread: { id: thread.id, title: thread.title }, message: { id: messageId, role: 'assistant', content: answer, sources: used, visual: lead.visual, actions: results.map(runner.publicView) } };
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
    const results = [];
    const cues = createLeadExtractor({
      onAction(action) {
        const result = runner.run(user, action);
        results.push(result);
        send('action', runner.publicView(result));
      },
    });
    const emit = (piece) => {
      if (!piece) return;
      answer += piece;
      send('delta', { text: piece });
    };
    try {
      let announced = false;
      for await (const delta of ai.stream({ user, system, prompt, history, signal: controller.signal, maxTokens: ANSWER_TOKENS })) {
        emit(cues.push(delta));
        if (!announced && cues.visual) {
          announced = true;
          send('visual', cues.visual);
        }
      }
      emit(cues.end());
      if (!answer.trim() && results.length) emit(summarise(results));
      if (answer.trim()) {
        const { messageId, used } = save(answer, cues.visual, results);
        send('done', { messageId, sources: used, visual: cues.visual, actions: results.map(runner.publicView) });
      } else if (!controller.signal.aborted) {
        send('error', { message: 'The assistant returned an empty answer. Please try again.' });
      }
    } catch (error) {
      if (answer.trim() || results.length) save(answer.trim() ? answer : summarise(results), cues.visual, results);
      if (!controller.signal.aborted) send('error', { message: error.status ? error.message : 'The assistant could not finish this answer.' });
    }
    res.off('close', abort);
    res.end();
  });

  /** Undo something the assistant did. The server keeps the undo data; the client only says which result. */
  router.post('/api/assistant/messages/:id/actions/:index/undo', (ctx) => {
    const message = db.get(
      `SELECT m.id, m.actions FROM assistant_messages m JOIN assistant_threads t ON t.id = m.thread_id
       WHERE m.id = ? AND t.user_id = ?`, id(ctx.params.id), ctx.user.id,
    );
    if (!message) throw notFound('Message not found');
    const results = parseJson(message.actions, []);
    const index = Number(ctx.params.index);
    if (!Number.isInteger(index) || !results[index]) throw notFound('Action not found');
    results[index] = runner.undo(ctx.user, results[index]);
    db.run('UPDATE assistant_messages SET actions = ? WHERE id = ?', JSON.stringify(results), message.id);
    return { action: runner.publicView(results[index]) };
  });

  /** Knowledge search for everyone (Campus guide search box). */
  router.get('/api/knowledge/search', (ctx) => {
    const q = String(ctx.query.get('q') || '').trim().slice(0, 200);
    return { results: q.length < 2 ? [] : ai.retrieve(ctx.user, q, 8) };
  });
}

module.exports = { register };
