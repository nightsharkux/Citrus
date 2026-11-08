/** Date, number and text formatting in the institution's time zone. */
import { session } from './store.js';

const tz = () => session.site.timezone || undefined;
const cache = new Map();
function fmt(options) {
  const key = JSON.stringify(options) + tz();
  if (!cache.has(key)) cache.set(key, new Intl.DateTimeFormat(undefined, { timeZone: tz(), ...options }));
  return cache.get(key);
}

export const time = (iso) => fmt({ hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
export const date = (iso) => fmt({ day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso));
export const shortDate = (iso) => fmt({ day: 'numeric', month: 'short' }).format(new Date(iso));
export const weekday = (iso) => fmt({ weekday: 'short' }).format(new Date(iso));
export const longDay = (iso) => fmt({ weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(iso));
export const dateTime = (iso) => fmt({ day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));

/** YYYY-MM-DD in the institution's zone, for grouping. */
export function dayKey(iso) {
  const parts = Object.fromEntries(fmt({ year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(iso)).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function dayLabel(iso) {
  const key = dayKey(iso);
  const today = dayKey(new Date().toISOString());
  const tomorrow = dayKey(new Date(Date.now() + 86_400_000).toISOString());
  const yesterday = dayKey(new Date(Date.now() - 86_400_000).toISOString());
  if (key === today) return 'Today';
  if (key === tomorrow) return 'Tomorrow';
  if (key === yesterday) return 'Yesterday';
  return longDay(iso);
}

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
export function ago(iso) {
  if (!iso) return '';
  const seconds = (new Date(iso).getTime() - Date.now()) / 1000;
  const abs = Math.abs(seconds);
  if (abs < 45) return 'just now';
  if (abs < 3600) return rtf.format(Math.round(seconds / 60), 'minute');
  if (abs < 86_400) return rtf.format(Math.round(seconds / 3600), 'hour');
  if (abs < 7 * 86_400) return rtf.format(Math.round(seconds / 86_400), 'day');
  return shortDate(iso);
}

export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
export const bytes = (n) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
export const initials = (name) => String(name || '?').trim().split(/\s+/).slice(0, 2).map((p) => p[0]).join('').toUpperCase();
export const greeting = () => {
  const h = Number(fmt({ hour: 'numeric', hourCycle: 'h23' }).format(new Date()));
  return h < 5 ? 'Good evening' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
};
export const capitalize = (s) => String(s || '').charAt(0).toUpperCase() + String(s || '').slice(1);
export const humanize = (s) => capitalize(String(s || '').replaceAll('_', ' '));

/** Local datetime-input value (YYYY-MM-DDTHH:mm) for an ISO instant. */
export function toInputValue(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
