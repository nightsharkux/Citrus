'use strict';
/**
 * Practice quizzes (src/modules/quiz): the questions as written (with answers, never sent before answering) and
 * one marked answer per question.
 */
module.exports = {
  version: 10,
  name: 'quizzes',
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS quizzes(
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        institution_id INTEGER NOT NULL,
        course_id INTEGER REFERENCES courses(id) ON DELETE SET NULL,
        title TEXT NOT NULL,
        topic TEXT NOT NULL DEFAULT '',
        difficulty TEXT NOT NULL DEFAULT 'mixed',
        language TEXT NOT NULL DEFAULT 'en',
        questions TEXT NOT NULL,
        seed INTEGER NOT NULL DEFAULT 1,
        total INTEGER NOT NULL,
        answered INTEGER NOT NULL DEFAULT 0,
        score REAL NOT NULL DEFAULT 0,
        created TEXT NOT NULL,
        finished TEXT);
      CREATE INDEX IF NOT EXISTS idx_quizzes_user ON quizzes(user_id, created);
      CREATE TABLE IF NOT EXISTS quiz_answers(
        quiz_id INTEGER NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
        idx INTEGER NOT NULL,
        answer TEXT NOT NULL,
        score REAL NOT NULL,
        feedback TEXT NOT NULL DEFAULT '',
        created TEXT NOT NULL,
        PRIMARY KEY (quiz_id, idx));
    `);
  },
};
