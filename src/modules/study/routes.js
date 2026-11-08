'use strict';
/** Spaced review queue, revision packs and per-course progress. */
const { id, oneOf } = require('../../lib/validate');
const { badRequest, forbidden, notFound, unavailable } = require('../../http/errors');
const { GRADES } = require('./review');
const { revisionPrompt, revisionSystemPrompt } = require('../../ai/prompts');

/** Extract and validate a JSON question array from model output. */
function parseQuestions(raw) {
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  let list;
  try {
    list = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return [];
  }
  return (Array.isArray(list) ? list : [])
    .filter((q) => q && typeof q.question === 'string' && q.question.trim() && Array.isArray(q.options) && q.options.length === 4 && q.options.every((o) => typeof o === 'string' && o.trim()) && Number.isInteger(q.answer) && q.answer >= 0 && q.answer < q.options.length && (q.explanation === undefined || typeof q.explanation === 'string'))
    .slice(0, 10)
    .map((q) => ({ question: q.question.trim().slice(0, 300), options: q.options.map((o) => o.trim().slice(0, 160)), answer: q.answer, explanation: (q.explanation || '').trim().slice(0, 400) }))
    .filter((q) => new Set(q.options).size === 4);
}

function register(router, { db, access, ai, review }) {
  const isoNow = () => new Date().toISOString();
  const studentOnly = (user) => {
    if (user.role !== 'student') throw forbidden('This is part of the student learning area');
  };

  router.get('/api/review', (ctx) => {
    studentOnly(ctx.user);
    return { ...review.queue(ctx.user), grades: GRADES };
  });

  router.post('/api/review/:id', async (ctx) => {
    studentOnly(ctx.user);
    const b = await ctx.json();
    const item = review.grade(ctx.user, id(ctx.params.id), oneOf(b.grade, GRADES, 'Grade'));
    if (!item) throw notFound('Review item not found');
    return { item };
  });

  router.get('/api/progress', (ctx) => {
    studentOnly(ctx.user);
    const courses = db.prepare(
      `SELECT c.id, c.code, c.title,
         (SELECT COUNT(*) FROM topics t JOIN lectures l ON l.id = t.lecture_id WHERE l.course_id = c.id) AS topics,
         (SELECT COUNT(*) FROM responses r JOIN topics t ON t.id = r.topic_id JOIN lectures l ON l.id = t.lecture_id WHERE l.course_id = c.id AND r.user_id = @uid) AS rated,
         (SELECT COUNT(*) FROM responses r JOIN topics t ON t.id = r.topic_id JOIN lectures l ON l.id = t.lecture_id WHERE l.course_id = c.id AND r.user_id = @uid AND r.level = 3) AS understood,
         (SELECT COUNT(*) FROM poll_answers pa JOIN polls p ON p.id = pa.poll_id JOIN topics t ON t.id = p.topic_id JOIN lectures l ON l.id = t.lecture_id WHERE l.course_id = c.id AND pa.user_id = @uid) AS answered,
         (SELECT COUNT(*) FROM poll_answers pa JOIN polls p ON p.id = pa.poll_id JOIN topics t ON t.id = p.topic_id JOIN lectures l ON l.id = t.lecture_id WHERE l.course_id = c.id AND pa.user_id = @uid AND pa.answer = p.correct) AS correct
       FROM courses c JOIN enrollments e ON e.course_id = c.id AND e.user_id = @uid ORDER BY c.code`,
    ).all({ uid: ctx.user.id });
    return { courses };
  });

  // --- Revision packs ---

  router.get('/api/revision', (ctx) => {
    studentOnly(ctx.user);
    const packs = db.all(
      'SELECT p.id, p.title, p.source, p.best_score, p.created, p.questions, c.code FROM revision_packs p LEFT JOIN courses c ON c.id = p.course_id WHERE p.user_id = ? ORDER BY p.id DESC',
      ctx.user.id,
    ).map(({ questions, ...p }) => ({ ...p, count: JSON.parse(questions).length }));
    return { packs };
  });

  router.get('/api/revision/:id', (ctx) => {
    studentOnly(ctx.user);
    const pack = db.get('SELECT * FROM revision_packs WHERE id = ? AND user_id = ?', id(ctx.params.id), ctx.user.id);
    if (!pack) throw notFound('Revision pack not found');
    return { pack: { ...pack, questions: JSON.parse(pack.questions) } };
  });

  router.delete('/api/revision/:id', (ctx) => {
    db.run('DELETE FROM revision_packs WHERE id = ? AND user_id = ?', id(ctx.params.id), ctx.user.id);
    return { ok: true };
  });

  router.post('/api/revision', async (ctx) => {
    studentOnly(ctx.user);
    const b = await ctx.json();
    const course = access.course(ctx.user, id(b.course_id, 'Course'));
    if (!course) throw forbidden('Join this course first');

    const topics = db.all('SELECT t.title FROM topics t JOIN lectures l ON l.id = t.lecture_id WHERE l.course_id = ? ORDER BY t.id DESC LIMIT 30', course.id).map((t) => t.title);
    const focus = db.all(
      'SELECT t.title FROM responses r JOIN topics t ON t.id = r.topic_id JOIN lectures l ON l.id = t.lecture_id WHERE l.course_id = ? AND r.user_id = ? AND r.level < 3',
      course.id, ctx.user.id,
    ).map((t) => t.title);

    let questions = [];
    let source = 'course';
    let aiFailure;
    if (ai.status(ctx.user).aiEnabled && (topics.length || focus.length)) {
      try {
        const raw = await ai.complete({ user: ctx.user, system: revisionSystemPrompt(), prompt: revisionPrompt({ course, topics, focus }), maxTokens: 2000 });
        questions = parseQuestions(raw);
        if (questions.length) source = 'ai';
        else aiFailure = unavailable('AI did not return usable practice questions. Try again or use your course checks.');
      } catch (error) {
        if (error.status === 429) throw error;
        aiFailure = error.status ? error : unavailable('AI practice generation failed. Please try again.');
        questions = [];
      }
    }
    if (!questions.length) {
      // Fallback: the lecturer's own concept checks for this course.
      questions = db.all(
        'SELECT p.question, p.options, p.correct FROM polls p JOIN topics t ON t.id = p.topic_id JOIN lectures l ON l.id = t.lecture_id WHERE l.course_id = ? ORDER BY RANDOM() LIMIT 8',
        course.id,
      ).map((p) => ({ question: p.question, options: JSON.parse(p.options), answer: p.correct, explanation: '' }));
    }
    if (!questions.length) throw aiFailure || badRequest('There is not enough material in this course yet. Try again after your lecturer adds topics or concept checks.');

    const title = `${course.code} · ${source === 'ai' ? 'Practice set' : 'Concept checks'} ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`;
    const packId = db.insert('INSERT INTO revision_packs(user_id, course_id, title, questions, source, created) VALUES(?, ?, ?, ?, ?, ?)', ctx.user.id, course.id, title, JSON.stringify(questions), source, isoNow());
    ctx.status = 201;
    return { id: packId, source, count: questions.length, ...(aiFailure ? { warning: 'AI questions were unavailable. This set uses your lecturer’s concept checks.' } : {}) };
  });

  /** Submit answers: records the best score and queues missed questions for review. */
  router.post('/api/revision/:id/result', async (ctx) => {
    studentOnly(ctx.user);
    const pack = db.get('SELECT * FROM revision_packs WHERE id = ? AND user_id = ?', id(ctx.params.id), ctx.user.id);
    if (!pack) throw notFound('Revision pack not found');
    const questions = JSON.parse(pack.questions);
    const b = await ctx.json();
    const answers = Array.isArray(b.answers) ? b.answers : [];
    let score = 0;
    questions.forEach((q, i) => {
      if (answers[i] === q.answer) score += 1;
      else review.ensure(ctx.user.id, { courseId: pack.course_id, kind: 'revision', sourceId: `${pack.id}:${i}`, prompt: q.question, answer: q.options[q.answer] + (q.explanation ? ` — ${q.explanation}` : '') });
    });
    db.run('UPDATE revision_packs SET best_score = MAX(COALESCE(best_score, 0), ?) WHERE id = ?', score, pack.id);
    return { score, total: questions.length };
  });
}

module.exports = { register, parseQuestions };
