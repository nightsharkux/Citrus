'use strict';
/**
 * notify(userIds, message) stores an inbox item, pushes it live to open tabs
 * and — if the user subscribed — sends a Web Push, respecting quiet hours and
 * the user's notification level.
 *
 * message: { kind, title, body?, link?, category?, priority?, urgent? }   written in English; a person whose
 *   language is German gets it in German (notifications/german.js), in the inbox and in the push message
 *   kind      'system' | 'campus' | 'course' | 'device' | ...
 *   category  campus feed category (used for topic preferences)
 *   urgent    bypass quiet hours and Citrus Focus (e.g. a device tap the user just made)
 */
const { zonedParts } = require('../../lib/time');
const { isFocused } = require('../account/preferences');
const { inGerman } = require('./german');

function createNotifier({ db, bus, push, timeZone, defaultLanguage = 'de' }) {
  function prefs(userId) {
    const p = db.get('SELECT level, topics, quiet_start, quiet_end FROM cx_preferences WHERE user_id = ?', userId);
    if (!p) return { level: 'personalized', topics: null, quietStart: '22:00', quietEnd: '08:00' };
    let topics = null;
    try {
      topics = JSON.parse(p.topics);
    } catch {
      topics = null;
    }
    return { level: p.level, topics, quietStart: p.quiet_start || '22:00', quietEnd: p.quiet_end || '08:00' };
  }

  function inQuietHours({ quietStart, quietEnd }) {
    const { hour, minute } = zonedParts(new Date(), timeZone);
    const now = hour * 60 + minute;
    const [sh, sm] = quietStart.split(':').map(Number);
    const [eh, em] = quietEnd.split(':').map(Number);
    const start = sh * 60 + sm;
    const end = eh * 60 + em;
    if (start === end) return false;
    return start < end ? now >= start && now < end : now >= start || now < end;
  }

  /** Citrus Focus is on for this person right now. */
  function focused(userId) {
    try {
      return isFocused(JSON.parse(db.get('SELECT preferences FROM users WHERE id = ?', userId)?.preferences || '{}'));
    } catch {
      return false;
    }
  }

  function shouldPush(userId, message, isFocusedNow = focused(userId)) {
    if (!message.urgent && isFocusedNow) return false;
    const p = prefs(userId);
    if (!message.urgent && inQuietHours(p)) return false;
    if (message.kind !== 'campus') return true;
    if (p.level === 'digest') return false;
    if (p.level === 'essential') return (message.priority || 2) >= 4;
    if (p.level === 'all') return true;
    return !message.category || !p.topics || p.topics.includes(message.category);
  }

  async function pushTo(userId, message, id) {
    const subs = db.all('SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?', userId);
    for (const sub of subs) {
      const result = await push.send(sub, { id, title: message.title, body: message.body || '', link: message.link || '/inbox', kind: message.kind }, { urgency: message.urgent ? 'high' : 'normal' });
      if (result === 'gone') db.run('DELETE FROM push_subscriptions WHERE id = ?', sub.id);
    }
  }

  /**
   * One read for every recipient's preferences (their language and whether Citrus Focus is on), however many there
   * are: a lecture going live tells a whole class. A person who never chose a language is sent the default (German unless CAMPUS_DEFAULT_LANGUAGE=en), the language
   * most people here use; the app saves the language it shows at first start, so that is rare.
   */
  function recipients(ids) {
    const rows = ids.length ? db.all(`SELECT id, preferences FROM users WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids) : [];
    return new Map(rows.map((r) => {
      let prefs = {};
      try {
        prefs = JSON.parse(r.preferences || '{}');
      } catch { /* none */ }
      return [r.id, { language: prefs.language === 'en' || prefs.language === 'de' ? prefs.language : defaultLanguage, focused: isFocused(prefs) }];
    }));
  }

  function notify(userIds, message) {
    const ids = [...new Set([].concat(userIds).map(Number).filter(Boolean))];
    const created = new Date().toISOString();
    const who = recipients(ids);
    for (const userId of ids) {
      const person = who.get(userId) || { language: defaultLanguage, focused: false };
      const text = person.language === 'de' ? inGerman(message) : message;
      const id = db.insert(
        'INSERT INTO notifications(user_id, kind, title, body, link, created) VALUES(?, ?, ?, ?, ?, ?)',
        userId, message.kind || 'system', String(text.title).slice(0, 160), String(text.body || '').slice(0, 600), String(message.link || '').slice(0, 300), created,
      );
      bus.publish(`user:${userId}`, 'notification', { id, kind: message.kind, title: text.title, body: text.body || '', link: message.link || '', quiet: !message.urgent && person.focused });
      if (shouldPush(userId, message, person.focused)) {
        pushTo(userId, text, id).catch((error) => console.error('Push failed:', error.message));
      }
    }
  }

  const unread = (userId) => db.get('SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND read = 0', userId).n;

  return { notify, unread, inQuietHours, focused };
}

module.exports = { createNotifier };
