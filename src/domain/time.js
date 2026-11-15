'use strict';

/**
 * Timezone-aware "wall clock" helpers.
 *
 * Doses and appointments are stored as local wall-clock values (YYYY-MM-DD + HH:MM)
 * in the circle's timezone, because "8 AM tablet" means 8 AM where the elder lives,
 * regardless of where the server runs. To compare two wall-clock values we project
 * both onto a common minute scale with Date.UTC, which is exact for any zone without
 * a DST jump between the two instants (and always exact for zones like Asia/Kolkata).
 */

const formatterCache = new Map();

function getFormatter(timeZone) {
  if (!formatterCache.has(timeZone)) {
    formatterCache.set(
      timeZone,
      new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }),
    );
  }
  return formatterCache.get(timeZone);
}

function isValidTimezone(timeZone) {
  try {
    getFormatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** Returns { date: 'YYYY-MM-DD', time: 'HH:MM', minutes } for an instant in a zone. */
function localParts(instant, timeZone) {
  const parts = Object.fromEntries(
    getFormatter(timeZone)
      .formatToParts(instant)
      .map((p) => [p.type, p.value]),
  );
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  const time = `${parts.hour}:${parts.minute}`;
  return { date, time, minutes: wallToMinutes(date, time) };
}

/** Projects a wall-clock date + time onto an absolute minute scale. */
function wallToMinutes(date, time = '00:00') {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  return Date.UTC(y, m - 1, d, hh, mm) / 60_000;
}

/** Converts a wall-clock date + time in `timeZone` into the real instant (Date). */
function wallToInstant(date, time, timeZone) {
  const guess = wallToMinutes(date, time) * 60_000;
  const offsetMinutes = localParts(new Date(guess), timeZone).minutes - wallToMinutes(date, time);
  return new Date(guess - offsetMinutes * 60_000);
}

function addDays(date, days) {
  const [y, m, d] = date.split('-').map(Number);
  const shifted = new Date(Date.UTC(y, m - 1, d + days));
  return shifted.toISOString().slice(0, 10);
}

/** 0 = Sunday … 6 = Saturday, matching JavaScript's getDay(). */
function dayOfWeek(date) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** ISO-8601 week key such as "2026-W46", used to send one weekly brief per week. */
function isoWeekKey(date) {
  const [y, m, d] = date.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1, d));
  const dayNum = (target.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const week =
    1 +
    Math.round(
      ((target - firstThursday) / 86_400_000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7,
    );
  return `${target.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function timeSlot(time) {
  const hour = Number(time.slice(0, 2));
  if (hour < 12) return 'morning';
  if (hour < 17) return 'afternoon';
  if (hour < 21) return 'evening';
  return 'night';
}

module.exports = {
  isValidTimezone,
  localParts,
  wallToMinutes,
  wallToInstant,
  addDays,
  dayOfWeek,
  isoWeekKey,
  timeSlot,
};
