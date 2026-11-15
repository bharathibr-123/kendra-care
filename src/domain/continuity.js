'use strict';

const { localParts, wallToMinutes, addDays } = require('./time');
const { dosesForDate, indexDoseLog, DOSE_STATUS } = require('./schedule');

/**
 * Care Continuity Engine: shared logic that turns doses, notifications and caregiver
 * acknowledgements into a per-slot care state and a list of active alerts.
 *
 * A "slot" is every dose scheduled at the same local date and time (e.g. the 08:00
 * tablets), because people take and confirm them together.
 *
 * Care states (in escalation order):
 *   scheduled → reminder_sent → awaiting_confirmation → caregiver_notified → escalated
 * plus the resolving states: caregiver_acknowledged, confirmed, reported_missed.
 */

const CARE_STATE = Object.freeze({
  SCHEDULED: 'scheduled',
  REMINDER_SENT: 'reminder_sent',
  AWAITING: 'awaiting_confirmation',
  CAREGIVER_NOTIFIED: 'caregiver_notified',
  ESCALATED: 'escalated',
  ACKNOWLEDGED: 'caregiver_acknowledged',
  CONFIRMED: 'confirmed',
  REPORTED_MISSED: 'reported_missed',
});

const STALE_AFTER_MIN = 12 * 60;
const SLOT_PATTERN = /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/;

function slotKey(date, time) {
  return `${date}T${time}`;
}

function sentStages(circle) {
  const stages = new Map();
  for (const note of circle.notifications) {
    if (note.type !== 'dose') continue;
    const slot = note.key.slice('dose:'.length, 'dose:'.length + 16);
    if (!stages.has(slot)) stages.set(slot, new Set());
    stages.get(slot).add(note.stage);
  }
  return stages;
}

function acknowledgementFor(circle, slot) {
  return circle.acknowledgements.find((a) => a.slot === slot) || null;
}

/** Groups doses for yesterday and today into slots, with log status and timing. */
function collectSlots(circle, now) {
  const local = localParts(now, circle.timezone);
  const log = indexDoseLog(circle);
  const slots = new Map();
  for (const date of [addDays(local.date, -1), local.date]) {
    for (const dose of dosesForDate(circle, date)) {
      const key = slotKey(dose.date, dose.time);
      if (!slots.has(key)) {
        slots.set(key, { slot: key, date: dose.date, time: dose.time, elapsed: local.minutes - wallToMinutes(dose.date, dose.time), doses: [] });
      }
      slots.get(key).doses.push({ ...dose, logged: log.get(dose.key)?.status ?? null });
    }
  }
  return [...slots.values()];
}

function careStateOf(slot, { stages, acknowledgement, settings }) {
  const open = slot.doses.filter((d) => !d.logged);
  if (open.length === 0) {
    return slot.doses.every((d) => d.logged === DOSE_STATUS.TAKEN) ? CARE_STATE.CONFIRMED : CARE_STATE.REPORTED_MISSED;
  }
  if (acknowledgement) return CARE_STATE.ACKNOWLEDGED;
  if (stages.has('backup')) return CARE_STATE.ESCALATED;
  if (stages.has('primary')) return CARE_STATE.CAREGIVER_NOTIFIED;
  if (slot.elapsed >= 0) return CARE_STATE.AWAITING;
  if (stages.has('reminder')) return CARE_STATE.REMINDER_SENT;
  return slot.elapsed >= -settings.upcomingLeadMin ? CARE_STATE.AWAITING : CARE_STATE.SCHEDULED;
}

/** Care state for every slot today (and yesterday's still-open ones). */
function careSlots(circle, now) {
  const stages = sentStages(circle);
  const today = localParts(now, circle.timezone).date;
  return collectSlots(circle, now)
    .map((slot) => {
      const acknowledgement = acknowledgementFor(circle, slot.slot);
      const state = careStateOf(slot, { stages: stages.get(slot.slot) || new Set(), acknowledgement, settings: circle.settings });
      return { ...slot, state, acknowledgement, openDoses: slot.doses.filter((d) => !d.logged).map((d) => d.name) };
    })
    .filter((slot) => slot.date === today || (slot.openDoses.length > 0 && slot.elapsed < STALE_AFTER_MIN));
}

/** Slots needing human attention: caregiver notified or escalated, and still unacknowledged. */
function activeAlerts(circle, now) {
  return careSlots(circle, now).filter((s) => s.state === CARE_STATE.CAREGIVER_NOTIFIED || s.state === CARE_STATE.ESCALATED);
}

module.exports = { CARE_STATE, STALE_AFTER_MIN, SLOT_PATTERN, slotKey, collectSlots, careSlots, activeAlerts, acknowledgementFor };
