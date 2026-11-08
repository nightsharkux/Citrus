'use strict';
/** Career interest activity. Private to the user — never shown to lecturers or admins. */
const { badRequest } = require('../../http/errors');
const { questions, groups, assess } = require('./questions');

function register(router, { db }) {
  const own = (u) => db.get('SELECT answers, reflection, updated FROM career_interests WHERE user_id = ? AND institution_id = ?', u.id, u.institution_id);

  router.get('/api/career', (ctx) => {
    const row = own(ctx.user);
    const answers = row ? JSON.parse(row.answers) : null;
    return {
      questions: questions.map(([prompt, options], index) => ({ id: index + 1, prompt, options })),
      groups,
      answers,
      reflection: row?.reflection || '',
      updated: row?.updated ?? null,
      result: answers ? assess(answers) : null,
    };
  });

  router.post('/api/career', async (ctx) => {
    const b = await ctx.json(12_000);
    const answers = b.answers;
    if (!Array.isArray(answers) || answers.length !== questions.length || answers.some((v) => !Number.isInteger(v) || v < 0 || v > 3)) {
      throw badRequest(`Please answer all ${questions.length} questions`);
    }
    const reflection = String(b.reflection ?? '').trim().slice(0, 2000);
    const updated = new Date().toISOString();
    db.run(
      `INSERT INTO career_interests(user_id, institution_id, answers, reflection, updated) VALUES(?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET answers = excluded.answers, reflection = excluded.reflection, updated = excluded.updated`,
      ctx.user.id, ctx.user.institution_id, JSON.stringify(answers), reflection, updated,
    );
    return { ok: true, updated, result: assess(answers) };
  });

  router.delete('/api/career', (ctx) => {
    db.run('DELETE FROM career_interests WHERE user_id = ?', ctx.user.id);
    return { ok: true };
  });
}

module.exports = { register };
