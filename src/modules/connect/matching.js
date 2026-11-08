'use strict';
/**
 * Opt-in opportunity matching: a transparent keyword score between a post and
 * the interests a user chose in their profile (plus, if they did the career
 * activity, the interest areas it surfaced). No hidden profiling.
 */
const KEYWORDS = {
  software: ['software', 'developer', 'programming', 'coding', 'web', 'app', 'backend', 'frontend'],
  data: ['data', 'analytics', 'statistics', 'sql', 'dashboard', 'excel'],
  ai: ['artificial intelligence', ' ai ', 'machine learning', 'llm', 'neural'],
  design: ['design', 'ux', 'ui', 'figma', 'illustrat'],
  business: ['business', 'management', 'consult', 'finance', 'accounting'],
  marketing: ['marketing', 'social media', 'brand', 'campaign', 'content'],
  engineering: ['engineering', 'mechanical', 'electrical', 'cad', 'prototype', 'robot'],
  research: ['research', 'study', 'thesis', 'participant', 'survey', 'lab'],
  teaching: ['tutor', 'teaching', 'mentor', 'workshop'],
  healthcare: ['health', 'medical', 'clinic', 'care'],
  sustainability: ['sustainab', 'climate', 'energy', 'environment', 'green'],
  logistics: ['logistics', 'supply chain', 'warehouse', 'operations'],
  media: ['media', 'video', 'film', 'photo', 'podcast'],
  entrepreneurship: ['startup', 'start-up', 'founder', 'entrepreneur', 'pitch'],
  international: ['international', 'exchange', 'language', 'erasmus', 'abroad'],
  sports: ['sport', 'football', 'fitness', 'running', 'team'],
  music: ['music', 'choir', 'band', 'orchestra', 'concert'],
  volunteering: ['volunteer', 'charity', 'community service'],
};

/** RIASEC letters from the career activity → interest tags. */
const CAREER_TAGS = { R: ['engineering'], I: ['research', 'data'], A: ['design', 'media'], S: ['teaching', 'volunteering'], E: ['entrepreneurship', 'business', 'marketing'], C: ['logistics', 'data'] };

function interestsFor(db, userId, careerTop) {
  const profile = db.get('SELECT interests FROM user_profiles WHERE user_id = ?', userId);
  const chosen = profile ? JSON.parse(profile.interests) : [];
  const inferred = (careerTop || []).flatMap((k) => CAREER_TAGS[k] || []);
  return { chosen, inferred };
}

function score(post, { chosen, inferred }) {
  const tags = String(post.tags || '').split(',').filter(Boolean);
  const haystack = ` ${post.title} ${post.body} `.toLowerCase();
  let total = 0;
  const reasons = new Set();
  for (const interest of chosen) {
    if (tags.includes(interest)) {
      total += 3;
      reasons.add(interest);
    } else if ((KEYWORDS[interest] || []).some((k) => haystack.includes(k))) {
      total += 2;
      reasons.add(interest);
    }
  }
  for (const interest of inferred) {
    if (!chosen.includes(interest) && (tags.includes(interest) || (KEYWORDS[interest] || []).some((k) => haystack.includes(k)))) {
      total += 1;
      reasons.add(interest);
    }
  }
  return { score: total, reasons: [...reasons] };
}

module.exports = { score, interestsFor, KEYWORDS };
