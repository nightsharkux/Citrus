'use strict';
/**
 * First-run data: one institution and, when CAMPUS_ADMIN_PASSWORD is set,
 * an administrator plus a clearly labelled demo course.
 */
const { hashPasswordSync: hashPassword } = require('../lib/crypto');

function seed(db, config, log = console.log) {
  if (db.get('SELECT id FROM institutions LIMIT 1')) return;
  const created = new Date().toISOString();
  const institutionId = db.insert('INSERT INTO institutions(name, slug, created) VALUES(?, ?, ?)', config.seed.institution || config.site.institution, 'demo-university', created);

  const password = config.seed.adminPassword;
  if (!password || password.length < 12) {
    log('\nSetup needed: set CAMPUS_ADMIN_PASSWORD in .env and run `node --env-file=.env setup-admin.js`.\n');
    return;
  }
  db.insert(
    'INSERT INTO users(institution_id, name, email, pass, role, created) VALUES(?, ?, ?, ?, ?, ?)',
    institutionId, 'University Administrator', config.seed.adminEmail.toLowerCase(), hashPassword(password), 'admin', created,
  );
  const courseId = db.insert('INSERT INTO courses(institution_id, title, code, lecturer_id) VALUES(?, ?, ?, NULL)', institutionId, 'Demo course · Introduction to Digital Technology', 'DEMO101');
  const lectureId = db.insert('INSERT INTO lectures(course_id, topic, created) VALUES(?, ?, ?)', courseId, 'Welcome and learning goals', created);
  db.insert('INSERT INTO topics(lecture_id, title, created) VALUES(?, ?, ?)', lectureId, 'Course overview', created);
  log(`Administrator created: ${config.seed.adminEmail}`);
}

module.exports = { seed };
