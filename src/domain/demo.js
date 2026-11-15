'use strict';

const crypto = require('node:crypto');
const { buildCircle } = require('./circle');
const { generateId } = require('../security/passcode');
const { localParts, addDays, wallToMinutes, wallToInstant } = require('./time');
const { dosesForDate } = require('./schedule');
const { ROLES } = require('./policy');

/**
 * A realistic, explorable demo circle so evaluators can see every feature without
 * setting anything up. All people are fictional and demo emails are simulated.
 *
 * The 30-day history is deterministic and tells a story the analytics should find:
 *  - morning confirmations drift ~45 minutes later over the last few days
 *  - the night dose went unconfirmed on two recent days
 *  - one dose was explicitly reported missed, with a note
 */

const HISTORY_DAYS = 30;

/** Deterministic pseudo-random jitter in [0, range) derived from a string. */
function jitter(seed, range) {
  return crypto.createHash('sha256').update(seed).digest().readUInt16BE(0) % range;
}

function doseOutcome(dose, offset) {
  const isMorning = dose.time < '12:00';
  const isNight = dose.time >= '21:00';
  if (isNight && [1, 2, 9, 17].includes(offset)) return { status: null }; // nobody confirmed
  if (isNight && offset === 12 && dose.name === 'Atorvastatin') return { status: 'missed', delay: 40, note: 'Ran out at home that night' };
  const base = isMorning && offset <= 2 ? 42 : isNight ? 6 : 3;
  const spread = isMorning && offset <= 2 ? 14 : 10;
  return { status: 'taken', delay: base + jitter(`${dose.medId}${dose.time}${offset}`, spread) };
}

