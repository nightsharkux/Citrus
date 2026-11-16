'use strict';
/**
 * A course page like Moodle's: topics, and topics inside topics (folders within folders), each with files, links
 * and its own lectures. Items without a topic belong to the course as a whole ("General").
 *
 * Files are kept in the database (base64, at most a few MB each) with their readable text, so Citrus can use them
 * in lectures and answers and students can download them.
 */
const { addColumn } = require('../helpers');

module.exports = {
  version: 24,
  name: 'course-sections',
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS course_sections(
        id INTEGER PRIMARY KEY,
        course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
        parent_id INTEGER REFERENCES course_sections(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        position INTEGER NOT NULL DEFAULT 0,
        created TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_course_sections ON course_sections(course_id, parent_id, position);
      CREATE TABLE IF NOT EXISTS course_items(
        id INTEGER PRIMARY KEY,
        course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
        section_id INTEGER REFERENCES course_sections(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK(kind IN ('file','link','note')),
        title TEXT NOT NULL,
        url TEXT NOT NULL DEFAULT '',
        mime TEXT NOT NULL DEFAULT '',
        size INTEGER NOT NULL DEFAULT 0,
        data TEXT NOT NULL DEFAULT '',
        text TEXT NOT NULL DEFAULT '',
        position INTEGER NOT NULL DEFAULT 0,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_course_items ON course_items(course_id, section_id, position);
    `);
    addColumn(db, 'lectures', 'section_id', 'INTEGER REFERENCES course_sections(id) ON DELETE SET NULL');
  },
};
