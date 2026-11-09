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
 *
 * Body: { prompt, thread_id?, attachments?, mode?, web? }. mode 'voice' (the spoken
 * conversation) asks for short answers written to be read aloud; default 'text'.
 * web: 'auto' (default: the model searches the web when it needs to), 'on' (search
 * first; the stream then starts with `event: searching`) or 'off'. Web search only
 * runs when the institution allows it. Pages the answer links to from a search are
 * added to the sources with { web: true, site }.
 */
const { text, id, optionalId, oneOf } = require('../../lib/validate');
const { notFound, unavailable, badRequest } = require('../../http/errors');
const { assistantPrompt, translationPrompt, referenceBlock } = require('../../ai/prompts');
const { extractLead, createLeadExtractor } = require('../../ai/actions');
const { createActionRunner } = require('./actions');
const { createAttachments } = require('./attachments');
const { assistantNameFor } = require('../account/preferences');

/** What the browser heard in the latest message: its language (as the browser judged it) and the recogniser's. */
function readHeard(b) {
  const heard = ['de', 'en'].includes(b.heard) ? b.heard : null;
  const recogniser = b.recogniser === 'multi' ? 'German and English together' : /^[a-z]{2}-[A-Z]{2}$/.test(String(b.recogniser || '')) ? b.recogniser : null;
  return { heard, recogniser, spoken: b.mode === 'voice' || b.spoken === true };
}

/** The few device settings the browser reports with a message, so the assistant knows what "faster" is relative to. */
function readDevice(input) {
  const d = input && typeof input === 'object' ? input : {};
  const out = {};
  const rate = Number(d.voiceRate);
  if (Number.isFinite(rate) && rate >= 0.5 && rate <= 2) out.voiceRate = Math.round(rate * 100) / 100;
  if (['natural', 'calm', 'bright', 'deep', 'quick'].includes(d.voiceStyle)) out.voiceStyle = d.voiceStyle;
  if (['female', 'male', 'any'].includes(d.voiceGender)) out.voiceGender = d.voiceGender;
  if (['spoken', 'always', 'never'].includes(d.readAloud)) out.readAloud = d.readAloud;
  return out;
}

/** Long enough for worked examples with formulas; reasoning models also spend this budget thinking. */
const ANSWER_TOKENS = 2600;

