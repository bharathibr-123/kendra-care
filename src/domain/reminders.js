'use strict';

const { localParts, wallToMinutes, dayOfWeek, isoWeekKey } = require('./time');
const { ROLES } = require('./policy');
const { RESPONDER } = require('./circle');
const { collectSlots, acknowledgementFor, STALE_AFTER_MIN } = require('./continuity');

/**
 * The escalation engine. `planNotifications` is a pure function: given a circle and
 * the current instant, it returns the notifications that are due *and not yet sent*.
 * Each has a deterministic key, so running the planner every minute (or twice by
 * accident) can never send the same reminder twice.
 *
 * Escalation ladder for an unconfirmed dose slot scheduled at T (all configurable):
 *   T - lead         reminder to the elder
 *   T + followup     follow-up reminder to the elder
 *   T + primary      primary caregiver(s) notified (backup contacts if no primary exists)
 *   T + backup       backup contact(s) notified, unless a caregiver acknowledged the alert
 * Confirming (or explicitly reporting) every dose in the slot stops the ladder.
 */

const WEEKLY_BRIEF_DAY = 0; // Sunday
const WEEKLY_BRIEF_TIME = '18:00';

function recipients(circle, roles) {
  return circle.members
    .filter((m) => roles.includes(m.role) && m.email && m.notify !== false)
    .map((m) => ({ name: m.name, email: m.email, role: m.role }));
}

function responders(circle, level) {
  return circle.members
    .filter((m) => m.responder === level && m.email && m.notify !== false)
    .map((m) => ({ name: m.name, email: m.email, role: m.role }));
}

function listDoses(items) {
  return items.map((d) => `• ${d.name}${d.dosage ? ` (${d.dosage})` : ''}${d.instructions ? ` — ${d.instructions}` : ''}`).join('\n');
}

function planDoseNotifications(circle, now, sent) {
  const { settings } = circle;
  const elderName = circle.elder.name;
  const intents = [];
  const primary = responders(circle, RESPONDER.PRIMARY);
  const backup = responders(circle, RESPONDER.BACKUP);
  const firstResponders = primary.length > 0 ? primary : backup;
  const alreadyAlerted = new Set(firstResponders.map((r) => r.email));

  for (const slot of collectSlots(circle, now)) {
    const doses = slot.doses.filter((d) => !d.logged);
    if (doses.length === 0 || slot.elapsed >= STALE_AFTER_MIN) continue;
    const { elapsed, time } = slot;
    const acknowledged = Boolean(acknowledgementFor(circle, slot.slot));

    const stages = [
      {
        stage: 'reminder',
        active: elapsed >= -settings.upcomingLeadMin && elapsed < settings.followupMin,
        to: recipients(circle, [ROLES.ELDER]),
        subject: `Time for your ${time} medicine`,
        text: `Hello ${elderName},\n\nIt's time for:\n${listDoses(doses)}\n\nPlease confirm in Kendra once you have taken it.`,
      },
      {
        stage: 'followup',
        active: elapsed >= settings.followupMin && elapsed < settings.escalatePrimaryMin,
        to: recipients(circle, [ROLES.ELDER]),
        subject: `Gentle reminder: your ${time} medicine is not confirmed yet`,
        text: `Hello ${elderName},\n\nWe have not received a confirmation for:\n${listDoses(doses)}\n\nIf you have taken it, please tap "I took it" in Kendra.`,
      },
      {
        stage: 'primary',
        active: elapsed >= settings.escalatePrimaryMin && !acknowledged,
        to: firstResponders,
        subject: `Please check in: ${elderName}'s ${time} dose is unconfirmed`,
        text: `${elderName}'s ${time} medicine has not been confirmed after ${settings.escalatePrimaryMin} minutes. This does not mean it was missed, only that nobody has confirmed it.\n${listDoses(doses)}\n\nPlease check in with ${elderName} and acknowledge the alert in Kendra so the backup contact is not alerted.`,
      },
      {
        stage: 'backup',
        active: elapsed >= settings.escalateBackupMin && !acknowledged,
        to: backup.filter((r) => !alreadyAlerted.has(r.email)),
        subject: `Escalation: ${elderName}'s ${time} dose is still unconfirmed`,
        text: `${elderName}'s ${time} medicine is still unconfirmed after ${settings.escalateBackupMin} minutes, and the primary caregiver has not acknowledged the alert yet.\n${listDoses(doses)}\n\nYou are the backup contact. Please check in if you can and acknowledge the alert in Kendra.`,
      },
    ];

    for (const s of stages) {
      const key = `dose:${slot.slot}:${s.stage}`;
      if (!s.active || s.to.length === 0 || sent.has(key)) continue;
      intents.push({ key, type: 'dose', stage: s.stage, recipients: s.to, subject: s.subject, text: s.text });
    }
  }
  return intents;
}

