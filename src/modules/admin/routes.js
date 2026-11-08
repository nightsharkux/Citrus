'use strict';
/** Institution administration: people, roles, lecturer approvals, feedback, settings, audit and export. */
const { id, oneOf, integer } = require('../../lib/validate');
const { badRequest, notFound, unavailable } = require('../../http/errors');
const { suggestionsPrompt, referenceBlock } = require('../../ai/prompts');
const { networkUrls } = require('../../lib/network');

const ROLES = ['student', 'lecturer', 'admin'];
const SUGGESTION_STATUS = ['new', 'planned', 'done', 'declined'];

function register(router, deps) {
  const { db, config, ai, audit, settings, notifier, oidc, push } = deps;
  const ADMIN = { roles: ['admin'] };
  const inInstitution = (user, userId) => db.get('SELECT * FROM users WHERE id = ? AND institution_id = ? AND deleted = 0', id(userId), user.institution_id);
  const adminCount = (institutionId) => db.get("SELECT COUNT(*) n FROM users WHERE institution_id = ? AND role = 'admin' AND deleted = 0", institutionId).n;

  router.get('/api/admin/overview', (ctx) => {
    const inst = ctx.user.institution_id;
    const count = (sql, ...a) => db.get(sql, inst, ...a).n;
    return {
      people: {
        students: count("SELECT COUNT(*) n FROM users WHERE institution_id = ? AND role = 'student' AND deleted = 0"),
        lecturers: count("SELECT COUNT(*) n FROM users WHERE institution_id = ? AND role = 'lecturer' AND deleted = 0"),
        admins: count("SELECT COUNT(*) n FROM users WHERE institution_id = ? AND role = 'admin' AND deleted = 0"),
        activeWeek: db.get('SELECT COUNT(*) n FROM users WHERE institution_id = ? AND last_login > ?', inst, new Date(Date.now() - 7 * 86_400_000).toISOString()).n,
      },
      pending: {
        lecturers: count("SELECT COUNT(*) n FROM users WHERE institution_id = ? AND requested_role = 'lecturer' AND role = 'student' AND deleted = 0"),
        posts: count("SELECT COUNT(*) n FROM cx_posts WHERE institution_id = ? AND status = 'pending'"),
        reports: count("SELECT COUNT(*) n FROM cx_reports r JOIN cx_posts p ON p.id = r.post_id WHERE p.institution_id = ? AND p.status = 'published'"),
        suggestions: count("SELECT COUNT(*) n FROM suggestions WHERE institution_id = ? AND status = 'new'"),
      },
      courses: count('SELECT COUNT(*) n FROM courses WHERE institution_id = ?'),
      knowledge: count('SELECT COUNT(*) n FROM institution_knowledge WHERE institution_id = ?'),
      devices: {
        total: count("SELECT COUNT(*) n FROM devices WHERE institution_id = ? AND status = 'active'"),
        online: db.get("SELECT COUNT(*) n FROM devices WHERE institution_id = ? AND status = 'active' AND last_seen > ?", inst, Date.now() - 90_000).n,
      },
      ai: ai.status(ctx.user),
    };
  }, ADMIN);

  router.get('/api/admin/users', (ctx) => ({
    users: db.all(
      `SELECT id, name, email, role, requested_role, can_publish, created, last_login, auth_provider,
              EXISTS(SELECT 1 FROM cx_nfc_bindings b WHERE b.user_id = users.id) AS has_card
       FROM users WHERE institution_id = ? AND deleted = 0 ORDER BY name`,
      ctx.user.institution_id,
    ).map((u) => ({ ...u, can_publish: !!u.can_publish, has_card: !!u.has_card })),
  }), ADMIN);

  function changeRole(actor, target, role) {
    if (target.id === actor.id) throw badRequest('You cannot change your own role');
    oneOf(role, ROLES, 'Role');
    if (target.role === 'admin' && role !== 'admin' && adminCount(actor.institution_id) <= 1) throw badRequest('At least one administrator is required');
    db.run('UPDATE users SET role = ?, requested_role = NULL WHERE id = ?', role, target.id);
    if (role !== target.role) db.run('DELETE FROM sessions WHERE user_id = ?', target.id);
    audit(actor, 'role_changed', `${target.id}:${role}`);
  }

  router.post('/api/admin/users/role', async (ctx) => {
    const b = await ctx.json();
    const target = inInstitution(ctx.user, b.id);
    if (!target) throw badRequest('Invalid role change');
    changeRole(ctx.user, target, b.role);
    return { ok: true };
  }, ADMIN);

  router.patch('/api/admin/users/:id', async (ctx) => {
    const target = inInstitution(ctx.user, ctx.params.id);
    if (!target) throw notFound('Person not found');
    const b = await ctx.json();
    if (b.role !== undefined && b.role !== target.role) changeRole(ctx.user, target, b.role);
    if (b.can_publish !== undefined) {
      db.run('UPDATE users SET can_publish = ? WHERE id = ?', b.can_publish ? 1 : 0, target.id);
      audit(ctx.user, 'publisher_changed', `${target.id}:${b.can_publish ? 1 : 0}`);
    }
    if (b.unlock) db.run('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?', target.id);
    return { ok: true };
  }, ADMIN);

  router.post('/api/admin/users/:id/sign-out', (ctx) => {
    const target = inInstitution(ctx.user, ctx.params.id);
    if (!target) throw notFound('Person not found');
    db.run('DELETE FROM sessions WHERE user_id = ?', target.id);
    audit(ctx.user, 'sessions_revoked', target.id);
    return { ok: true };
  }, ADMIN);

  router.post('/api/admin/assign', async (ctx) => {
    const b = await ctx.json();
    const course = db.get('SELECT id FROM courses WHERE id = ? AND institution_id = ?', Number(b.course_id), ctx.user.institution_id);
    const lecturerId = b.lecturer_id === null || b.lecturer_id === '' ? null : Number(b.lecturer_id);
    const lecturer = lecturerId === null ? { id: null } : db.get("SELECT id FROM users WHERE id = ? AND institution_id = ? AND role IN ('lecturer','admin') AND deleted = 0", lecturerId, ctx.user.institution_id);
    if (!course || !lecturer) throw badRequest('Invalid course or lecturer');
    db.run('UPDATE courses SET lecturer_id = ? WHERE id = ?', lecturer.id, course.id);
    audit(ctx.user, 'lecturer_assigned', `${course.id}:${lecturer.id}`);
    return { ok: true };
  }, ADMIN);

  router.get('/api/admin/lecturer-applications', (ctx) => ({
    applications: db.all("SELECT id, name, email, created FROM users WHERE institution_id = ? AND requested_role = 'lecturer' AND role = 'student' AND deleted = 0 ORDER BY id", ctx.user.institution_id),
  }), ADMIN);

  router.post('/api/admin/lecturer-applications', async (ctx) => {
    const b = await ctx.json();
    const target = db.get("SELECT id FROM users WHERE id = ? AND institution_id = ? AND requested_role = 'lecturer' AND role = 'student'", Number(b.user_id), ctx.user.institution_id);
    if (!target) throw notFound('Application not found');
    const decision = oneOf(b.decision, ['approve', 'reject'], 'Decision');
    db.run('UPDATE users SET role = ?, requested_role = NULL WHERE id = ?', decision === 'approve' ? 'lecturer' : 'student', target.id);
    audit(ctx.user, `lecturer_${decision}d`, target.id);
    notifier.notify(target.id, decision === 'approve'
      ? { kind: 'system', title: 'Lecturer access approved', body: 'Sign out and back in to see your teaching tools.', link: '/home' }
      : { kind: 'system', title: 'Lecturer request not approved', body: 'Contact your administrator if you think this is a mistake.', link: '/settings' });
    return { ok: true };
  }, ADMIN);

  // --- Feedback ---

  router.get('/api/admin/suggestions', (ctx) => ({
    suggestions: db.all('SELECT s.*, u.name FROM suggestions s JOIN users u ON u.id = s.user_id WHERE s.institution_id = ? ORDER BY s.id DESC', ctx.user.institution_id),
  }), ADMIN);

  router.patch('/api/admin/suggestions/:id', async (ctx) => {
    const b = await ctx.json();
    db.run('UPDATE suggestions SET status = ? WHERE id = ? AND institution_id = ?', oneOf(b.status, SUGGESTION_STATUS, 'Status'), id(ctx.params.id), ctx.user.institution_id);
    return { ok: true };
  }, ADMIN);

  router.post('/api/admin/suggestions/summary', async (ctx) => {
    const rows = db.all("SELECT message FROM suggestions WHERE institution_id = ? AND status IN ('new','planned') ORDER BY id DESC LIMIT 120", ctx.user.institution_id);
    if (rows.length < 2) throw badRequest('There are not enough open suggestions to summarise');
    if (!ai.status(ctx.user).aiEnabled) throw unavailable('AI is not configured');
    const summary = await ai.complete({ user: ctx.user, system: suggestionsPrompt(), prompt: referenceBlock('SUGGESTIONS', rows.map((r, i) => `${i + 1}. ${r.message}`).join('\n').slice(0, 20_000)), maxTokens: 900, task: 'summary' });
    return { summary, count: rows.length };
  }, ADMIN);

  // --- Settings, integrations, audit ---

  router.get('/api/admin/settings', (ctx) => ({
    institution: db.get('SELECT id, name, slug FROM institutions WHERE id = ?', ctx.user.institution_id),
    settings: settings.all(ctx.user.institution_id),
    integrations: {
      sso: { configured: oidc.enabled(), label: oidc.label(), issuer: config.oidc.issuer || null },
      moodle: { configured: !!config.moodle.url, url: config.moodle.url || null },
      push: { configured: true, publicKey: push.publicKey, subscribers: db.get('SELECT COUNT(DISTINCT p.user_id) n FROM push_subscriptions p JOIN users u ON u.id = p.user_id WHERE u.institution_id = ?', ctx.user.institution_id).n },
      transcription: { configured: ai.transcriptionReady() },
      ai: ai.status(ctx.user),
    },
    publicUrl: config.publicUrl,
    network: { host: config.host, port: config.port, urls: networkUrls(config.host, config.port), secure: config.publicUrl.startsWith('https://') },
  }), ADMIN);

  router.patch('/api/admin/settings', async (ctx) => {
    const b = await ctx.json();
    const changes = {};
    if (b.allowRegistration !== undefined) changes.allowRegistration = !!b.allowRegistration;
    if (b.ssoOnly !== undefined) {
      if (b.ssoOnly && !oidc.enabled()) throw badRequest('Configure single sign-on before requiring it');
      changes.ssoOnly = !!b.ssoOnly;
    }
    if (b.recordingRetentionDays !== undefined) changes.recordingRetentionDays = integer(b.recordingRetentionDays, { min: 0, max: 3650, label: 'Retention' });
    const next = settings.set(ctx.user.institution_id, changes);
    audit(ctx.user, 'settings_changed', JSON.stringify(changes));
    return { settings: next };
  }, ADMIN);

  router.get('/api/admin/audit', (ctx) => ({
    entries: db.all(
      'SELECT a.id, a.action, a.detail, a.created, u.name AS actor FROM audit a LEFT JOIN users u ON u.id = a.actor_id WHERE a.institution_id = ? ORDER BY a.id DESC LIMIT ?',
      ctx.user.institution_id, Math.min(500, Number(ctx.query.get('limit')) || 100),
    ),
  }), ADMIN);

  router.get('/api/admin/export', (ctx) => {
    const inst = ctx.user.institution_id;
    const viaCourse = (table, alias, join) => db.all(`SELECT ${alias}.* FROM ${table} ${alias} ${join} WHERE c.institution_id = ?`, inst);
    const data = {
      institution: ctx.user.institution,
      exported: new Date().toISOString(),
      users: db.all('SELECT id, name, email, role, created, last_login FROM users WHERE institution_id = ? AND deleted = 0', inst),
      courses: db.all('SELECT * FROM courses WHERE institution_id = ?', inst),
      enrollments: viaCourse('enrollments', 'e', 'JOIN courses c ON c.id = e.course_id'),
      lectures: viaCourse('lectures', 'l', 'JOIN courses c ON c.id = l.course_id'),
      topics: viaCourse('topics', 't', 'JOIN lectures l ON l.id = t.lecture_id JOIN courses c ON c.id = l.course_id'),
      responses: viaCourse('responses', 'r', 'JOIN topics t ON t.id = r.topic_id JOIN lectures l ON l.id = t.lecture_id JOIN courses c ON c.id = l.course_id'),
      polls: viaCourse('polls', 'p', 'JOIN topics t ON t.id = p.topic_id JOIN lectures l ON l.id = t.lecture_id JOIN courses c ON c.id = l.course_id'),
      pollAnswers: viaCourse('poll_answers', 'pa', 'JOIN polls p ON p.id = pa.poll_id JOIN topics t ON t.id = p.topic_id JOIN lectures l ON l.id = t.lecture_id JOIN courses c ON c.id = l.course_id'),
      timetable: db.all('SELECT * FROM timetable_events WHERE institution_id = ? AND owner_id IS NULL', inst),
      suggestions: db.all('SELECT * FROM suggestions WHERE institution_id = ?', inst),
      connectPosts: db.all('SELECT * FROM cx_posts WHERE institution_id = ?', inst),
      connectReports: db.all('SELECT r.* FROM cx_reports r JOIN cx_posts p ON p.id = r.post_id WHERE p.institution_id = ?', inst),
      notificationPreferences: db.all('SELECT p.* FROM cx_preferences p JOIN users u ON u.id = p.user_id WHERE u.institution_id = ?', inst),
      participationSessions: db.all('SELECT id, institution_id, course_id, owner_id, title, room, open, created, require_code FROM cx_attendance_sessions WHERE institution_id = ?', inst),
      participationCheckins: db.all('SELECT ch.* FROM cx_checkins ch JOIN cx_attendance_sessions s ON s.id = ch.session_id WHERE s.institution_id = ?', inst),
      knowledge: db.all('SELECT * FROM institution_knowledge WHERE institution_id = ?', inst),
      devices: db.all('SELECT id, name, kind, room, status, firmware, created FROM devices WHERE institution_id = ?', inst),
      audit: db.all('SELECT * FROM audit WHERE institution_id = ? ORDER BY id DESC LIMIT 5000', inst),
    };
    audit(ctx.user, 'institution_exported', '');
    ctx.res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': 'attachment; filename="campusos-export.json"', 'Cache-Control': 'no-store' });
    ctx.res.end(JSON.stringify(data, null, 2));
  }, ADMIN);
}

module.exports = { register };