function register(router, { db, ai, site, buildContext, config, access, timetable, audit, studyGroups, campusPosts }) {
  const runner = createActionRunner({ db, config, access, timetable, audit, studyGroups, campusPosts });
  const attachments = createAttachments({ db });
  const isoNow = () => new Date().toISOString();
  router.post('/api/assistant/translate', async (ctx) => {
    const b = await ctx.json();
    const target = oneOf(b.target, ['de', 'en'], 'Language');
    let content;
    if (b.message_id !== undefined) {
      const message = access.assistantMessage(ctx.user, id(b.message_id));
      if (!message) throw notFound('Message not found');
      content = message.content;
    } else {
      if (typeof b.text !== 'string' || b.text.length > 16000) throw badRequest('Text must contain at most 16000 characters');
      content = text(b.text, { min: 1, max: 16000 });
    }
    if (!ai.status(ctx.user).aiEnabled) throw unavailable('The assistant is not connected yet. Your university administrator can enable it.');
    const translated = await ai.complete({ user: ctx.user, system: translationPrompt(target),
      prompt: referenceBlock('TRANSLATION', content), maxTokens: 6000, task: 'translation' });
    return { text: translated, target };
  });
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
    if (!done.length) return { id: m.id, role: m.role, content: m.content };
    return { id: m.id, role: m.role, content: `${m.content}\n(The app ran: ${done.map((r) => `${r.name} on event id ${r.eventId}, ${r.detail}`).join('; ')}.)` };
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

  /**
   * Conversation starters made from the user's own situation (their next exam, next class, a topic they
   * found hard), so the first message needs no explaining. The client falls back to generic ones.
   */
  function starters(user) {
    const clip = (t) => (t.length > 44 ? `${t.slice(0, 43)}…` : t);
    const now = Date.now();
    const events = timetable.upcoming(user, { days: 30, limit: 80 });
    const due = events.find((e) => e.kind === 'exam' || e.kind === 'deadline');
    const next = events.find((e) => Date.parse(e.starts) > now && Date.parse(e.starts) < now + 2 * 86_400_000 && e.kind !== 'exam' && e.kind !== 'deadline');
    const out = [];
    if (user.role === 'student') {
      if (due) out.push(['target', `How do I get ready for “${clip(due.title)}”?`]);
      if (next) out.push(['calendar', `What should I know before “${clip(next.title)}”?`]);
      const hard = db.get(
        `SELECT t.title FROM responses r JOIN topics t ON t.id = r.topic_id JOIN lectures l ON l.id = t.lecture_id JOIN courses c ON c.id = l.course_id
         WHERE r.user_id = ? AND c.institution_id = ? AND r.level < 3 ORDER BY r.created DESC LIMIT 1`, user.id, user.institution_id,
      );
      if (hard) out.push(['bulb', `Explain “${clip(hard.title)}” again, simply`]);
      if (events.length) out.push(['clock', 'Plan my study time this week']);
    } else {
      if (next) out.push(['presentation', `Help me prepare “${clip(next.title)}”`]);
      if (due) out.push(['clipboard', `What is coming up with “${clip(due.title)}”?`]);
      out.push(['bulb', 'Which topics should I revisit with my students?']);
    }
    return out.slice(0, 4);
  }

  router.get('/api/assistant', (ctx) => ({
    status: ai.status(ctx.user),
    name: assistantNameFor(ctx.user, site),
    threads: listThreads(ctx.user),
    starters: starters(ctx.user),
  }));

  router.get('/api/assistant/threads/:id', (ctx) => {
    const t = threadFor(ctx.user, ctx.params.id);
    const messages = db.all('SELECT id, role, content, sources, visual, actions, created FROM assistant_messages WHERE thread_id = ? ORDER BY id', t.id)
      .map((m) => ({ ...m, sources: JSON.parse(m.sources || '[]'), visual: parseJson(m.visual), actions: parseJson(m.actions, []).map(runner.publicView) }));
    const files = attachments.forMessages(messages.map((m) => m.id));
    return { thread: t, messages: messages.map((m) => ({ ...m, attachments: files.get(m.id) || [] })) };
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
    const files = attachments.claim(user, b.attachments);
    const prompt = files.length ? text(b.prompt, { max: 4000, optional: true, label: 'Message' }) : text(b.prompt, { min: 1, max: 4000, label: 'Message' });
    const voice = oneOf(b.mode ?? 'text', ['text', 'voice'], 'Mode') === 'voice';
    // Web search: 'auto' lets the model search when it needs to, 'on' (the globe button) searches first, 'off' never.
    const webChoice = oneOf(b.web ?? 'auto', ['auto', 'on', 'off'], 'Web search');
    const web = !ai.status(user).webSearch || webChoice === 'off' ? null : webChoice === 'on' ? 'required' : 'auto';
    if (!ai.status(user).aiEnabled) throw unavailable(user.role === 'admin' ? 'No AI provider is connected yet. Choose one in Admin → AI & knowledge.' : 'The assistant is not connected yet. Your university administrator can enable it.');

    const threadId = optionalId(b.thread_id, 'Conversation');
    const thread = threadId
      ? threadFor(user, threadId)
      : db.get('SELECT * FROM assistant_threads WHERE id = ?', db.insert('INSERT INTO assistant_threads(user_id, title, created, updated) VALUES(?, ?, ?, ?)', user.id, (prompt || files[0].name).replace(/\s+/g, ' ').slice(0, 60), isoNow(), isoNow()));

    const history = attachments.decorate(db.all('SELECT id, role, content, actions FROM assistant_messages WHERE thread_id = ? ORDER BY id DESC LIMIT 24', thread.id).reverse().map(withActions));
    const userMessageId = db.insert('INSERT INTO assistant_messages(thread_id, role, content, created) VALUES(?, ?, ?, ?)', thread.id, 'user', prompt, isoNow());
    attachments.link(files, userMessageId);
    db.run('UPDATE assistant_threads SET updated = ? WHERE id = ?', isoNow(), thread.id);

    const { sources, references } = ai.retrieveContext(user, [...history.filter((h) => h.role === 'user').map((h) => h.content), prompt].join('\n'));
    const seen = attachments.forModel(files);
    const turn = { text: [prompt || 'Please look at what I attached and tell me what it is and what I can do with it.', ...seen.blocks].join('\n\n'), images: seen.images };
    const system = assistantPrompt({ site, user, assistantName: assistantNameFor(user, site), context: buildContext(user, { query: [...history.filter((h) => h.role === 'user').map((h) => h.content), prompt].join('\n'), assistantName: assistantNameFor(user, site), device: readDevice(b.device) }), sources: references, attached: files.length > 0 || history.some((h) => h.images?.length || h.content.includes("<ATTACHMENT>")), voice, web, language: { ui: user.preferences?.language || null, answer: user.preferences?.answerLanguage || 'match', ...readHeard(b) } });

    // Pages from the web that the answer links to become sources too, numbered after the library's.
    let searched = false;
    const onMeta = (meta) => { searched = !!meta?.searched; };
    const webSources = (answer, from) => {
      if (!searched) return [];
      const known = new Set(sources.map((s) => s.url).filter(Boolean));
      const found = [];
      for (const m of answer.matchAll(/\[([^\]\n]{1,140})\]\((https?:\/\/[^\s)]+)\)/g)) {
        const url = m[2].replace(/[.,;]+$/, '');
        if (known.has(url) || found.some((f) => f.url === url)) continue;
        let host = '';
        try {
          host = new URL(url).hostname.replace(/^www\./, '');
        } catch {
          continue;
        }
        found.push({ n: from + found.length + 1, title: m[1].replace(/[*_`]/g, '').trim() || host, url, web: true, site: host });
        if (found.length >= 8) break;
      }
      return found;
    };

    const save = (raw, visual = null, results = []) => {
      const answer = raw.trim();
      const cited = sources.filter((s) => answer.includes(`[${s.n}]`));
      const used = [...cited, ...webSources(answer, sources.length)];
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
      const lead = extractLead(await ai.complete({ user, system, prompt: turn, history, maxTokens: ANSWER_TOKENS, task: voice ? 'voice' : 'chat', web, onMeta }), (action) => results.push(runner.run(user, action)));
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
    if (web === 'required') send('searching', {}); // the page says "Searching the web" until the answer starts
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
      for await (const delta of ai.stream({ user, system, prompt: turn, history, signal: controller.signal, maxTokens: ANSWER_TOKENS, task: voice ? 'voice' : 'chat', web, onMeta })) {
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

  // ---- Attachments: upload first, then send the message with the returned ids.
  router.post('/api/assistant/attachments', async (ctx) => {
    const b = await ctx.json(4_400_000);
    return { attachment: attachments.add(ctx.user, b) };
  }, { maxBody: 4_400_000 });

  router.get('/api/assistant/attachments/:id/file', (ctx) => {
    const f = attachments.file(ctx.user, id(ctx.params.id));
    ctx.res.writeHead(200, { 'Content-Type': f.mime, 'Content-Length': f.bytes.length, 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'inline' });
    ctx.res.end(f.bytes);
  });

  router.delete('/api/assistant/attachments/:id', (ctx) => {
    attachments.remove(ctx.user, id(ctx.params.id));
    return { ok: true };
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