function planAppointmentNotifications(circle, now, sent) {
  const local = localParts(now, circle.timezone);
  const everyone = recipients(circle, Object.values(ROLES));
  const intents = [];

  for (const appt of circle.appointments) {
    if (appt.status && appt.status !== 'upcoming') continue;
    const minutesUntil = wallToMinutes(appt.date, appt.time) - local.minutes;
    if (minutesUntil <= 0) continue;
    const stage = minutesUntil <= 120 ? '2h' : minutesUntil <= 1440 ? '24h' : null;
    if (!stage) continue;
    const key = `appt:${appt.id}:${stage}`;
    if (sent.has(key) || everyone.length === 0) continue;
    const hours = Math.max(1, Math.round(minutesUntil / 60));
    intents.push({
      key,
      type: 'appointment',
      stage,
      recipients: everyone,
      subject: `Reminder: ${circle.elder.name} sees Dr. ${appt.doctor} in about ${hours} hour${hours === 1 ? '' : 's'}`,
      text: `Upcoming appointment for ${circle.elder.name}:\n\nDoctor: Dr. ${appt.doctor}${appt.specialty ? ` (${appt.specialty})` : ''}\nWhen: ${appt.date} at ${appt.time}\n${appt.location ? `Where: ${appt.location}\n` : ''}${appt.notes ? `Notes: ${appt.notes}\n` : ''}`,
    });
  }
  return intents;
}

function planStockNotifications(circle, now, sent) {
  const today = localParts(now, circle.timezone).date;
  const to = recipients(circle, [ROLES.ELDER, ROLES.CARETAKER]);
  const intents = [];
  for (const med of circle.medications) {
    if (med.active === false || med.stock == null || med.refillAt == null) continue;
    if (med.stock > med.refillAt) continue;
    const key = `stock:${med.id}:${today}`;
    if (sent.has(key) || to.length === 0) continue;
    intents.push({
      key,
      type: 'stock',
      stage: 'low',
      recipients: to,
      subject: `Refill needed: ${med.name}`,
      text: `Only ${med.stock} dose${med.stock === 1 ? '' : 's'} of ${med.name} left for ${circle.elder.name}. Please arrange a refill.`,
    });
  }
  return intents;
}

function planWeeklyBrief(circle, now, sent) {
  const local = localParts(now, circle.timezone);
  if (dayOfWeek(local.date) !== WEEKLY_BRIEF_DAY || local.time < WEEKLY_BRIEF_TIME) return [];
  const key = `brief:${isoWeekKey(local.date)}`;
  const to = recipients(circle, Object.values(ROLES));
  if (sent.has(key) || to.length === 0) return [];
  return [{ key, type: 'brief', stage: 'weekly', recipients: to, subject: `Weekly care brief for ${circle.elder.name}`, text: null }];
}

function planNotifications(circle, now) {
  const sent = new Set(circle.notifications.map((n) => n.key));
  return [
    ...planDoseNotifications(circle, now, sent),
    ...planAppointmentNotifications(circle, now, sent),
    ...planStockNotifications(circle, now, sent),
    ...planWeeklyBrief(circle, now, sent),
  ];
}

module.exports = { planNotifications, recipients, responders };