async function buildDemoCircle(now, timezone) {
  const circle = await buildCircle(
    {
      elderName: 'Kamala Rao',
      elderEmail: 'kamala.demo@example.com',
      elderPin: String(crypto.randomInt(100000, 999999)),
      sharePasscode: crypto.randomBytes(12).toString('hex'),
      timezone,
      demo: true,
    },
    now,
  );

  const local = localParts(now, timezone);
  const ago = (days) => new Date(now.getTime() - days * 86_400_000).toISOString();
  const created = ago(HISTORY_DAYS + 2);
  const elder = circle.members[0];
  elder.joinedAt = created;
  const nurse = { id: generateId('mbr'), name: 'Ravi (home nurse)', email: 'ravi.demo@example.com', role: ROLES.CARETAKER, responder: 'primary', notify: true, tokenVersion: 0, joinedAt: ago(HISTORY_DAYS) };
  const daughter = { id: generateId('mbr'), name: 'Priya (daughter)', email: 'priya.demo@example.com', role: ROLES.FAMILY, responder: 'backup', notify: true, tokenVersion: 0, joinedAt: ago(HISTORY_DAYS) };
  circle.members.push(nurse, daughter);

  const med = (fields) => ({ id: generateId('med'), active: true, days: [], startDate: addDays(local.date, -(HISTORY_DAYS + 2)), endDate: null, createdAt: created, updatedAt: created, ...fields });
  circle.medications = [
    med({ name: 'Metformin', dosage: '500 mg', instructions: 'After food', times: ['08:00', '21:00'], stock: 18, refillAt: 6 }),
    med({ name: 'Amlodipine', dosage: '5 mg', instructions: 'Morning, with water', times: ['08:00'], stock: 4, refillAt: 5 }),
    med({ name: 'Atorvastatin', dosage: '10 mg', instructions: 'At bedtime', times: ['21:30'], stock: 25, refillAt: 7 }),
    med({ name: 'Vitamin D3', dosage: '60,000 IU', instructions: 'Once a week, after breakfast', times: ['09:00'], days: [0], stock: null, refillAt: null }),
  ];

  const log = (dose, status, delay, by, note) => {
    circle.doseLog.push({
      key: dose.key,
      medId: dose.medId,
      date: dose.date,
      time: dose.time,
      status,
      ...(note && { note }),
      at: new Date(wallToInstant(dose.date, dose.time, timezone).getTime() + delay * 60_000).toISOString(),
      byId: by.id,
      byName: by.name,
    });
  };

  for (let offset = HISTORY_DAYS; offset >= 1; offset -= 1) {
    for (const dose of dosesForDate(circle, addDays(local.date, -offset))) {
      const outcome = doseOutcome(dose, offset);
      if (!outcome.status) continue;
      log(dose, outcome.status, outcome.delay, offset % 3 === 0 ? nurse : elder, outcome.note);
    }
  }

  // Today: confirm past slots except the latest, so the continuity ladder is visible on arrival.
  const pastToday = dosesForDate(circle, local.date).filter((d) => wallToMinutes(d.date, d.time) < local.minutes - 40);
  const latestTime = pastToday.at(-1)?.time;
  pastToday.filter((d) => d.time !== latestTime).forEach((dose) => log(dose, 'taken', 9, elder));

  circle.appointments = [
    { id: generateId('apt'), doctor: 'Suresh Hegde', specialty: 'Cardiologist', location: 'JSS Hospital, Mysuru', date: addDays(local.date, 1), time: '10:30', notes: 'Bring the last ECG report and BP diary.', status: 'upcoming', createdAt: created, updatedAt: created },
    { id: generateId('apt'), doctor: 'Anita Kulkarni', specialty: 'Diabetologist', location: 'Apollo BGS, Mysuru', date: addDays(local.date, 9), time: '17:00', notes: 'Fasting blood sugar test the same morning.', status: 'upcoming', createdAt: created, updatedAt: created },
    { id: generateId('apt'), doctor: 'Meera Shetty', specialty: 'General physician', location: 'Kuvempunagar Clinic', date: addDays(local.date, -12), time: '11:00', notes: '', status: 'done', createdAt: created, updatedAt: created },
  ];

  const atorvastatin = circle.medications[2];
  circle.proposals = [
    {
      id: generateId('prp'),
      entity: 'medication',
      action: 'update',
      targetId: atorvastatin.id,
      data: { times: ['20:30'] },
      summary: 'update medication "Atorvastatin" (move bedtime dose to 20:30)',
      proposedBy: { id: daughter.id, name: daughter.name, role: daughter.role },
      createdAt: ago(0.2),
      status: 'pending',
    },
  ];

  circle.tasks = [
    { id: generateId('tsk'), title: 'Book an auto for tomorrow’s cardiology visit', dueDate: local.date, assigneeId: daughter.id, assigneeName: daughter.name, status: 'open', createdBy: nurse.name, createdAt: ago(0.5) },
    { id: generateId('tsk'), title: 'Collect Amlodipine refill from the pharmacy', dueDate: addDays(local.date, 1), assigneeId: nurse.id, assigneeName: nurse.name, status: 'open', createdBy: elder.name, createdAt: ago(1) },
    { id: generateId('tsk'), title: 'Print last month’s BP diary', dueDate: addDays(local.date, -1), assigneeId: nurse.id, assigneeName: nurse.name, status: 'done', createdBy: daughter.name, createdAt: ago(3), completedAt: ago(1.2), completedBy: nurse.name },
  ];

  circle.careNotes = [
    { id: generateId('note'), text: 'Kamala said she has been sleeping late and wakes up after 8:30 this week.', byName: nurse.name, role: nurse.role, at: ago(0.9) },
    { id: generateId('note'), text: 'BP diary updated. Readings look similar to last week.', byName: nurse.name, role: nurse.role, at: ago(1.1) },
  ];

  circle.handovers = [
    {
      id: generateId('hnd'),
      fromId: nurse.id,
      fromName: nurse.name,
      toId: daughter.id,
      toName: daughter.name,
      note: 'Evening is yours today. Please remind her about the night tablets; she missed confirming them twice.',
      snapshot: { confirmed: ['08:00 Metformin, Amlodipine'], pending: ['21:00 Metformin', '21:30 Atorvastatin'], alerts: [], appointments: [`Dr. Suresh Hegde, ${addDays(local.date, 1)} 10:30`], tasks: ['Book an auto for tomorrow’s cardiology visit'], notes: [] },
      createdAt: ago(1.05),
      acknowledgedAt: ago(1),
      acknowledgedBy: daughter.name,
    },
  ];

  circle.emergency = {
    contacts: [
      { name: 'Priya Rao (daughter)', phone: '+91 90000 00001', relation: 'Daughter' },
      { name: 'Ravi Kumar (home nurse)', phone: '+91 90000 00002', relation: 'Caretaker' },
    ],
    allergies: 'Penicillin (rash)',
    conditions: 'Type 2 diabetes, high blood pressure',
    bloodGroup: 'B+',
    notes: 'Wears reading glasses. Prefers Kannada.',
  };

  circle.activity = [
    { at: ago(0.2), actor: daughter.name, role: daughter.role, text: 'Proposed to move Atorvastatin to 20:30 (awaiting elder approval)' },
    { at: ago(0.5), actor: nurse.name, role: nurse.role, text: 'Added task: Book an auto for tomorrow’s cardiology visit' },
    { at: ago(1), actor: daughter.name, role: daughter.role, text: 'Acknowledged the evening handover from Ravi (home nurse)' },
    { at: ago(1.05), actor: nurse.name, role: nurse.role, text: 'Handed over to Priya (daughter)' },
    { at: ago(HISTORY_DAYS), actor: daughter.name, role: daughter.role, text: 'Joined the care circle' },
    { at: ago(HISTORY_DAYS), actor: nurse.name, role: nurse.role, text: 'Joined the care circle' },
    { at: created, actor: circle.elder.name, role: ROLES.ELDER, text: 'Created the care circle' },
  ];
  circle.createdAt = now.toISOString(); // demo expiry counts from now; history above is backdated
  return circle;
}

module.exports = { buildDemoCircle };
