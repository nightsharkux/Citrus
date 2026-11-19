/**
 * The arithmetic behind ready-made lecture times, with no page or browser in it (so it is tested in Node).
 *
 * An edition lists `teachingPeriods` [{ n, from, to }] and `teachingSessions` [{ id, name, from, to }]; times are
 * "HH:MM" in the university's time zone, which is also the zone the lecturer's browser shows.
 */
const pad = (n) => String(n).padStart(2, '0');
const CLOCK = /^\d{2}:\d{2}$/;
const minutesOf = (clock) => {
  const [h, m] = String(clock).split(':').map(Number);
  return h * 60 + m;
};

/** Length in minutes of a slot from its from/to ("14:00", "15:30" -> 90). */
export const slotLength = (slot) => minutesOf(slot.to) - minutesOf(slot.from);

/** The edition's sessions and single periods, each with its length in minutes. Empty lists when it has none. */
export function slotsOf(site) {
  const valid = (list) => (Array.isArray(list) ? list : [])
    .filter((s) => CLOCK.test(s?.from) && CLOCK.test(s?.to))
    .map((s) => ({ ...s, minutes: slotLength(s) }))
    .filter((s) => s.minutes > 0);
  return { sessions: valid(site?.teachingSessions), periods: valid(site?.teachingPeriods) };
}

/** The start times of the periods ("08:15", "10:00", …), or an empty list. */
export const periodStarts = (site) => slotsOf(site).periods.map((p) => p.from);

/** The day a slot goes on when none is chosen: today while it has not started yet, else tomorrow (YYYY-MM-DD). */
export function dayFor(slot, now = new Date()) {
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (now.getHours() * 60 + now.getMinutes() >= minutesOf(slot.from)) day.setDate(day.getDate() + 1);
  return `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
}

/** "3 h 15 min", "1 h 30 min", "45 min". */
export function lengthLabel(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? `${h} h${m ? ` ${m} min` : ''}` : `${m} min`;
}

/** The first period start after `now` ("HH:MM") today, else the first of the day; null without periods. */
export function nextPeriodStart(site, now = new Date()) {
  const starts = periodStarts(site);
  if (!starts.length) return null;
  const clock = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  return starts.find((t) => t > clock) || starts[0];
}
