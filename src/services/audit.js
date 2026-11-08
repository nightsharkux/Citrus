'use strict';
/** Append-only audit trail for security-relevant actions. Viewable by administrators. */
function createAudit(db) {
  return function audit(user, action, detail = '') {
    db.run(
      'INSERT INTO audit(institution_id, actor_id, action, detail, created) VALUES(?, ?, ?, ?, ?)',
      user.institution_id, user.id ?? null, action, String(detail).slice(0, 500), new Date().toISOString(),
    );
  };
}

module.exports = { createAudit };
