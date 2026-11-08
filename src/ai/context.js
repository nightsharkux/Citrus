'use strict';
/**
 * Builds the "CONTEXT" block for the personal assistant from the user's OWN
 * Campus OS data only. Add a new section by adding a function to SECTIONS —
 * each returns a short string or ''.
 */
function createContextBuilder({ db, timetable, timeZone }) {
  const fmt = (iso, opts) => new Intl.DateTimeFormat('en-GB', { timeZone, ...opts }).format(new Date(iso));

  const SECTIONS = [
    function clock() {
      const now = new Date().toISOString();
      return `Now: ${fmt(now, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}, ${fmt(now, { hour: '2-digit', minute: '2-digit' })} (${timeZone})`;
    },

    function profile(user) {
      const p = db.get('SELECT p.programme, p.semester, p.interests FROM user_profiles p JOIN users u ON u.id = p.user_id WHERE p.user_id = ? AND u.institution_id = ?', user.id, user.institution_id);
      const bits = [`Role: ${user.role}`];
      if (p?.programme) bits.push(`Programme: ${p.programme}${p.semester ? `, semester ${p.semester}` : ''}`);
      const interests = p ? JSON.parse(p.interests) : [];
      if (interests.length) bits.push(`Interests: ${interests.join(', ')}`);
      return bits.join(' · ');
    },

    function courses(user) {
      const rows = user.role === 'student'
        ? db.all('SELECT c.code, c.title FROM enrollments e JOIN courses c ON c.id = e.course_id WHERE e.user_id = ? AND c.institution_id = ? ORDER BY c.code LIMIT 20', user.id, user.institution_id)
        : db.all("SELECT code, title FROM courses WHERE institution_id = ? AND (lecturer_id = ? OR ? = 'admin') ORDER BY code LIMIT 20", user.institution_id, user.id, user.role);
      return rows.length ? `${user.role === 'student' ? 'Enrolled courses' : 'Courses you teach/manage'}: ${rows.map((c) => `${c.code} ${c.title}`).join('; ')}` : '';
    },

    function difficulties(user) {
      if (user.role !== 'student') return '';
      const rows = db.all(
        `SELECT t.title, c.code FROM responses r JOIN topics t ON t.id = r.topic_id JOIN lectures l ON l.id = t.lecture_id JOIN courses c ON c.id = l.course_id
         WHERE r.user_id = ? AND c.institution_id = ? AND r.level < 3 AND EXISTS (SELECT 1 FROM enrollments e WHERE e.user_id = r.user_id AND e.course_id = c.id) ORDER BY r.created DESC LIMIT 8`, user.id, user.institution_id,
      );
      return rows.length ? `Topics the user marked as not yet understood: ${rows.map((r) => `${r.title} (${r.code})`).join('; ')}` : '';
    },

    function review(user) {
      const due = db.get('SELECT COUNT(*) n FROM review_items r JOIN users u ON u.id = r.user_id LEFT JOIN courses c ON c.id = r.course_id WHERE r.user_id = ? AND u.institution_id = ? AND (r.course_id IS NULL OR c.institution_id = u.institution_id) AND r.due <= ?', user.id, user.institution_id, new Date().toISOString()).n;
      return due ? `Review items due now: ${due}` : '';
    },

    function schedule(user) {
      const events = timetable.upcoming(user, { days: 7, limit: 8 });
      if (!events.length) return 'Upcoming schedule (7 days): nothing in Campus OS';
      return `Upcoming schedule (7 days):\n${events.map((e) => `- ${fmt(e.starts, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}–${fmt(e.ends, { hour: '2-digit', minute: '2-digit' })} ${e.title}${e.location ? ` @ ${e.location}` : ''}`).join('\n')}`;
    },
  ];

  return function build(user) {
    return SECTIONS.map((section) => {
      try {
        return section(user);
      } catch {
        return '';
      }
    }).filter(Boolean).join('\n');
  };
}

module.exports = { createContextBuilder };
