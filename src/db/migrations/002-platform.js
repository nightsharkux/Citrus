'use strict';
/** Citrus 1.0 platform tables: accounts, assistant threads, notifications, schedule, review, devices. */
const { addColumn } = require('../helpers');

module.exports = {
  version: 2,
  name: 'platform-1.0',
  up(db) {
    // Accounts and sessions
    addColumn(db, 'users', 'can_publish', 'INTEGER NOT NULL DEFAULT 0');
    addColumn(db, 'users', 'failed_logins', 'INTEGER NOT NULL DEFAULT 0');
    addColumn(db, 'users', 'locked_until', 'INTEGER');
    addColumn(db, 'users', 'last_login', 'TEXT');
    addColumn(db, 'users', 'auth_provider', "TEXT NOT NULL DEFAULT 'local'");
    addColumn(db, 'users', 'external_subject', 'TEXT');
    addColumn(db, 'users', 'preferences', "TEXT NOT NULL DEFAULT '{}'");
    addColumn(db, 'users', 'deleted', 'INTEGER NOT NULL DEFAULT 0');
    addColumn(db, 'sessions', 'created', 'INTEGER');
    addColumn(db, 'sessions', 'last_seen', 'INTEGER');
    addColumn(db, 'sessions', 'user_agent', "TEXT NOT NULL DEFAULT ''");

    db.exec(`
      CREATE TABLE IF NOT EXISTS user_profiles(
        user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        programme TEXT NOT NULL DEFAULT '', semester INTEGER,
        interests TEXT NOT NULL DEFAULT '[]', updated TEXT NOT NULL);

      CREATE TABLE IF NOT EXISTS settings(
        institution_id INTEGER NOT NULL REFERENCES institutions(id),
        key TEXT NOT NULL, value TEXT NOT NULL,
        PRIMARY KEY(institution_id, key));

      CREATE TABLE IF NOT EXISTS sso_states(
        state TEXT PRIMARY KEY, nonce TEXT NOT NULL, verifier TEXT NOT NULL,
        return_to TEXT NOT NULL DEFAULT '/', created INTEGER NOT NULL);

      CREATE TABLE IF NOT EXISTS connector_tokens(
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        connector TEXT NOT NULL, secret TEXT NOT NULL, meta TEXT NOT NULL DEFAULT '{}', created TEXT NOT NULL,
        PRIMARY KEY(user_id, connector));
    `);

    // Assistant
    db.exec(`
      CREATE TABLE IF NOT EXISTS assistant_threads(
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title TEXT NOT NULL DEFAULT 'New conversation',
        created TEXT NOT NULL, updated TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_threads_user ON assistant_threads(user_id, updated);

      CREATE TABLE IF NOT EXISTS assistant_messages(
        id INTEGER PRIMARY KEY,
        thread_id INTEGER NOT NULL REFERENCES assistant_threads(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK(role IN ('user','assistant')),
        content TEXT NOT NULL, sources TEXT NOT NULL DEFAULT '[]', created TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_messages_thread ON assistant_messages(thread_id, id);
    `);

    // Knowledge library gets provenance metadata for citations.
    addColumn(db, 'institution_knowledge', 'category', "TEXT NOT NULL DEFAULT ''");
    addColumn(db, 'institution_knowledge', 'source_url', "TEXT NOT NULL DEFAULT ''");
    addColumn(db, 'institution_knowledge', 'tags', "TEXT NOT NULL DEFAULT ''");
    addColumn(db, 'institution_knowledge', 'volatility', "TEXT NOT NULL DEFAULT 'stable'");
    addColumn(db, 'institution_knowledge', 'external_id', 'TEXT');
    addColumn(db, 'institution_knowledge', 'observed_on', 'TEXT');

    // Workspaces: assistant naming and live captions
    addColumn(db, 'workspaces', 'assistant_name', "TEXT NOT NULL DEFAULT ''");
    addColumn(db, 'workspaces', 'live', 'INTEGER NOT NULL DEFAULT 0');
    db.exec(`
      CREATE TABLE IF NOT EXISTS live_captions(
        id INTEGER PRIMARY KEY,
        workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        author_id INTEGER NOT NULL REFERENCES users(id), text TEXT NOT NULL, created TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_captions_ws ON live_captions(workspace_id, id);
    `);

    // Notifications and push
    db.exec(`
      CREATE TABLE IF NOT EXISTS notifications(
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', link TEXT NOT NULL DEFAULT '',
        read INTEGER NOT NULL DEFAULT 0, created TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read, id);

      CREATE TABLE IF NOT EXISTS push_subscriptions(
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        endpoint TEXT NOT NULL UNIQUE, p256dh TEXT NOT NULL, auth TEXT NOT NULL,
        user_agent TEXT NOT NULL DEFAULT '', created TEXT NOT NULL);
    `);

    // Campus feed: events, tags and RSVPs
    addColumn(db, 'cx_posts', 'tags', "TEXT NOT NULL DEFAULT ''");
    addColumn(db, 'cx_posts', 'event_start', 'TEXT');
    addColumn(db, 'cx_posts', 'location', "TEXT NOT NULL DEFAULT ''");
    addColumn(db, 'cx_posts', 'link', "TEXT NOT NULL DEFAULT ''");
    db.exec(`
      CREATE TABLE IF NOT EXISTS cx_rsvps(
        post_id INTEGER NOT NULL REFERENCES cx_posts(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created TEXT NOT NULL, PRIMARY KEY(post_id, user_id));
    `);

    // Participation: rotating check-in codes
    addColumn(db, 'cx_attendance_sessions', 'code_secret', 'TEXT');
    addColumn(db, 'cx_attendance_sessions', 'require_code', 'INTEGER NOT NULL DEFAULT 0');

    // Schedule
    db.exec(`
      CREATE TABLE IF NOT EXISTS timetable_events(
        id INTEGER PRIMARY KEY,
        institution_id INTEGER NOT NULL REFERENCES institutions(id),
        course_id INTEGER REFERENCES courses(id) ON DELETE CASCADE,
        owner_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        title TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'lecture',
        location TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '',
        starts TEXT NOT NULL, ends TEXT NOT NULL,
        repeat_weeks INTEGER NOT NULL DEFAULT 0, until TEXT,
        source TEXT NOT NULL DEFAULT 'manual', external_uid TEXT,
        created_by INTEGER REFERENCES users(id), created TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_timetable_course ON timetable_events(course_id);
      CREATE INDEX IF NOT EXISTS idx_timetable_owner ON timetable_events(owner_id);

      CREATE TABLE IF NOT EXISTS calendar_feeds(
        user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE, created TEXT NOT NULL);
    `);

    // Learning: spaced review and revision packs
    db.exec(`
      CREATE TABLE IF NOT EXISTS review_items(
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        course_id INTEGER REFERENCES courses(id) ON DELETE CASCADE,
        source_kind TEXT NOT NULL, source_id TEXT NOT NULL,
        prompt TEXT NOT NULL, answer TEXT NOT NULL DEFAULT '',
        ease REAL NOT NULL DEFAULT 2.5, interval_days REAL NOT NULL DEFAULT 0,
        reps INTEGER NOT NULL DEFAULT 0, lapses INTEGER NOT NULL DEFAULT 0,
        due TEXT NOT NULL, created TEXT NOT NULL, updated TEXT NOT NULL,
        UNIQUE(user_id, source_kind, source_id));
      CREATE INDEX IF NOT EXISTS idx_review_due ON review_items(user_id, due);

      CREATE TABLE IF NOT EXISTS revision_packs(
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        course_id INTEGER REFERENCES courses(id) ON DELETE CASCADE,
        title TEXT NOT NULL, questions TEXT NOT NULL, source TEXT NOT NULL,
        best_score INTEGER, created TEXT NOT NULL);
    `);

    // Devices (classroom puck, NFC readers, door lights)
    db.exec(`
      CREATE TABLE IF NOT EXISTS devices(
        id INTEGER PRIMARY KEY,
        institution_id INTEGER NOT NULL REFERENCES institutions(id),
        name TEXT NOT NULL, kind TEXT NOT NULL, room TEXT NOT NULL DEFAULT '',
        secret TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
        firmware TEXT NOT NULL DEFAULT '', capabilities TEXT NOT NULL DEFAULT '[]',
        last_seen INTEGER, created_by INTEGER REFERENCES users(id), created TEXT NOT NULL);

      CREATE TABLE IF NOT EXISTS device_nonces(
        device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
        nonce TEXT NOT NULL, seen INTEGER NOT NULL, PRIMARY KEY(device_id, nonce));

      CREATE TABLE IF NOT EXISTS device_commands(
        id INTEGER PRIMARY KEY,
        device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
        type TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'queued', result TEXT,
        created TEXT NOT NULL, delivered TEXT, acked TEXT);
      CREATE INDEX IF NOT EXISTS idx_device_commands ON device_commands(device_id, status);

      CREATE TABLE IF NOT EXISTS device_events(
        id INTEGER PRIMARY KEY,
        device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
        type TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '', created TEXT NOT NULL);

      CREATE TABLE IF NOT EXISTS device_activations(
        id INTEGER PRIMARY KEY,
        institution_id INTEGER NOT NULL REFERENCES institutions(id),
        device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        room TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending',
        course_id INTEGER REFERENCES courses(id), session_id INTEGER REFERENCES cx_attendance_sessions(id),
        created TEXT NOT NULL, expires INTEGER NOT NULL, resolved TEXT);

      CREATE TABLE IF NOT EXISTS nfc_pairings(
        device_id INTEGER PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        requested_by INTEGER NOT NULL REFERENCES users(id), expires INTEGER NOT NULL);
    `);
  },
};
