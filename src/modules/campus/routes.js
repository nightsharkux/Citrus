'use strict';
/** Campus guide: edition-defined campuses, official links and current room statuses, and the campus map. */
const { readBundled } = require('../../lib/bundled');

function register(router, { db, config, timetable, programmes }) {
  let mapFile;
  const campusMap = () => {
    if (mapFile === undefined) {
      try {
        mapFile = config.site.campusMap ? JSON.parse(readBundled(config.root, config.site.campusMap)) : null;
      } catch {
        mapFile = null;
      }
    }
    return mapFile;
  };

  /** Geometry and places for the map page. Public university data, but the page is for signed-in users like the rest of the app. */
  router.get('/api/campus/map', () => ({ map: campusMap() }));

  /**
   * The lessons a student may want to walk to next: those in their own schedule that have a room, and the official
   * programme timetable for the programme and semester in their profile (or the ones they pick on the map page).
   */
  router.get('/api/campus/map/classes', (ctx) => {
    const user = ctx.user;
    const now = new Date();
    const profile = db.get('SELECT programme, semester FROM user_profiles WHERE user_id = ?', user.id);
    const asked = String(ctx.query.get('programme') || '').slice(0, 80);
    const codes = programmes ? programmes.fromProfile(asked || profile?.programme) : [];
    const semester = Number(ctx.query.get('semester')) || profile?.semester || null;
    const mine = timetable.upcoming(user, { days: 7, limit: 80 })
      .filter((e) => e.location && Date.parse(e.ends) > now.getTime())
      .slice(0, 10)
      .map((e) => ({ title: e.title, starts: e.starts, ends: e.ends, location: e.location, source: 'schedule' }));
    const official = codes.length ? programmes.upcoming({ codes, semester, now, days: 7, limit: 12 }) : [];
    return {
      classes: [...mine, ...official].sort((a, b) => a.starts.localeCompare(b.starts)).slice(0, 14),
      programme: codes[0] || null,
      semester,
      semesters: codes[0] && programmes ? programmes.semestersOf(codes[0]) : [],
      programmes: programmes ? programmes.programmes().map((p) => ({ code: p.code, name: p.name })) : [],
    };
  });

  router.get('/api/campus', (ctx) => ({
    campuses: config.site.campuses,
    links: config.site.links,
    notice: config.site.conceptNotice,
    rooms: db.all('SELECT room, status, note, updated FROM notices WHERE institution_id = ? ORDER BY room', ctx.user.institution_id),
    hasMap: !!config.site.campusMap,
    knowledgeCount: db.get('SELECT COUNT(*) n FROM institution_knowledge WHERE institution_id = ?', ctx.user.institution_id).n,
  }));
}

module.exports = { register };
