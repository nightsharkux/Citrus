'use strict';
/** Campus guide: edition-defined campuses, official links and current room statuses. */
function register(router, { db, config }) {
  router.get('/api/campus', (ctx) => ({
    campuses: config.site.campuses,
    links: config.site.links,
    notice: config.site.conceptNotice,
    rooms: db.all('SELECT room, status, note, updated FROM notices WHERE institution_id = ? ORDER BY room', ctx.user.institution_id),
    knowledgeCount: db.get('SELECT COUNT(*) n FROM institution_knowledge WHERE institution_id = ?', ctx.user.institution_id).n,
  }));
}

module.exports = { register };
