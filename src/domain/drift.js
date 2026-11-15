'use strict';

const { localParts, wallToMinutes, addDays, timeSlot } = require('./time');
const { dosesForDate, indexDoseLog, DOSE_STATUS } = require('./schedule');

/**
 * Routine drift detection: a transparent, statistical (not LLM) analysis of when
 * dose slots get confirmed, compared with the elder's own recent baseline.
 *
 * For every daily dose time (e.g. 08:00):
 *   delay(day)  = minutes between the scheduled time and the first confirmation that day
 *   baseline    = the 14 days before the recent window → median and MAD (median absolute
 *                 deviation, robust to the odd outlier day)
 *   recent      = the last 3 days
 * A "later confirmations" insight is raised when the recent median exceeds the baseline
 * median by max(20 min, 3 × 1.4826 × MAD) *and* at least 2 recent days were late.
 * A "repeated unconfirmed" insight is raised when ≥2 recent days had no confirmation
 * while the baseline mostly did. With too little history it says so instead of guessing.
 *
 * Output wording is deliberately non-medical: it describes confirmation timing only.
 */

const DEFAULTS = Object.freeze({ baselineDays: 14, recentDays: 3, minBaseline: 5, minShiftMin: 20 });
const MAD_SCALE = 1.4826; // makes MAD comparable to a standard deviation for normal data
const SLOT_WORD = { morning: 'morning', afternoon: 'afternoon', evening: 'evening', night: 'night' };

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function mad(values) {
  const m = median(values);
  return m === null ? null : median(values.map((v) => Math.abs(v - m)));
}

function clock(minutesOfDay) {
  const total = ((Math.round(minutesOfDay) % 1440) + 1440) % 1440;
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

/** Per dose time: one observation per day — first confirmation delay, or the outcome if none. */
function observations(circle, now, totalDays) {
  const local = localParts(now, circle.timezone);
  const log = indexDoseLog(circle);
  const byTime = new Map();

  for (let offset = totalDays; offset >= 0; offset -= 1) {
    const date = addDays(local.date, -offset);
    const slots = new Map();
    for (const dose of dosesForDate(circle, date)) {
      if (!slots.has(dose.time)) slots.set(dose.time, []);
      slots.get(dose.time).push(log.get(dose.key) || null);
    }
    for (const [time, entries] of slots) {
      const scheduled = wallToMinutes(date, time);
      const confirmations = entries
        .filter((e) => e?.status === DOSE_STATUS.TAKEN && e.at)
        .map((e) => localParts(new Date(e.at), circle.timezone).minutes - scheduled);
      const reportedMissed = entries.some((e) => e?.status === DOSE_STATUS.MISSED);
      const pending = confirmations.length === 0 && !reportedMissed && local.minutes < scheduled + circle.settings.escalatePrimaryMin;
      if (pending) continue; // too early to judge today's slot
      if (!byTime.has(time)) byTime.set(time, []);
      byTime.get(time).push({
        date,
        delay: confirmations.length ? Math.min(...confirmations) : null,
        outcome: confirmations.length ? 'confirmed' : reportedMissed ? 'reported_missed' : 'unconfirmed',
      });
    }
  }
  return byTime;
}

/** Doses a few minutes apart (e.g. 21:00 and 21:30) tell one story: report them once. */
function mergeUnconfirmed(insights) {
  const merged = [];
  for (const insight of insights) {
    const previous = merged.find((m) => m.type === 'repeated_unconfirmed' && insight.type === 'repeated_unconfirmed' && m.word === insight.word);
    if (previous) {
      previous.times.push(insight.time);
      previous.message = previous.message.replace(/dose \(([^)]+)\)/, (_, t) => `doses (${t} and ${clock(toMinutes(insight.time))})`).replace('was not confirmed', 'were not confirmed');
    } else {
      merged.push({ ...insight, times: [insight.time] });
    }
  }
  return merged.map(({ word: _word, ...rest }) => rest);
}

function toMinutes(time) {
  const [hh, mm] = time.split(':').map(Number);
  return hh * 60 + mm;
}

