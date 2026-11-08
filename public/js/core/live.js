/**
 * Live updates over Server-Sent Events (/api/events).
 * live.on('notification', fn) → returns an unsubscribe function.
 * Events: notification, activation, course.updated, workspace.updated,
 *         caption, captions.state, room.updated, participation.updated
 */
const handlers = new Map();
let source = null;

function dispatch(type, event) {
  let data = {};
  try {
    data = JSON.parse(event.data);
  } catch {
    /* ignore */
  }
  for (const fn of handlers.get(type) || []) fn(data);
}

const TYPES = ['notification', 'activation', 'course.updated', 'workspace.updated', 'caption', 'captions.state', 'room.updated', 'participation.updated'];

export const live = {
  connect() {
    if (source || !('EventSource' in window)) return;
    source = new EventSource('/api/events');
    for (const type of TYPES) source.addEventListener(type, (e) => dispatch(type, e));
  },
  disconnect() {
    source?.close();
    source = null;
  },
  on(type, fn) {
    if (!handlers.has(type)) handlers.set(type, new Set());
    handlers.get(type).add(fn);
    return () => handlers.get(type)?.delete(fn);
  },
};

/** Debounce helper for "refresh when something changes" handlers. */
export function debounce(fn, ms = 400) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}
