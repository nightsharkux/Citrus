'use strict';
/**
 * Authorisation helpers shared by every module. All return the record when
 * access is allowed and null otherwise — never trust the client (or an AI
 * model) to decide permissions.
 */
function createAccess(db) {
  const isStaff = (user) => user.role === 'lecturer' || user.role === 'admin';

  /** A saved assistant answer belongs only to its authoring account and institution. */
  function assistantMessage(user, messageId) {
    return db.get(`SELECT m.content FROM assistant_messages m
      JOIN assistant_threads t ON t.id = m.thread_id JOIN users u ON u.id = t.user_id
      WHERE m.id = ? AND m.role = 'assistant' AND t.user_id = ? AND u.institution_id = ?`, Number(messageId), user.id, user.institution_id) || null;
  }

  /** Does this user teach (or administer) this course? Decided from the course row, without a query. */
  const teaches = (user, c) => !!c && (user.role === 'admin' || (user.role === 'lecturer' && c.lecturer_id === user.id));

  /** Any course in the user's institution that they teach, administer or are enrolled in. One query. */
  function course(user, courseId) {
    const row = db.get(
      'SELECT c.*, EXISTS(SELECT 1 FROM enrollments e WHERE e.course_id = c.id AND e.user_id = ?) AS access_enrolled FROM courses c WHERE c.id = ? AND c.institution_id = ?',
      user.id, Number(courseId), user.institution_id,
    );
    if (!row) return null;
    const { access_enrolled: enrolled, ...c } = row;
    return teaches(user, c) || enrolled ? c : null;
  }

  /** A course the user may manage (its lecturer, or any admin). */
  function teachingCourse(user, courseId) {
    const c = db.get('SELECT * FROM courses WHERE id = ? AND institution_id = ?', Number(courseId), user.institution_id);
    if (!c) return null;
    return user.role === 'admin' || (user.role === 'lecturer' && c.lecturer_id === user.id) ? c : null;
  }

  function isEnrolled(userId, courseId) {
    return !!db.get('SELECT 1 FROM enrollments WHERE course_id = ? AND user_id = ?', courseId, userId);
  }

  function lecture(user, lectureId, { teach = false } = {}) {
    const l = db.get('SELECT * FROM lectures WHERE id = ?', Number(lectureId));
    if (!l) return null;
    return (teach ? teachingCourse(user, l.course_id) : course(user, l.course_id)) ? l : null;
  }

  function topic(user, topicId, { teach = false } = {}) {
    const t = db.get(
      `SELECT t.*, l.course_id, l.status AS lecture_status
       FROM topics t JOIN lectures l ON l.id = t.lecture_id WHERE t.id = ?`,
      Number(topicId),
    );
    if (!t) return null;
    return (teach ? teachingCourse(user, t.course_id) : course(user, t.course_id)) ? t : null;
  }

  function workspace(user, workspaceId) {
    return db.get('SELECT * FROM workspaces WHERE id = ? AND institution_id = ?', Number(workspaceId), user.institution_id) || null;
  }

  function workspaceMember(user, workspaceId) {
    const w = workspace(user, workspaceId);
    if (!w) return null;
    if (w.creator_id === user.id) return w;
    return db.get('SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?', w.id, user.id) ? w : null;
  }

  /** Owner, or an admin who is also a member. */
  function workspaceOwner(user, workspaceId) {
    const w = workspace(user, workspaceId);
    if (!w) return null;
    if (w.creator_id === user.id) return w;
    if (user.role === 'admin' && db.get('SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?', w.id, user.id)) return w;
    return null;
  }

  /** Can this user steer teaching settings in a workspace? */
  function teachesWorkspace(user, w) {
    if (user.role === 'admin') return true;
    if (user.role !== 'lecturer') return false;
    if (!w.course_id) return w.creator_id === user.id;
    return !!db.get('SELECT 1 FROM courses WHERE id = ? AND institution_id = ? AND lecturer_id = ?', w.course_id, user.institution_id, user.id);
  }

  /** Realtime channel authorisation (see src/realtime/bus.js). */
  function canSee(user, channel) {
    const [kind, raw] = channel.split(':');
    const id = Number(raw);
    switch (kind) {
      case 'user': return id === user.id;
      case 'institution': return id === user.institution_id;
      case 'course': return !!course(user, id);
      case 'workspace': return !!workspaceMember(user, id);
      default: return false;
    }
  }

  return { isStaff, assistantMessage, course, teachingCourse, teaches, isEnrolled, lecture, topic, workspace, workspaceMember, workspaceOwner, teachesWorkspace, canSee };
}

module.exports = { createAccess };
