'use strict';
/**
 * Baseline: the complete schema of CampusOS 0.4–0.6. Every statement is
 * idempotent, so existing databases pass through untouched.
 */
const { addColumn } = require('../helpers');

module.exports = {
  version: 1,
  name: 'baseline',
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS institutions(
        id INTEGER PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, created TEXT NOT NULL);

      CREATE TABLE IF NOT EXISTS users(
        id INTEGER PRIMARY KEY,
        institution_id INTEGER NOT NULL REFERENCES institutions(id),
        name TEXT NOT NULL, email TEXT NOT NULL, pass TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('student','lecturer','admin')),
        created TEXT NOT NULL,
        requested_role TEXT,
        UNIQUE(institution_id, email));

      CREATE TABLE IF NOT EXISTS sessions(
        token TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires INTEGER NOT NULL);

      CREATE TABLE IF NOT EXISTS courses(
        id INTEGER PRIMARY KEY,
        institution_id INTEGER NOT NULL REFERENCES institutions(id),
        title TEXT NOT NULL, code TEXT NOT NULL,
        lecturer_id INTEGER REFERENCES users(id),
        UNIQUE(institution_id, code));

      CREATE TABLE IF NOT EXISTS enrollments(
        course_id INTEGER REFERENCES courses(id) ON DELETE CASCADE,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        PRIMARY KEY(course_id, user_id));

      CREATE TABLE IF NOT EXISTS lectures(
        id INTEGER PRIMARY KEY, course_id INTEGER NOT NULL REFERENCES courses(id),
        topic TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', created TEXT NOT NULL);

      CREATE TABLE IF NOT EXISTS topics(
        id INTEGER PRIMARY KEY, lecture_id INTEGER NOT NULL REFERENCES lectures(id) ON DELETE CASCADE,
        title TEXT NOT NULL, created TEXT NOT NULL);

      CREATE TABLE IF NOT EXISTS responses(
        id INTEGER PRIMARY KEY,
        topic_id INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        level INTEGER NOT NULL CHECK(level BETWEEN 1 AND 3), created TEXT NOT NULL,
        UNIQUE(topic_id, user_id));

      CREATE TABLE IF NOT EXISTS polls(
        id INTEGER PRIMARY KEY, topic_id INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
        question TEXT NOT NULL, options TEXT NOT NULL, correct INTEGER NOT NULL, created TEXT NOT NULL);

      CREATE TABLE IF NOT EXISTS poll_answers(
        poll_id INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        answer INTEGER NOT NULL, created TEXT NOT NULL, PRIMARY KEY(poll_id, user_id));

      CREATE TABLE IF NOT EXISTS notices(
        id INTEGER PRIMARY KEY, institution_id INTEGER NOT NULL REFERENCES institutions(id),
        room TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('open','quiet','do_not_disturb','consultation')),
        note TEXT NOT NULL DEFAULT '', updated TEXT NOT NULL, UNIQUE(institution_id, room));

      CREATE TABLE IF NOT EXISTS suggestions(
        id INTEGER PRIMARY KEY, institution_id INTEGER NOT NULL REFERENCES institutions(id),
        user_id INTEGER NOT NULL REFERENCES users(id), message TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'new', created TEXT NOT NULL);

      CREATE TABLE IF NOT EXISTS audit(
        id INTEGER PRIMARY KEY, institution_id INTEGER NOT NULL, actor_id INTEGER,
        action TEXT NOT NULL, detail TEXT NOT NULL, created TEXT NOT NULL);

      CREATE TABLE IF NOT EXISTS workspaces(
        id INTEGER PRIMARY KEY, institution_id INTEGER NOT NULL REFERENCES institutions(id),
        creator_id INTEGER NOT NULL REFERENCES users(id), title TEXT NOT NULL, kind TEXT NOT NULL,
        course_id INTEGER REFERENCES courses(id), join_code TEXT NOT NULL UNIQUE,
        guidance TEXT NOT NULL DEFAULT 'coach', instructions TEXT NOT NULL DEFAULT '',
        created TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0);

      CREATE TABLE IF NOT EXISTS workspace_members(
        workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        joined TEXT NOT NULL, PRIMARY KEY(workspace_id, user_id));

      CREATE TABLE IF NOT EXISTS workspace_notes(
        id INTEGER PRIMARY KEY, workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        author_id INTEGER NOT NULL REFERENCES users(id), category TEXT NOT NULL, content TEXT NOT NULL,
        created TEXT NOT NULL);

      CREATE TABLE IF NOT EXISTS meeting_recordings(
        id INTEGER PRIMARY KEY, workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        owner_id INTEGER NOT NULL REFERENCES users(id), filename TEXT NOT NULL, mime TEXT NOT NULL,
        bytes INTEGER NOT NULL, transcript TEXT NOT NULL DEFAULT '', shared INTEGER NOT NULL DEFAULT 0,
        created TEXT NOT NULL);

      CREATE TABLE IF NOT EXISTS meeting_reports(
        id INTEGER PRIMARY KEY, workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        owner_id INTEGER NOT NULL REFERENCES users(id), recording_id INTEGER REFERENCES meeting_recordings(id),
        report TEXT NOT NULL, source TEXT NOT NULL, created TEXT NOT NULL);

      CREATE TABLE IF NOT EXISTS ai_chats(
        id INTEGER PRIMARY KEY, workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id), role TEXT NOT NULL, content TEXT NOT NULL, created TEXT NOT NULL);

      CREATE TABLE IF NOT EXISTS institution_knowledge(
        id INTEGER PRIMARY KEY, institution_id INTEGER NOT NULL REFERENCES institutions(id),
        title TEXT NOT NULL, content TEXT NOT NULL, updated TEXT NOT NULL);

      CREATE TABLE IF NOT EXISTS recording_signals(
        workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id), started INTEGER NOT NULL,
        PRIMARY KEY(workspace_id, user_id));

      CREATE TABLE IF NOT EXISTS institution_ai_settings(
        institution_id INTEGER PRIMARY KEY REFERENCES institutions(id),
        provider TEXT NOT NULL CHECK (provider IN ('off','openai','ollama')),
        updated TEXT NOT NULL);

      CREATE TABLE IF NOT EXISTS cx_preferences(
        user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        level TEXT NOT NULL DEFAULT 'personalized',
        topics TEXT NOT NULL DEFAULT '["event","job","announcement","research","community","housing"]',
        quiet_start TEXT DEFAULT '22:00', quiet_end TEXT DEFAULT '08:00', updated TEXT NOT NULL);

      CREATE TABLE IF NOT EXISTS cx_posts(
        id INTEGER PRIMARY KEY, institution_id INTEGER NOT NULL REFERENCES institutions(id),
        author_id INTEGER NOT NULL REFERENCES users(id), title TEXT NOT NULL, body TEXT NOT NULL,
        category TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 2, official INTEGER NOT NULL DEFAULT 0,
        verified INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending', created TEXT NOT NULL);

      CREATE TABLE IF NOT EXISTS cx_reports(
        id INTEGER PRIMARY KEY, post_id INTEGER NOT NULL REFERENCES cx_posts(id),
        reporter_id INTEGER NOT NULL REFERENCES users(id), reason TEXT NOT NULL, created TEXT NOT NULL,
        UNIQUE(post_id, reporter_id));

      CREATE TABLE IF NOT EXISTS cx_attendance_sessions(
        id INTEGER PRIMARY KEY, institution_id INTEGER NOT NULL REFERENCES institutions(id),
        course_id INTEGER NOT NULL REFERENCES courses(id), owner_id INTEGER NOT NULL REFERENCES users(id),
        title TEXT NOT NULL, room TEXT NOT NULL DEFAULT '', open INTEGER NOT NULL DEFAULT 1, created TEXT NOT NULL);

      CREATE TABLE IF NOT EXISTS cx_checkins(
        session_id INTEGER NOT NULL REFERENCES cx_attendance_sessions(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id), method TEXT NOT NULL, created TEXT NOT NULL,
        PRIMARY KEY(session_id, user_id));

      CREATE TABLE IF NOT EXISTS cx_nfc_bindings(
        institution_id INTEGER NOT NULL REFERENCES institutions(id), uid_digest TEXT NOT NULL,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        bound_by INTEGER NOT NULL REFERENCES users(id), created TEXT NOT NULL,
        PRIMARY KEY(institution_id, uid_digest), UNIQUE(institution_id, user_id));

      CREATE TABLE IF NOT EXISTS career_interests(
        user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        institution_id INTEGER NOT NULL, answers TEXT NOT NULL,
        reflection TEXT NOT NULL DEFAULT '', updated TEXT NOT NULL);
    `);

    // Columns that older databases may be missing.
    addColumn(db, 'users', 'requested_role', 'TEXT');
    addColumn(db, 'career_interests', 'reflection', "TEXT NOT NULL DEFAULT ''");
  },
};
