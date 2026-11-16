'use strict';
/** Sign-in, registration, sign-out, bootstrap and university SSO. */
const { hashPassword, verifyPassword, randomToken } = require('../../lib/crypto');
const { text, email, id } = require('../../lib/validate');
const { badRequest, unauthorized, forbidden, notFound, conflict, tooMany } = require('../../http/errors');
const { createRateLimiter } = require('../../http/rate-limit');
const { publicSite } = require('../../../config/site');
const { createLinks } = require('../live/links');

const LOCK_AFTER = 8;
const LOCK_MS = 15 * 60_000;

function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    institution_id: u.institution_id,
    institution: u.institution,
    name: u.name,
    email: u.email,
    role: u.role,
    requested_role: u.requested_role || null,
    can_publish: !!u.can_publish,
    auth_provider: u.auth_provider || 'local',
    preferences: u.preferences || {},
  };
}

function register(router, { db, config, sessions, oidc, settings, ai, notifier, audit }) {
  // Generous per-IP cap (classrooms share NAT addresses); per-account lockout stops guessing.
  const ipLimiter = createRateLimiter({ windowMs: 15 * 60_000, max: 100 });
  const hallLimiter = createRateLimiter({ windowMs: 15 * 60_000, max: 600 });
  const links = createLinks({ db });

  const institutionOrDefault = (value) => {
    if (value !== undefined && value !== null && value !== '') return id(value, 'University');
    return db.get('SELECT id FROM institutions ORDER BY id LIMIT 1')?.id;
  };

  // The first request of every visit: its reads go together in one round trip to the database.
  router.get('/api/bootstrap', (ctx) => {
    const user = ctx.user;
    const [institutions, admins, unread] = db.batch([
      ['SELECT id, name, slug FROM institutions ORDER BY id'],
      ["SELECT 1 AS yes FROM users WHERE role = 'admin' LIMIT 1"],
      ['SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND read = 0', user?.id || 0],
    ]);
    const firstInstitution = institutions[0]?.id;
    return {
      user: publicUser(user),
      institutions,
      configured: admins.length > 0,
      site: publicSite(config.site),
      sso: { enabled: oidc.enabled(), label: oidc.label() },
      durable: config.persistence.durable,
      guests: guestsOn() && institutions.length > 0,
      registration: firstInstitution ? settings.get(user?.institution_id || firstInstitution, 'allowRegistration') : false,
      ...(user ? { ai: ai.status(user), unread: unread[0].n } : {}),
    };
  }, { auth: 'public' });

  router.post('/api/register', async (ctx) => {
    if (!ipLimiter.hit(`register:${ctx.ip}`)) throw tooMany();
    const b = await ctx.json();
    const institutionId = institutionOrDefault(b.institution_id);
    if (!db.get('SELECT id FROM institutions WHERE id = ?', institutionId)) throw badRequest('Choose a valid university');
    if (!settings.get(institutionId, 'allowRegistration')) throw forbidden('Registration is closed. Ask your university administrator for an account.');
    const name = text(b.name, { min: 2, max: 80, label: 'Name' });
    const mail = email(b.email);
    const password = String(b.password || '');
    if (password.length < 12) throw badRequest('Use a password with at least 12 characters');
    if (db.get('SELECT id FROM users WHERE institution_id = ? AND email = ?', institutionId, mail)) throw conflict('An account with this email already exists');

    // A lecturer account is active at once unless the university turned on approval (Admin → Institution).
    const wantsLecturer = b.role === 'lecturer';
    const needsApproval = wantsLecturer && settings.get(institutionId, 'lecturerApproval');
    const requested = needsApproval ? 'lecturer' : null;
    const userId = db.insert(
      'INSERT INTO users(institution_id, name, email, pass, role, requested_role, created) VALUES(?, ?, ?, ?, ?, ?, ?)',
      institutionId, name, mail, await hashPassword(password), wantsLecturer && !needsApproval ? 'lecturer' : 'student', requested, new Date().toISOString(),
    );
    const user = db.get('SELECT u.*, i.name AS institution FROM users u JOIN institutions i ON i.id = u.institution_id WHERE u.id = ?', userId);
    sessions.start(user, ctx.req, ctx.res);

    if (requested) {
      const admins = db.all("SELECT id FROM users WHERE institution_id = ? AND role = 'admin' AND deleted = 0", institutionId).map((a) => a.id);
      notifier.notify(admins, { kind: 'system', title: 'New lecturer request', body: `${name} asked for lecturer access.`, link: '/admin/people?tab=requests' });
    }
    ctx.status = 201;
    return { user: publicUser({ ...user, preferences: {} }) };
  }, { auth: 'public' });

  // Guests: try the app without an account. A guest is a student with a throwaway account, retired after a month idle.
  //   { lecture, name }  from a lecture's QR code (live/links.js): the guest belongs to that lecture's university and
  //   may give a name. A whole lecture hall shares one network address, so those have a limit per lecture instead.
  const guestsOn = () => !['off', '0', 'false', 'no'].includes(String(process.env.CAMPUS_GUESTS || '').toLowerCase());
  const guestsAllowed = () => guestsOn() && !!db.get('SELECT id FROM institutions LIMIT 1');
  router.post('/api/guest', async (ctx) => {
    if (!guestsOn()) throw forbidden('Guest access is switched off.');
    const b = await ctx.json();
    // A lecture's own university is known from the lecture; otherwise the first one (one lookup that also tells
    // whether there is a university at all).
    const lecture = b.lecture ? links.lectureOf(b.lecture) : null;
    if (b.lecture && !lecture) throw notFound('This QR code no longer works. Ask your lecturer for the current one.');
    const institutionId = lecture ? lecture.institution_id : db.get('SELECT id FROM institutions ORDER BY id LIMIT 1')?.id;
    if (!institutionId) throw forbidden('Guest access is switched off.');
    const allowed = lecture ? hallLimiter.hit(`guest:${ctx.ip}:${lecture.id}`) : ipLimiter.hit(`guest:${ctx.ip}`);
    if (!allowed) throw tooMany('Too many guest sessions from this network. Please wait a few minutes.');
    const name = text(b.name, { max: 60, optional: true, label: 'Name' }).replace(/\s+/g, ' ') || 'Guest';
    const userId = db.insert(
      "INSERT INTO users(institution_id, name, email, pass, role, created, auth_provider) VALUES(?, ?, ?, '!', 'student', ?, 'guest')",
      institutionId, name, `guest-${randomToken(6)}@guest.invalid`, new Date().toISOString(),
    );
    const user = db.get('SELECT u.*, i.name AS institution FROM users u JOIN institutions i ON i.id = u.institution_id WHERE u.id = ?', userId);
    sessions.start(user, ctx.req, ctx.res);
    ctx.status = 201;
    return { user: publicUser({ ...user, preferences: {} }) };
  }, { auth: 'public' });

  router.post('/api/login', async (ctx) => {
    if (!ipLimiter.hit(`login:${ctx.ip}`)) throw tooMany('Too many sign-in attempts. Please wait a few minutes.');
    const b = await ctx.json();
    const institutionId = institutionOrDefault(b.institution_id);
    const mail = String(b.email || '').trim().toLowerCase().slice(0, 180);
    const user = db.get(
      'SELECT u.*, i.name AS institution FROM users u JOIN institutions i ON i.id = u.institution_id WHERE u.institution_id = ? AND u.email = ? AND u.deleted = 0',
      institutionId, mail,
    );
    if (user?.locked_until && user.locked_until > Date.now()) throw tooMany('This account is temporarily locked after several failed attempts. Try again in a few minutes.');
    if (!user || !(await verifyPassword(String(b.password || ''), user.pass))) {
      if (user) {
        const failures = user.failed_logins + 1;
        db.run('UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?', failures, failures >= LOCK_AFTER ? Date.now() + LOCK_MS : null, user.id);
      }
      throw unauthorized('Incorrect email or password');
    }
    if (settings.get(institutionId, 'ssoOnly') && oidc.enabled() && user.role !== 'admin') {
      throw forbidden(`Please use ${oidc.label()} to sign in.`);
    }
    sessions.start(user, ctx.req, ctx.res);
    return { user: publicUser({ ...user, preferences: safeParse(user.preferences) }) };
  }, { auth: 'public' });

  router.post('/api/logout', (ctx) => {
    sessions.end(ctx.req, ctx.res);
    return { ok: true };
  }, { auth: 'public' });

  // --- University single sign-on (OIDC). Browser redirects, not JSON. ---

  router.get('/auth/sso/start', async (ctx) => {
    if (!oidc.enabled()) return ctx.redirect('/login?error=' + encodeURIComponent('University login is not configured'));
    return ctx.redirect(await oidc.begin(ctx.query.get('return') || '/home'));
  }, { auth: 'public' });

  router.get('/auth/sso/callback', async (ctx) => {
    try {
      if (ctx.query.get('error')) throw badRequest(ctx.query.get('error_description') || 'Login was cancelled');
      const { claims, returnTo } = await oidc.complete({ code: ctx.query.get('code'), state: ctx.query.get('state') });
      const user = findOrCreateSsoUser(claims);
      sessions.start(user, ctx.req, ctx.res);
      audit(user, 'sso_login', claims.sub);
      return ctx.redirect(returnTo);
    } catch (error) {
      return ctx.redirect('/login?error=' + encodeURIComponent(error.message || 'Login failed'));
    }
  }, { auth: 'public' });

  function findOrCreateSsoUser(claims) {
    const institutionId = config.oidc.institutionId;
    const subject = `${config.oidc.issuer}|${claims.sub}`;
    const mail = String(claims.email || '').toLowerCase();
    let user = db.get('SELECT * FROM users WHERE institution_id = ? AND external_subject = ? AND deleted = 0', institutionId, subject);
    if (!user && mail) {
      user = db.get('SELECT * FROM users WHERE institution_id = ? AND email = ? AND deleted = 0', institutionId, mail);
      if (user) db.run("UPDATE users SET external_subject = ?, auth_provider = 'oidc' WHERE id = ?", subject, user.id);
    }
    if (!user) {
      if (!config.oidc.autoCreate) throw forbidden('No Campus OS account exists for this university login yet.');
      if (!mail) throw badRequest('Your university login did not share an email address.');
      const staff = oidc.claimsSayLecturer(claims);
      const role = staff && config.oidc.trustRoleClaim ? 'lecturer' : 'student';
      const requested = staff && role === 'student' ? 'lecturer' : null;
      const name = String(claims.name || [claims.given_name, claims.family_name].filter(Boolean).join(' ') || mail.split('@')[0]).slice(0, 80);
      const newId = db.insert(
        "INSERT INTO users(institution_id, name, email, pass, role, requested_role, created, auth_provider, external_subject) VALUES(?, ?, ?, '!', ?, ?, ?, 'oidc', ?)",
        institutionId, name, mail, role, requested, new Date().toISOString(), subject,
      );
      user = db.get('SELECT * FROM users WHERE id = ?', newId);
    }
    return user;
  }
}

function safeParse(json) {
  try {
    return JSON.parse(json || '{}');
  } catch {
    return {};
  }
}

module.exports = { register, publicUser };
