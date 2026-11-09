'use strict';
/**
 * Quizzes: practice quizzes written by the assistant, like a tutor's. Eight kinds of question (questions.js),
 * instant marking, a hint and an explanation for every question, a tutor to ask about any question, written
 * answers marked with feedback, and a retry of the questions you got wrong. Missed questions from a course quiz
 * also join the student's review queue.
 *
 *   GET    /api/quizzes                   the user's quizzes, newest first
 *   POST   /api/quizzes                   { topic?, course_id?, notes?, count, difficulty, types[], language? } make one
 *   GET    /api/quizzes/:id               questions (without answers) and the answers given so far
 *   POST   /api/quizzes/:id/answers       { index, answer } → { score, correct, feedback, explanation, solution }
 *   POST   /api/quizzes/:id/tutor         { index, messages: [{ role, content }] } → { reply }
 *   POST   /api/quizzes/:id/retry         a new quiz from the questions answered wrongly
 *   DELETE /api/quizzes/:id
 *
 * A quiz belongs to the person who made it. A course quiz needs access to the course.
 */
const crypto = require('node:crypto');
const { text, id, oneOf, integer } = require('../../lib/validate');
const { badRequest, forbidden, notFound, unavailable } = require('../../http/errors');
const { quizSystemPrompt, quizPrompt, quizGradePrompt, quizTutorPrompt, referenceBlock } = require('../../ai/prompts');
const { KINDS, LABELS, parseQuiz, publicView, solution, answerKey, mark, markShortByKeywords } = require('./questions');

const DIFFICULTIES = ['easy', 'medium', 'hard', 'mixed'];
const parse = (json, fallback) => {
  try {
    return JSON.parse(json);
  } catch {
    return fallback;
  }
};

