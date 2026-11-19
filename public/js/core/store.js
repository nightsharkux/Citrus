/**
 * App-wide session state and a tiny event emitter.
 *
 *   session.user, session.site, session.ai, session.unread …
 *   setSession({ unread: 3 })   → emits 'session'
 *   on('unauthorized', fn)
 */
const listeners = new Map();

export const session = {
  user: null,
  site: { id: (typeof document !== 'undefined' && document.documentElement.dataset.edition) || 'general', assistant: 'Citrus', name: 'Citrus', shortName: 'Citrus', timezone: 'Europe/Berlin' },
  ai: null,
  unread: 0,
  sso: { enabled: false, label: 'University login' },
  registration: true,
  guests: false,
  institutions: [],
};

export function on(type, fn) {
  if (!listeners.has(type)) listeners.set(type, new Set());
  listeners.get(type).add(fn);
  return () => listeners.get(type)?.delete(fn);
}

export function emit(type, data) {
  for (const fn of listeners.get(type) || []) {
    try {
      fn(data);
    } catch (error) {
      console.error(error);
    }
  }
}

export function setSession(patch) {
  Object.assign(session, patch);
  emit('session', patch);
}

export const role = () => session.user?.role || null;
export const isStaff = () => role() === 'lecturer' || role() === 'admin';
export const assistantName = () => session.user?.preferences?.assistantName || session.site.assistant || 'Citrus';
export const firstName = () => (session.user?.name || '').split(/\s+/)[0];
