'use strict';

const { localParts, wallToMinutes, addDays, dayOfWeek, timeSlot } = require('./time');

/**
 * Pure functions that turn medication definitions + the dose log into
 * concrete, status-tagged doses and adherence statistics. No I/O here,
 * which keeps the core rules fully unit-testable.
 */

/**
 * Dose statuses. Kendra never claims to know whether medicine was physically taken:
 *  - TAKEN       someone explicitly confirmed it
 *  - MISSED      someone explicitly reported it as missed
 *  - UNCONFIRMED labelled system policy: nobody confirmed it within the primary
 *                escalation window. It is *not* recorded as missed.
 *  - DUE         inside the reminder window, awaiting confirmation
 *  - UPCOMING    scheduled for later
 */
const DOSE_STATUS = Object.freeze({
  TAKEN: 'taken',
  MISSED: 'missed',
  UNCONFIRMED: 'unconfirmed',
  DUE: 'due',
  UPCOMING: 'upcoming',
});

const LOGGED_STATUSES = Object.freeze([DOSE_STATUS.TAKEN, DOSE_STATUS.MISSED]);
const FINAL_STATUSES = new Set([DOSE_STATUS.TAKEN, DOSE_STATUS.MISSED, DOSE_STATUS.UNCONFIRMED]);

function doseKey(medId, date, time) {
  return `${medId}@${date}@${time}`;
}

function isMedicationActiveOn(med, date) {
  if (med.active === false) return false;
  if (med.startDate && date < med.startDate) return false;
  if (med.endDate && date > med.endDate) return false;
  if (Array.isArray(med.days) && med.days.length > 0 && !med.days.includes(dayOfWeek(date))) {
    return false;
  }
  return true;
}

/** All doses scheduled on a local date, ignoring any that predate the medication's creation. */
function dosesForDate(circle, date) {
  const doses = [];
  for (const med of circle.medications) {
    if (!isMedicationActiveOn(med, date)) continue;
    const createdAt = med.createdAt
      ? localParts(new Date(med.createdAt), circle.timezone).minutes
      : -Infinity;
    for (const time of med.times) {
      if (wallToMinutes(date, time) < createdAt) continue;
      doses.push({
        key: doseKey(med.id, date, time),
        medId: med.id,
        name: med.name,
        dosage: med.dosage || '',
        instructions: med.instructions || '',
        date,
        time,
      });
    }
  }
  return doses.sort((a, b) => a.time.localeCompare(b.time) || a.name.localeCompare(b.name));
}

function indexDoseLog(circle) {
  return new Map(circle.doseLog.map((entry) => [entry.key, entry]));
}

function resolveStatus(dose, logEntry, nowMinutes, settings) {
  if (logEntry) return logEntry.status;
  const scheduled = wallToMinutes(dose.date, dose.time);
  if (nowMinutes >= scheduled + settings.escalatePrimaryMin) return DOSE_STATUS.UNCONFIRMED;
  if (nowMinutes >= scheduled - settings.upcomingLeadMin) return DOSE_STATUS.DUE;
  return DOSE_STATUS.UPCOMING;
}

function scheduleForDate(circle, date, now, log = indexDoseLog(circle)) {
  const nowMinutes = localParts(now, circle.timezone).minutes;
  return dosesForDate(circle, date).map((dose) => {
    const entry = log.get(dose.key);
    return {
      ...dose,
      status: resolveStatus(dose, entry, nowMinutes, circle.settings),
      loggedAt: entry?.at ?? null,
      loggedBy: entry?.byName ?? null,
      note: entry?.note ?? null,
    };
  });
}

function emptyCounts() {
  return { scheduled: 0, taken: 0, missed: 0, unconfirmed: 0 };
}

function rate(counts) {
  const decided = counts.taken + counts.missed + counts.unconfirmed;
  return decided === 0 ? null : Math.round((counts.taken / decided) * 100);
}

/**
 * Confirmation statistics over the last `days` local days (today included).
 * Rate = confirmed-taken / (taken + reported missed + unconfirmed). Doses still in
 * their reminder window are excluded, so a dose due in an hour never lowers the score.
 * Unconfirmed and reported-missed doses are always reported separately.
 */
function adherenceStats(circle, now, days = 7) {
  const today = localParts(now, circle.timezone).date;
  const log = indexDoseLog(circle);
  const totals = emptyCounts();
  const byDay = [];
  const byMedication = new Map();
  const bySlot = { morning: emptyCounts(), afternoon: emptyCounts(), evening: emptyCounts(), night: emptyCounts() };

  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = addDays(today, -offset);
    const dayCounts = { date, ...emptyCounts() };
    for (const dose of scheduleForDate(circle, date, now, log)) {
      if (!FINAL_STATUSES.has(dose.status)) continue;
      if (!byMedication.has(dose.medId)) {
        byMedication.set(dose.medId, { medId: dose.medId, name: dose.name, ...emptyCounts() });
      }
      for (const bucket of [totals, dayCounts, byMedication.get(dose.medId), bySlot[timeSlot(dose.time)]]) {
        bucket.scheduled += 1;
        bucket[dose.status] += 1;
      }
    }
    byDay.push({ ...dayCounts, rate: rate(dayCounts) });
  }

  // Consecutive fully-adherent days, counting back from yesterday (today is still in progress).
  let streakDays = 0;
  for (let i = byDay.length - 2; i >= 0; i -= 1) {
    const day = byDay[i];
    if (day.scheduled === 0 || day.taken !== day.scheduled) break;
    streakDays += 1;
  }

  return {
    from: byDay[0].date,
    to: today,
    totals: { ...totals, rate: rate(totals) },
    byDay,
    byMedication: [...byMedication.values()].map((m) => ({ ...m, rate: rate(m) })),
    bySlot: Object.fromEntries(Object.entries(bySlot).map(([slot, c]) => [slot, { ...c, rate: rate(c) }])),
    streakDays,
  };
}

module.exports = {
  DOSE_STATUS,
  LOGGED_STATUSES,
  doseKey,
  isMedicationActiveOn,
  dosesForDate,
  scheduleForDate,
  adherenceStats,
  indexDoseLog,
};
