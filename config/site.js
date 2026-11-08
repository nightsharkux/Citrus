'use strict';
/**
 * Edition (branding) selection. One codebase, several institution themes.
 * Set CAMPUS_EDITION in .env to an id below. Add a new edition by dropping a
 * file in config/editions/ and registering it here.
 */
const VERSION = '1.1.0';

const THEMES = Object.freeze({
  oth: Object.freeze(require('./editions/oth')),
  general: Object.freeze(require('./editions/general')),
});

function siteConfig(env = process.env) {
  const edition = String(env.CAMPUS_EDITION || 'oth').toLowerCase();
  const base = THEMES[edition] || THEMES.oth;
  return {
    ...base,
    accent: base.palette.accent,
    version: VERSION,
    concept: base.id === 'oth',
    mode: 'pilot',
  };
}

/** The subset of edition data that is safe and useful for the browser. */
function publicSite(site) {
  const { id, name, shortName, institution, assistant, tagline, logo, conceptNotice, palette, version, timezone } = site;
  return { id, name, shortName, institution, assistant, tagline, logo, conceptNotice, palette, version, timezone };
}

module.exports = { THEMES, VERSION, siteConfig, publicSite };
