'use strict';
/**
 * Spaced review (a simplified SM-2 schedule).
 *
 * Items come from the student's own signals: topics rated "lost" or "getting
 * there", concept checks answered incorrectly, and missed revision-pack
 * questions. Grading an item moves its next due date further out (or back).
 * This schedules practice; it does not claim to measure mastery.
 */
const DAY = 86_400_000;
const GRADES = ['again', 'hard', 'good', 'easy'];

/** Pure scheduling function — easy to unit test or replace. */
function schedule(item, grade, now = Date.now()) {
  let { ease, interval_days: interval, reps, lapses } = item;
  switch (grade) {
    case 'again':
      lapses += 1;
      reps = 0;
      ease = Math.max(1.3, ease - 0.2);
      interval = 0;
      break;
    case 'hard':
      ease = Math.max(1.3, ease - 0.15);
      interval = Math.max(1, Math.round(interval * 1.2));
      reps += 1;
      break;
    case 'good':
      interval = reps === 0 ? 1 : reps === 1 ? 3 : Math.round(interval * ease);
      reps += 1;
      break;
    case 'easy':
      interval = reps === 0 ? 3 : Math.round(Math.max(interval, 1) * ease * 1.3);
      ease += 0.15;
      reps += 1;
      break;
    default:
      throw new Error('Unknown grade');
  }
  const due = new Date(now + (interval === 0 ? 10 * 60_000 : interval * DAY)).toISOString();
  return { ease: Math.round(ease * 100) / 100, interval_days: interval, reps, lapses, due };
}

/** Preview the next interval for each grade (shown on the buttons). */
function preview(item) {
  return Object.fromEntries(GRADES.map((g) => [g, schedule(item, g).interval_days]));
}

function createReview({ db }) {
  const isoNow = () => new Date().toISOString();

  function ensure(userId, { courseId, kind, sourceId, prompt, answer = '' }) {
    db.run(
      `INSERT INTO review_items(user_id, course_id, source_kind, source_id, prompt, answer, due, created, updated)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, source_kind, source_id) DO NOTHING`,
      userId, courseId || null, kind, String(sourceId), prompt.slice(0, 500), answer.slice(0, 1000), isoNow(), isoNow(), isoNow(),
    );
  }

  /** Pull new items from the student's ratings and answers. Idempotent. */
  function sync(user) {
    const topics = db.all(
      `SELECT t.id, t.title, l.course_id, c.code FROM responses r JOIN topics t ON t.id = r.topic_id JOIN lectures l ON l.id = t.lecture_id JOIN courses c ON c.id = l.course_id
       WHERE r.user_id = ? AND r.level < 3`, user.id,
    );
    for (const t of topics) ensure(user.id, { courseId: t.course_id, kind: 'topic', sourceId: t.id, prompt: `Explain “${t.title}” (${t.code}) in your own words, then check your course notes.` });

    const missed = db.all(
      `SELECT p.id, p.question, p.options, p.correct, l.course_id FROM poll_answers pa JOIN polls p ON p.id = pa.poll_id JOIN topics t ON t.id = p.topic_id JOIN lectures l ON l.id = t.lecture_id
       WHERE pa.user_id = ? AND pa.answer != p.correct`, user.id,
    );
    for (const p of missed) ensure(user.id, { courseId: p.course_id, kind: 'poll', sourceId: p.id, prompt: p.question, answer: JSON.parse(p.options)[p.correct] || '' });
  }

  function queue(user) {
    sync(user);
    const now = isoNow();
    const items = db.all(
      `SELECT r.*, c.code AS course_code FROM review_items r LEFT JOIN courses c ON c.id = r.course_id
       WHERE r.user_id = ? ORDER BY r.due LIMIT 200`, user.id,
    );
    const due = items.filter((i) => i.due <= now).map((i) => ({ ...shape(i), preview: preview(i) }));
    return {
      due,
      stats: {
        dueNow: due.length,
        total: items.length,
        learning: items.filter((i) => i.interval_days < 21).length,
        mastered: items.filter((i) => i.interval_days >= 21).length,
        nextDue: items.find((i) => i.due > now)?.due || null,
      },
    };
  }

  function grade(user, itemId, g) {
    const item = db.get('SELECT * FROM review_items WHERE id = ? AND user_id = ?', itemId, user.id);
    if (!item) return null;
    const next = schedule(item, g);
    db.run('UPDATE review_items SET ease = ?, interval_days = ?, reps = ?, lapses = ?, due = ?, updated = ? WHERE id = ?', next.ease, next.interval_days, next.reps, next.lapses, next.due, isoNow(), item.id);
    return { ...shape({ ...item, ...next }) };
  }

  const shape = (i) => ({ id: i.id, prompt: i.prompt, answer: i.answer, kind: i.source_kind, course: i.course_code || null, due: i.due, interval: i.interval_days, reps: i.reps });

  return { sync, queue, grade, ensure };
}

module.exports = { createReview, schedule, preview, GRADES };
