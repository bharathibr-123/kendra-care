'use strict';

const { generateId, generateCircleCode, hashSecret } = require('../security/passcode');
const { ROLES } = require('./policy');
const { localParts, addDays } = require('./time');

/**
 * Default care-continuity timings for a dose scheduled at T:
 *   T - 10 min  reminder to the elder
 *   T + 15 min  follow-up reminder to the elder
 *   T + 30 min  primary caregiver(s) notified, dose labelled "unconfirmed"
 *   T + 45 min  backup contact(s) notified, unless a caregiver acknowledged
 */
const DEFAULT_SETTINGS = Object.freeze({
  requireApproval: true,
  upcomingLeadMin: 10,
  followupMin: 15,
  escalatePrimaryMin: 30,
  escalateBackupMin: 45,
});

/** Who responds when a dose goes unconfirmed. Elders default to none, caretakers to primary, family to backup. */
const RESPONDER = Object.freeze({ PRIMARY: 'primary', BACKUP: 'backup', NONE: 'none' });

function defaultResponder(role) {
  if (role === ROLES.CARETAKER) return RESPONDER.PRIMARY;
  if (role === ROLES.FAMILY) return RESPONDER.BACKUP;
  return RESPONDER.NONE;
}

const COLLECTIONS = ['members', 'medications', 'appointments', 'doseLog', 'proposals', 'notifications', 'activity', 'acknowledgements', 'careNotes', 'tasks', 'handovers', 'conversations', 'emergencyShares'];

/** Fills fields added in later versions so older stored circles keep working (lazy migration). */
function withDefaults(circle) {
  for (const key of COLLECTIONS) circle[key] ??= [];
  circle.settings = { ...DEFAULT_SETTINGS, ...circle.settings };
  circle.emergency ??= { contacts: [], allergies: '', conditions: '', bloodGroup: '', notes: '' };
  for (const member of circle.members) member.responder ??= defaultResponder(member.role);
  return circle;
}

const RETENTION = Object.freeze({ doseLogDays: 90, notificationDays: 30, proposalDays: 30, demoHours: 24 });

async function buildCircle({ elderName, elderEmail, elderPin, sharePasscode, timezone, demo = false }, now) {
  const at = now.toISOString();
  const elder = {
    id: generateId('mbr'),
    name: elderName,
    email: elderEmail || '',
    role: ROLES.ELDER,
    notify: true,
    responder: RESPONDER.NONE,
    tokenVersion: 0,
    joinedAt: at,
  };
  return withDefaults({
    id: generateId('cir'),
    code: generateCircleCode(),
    demo,
    createdAt: at,
    timezone,
    elder: { name: elderName },
    security: {
      elderPin: await hashSecret(elderPin),
      sharePasscode: await hashSecret(sharePasscode),
      passcodeVersion: 0,
      failedAttempts: 0,
      lockedUntil: null,
    },
    settings: { ...DEFAULT_SETTINGS },
    members: [elder],
    medications: [],
    appointments: [],
    doseLog: [],
    proposals: [],
    notifications: [],
    activity: [{ at, actor: elderName, role: ROLES.ELDER, text: 'Created the care circle' }],
  });
}

/** The shape sent to browsers. Secrets and internal counters never leave the server. */
function toPublicCircle(circle, member) {
  return {
    id: circle.id,
    code: circle.code,
    demo: Boolean(circle.demo),
    timezone: circle.timezone,
    elderName: circle.elder.name,
    settings: circle.settings,
    me: { id: member.id, name: member.name, role: member.role, email: member.email, notify: member.notify !== false },
    members: circle.members.map((m) => ({
      id: m.id,
      name: m.name,
      role: m.role,
      hasEmail: Boolean(m.email),
      notify: m.notify !== false,
      responder: m.responder,
      joinedAt: m.joinedAt,
    })),
  };
}

function pruneCircle(circle, now) {
  const today = localParts(now, circle.timezone).date;
  const doseCutoff = addDays(today, -RETENTION.doseLogDays);
  const noteCutoff = new Date(now.getTime() - RETENTION.notificationDays * 86_400_000).toISOString();
  const proposalCutoff = new Date(now.getTime() - RETENTION.proposalDays * 86_400_000).toISOString();

  circle.doseLog = circle.doseLog.filter((entry) => entry.date >= doseCutoff);
  circle.notifications = circle.notifications.filter((n) => n.at >= noteCutoff);
  circle.proposals = circle.proposals.filter((p) => p.status === 'pending' || p.decidedAt >= proposalCutoff);
  circle.acknowledgements = circle.acknowledgements.filter((a) => a.slot.slice(0, 10) >= doseCutoff);
  circle.emergencyShares = circle.emergencyShares.filter((s) => Date.parse(s.expiresAt) > now.getTime() - 7 * 86_400_000);
  circle.conversations.length = Math.min(circle.conversations.length, 100);
  circle.handovers.length = Math.min(circle.handovers.length, 100);
  return circle;
}

function isExpiredDemo(circle, now) {
  return Boolean(circle.demo) && now.getTime() - Date.parse(circle.createdAt) > RETENTION.demoHours * 3_600_000;
}

module.exports = { buildCircle, toPublicCircle, pruneCircle, isExpiredDemo, withDefaults, defaultResponder, DEFAULT_SETTINGS, RESPONDER, RETENTION };
