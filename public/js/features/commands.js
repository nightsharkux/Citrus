/**
 * Voice commands that need no AI: they run the moment they are heard.
 *
 *   "open schedule" · "go to my inbox" · "dark mode" · "new chat" · "stop" · "stop listening"
 *
 * A command only matches when the *whole* sentence is one of these shapes, so a
 * question like "show me what's on my calendar tomorrow" still goes to the
 * assistant, which can answer it and act on it. Page names come from the menu
 * (nav.js), so a renamed item is renamed here too.
 */
import { allItems } from '../nav.js';

const EXTRA_NAMES = {
  '/schedule': ['calendar', 'timetable', 'my schedule', 'my calendar', 'my timetable'],
  '/home': ['home', 'dashboard', 'start', 'home screen'],
  '/courses': ['courses', 'my courses', 'classes', 'teaching', 'my classes'],
  '/learning': ['learning', 'study', 'review', 'revision'],
  '/inbox': ['inbox', 'notifications', 'my notifications', 'messages'],
  '/campus': ['campus', 'campus life', 'campus feed', 'feed', 'events'],
  '/spaces': ['spaces', 'my spaces', 'rooms', 'workspaces'],
  '/settings': ['settings', 'preferences', 'my settings'],
  '/tools': ['tools', 'all tools', 'features'],
  '/participation': ['participation', 'check in', 'check-in', 'attendance'],
  '/career': ['career', 'career explorer', 'careers'],
  '/classroom': ['classroom'],
  '/assistant': ['assistant', 'chat'],
};

const norm = (s) => String(s).toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9\s-]/g, ' ').replace(/\s+/g, ' ').trim();
const POLITE = /^(?:(?:please|hey|ok|okay)\s+)*(?:(?:can|could|would) you\s+)?(?:please\s+)?/;

function pageFor(target, role) {
  const wanted = norm(target).replace(/^(?:the|my)\s+/, '').replace(/\s+(?:page|tab|screen|section)$/, '');
  for (const item of allItems(role)) {
    const names = [item.label, ...(EXTRA_NAMES[item.href] || [])].map((n) => norm(n).replace(/^(?:the|my)\s+/, ''));
    if (names.includes(wanted)) return item;
  }
  return null;
}

/**
 * Match a spoken sentence. Returns { say, run } or null.
 * `ctx` = { role, navigate, setTheme, stop, stopListening }.
 */
export function matchCommand(text, ctx) {
  const t = norm(text).replace(POLITE, '').trim();
  if (!t) return null;

  if (/^(?:stop|cancel|be quiet|quiet|enough|shut up|never ?mind|thats enough)$/.test(t)) return { say: 'Stopped', run: () => ctx.stop() };
  if (/^(?:stop listening|go to sleep|sleep|turn off (?:hey )?campus|turn off listening|stop hey campus)$/.test(t)) return { say: 'Campus stopped listening', run: () => ctx.stopListening() };
  if (/^(?:new (?:chat|conversation)|start (?:a )?new (?:chat|conversation)|start over|clear (?:the )?chat)$/.test(t)) return { say: 'New conversation', run: () => ctx.navigate('/assistant?new=1') };

  const theme = /^(?:(?:switch|turn|change|go)(?: it)?(?: on| to)?\s+)?(?:the\s+)?(dark|light|system)(?: mode| theme)?$/.exec(t) || /^(?:use|enable)\s+(dark|light|system)(?: mode| theme)?$/.exec(t);
  if (theme && (theme[1] !== 'system' || /mode|theme/.test(t))) {
    const mode = theme[1];
    return { say: mode === 'system' ? 'Theme follows your device' : `${mode[0].toUpperCase()}${mode.slice(1)} mode`, run: () => ctx.setTheme(mode) };
  }

  const open = /^(?:open|go to|go|show(?: me)?|take me to|navigate to|bring up|switch to)\s+(.+)$/.exec(t);
  if (open) {
    const item = pageFor(open[1], ctx.role);
    if (item) return { say: `Opening ${item.label}`, run: () => ctx.navigate(item.href) };
  }
  return null;
}
