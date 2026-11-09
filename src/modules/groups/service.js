'use strict';
/**
 * Study-group finder. A student says what they want a group for; the request is kept until they close it, and every
 * student of the same institution looking for something similar is matched with it.
 *
 * Privacy: a request is visible to the institution, but the person behind it is named (with their e-mail) only when
 * they agreed to share their contact (share_contact = 1). Otherwise others see "a student" and the programme.
 */
const STOP = new Set(['a', 'an', 'the', 'for', 'in', 'of', 'and', 'to', 'on', 'my', 'group', 'groups', 'study', 'studying', 'learning', 'learn', 'partner', 'partners', 'buddy', 'team',
  'für', 'fur', 'fuer', 'die', 'der', 'das', 'den', 'dem', 'und', 'im', 'in', 'zu', 'zum', 'zur', 'gruppe', 'gruppen', 'lerngruppe', 'lerngruppen', 'lernen', 'kurs', 'course', 'fach', 'subject', 'module', 'modul']);

/** Words of a subject, lower case without accents, so "Mathe 2", "mathe II" and "Mathematik 2" come out close. */
function subjectKey(subject) {
  const roman = { i: '1', ii: '2', iii: '3', iv: '4', v: '5' };
  return String(subject || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss')
    .split(/[^a-z0-9]+/).filter(Boolean).map((w) => roman[w] || w).filter((w) => !STOP.has(w)).join(' ');
}

/** True when two subject keys name the same thing: every word of the shorter one starts a word of the other (or the reverse). */
function similar(a, b) {
  const x = a.split(' ').filter(Boolean);
  const y = b.split(' ').filter(Boolean);
  if (!x.length || !y.length) return false;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  const hit = (w) => long.some((v) => (w.length < 4 || v.length < 4 ? w === v : v.startsWith(w.slice(0, 4)) || w.startsWith(v.slice(0, 4))));
  return short.every(hit);
}

function createStudyGroups({ db, notifier }) {
  const now = () => new Date().toISOString();

  const rows = (institutionId) => db.all(
    `SELECT r.*, u.name, u.email, p.programme, p.semester, c.code AS course_code FROM study_group_requests r
     JOIN users u ON u.id = r.user_id AND u.deleted = 0
     LEFT JOIN user_profiles p ON p.user_id = r.user_id LEFT JOIN courses c ON c.id = r.course_id
     WHERE r.institution_id = ? AND r.status = 'open' ORDER BY r.updated DESC LIMIT 400`, institutionId,
  );

  /** What one person may see of a request. */
  function view(r, viewer) {
    const mine = r.user_id === viewer.id;
    const shared = !!r.share_contact;
    return {
      id: r.id, subject: r.subject, note: r.note, course: r.course_code || null, mine, shareContact: shared, status: r.status, created: r.created,
      name: mine || shared ? r.name : null,
      email: mine || shared ? r.email : null,
      programme: r.programme ? `${r.programme}${r.semester ? `, semester ${r.semester}` : ''}` : null,
    };
  }

  /** Other people's open requests that match `subject` (or the same course). */
  function matches(user, subject, { courseId = null } = {}) {
    const key = subjectKey(subject);
    return rows(user.institution_id)
      .filter((r) => r.user_id !== user.id && ((courseId && r.course_id === courseId) || similar(key, r.subject_key)))
      .slice(0, 8).map((r) => view(r, user));
  }

  const mine = (user) => db.all(
    `SELECT r.*, u.name, u.email, c.code AS course_code FROM study_group_requests r JOIN users u ON u.id = r.user_id
     LEFT JOIN courses c ON c.id = r.course_id WHERE r.user_id = ? AND r.status = 'open' ORDER BY r.updated DESC`, user.id,
  ).map((r) => view(r, user));

  const others = (user) => rows(user.institution_id).filter((r) => r.user_id !== user.id).slice(0, 60).map((r) => view(r, user));

  /**
   * Record that `user` is looking for a group. The same subject updates their existing request instead of adding a
   * second one. Matching students hear about it, by name only if this person shares their contact.
   */
  function seek(user, { subject, note = '', courseId = null, shareContact }) {
    const clean = String(subject || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    const key = subjectKey(clean);
    if (clean.length < 2 || !key) throw Object.assign(new Error('Say which subject or course the group is for.'), { status: 400 });
    const text = String(note || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    const existing = db.all("SELECT * FROM study_group_requests WHERE user_id = ? AND status = 'open'", user.id)
      .find((r) => r.subject_key === key || similar(key, r.subject_key));
    let id;
    let created = false;
    let before = null;
    if (existing) {
      id = existing.id;
      before = { subject: existing.subject, subject_key: existing.subject_key, note: existing.note, share_contact: existing.share_contact, course_id: existing.course_id };
      db.run('UPDATE study_group_requests SET subject = ?, subject_key = ?, note = ?, share_contact = ?, course_id = ?, updated = ? WHERE id = ?',
        clean, key, text || existing.note, shareContact === undefined ? existing.share_contact : shareContact ? 1 : 0, courseId ?? existing.course_id, now(), id);
    } else {
      id = db.insert('INSERT INTO study_group_requests(institution_id, user_id, subject, subject_key, course_id, note, share_contact, created, updated) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)',
        user.institution_id, user.id, clean, key, courseId, text, shareContact ? 1 : 0, now(), now());
      created = true;
    }
    const row = db.get('SELECT share_contact FROM study_group_requests WHERE id = ?', id);
    const found = matches(user, clean, { courseId });
    const newlyShared = row.share_contact && (created || !before?.share_contact);
    if (notifier && found.length && (created || newlyShared)) {
      const who = row.share_contact ? user.name : 'Another student';
      notifier.notify(found.map((m) => db.get('SELECT user_id FROM study_group_requests WHERE id = ?', m.id).user_id), {
        kind: 'system', title: `${who} is also looking for a study group`, body: `${clean}${row.share_contact ? ` · ${user.email}` : ''}`, link: '/groups',
      });
    }
    return { id, created, before, shareContact: !!row.share_contact, subject: clean, matches: found };
  }

  /** The user's own open request, by id or by subject. */
  function own(user, { id, subject }) {
    const open = db.all("SELECT * FROM study_group_requests WHERE user_id = ? AND status = 'open' ORDER BY updated DESC", user.id);
    if (id !== undefined && id !== null && id !== '') return open.find((r) => r.id === Number(id)) || null;
    if (subject) {
      const key = subjectKey(subject);
      return open.find((r) => r.subject_key === key) || open.find((r) => similar(key, r.subject_key)) || null;
    }
    return open.length === 1 ? open[0] : null;
  }

  function close(user, which) {
    const r = own(user, which);
    if (!r) return null;
    db.run("UPDATE study_group_requests SET status = 'closed', updated = ? WHERE id = ?", now(), r.id);
    return r;
  }

  function reopen(user, id) {
    db.run("UPDATE study_group_requests SET status = 'open', updated = ? WHERE id = ? AND user_id = ?", now(), id, user.id);
  }

  function restore(user, id, before) {
    db.run('UPDATE study_group_requests SET subject = ?, subject_key = ?, note = ?, share_contact = ?, course_id = ?, updated = ? WHERE id = ? AND user_id = ?',
      before.subject, before.subject_key, before.note, before.share_contact, before.course_id, now(), id, user.id);
  }

  function setShare(user, id, share) {
    const r = db.get("SELECT id FROM study_group_requests WHERE id = ? AND user_id = ? AND status = 'open'", id, user.id);
    if (!r) return false;
    db.run('UPDATE study_group_requests SET share_contact = ?, updated = ? WHERE id = ?', share ? 1 : 0, now(), id);
    return true;
  }

  /** One line per request for the assistant's CONTEXT. */
  function describe(v) {
    const who = v.mine ? 'you' : v.name ? `${v.name} (${v.email})` : 'a student (contact not shared)';
    return `[group ${v.id}] ${v.subject}${v.course ? ` [${v.course}]` : ''} — ${who}${v.programme && !v.mine ? `, ${v.programme}` : ''}${v.note ? `: ${v.note}` : ''}`;
  }

  return { seek, matches, mine, others, close, reopen, restore, setShare, view, describe, subjectKey, similar };
}

module.exports = { createStudyGroups, subjectKey, similar };
