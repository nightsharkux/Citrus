'use strict';
/** Study groups: your own requests and other students' open ones. See ./service.js for what is shown to whom. */
const { text, id } = require('../../lib/validate');
const { notFound, badRequest } = require('../../http/errors');

function register(router, { db, studyGroups: groups }) {
  router.get('/api/groups', (ctx) => ({ mine: groups.mine(ctx.user), others: groups.others(ctx.user) }));

  router.post('/api/groups', async (ctx) => {
    const b = await ctx.json();
    const subject = text(b.subject, { min: 2, max: 120, label: 'Subject' });
    let courseId = null;
    if (b.course) {
      const c = db.get('SELECT id FROM courses WHERE institution_id = ? AND UPPER(code) = UPPER(?)', ctx.user.institution_id, String(b.course).trim());
      if (!c) throw notFound('Course not found');
      courseId = c.id;
    }
    try {
      const r = groups.seek(ctx.user, { subject, note: text(b.note, { max: 300, optional: true }) || '', courseId, shareContact: b.share_contact === true });
      ctx.status = r.created ? 201 : 200;
      return r;
    } catch (error) {
      if (error.status === 400) throw badRequest(error.message);
      throw error;
    }
  });

  router.patch('/api/groups/:id', async (ctx) => {
    const b = await ctx.json();
    if (typeof b.share_contact !== 'boolean') throw badRequest('Say whether to share your contact');
    if (!groups.setShare(ctx.user, id(ctx.params.id), b.share_contact)) throw notFound('Request not found');
    return { mine: groups.mine(ctx.user) };
  });

  router.delete('/api/groups/:id', (ctx) => {
    if (!groups.close(ctx.user, { id: id(ctx.params.id) })) throw notFound('Request not found');
    return { ok: true };
  });
}

module.exports = { register };