function routineDrift(circle, now, options = {}) {
  const { baselineDays, recentDays, minBaseline, minShiftMin } = { ...DEFAULTS, ...options };
  const today = localParts(now, circle.timezone).date;
  const recentStart = addDays(today, -(recentDays - 1));
  const baselineStart = addDays(recentStart, -baselineDays);
  const groups = [];
  const insights = [];

  for (const [time, series] of [...observations(circle, now, baselineDays + recentDays).entries()].sort()) {
    const baseline = series.filter((o) => o.date >= baselineStart && o.date < recentStart);
    const recent = series.filter((o) => o.date >= recentStart);
    const baseDelays = baseline.filter((o) => o.delay !== null).map((o) => o.delay);
    const recentDelays = recent.filter((o) => o.delay !== null).map((o) => o.delay);
    const word = SLOT_WORD[timeSlot(time)];
    const [hh, mm] = time.split(':').map(Number);
    const scheduledMin = hh * 60 + mm;

    const group = {
      time,
      label: `${word} (${clock(scheduledMin)})`,
      baseline: { days: baseline.length, confirmed: baseDelays.length, medianDelay: median(baseDelays), mad: mad(baseDelays) },
      recent: { days: recent.length, confirmed: recentDelays.length, medianDelay: median(recentDelays) },
      series: series.filter((o) => o.date >= baselineStart),
      status: 'stable',
    };

    if (baseDelays.length < minBaseline) {
      group.status = 'insufficient_data';
      group.note = `Needs at least ${minBaseline} confirmed days in the baseline window (has ${baseDelays.length}).`;
      groups.push(group);
      continue;
    }

    const confidence = baseDelays.length >= 10 && recent.length >= recentDays ? 'high' : 'moderate';
    const threshold = Math.max(minShiftMin, 3 * MAD_SCALE * group.baseline.mad);
    const shift = recentDelays.length ? group.recent.medianDelay - group.baseline.medianDelay : 0;
    const lateDays = recentDelays.filter((d) => d - group.baseline.medianDelay >= minShiftMin).length;

    if (recentDelays.length >= 2 && shift >= threshold && lateDays >= 2) {
      group.status = 'later_than_usual';
      insights.push({
        type: 'later_confirmations',
        time,
        word,
        confidence,
        shiftMinutes: Math.round(shift),
        usualTime: clock(scheduledMin + group.baseline.medianDelay),
        recentTime: clock(scheduledMin + group.recent.medianDelay),
        message: `Your ${word} medicine confirmations have been about ${Math.round(shift)} minutes later than your usual pattern for ${lateDays} of the last ${recent.length} days (usually around ${clock(scheduledMin + group.baseline.medianDelay)}, recently around ${clock(scheduledMin + group.recent.medianDelay)}).`,
        suggestion: `Would you like your caregiver to check whether the ${clock(scheduledMin)} reminder time is still convenient?`,
        basis: `Median of ${baseDelays.length} baseline days vs ${recentDelays.length} recent days; threshold ${Math.round(threshold)} min.`,
      });
    }

    const recentUnconfirmed = recent.filter((o) => o.outcome === 'unconfirmed').length;
    const baselineUnconfirmedRate = baseline.length ? baseline.filter((o) => o.outcome === 'unconfirmed').length / baseline.length : 0;
    if (recentUnconfirmed >= 2 && baselineUnconfirmedRate < 0.3) {
      if (group.status === 'stable') group.status = 'repeatedly_unconfirmed';
      insights.push({
        type: 'repeated_unconfirmed',
        time,
        word,
        confidence,
        message: `The ${word} dose (${clock(scheduledMin)}) was not confirmed on ${recentUnconfirmed} of the last ${recent.length} days, which is unusual compared with the previous ${baselineDays} days (${Math.round(baselineUnconfirmedRate * 100)}% unconfirmed).`,
        suggestion: 'A caregiver check-in around this time, or a later reminder, may help. This only reflects confirmations, not whether medicine was taken.',
        basis: `${recentUnconfirmed}/${recent.length} recent days unconfirmed vs ${Math.round(baselineUnconfirmedRate * 100)}% in baseline.`,
      });
    }
    groups.push(group);
  }

  return {
    window: { baselineFrom: baselineStart, recentFrom: recentStart, to: today, baselineDays, recentDays },
    method: 'Median and MAD of daily confirmation delay; recent window vs personal baseline.',
    insights: mergeUnconfirmed(insights),
    groups,
    hasEnoughData: groups.some((g) => g.status !== 'insufficient_data'),
  };
}

module.exports = { routineDrift, median, mad };