function register(router, { db, ai, access, review }) {
  const isoNow = () => new Date().toISOString();

  const own = (user, quizId) => {
    const quiz = db.get('SELECT * FROM quizzes WHERE id = ? AND user_id = ? AND institution_id = ?', id(quizId, 'Quiz'), user.id, user.institution_id);
    if (!quiz) throw notFound('Quiz not found');
    return quiz;
  };
  const languageOf = (user, requested) => (requested === 'de' || requested === 'en' ? requested : user.preferences?.language === 'de' ? 'de' : 'en');

  const summary = (q) => ({
    id: q.id, title: q.title, topic: q.topic, difficulty: q.difficulty, total: q.total, answered: q.answered,
    score: Math.round(q.score * 100) / 100, created: q.created, finished: q.finished, course_id: q.course_id,
  });

  /** The marked answer to one question, with what the student may now see. */
  const answerView = (q, row) => ({
    answer: parse(row.answer, null),
    score: row.score,
    correct: row.score >= 0.999,
    feedback: row.feedback,
    explanation: q.explanation,
    solution: solution(q),
    key: answerKey(q),
  });

  function full(quiz) {
    const questions = parse(quiz.questions, []);
    const answers = {};
    for (const row of db.all('SELECT * FROM quiz_answers WHERE quiz_id = ? ORDER BY idx', quiz.id)) {
      if (questions[row.idx]) answers[row.idx] = answerView(questions[row.idx], row);
    }
    const course = quiz.course_id ? db.get('SELECT id, code, title FROM courses WHERE id = ?', quiz.course_id) : null;
    return { quiz: { ...summary(quiz), course }, questions: questions.map((q, i) => publicView(q, quiz.seed + i)), answers };
  }

  router.get('/api/quizzes', (ctx) => ({
    quizzes: db.all('SELECT * FROM quizzes WHERE user_id = ? AND institution_id = ? ORDER BY id DESC LIMIT 60', ctx.user.id, ctx.user.institution_id).map(summary),
    kinds: KINDS.map((k) => ({ id: k, label: LABELS[k] })),
    ai: ai.status(ctx.user).aiEnabled,
  }));

  router.post('/api/quizzes', async (ctx) => {
    const user = ctx.user;
    const b = await ctx.json();
    const topic = text(b.topic, { max: 200, optional: true, label: 'Topic' }) || '';
    const notes = text(b.notes, { max: 20000, optional: true, label: 'Notes' }) || '';
    const count = integer(b.count ?? 6, { min: 3, max: 15, label: 'Number of questions' });
    const difficulty = oneOf(b.difficulty ?? 'mixed', DIFFICULTIES, 'Difficulty');
    const types = [...new Set((Array.isArray(b.types) && b.types.length ? b.types : KINDS).map(String))];
    for (const t of types) oneOf(t, KINDS, 'Question type');
    const language = languageOf(user, b.language);

    let course = null;
    let topics = [];
    let focus = [];
    if (b.course_id !== undefined && b.course_id !== null && b.course_id !== '') {
      course = access.course(user, id(b.course_id, 'Course'));
      if (!course) throw forbidden('You can only make quizzes for your own courses');
      topics = db.all('SELECT t.title FROM topics t JOIN lectures l ON l.id = t.lecture_id WHERE l.course_id = ? ORDER BY t.id DESC LIMIT 30', course.id).map((t) => t.title);
      focus = db.all(
        'SELECT DISTINCT t.title FROM responses r JOIN topics t ON t.id = r.topic_id JOIN lectures l ON l.id = t.lecture_id WHERE l.course_id = ? AND r.user_id = ? AND r.level < 3',
        course.id, user.id,
      ).map((t) => t.title);
    }
    if (!topic && !course && !notes) throw badRequest('Say what the quiz should be about: a topic, one of your courses or your notes.');
    if (!ai.status(user).aiEnabled) throw unavailable('Quizzes are written by the assistant, which is not connected yet.');

    // Ground the questions in the university's own material when it has something on the topic.
    const references = topic && !notes ? ai.retrieveContext(user, topic, 3).references.map((r) => ({ title: r.title, excerpt: String(r.excerpt || '').slice(0, 1500) })) : [];
    const raw = await ai.complete({
      user,
      system: quizSystemPrompt(),
      prompt: quizPrompt({ topic, count, types, difficulty, language, course, topics, focus, notes, references }),
      maxTokens: Math.min(8000, 900 + count * 450),
    });
    const parsed = parseQuiz(raw, { limit: count });
    if (!parsed.questions.length) throw unavailable('The assistant could not write usable questions this time. Please try again.');

    const title = parsed.title || topic || (course ? `${course.code} practice` : 'Practice quiz');
    const quizId = db.insert(
      'INSERT INTO quizzes(user_id, institution_id, course_id, title, topic, difficulty, language, questions, seed, total, created) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      user.id, user.institution_id, course?.id || null, title.slice(0, 100), topic || course?.title || 'My notes', difficulty, language,
      JSON.stringify(parsed.questions), crypto.randomInt(1, 2 ** 31), parsed.questions.length, isoNow(),
    );
    ctx.status = 201;
    return full(own(user, quizId));
  });

  router.get('/api/quizzes/:id', (ctx) => full(own(ctx.user, ctx.params.id)));

  router.delete('/api/quizzes/:id', (ctx) => {
    const quiz = own(ctx.user, ctx.params.id);
    db.run('DELETE FROM quizzes WHERE id = ?', quiz.id);
    return { ok: true };
  });

  /** Mark one answer. Each question is answered once; the quiz is finished when all are. */
  router.post('/api/quizzes/:id/answers', async (ctx) => {
    const user = ctx.user;
    const quiz = own(user, ctx.params.id);
    const b = await ctx.json();
    const questions = parse(quiz.questions, []);
    const i = integer(b.index, { min: 0, max: questions.length - 1, label: 'Question' });
    const q = questions[i];
    if (db.get('SELECT 1 AS done FROM quiz_answers WHERE quiz_id = ? AND idx = ?', quiz.id, i)) throw badRequest('You have already answered this question');

    let score;
    let feedback = '';
    let answer = b.answer;
    if (q.type === 'short') {
      answer = text(b.answer, { min: 1, max: 3000, label: 'Answer' });
      ({ score, feedback } = await markWritten(user, q, answer, quiz.language));
    } else {
      const result = mark(q, answer, quiz.seed + i);
      if (!result) throw badRequest('Please answer the question first');
      score = Math.round(result.score * 100) / 100;
    }
    db.run('INSERT INTO quiz_answers(quiz_id, idx, answer, score, feedback, created) VALUES(?, ?, ?, ?, ?, ?)', quiz.id, i, JSON.stringify(answer), score, feedback, isoNow());
    const totals = db.get('SELECT COUNT(*) AS answered, COALESCE(SUM(score), 0) AS score FROM quiz_answers WHERE quiz_id = ?', quiz.id);
    const finished = totals.answered >= quiz.total;
    db.run('UPDATE quizzes SET answered = ?, score = ?, finished = ? WHERE id = ?', totals.answered, totals.score, finished ? isoNow() : null, quiz.id);

    // Like the practice sets: a question a student got wrong comes back later in their review queue.
    if (score < 0.999 && user.role === 'student') {
      review.ensure(user.id, { courseId: quiz.course_id, kind: 'quiz', sourceId: `${quiz.id}:${i}`, prompt: q.question, answer: `${solution(q)}${q.explanation ? ` — ${q.explanation}` : ''}` });
    }
    return { index: i, ...answerView(q, { answer: JSON.stringify(answer), score, feedback }), quiz: summary({ ...quiz, answered: totals.answered, score: totals.score, finished: finished ? isoNow() : null }) };
  });

  /** A written answer, marked by the tutor; if the AI cannot, by the key points it mentions. */
  async function markWritten(user, q, answer, language) {
    try {
      const raw = await ai.complete({
        user,
        system: quizGradePrompt(language),
        prompt: [referenceBlock('QUESTION', { question: q.question, model_answer: q.model_answer, key_points: q.key_points }), referenceBlock('ANSWER', answer)].join('\n\n'),
        maxTokens: 600,
        task: 'summary',
      });
      const json = parse(String(raw).slice(String(raw).indexOf('{'), String(raw).lastIndexOf('}') + 1), null);
      const score = Number(json?.score);
      if (Number.isFinite(score) && typeof json.feedback === 'string' && json.feedback.trim()) {
        return { score: Math.round(Math.min(1, Math.max(0, score)) * 100) / 100, feedback: json.feedback.trim().slice(0, 1200) };
      }
    } catch (error) {
      if (error.status === 429) throw error;
    }
    const fallback = markShortByKeywords(q, answer);
    return {
      score: fallback.score,
      feedback: language === 'de' ? 'Automatisch nach den Kernpunkten bewertet. Vergleiche deine Antwort mit der Musterlösung.' : 'Marked automatically by the key points. Compare your answer with the model answer.',
    };
  }

  /** Ask the tutor about one question. Before it is answered, the tutor guides without giving the answer away. */
  router.post('/api/quizzes/:id/tutor', async (ctx) => {
    const user = ctx.user;
    const quiz = own(user, ctx.params.id);
    const b = await ctx.json();
    const questions = parse(quiz.questions, []);
    const i = integer(b.index, { min: 0, max: questions.length - 1, label: 'Question' });
    const q = questions[i];
    const messages = (Array.isArray(b.messages) ? b.messages : []).slice(-10).map((m) => ({
      role: m?.role === 'assistant' ? 'assistant' : 'user',
      content: text(m?.content, { min: 1, max: 2000, label: 'Message' }),
    }));
    if (!messages.length || messages[messages.length - 1].role !== 'user') throw badRequest('Ask the tutor something');
    if (!ai.status(user).aiEnabled) throw unavailable('The tutor is not connected yet.');
    const row = db.get('SELECT * FROM quiz_answers WHERE quiz_id = ? AND idx = ?', quiz.id, i);
    const shown = { ...publicView(q, quiz.seed + i), ...(row ? { student_answer: parse(row.answer, null), correct_answer: solution(q), explanation: q.explanation } : {}) };
    const reply = await ai.complete({
      user,
      system: quizTutorPrompt({ question: shown, answered: !!row, language: quiz.language }),
      prompt: messages[messages.length - 1].content,
      history: messages.slice(0, -1),
      maxTokens: 1400,
    });
    return { reply: reply.trim() };
  });

  /** Practise the mistakes: a new quiz with the questions not answered fully right. */
  router.post('/api/quizzes/:id/retry', (ctx) => {
    const user = ctx.user;
    const quiz = own(user, ctx.params.id);
    const questions = parse(quiz.questions, []);
    const right = new Set(db.all('SELECT idx FROM quiz_answers WHERE quiz_id = ? AND score >= 0.999', quiz.id).map((r) => r.idx));
    const missed = questions.filter((_, i) => !right.has(i));
    if (!missed.length) throw badRequest('You got every question right. Make a new quiz to keep practising.');
    const quizId = db.insert(
      'INSERT INTO quizzes(user_id, institution_id, course_id, title, topic, difficulty, language, questions, seed, total, created) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      user.id, user.institution_id, quiz.course_id, `Retry: ${quiz.title.replace(/^Retry: /, '')}`.slice(0, 100), quiz.topic, quiz.difficulty, quiz.language,
      JSON.stringify(missed), crypto.randomInt(1, 2 ** 31), missed.length, isoNow(),
    );
    ctx.status = 201;
    return full(own(user, quizId));
  });
}

module.exports = { register };
