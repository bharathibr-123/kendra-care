'use strict';

const { adherenceStats, scheduleForDate, DOSE_STATUS } = require('../domain/schedule');
const { localParts, wallToMinutes } = require('../domain/time');
const { activeAlerts } = require('../domain/continuity');

/** Gathers the computed facts that ground the weekly care brief. */
function buildBriefFacts(circle, now) {
  const local = localParts(now, circle.timezone);
  const upcomingAppointments = circle.appointments
    .filter((a) => (a.status || 'upcoming') === 'upcoming' && wallToMinutes(a.date, a.time) > local.minutes)
    .sort((a, b) => wallToMinutes(a.date, a.time) - wallToMinutes(b.date, b.time))
    .slice(0, 3)
    .map(({ doctor, specialty, date, time }) => ({ doctor, specialty, date, time }));
  const lowStock = circle.medications
    .filter((m) => m.active !== false && m.stock != null && m.refillAt != null && m.stock <= m.refillAt)
    .map(({ name, stock }) => ({ name, stock }));

  return {
    elderName: circle.elder.name,
    today: local.date,
    adherence: adherenceStats(circle, now, 7),
    upcomingAppointments,
    lowStock,
  };
}

/** Facts for the daily brief, computed from records. The AI only phrases these. */
function buildDailyFacts(circle, now) {
  const local = localParts(now, circle.timezone);
  const today = scheduleForDate(circle, local.date, now);
  const count = (...statuses) => today.filter((d) => statuses.includes(d.status)).length;
  const dayAgo = new Date(now.getTime() - 86_400_000).toISOString();
  const pending = circle.handovers.find((h) => !h.acknowledgedAt);
  return {
    elderName: circle.elder.name,
    date: local.date,
    time: local.time,
    medications: {
      scheduled: today.length,
      confirmed: count(DOSE_STATUS.TAKEN),
      awaiting: count(DOSE_STATUS.DUE, DOSE_STATUS.UPCOMING),
      unconfirmed: count(DOSE_STATUS.UNCONFIRMED),
      reportedMissed: count(DOSE_STATUS.MISSED),
    },
    appointments: circle.appointments
      .filter((a) => a.status === 'upcoming')
      .filter((a) => {
        const minutes = wallToMinutes(a.date, a.time) - local.minutes;
        return minutes > 0 && minutes <= 48 * 60;
      })
      .map(({ doctor, specialty, date, time }) => ({ doctor, specialty, date, time })),
    caregivers: circle.members.filter((m) => m.role !== 'elder').length,
    activeAlerts: activeAlerts(circle, now).length,
    openTasks: circle.tasks.filter((t) => t.status === 'open').length,
    pendingHandover: pending ? pending.fromName : null,
    recentCaregiverActivity: circle.activity.filter((a) => a.role !== 'elder' && a.at >= dayAgo).slice(0, 5).map((a) => `${a.actor}: ${a.text}`),
  };
}

function dailyBriefToText(brief, facts) {
  const m = facts.medications;
  const lines = [
    brief.greeting,
    '',
    'Facts from the records:',
    `• ${m.scheduled} scheduled doses, ${m.confirmed} confirmed, ${m.awaiting} still to come, ${m.unconfirmed} unconfirmed, ${m.reportedMissed} reported missed`,
    `• ${facts.appointments.length} appointment(s) in the next 48 hours`,
    `• ${facts.caregivers} connected caregiver(s), ${facts.activeAlerts} active alert(s), ${facts.openTasks} open task(s)`,
    '',
    brief.summary,
  ];
  if (brief.attention.length) lines.push('', 'Needs attention:', ...brief.attention.map((a) => `• ${a}`));
  return lines.join('\n');
}

function briefToText(brief) {
  const section = (title, items) => (items.length ? `\n\n${title}:\n${items.map((i) => `• ${i}`).join('\n')}` : '');
  return `${brief.headline}\n\n${brief.summary}${section('Going well', brief.wins)}${section('Worth watching', brief.watch)}${section('Questions for the doctor', brief.questionsForDoctor)}`;
}

module.exports = { buildBriefFacts, briefToText, buildDailyFacts, dailyBriefToText };
