'use strict';
/**
 * Data files the app reads while it runs (knowledge packs, class timetables, the campus map).
 *
 * Each one is read with a literal path on purpose: hosting such as Vercel works out which files to ship by
 * following the code, and it follows `fs.readFileSync(path.join(__dirname, '..', 'resources', 'x.json'))` but
 * not a path assembled from configuration. When you add a data file to a pack or an edition, add its line here
 * too. Anything not listed is still read from `root`, which is fine when you run the app yourself.
 */
const fs = require('node:fs');
const path = require('node:path');

const READERS = {
  'resources/OTH_Public_Knowledge_2026-10-31.jsonl': () => fs.readFileSync(path.join(__dirname, '..', '..', 'resources', 'OTH_Public_Knowledge_2026-10-31.jsonl'), 'utf8'),
  'resources/OTH_Website_Knowledge.jsonl': () => fs.readFileSync(path.join(__dirname, '..', '..', 'resources', 'OTH_Website_Knowledge.jsonl'), 'utf8'),
  'resources/Citrus_OTH_AW_Academic_Data_2026-11-08.txt': () => fs.readFileSync(path.join(__dirname, '..', '..', 'resources', 'Citrus_OTH_AW_Academic_Data_2026-11-08.txt'), 'utf8'),
  'resources/oth-campus-map.json': () => fs.readFileSync(path.join(__dirname, '..', '..', 'resources', 'oth-campus-map.json'), 'utf8'),
};

/** Text of a data file named relative to the project root ('resources/x.json'). Throws if it is missing. */
function readBundled(root, relative) {
  const direct = READERS[relative];
  return direct ? direct() : fs.readFileSync(path.join(root, relative), 'utf8');
}

module.exports = { readBundled };
