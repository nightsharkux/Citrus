'use strict';
/**
 * The signed-in user's own account: profile, preferences, password, sessions,
 * personal data export and account deletion (GDPR Art. 15/17 support).
 */
const fs = require('node:fs');
const path = require('node:path');
const { hashPassword, verifyPassword } = require('../../lib/crypto');
const { text, oneOf } = require('../../lib/validate');
const { badRequest, forbidden, notFound } = require('../../http/errors');
const { publicUser } = require('../auth/routes');
const { readPreferences, applyPreferences } = require('./preferences');

const INTEREST_TAGS = ['software', 'data', 'ai', 'design', 'business', 'marketing', 'engineering', 'research', 'teaching', 'healthcare', 'sustainability', 'logistics', 'media', 'entrepreneurship', 'international', 'sports', 'music', 'volunteering'];

function register(router, { db, config, sessions, audit }) {
  const profileOf = (userId) => {
    const p = db.get('SELECT programme, semester, interests FROM user_profiles WHERE user_id = ?', userId);
    return { programme: p?.programme || '', semester: p?.semester ?? null, interests: p ? JSON.parse(p.interests) : [] };
  };

  router.get('/api/me', (ctx) => ({ user: publicUser(ctx.user), profile: profileOf(ctx.user.id), interestTags: INTEREST_TAGS }));

  router.patch('/api/me', async (ctx) => {
    const b = await ctx.json();
    if (b.name !== undefined) {
      db.run('UPDATE users SET name = ? WHERE id = ?', text(b.name, { min: 2, max: 80, label: 'Name' }), ctx.user.id);
    }
    if (b.preferences && typeof b.preferences === 'object') {
      const prefs = applyPreferences(ctx.user.preferences, readPreferences(b.preferences));
      db.run('UPDATE users SET preferences = ? WHERE id = ?', JSON.stringify(prefs), ctx.user.id);
    }
    const user = sessions.identify(ctx.req);
    return { user: publicUser(user) };
  });

  router.put('/api/me/profile', async (ctx) => {
    const b = await ctx.json();
    const interests = Array.isArray(b.interests) ? [...new Set(b.interests.filter((t) => INTEREST_TAGS.includes(t)))] : [];
    const semester = b.semester === null || b.semester === '' || b.semester === undefined ? null : Math.max(1, Math.min(20, Number(b.semester) || 1));
    db.run(
      `INSERT INTO user_profiles(user_id, programme, semester, interests, updated) VALUES(?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET programme = excluded.programme, semester = excluded.semester, interests = excluded.interests, updated = excluded.updated`,
      ctx.user.id, text(b.programme, { max: 120, optional: true }), semester, JSON.stringify(interests), new Date().toISOString(),
    );
    return { profile: profileOf(ctx.user.id) };
  });

  router.post('/api/me/password', async (ctx) => {
    const b = await ctx.json();
    const row = db.get('SELECT pass, auth_provider FROM users WHERE id = ?', ctx.user.id);
    if (row.auth_provider === 'oidc' && row.pass === '!') throw badRequest('Your account uses university login, so there is no Campus OS password to change.');
    if (!verifyPassword(String(b.current || ''), row.pass)) throw forbidden('Your current password is incorrect');
    const next = String(b.next || '');
    if (next.length < 12) throw badRequest('Use a new password with at least 12 characters');
    db.run('UPDATE users SET pass = ? WHERE id = ?', hashPassword(next), ctx.user.id);
    sessions.revokeOthers(ctx.user);
    audit(ctx.user, 'password_changed', ctx.user.id);
    return { ok: true };
  });

  router.get('/api/me/sessions', (ctx) => ({ sessions: sessions.list(ctx.user) }));

  router.delete('/api/me/sessions/:id', (ctx) => {
    if (!sessions.revoke(ctx.user, ctx.params.id)) throw notFound('Session not found');
    return { ok: true };
  });

  router.post('/api/me/sessions/revoke-others', (ctx) => {
    sessions.revokeOthers(ctx.user);
    return { ok: true };
  });

  router.get('/api/me/export', (ctx) => {
    const uid = ctx.user.id;
    const data = {
      exported: new Date().toISOString(),
      account: db.get('SELECT id, name, email, role, requested_role, created, last_login, auth_provider FROM users WHERE id = ?', uid),
      profile: profileOf(uid),
      enrollments: db.all('SELECT c.code, c.title FROM enrollments e JOIN courses c ON c.id = e.course_id WHERE e.user_id = ?', uid),
      understandingRatings: db.all('SELECT t.title AS topic, r.level, r.created FROM responses r JOIN topics t ON t.id = r.topic_id WHERE r.user_id = ?', uid),
      conceptCheckAnswers: db.all('SELECT p.question, pa.answer, pa.created FROM poll_answers pa JOIN polls p ON p.id = pa.poll_id WHERE pa.user_id = ?', uid),
      assistantConversations: db.all('SELECT id, title, created FROM assistant_threads WHERE user_id = ?', uid).map((t) => ({ ...t, messages: db.all('SELECT role, content, created FROM assistant_messages WHERE thread_id = ? ORDER BY id', t.id) })),
      workspaceNotes: db.all('SELECT workspace_id, category, content, created FROM workspace_notes WHERE author_id = ?', uid),
      recordings: db.all('SELECT id, workspace_id, bytes, created, shared, transcript FROM meeting_recordings WHERE owner_id = ?', uid),
      campusPosts: db.all('SELECT title, body, category, status, created FROM cx_posts WHERE author_id = ?', uid),
      notificationPreferences: db.get('SELECT level, topics, quiet_start, quiet_end FROM cx_preferences WHERE user_id = ?', uid) || null,
      checkins: db.all('SELECT session_id, method, created FROM cx_checkins WHERE user_id = ?', uid),
      careerActivity: db.get('SELECT answers, reflection, updated FROM career_interests WHERE user_id = ?', uid) || null,
      reviewItems: db.all('SELECT prompt, interval_days, due, reps FROM review_items WHERE user_id = ?', uid),
      personalEvents: db.all('SELECT title, starts, ends, location FROM timetable_events WHERE owner_id = ?', uid),
      suggestions: db.all('SELECT message, status, created FROM suggestions WHERE user_id = ?', uid),
    };
    ctx.res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': 'attachment; filename="campusos-my-data.json"',
      'Cache-Control': 'no-store',
    });
    ctx.res.end(JSON.stringify(data, null, 2));
  });

  /**
   * Delete account. Shared contributions (notes, posts) stay but are attributed
   * to "Deleted user"; everything personal is removed.
   */
  router.post('/api/me/delete', async (ctx) => {
    const b = await ctx.json();
    const row = db.get('SELECT pass, auth_provider FROM users WHERE id = ?', ctx.user.id);
    const ssoOnly = row.auth_provider === 'oidc' && row.pass === '!';
    if (!ssoOnly && !verifyPassword(String(b.password || ''), row.pass)) throw forbidden('Your password is incorrect');
    if (b.confirm !== 'DELETE') throw badRequest('Type DELETE to confirm');
    if (ctx.user.role === 'admin') {
      const admins = db.get("SELECT COUNT(*) n FROM users WHERE institution_id = ? AND role = 'admin' AND deleted = 0", ctx.user.institution_id).n;
      if (admins <= 1) throw forbidden('You are the last administrator. Promote someone else first.');
    }
    const uid = ctx.user.id;
    const files = db.all('SELECT filename FROM meeting_recordings WHERE owner_id = ?', uid);
    db.transaction(() => {
      for (const sql of [
        'DELETE FROM sessions WHERE user_id = ?', 'DELETE FROM assistant_threads WHERE user_id = ?', 'DELETE FROM notifications WHERE user_id = ?',
        'DELETE FROM push_subscriptions WHERE user_id = ?', 'DELETE FROM review_items WHERE user_id = ?', 'DELETE FROM revision_packs WHERE user_id = ?',
        'DELETE FROM career_interests WHERE user_id = ?', 'DELETE FROM cx_preferences WHERE user_id = ?', 'DELETE FROM user_profiles WHERE user_id = ?',
        'DELETE FROM connector_tokens WHERE user_id = ?', 'DELETE FROM cx_nfc_bindings WHERE user_id = ?', 'DELETE FROM calendar_feeds WHERE user_id = ?',
        'DELETE FROM timetable_events WHERE owner_id = ?', 'DELETE FROM ai_chats WHERE user_id = ?', 'DELETE FROM responses WHERE user_id = ?',
        'DELETE FROM poll_answers WHERE user_id = ?', 'DELETE FROM cx_rsvps WHERE user_id = ?', 'DELETE FROM enrollments WHERE user_id = ?',
        'DELETE FROM workspace_members WHERE user_id = ?', 'DELETE FROM recording_signals WHERE user_id = ?', 'DELETE FROM device_activations WHERE user_id = ?', 'DELETE FROM study_group_requests WHERE user_id = ?', 'DELETE FROM assistant_memories WHERE user_id = ?',
      ]) db.run(sql, uid);
      db.run('DELETE FROM meeting_reports WHERE owner_id = ?', uid);
      db.run('DELETE FROM meeting_reports WHERE recording_id IN (SELECT id FROM meeting_recordings WHERE owner_id = ?)', uid);
      db.run('DELETE FROM meeting_recordings WHERE owner_id = ?', uid);
      db.run(
        "UPDATE users SET name = 'Deleted user', email = ?, pass = '!', role = 'student', requested_role = NULL, preferences = '{}', external_subject = NULL, deleted = 1 WHERE id = ?",
        `deleted-${uid}@invalid`, uid,
      );
    });
    for (const f of files) {
      try {
        fs.unlinkSync(path.join(config.audioDir, f.filename));
      } catch {
        /* already gone */
      }
    }
    audit(ctx.user, 'account_deleted', uid);
    sessions.end(ctx.req, ctx.res);
    return { ok: true };
  });
}

module.exports = { register, INTEREST_TAGS };
