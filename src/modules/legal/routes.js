'use strict';
/**
 * The Data Service and Privacy Agreement.
 *
 *   GET  /api/agreement          the text for the signed-in person's role (all parts for a visitor, or ?role=),
 *                                with the version they accepted and whether they must accept again
 *   POST /api/agreement/accept   { version }  the person accepts the current version
 *
 * Who must accept: everyone who signs in, and guests and new accounts when they join. Until someone has accepted
 * the current version every other request of theirs is refused with code "agreement" (see app.js), except these
 * two, downloading their data and deleting their account.
 */
const { badRequest, conflict } = require('../../http/errors');
const { agreementFor, VERSION } = require('./agreement');

/** Switched on unless CAMPUS_REQUIRE_AGREEMENT=off (for development and tests only). */
const agreementRequired = (env) => String(env?.CAMPUS_REQUIRE_AGREEMENT || '').toLowerCase() !== 'off';

/** True when this person still has to accept the current version. */
const mustAccept = (env, user) => !!user && agreementRequired(env) && user.agreement_version !== VERSION;

function register(router, { db, env, settings, audit }) {
  const institutionName = (id) => db.get('SELECT name FROM institutions WHERE id = ?', id)?.name;
  const firstInstitution = () => db.get('SELECT id, name FROM institutions ORDER BY id LIMIT 1');

  /** The text for these people, with the institution's own details and retention filled in. */
  function textFor(user, requestedRole, institutionId, lang) {
    const id = user?.institution_id || institutionId || firstInstitution()?.id;
    const s = id ? settings.all(id) : {};
    // Each kind of user has their own text; a visitor reads the one for the kind of account they are about to make.
    const role = user ? (user.auth_provider === 'guest' ? 'guest' : user.role === 'admin' ? 'admin' : user.role === 'lecturer' ? 'lecturer' : 'student') : (['student', 'guest', 'lecturer', 'admin'].includes(requestedRole) ? requestedRole : 'student');
    return agreementFor({
      role,
      institution: (id && institutionName(id)) || undefined, // the text says "your institution" in its own language
      legal: { controller: s.legalController, dpo: s.legalDpo, contact: s.legalContact, authority: s.legalAuthority },
      lectureTextRetentionDays: s.lectureTextRetentionDays,
      lang,
    });
  }

  router.get('/api/agreement', (ctx) => {
    // German first: it is the binding text, so it starts in German whatever the interface language is. English is
    // the second option, one tap away (?lang=en).
    const lang = ctx.query.get('lang') === 'en' ? 'en' : 'de';
    const doc = textFor(ctx.user, ctx.query.get('role'), Number(ctx.query.get('institution_id')) || null, lang);
    return {
      language: doc.language,
      languages: ['de', 'en'],
      version: doc.version,
      updated: doc.updated,
      role: doc.role,
      roleLabel: doc.roleLabel,
      title: doc.title,
      summary: doc.summary,
      sections: doc.sections,
      markdown: doc.markdown,
      accepted: ctx.user ? { version: ctx.user.agreement_version || null, current: ctx.user.agreement_version === VERSION, at: db.get('SELECT agreement_at FROM users WHERE id = ?', ctx.user.id)?.agreement_at || null } : null,
      required: mustAccept(env, ctx.user),
    };
  }, { auth: 'public' });

  router.post('/api/agreement/accept', async (ctx) => {
    const b = await ctx.json();
    if (b.version !== VERSION) throw conflict('The agreement was updated. Reload the page and read the new version.');
    if (b.accept !== true) throw badRequest('Tick the box to accept');
    const user = ctx.user;
    const now = new Date().toISOString();
    db.transaction(() => {
      db.run('UPDATE users SET agreement_version = ?, agreement_at = ? WHERE id = ?', VERSION, now, user.id);
      db.run('INSERT INTO agreement_acceptances(user_id, version, role, via, created) VALUES(?, ?, ?, ?, ?)', user.id, VERSION, user.auth_provider === 'guest' ? 'guest' : user.role, ['prompt', 'settings'].includes(b.via) ? b.via : 'prompt', now);
    });
    audit(user, 'agreement_accepted', VERSION);
    return { ok: true, version: VERSION, at: now };
  }, { agreementExempt: true });
}

module.exports = { register, agreementRequired, mustAccept };
