'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { planNotifications } = require('../src/domain/reminders');
const { careSlots, activeAlerts } = require('../src/domain/continuity');
const { acknowledgeAlert } = require('../src/domain/coordination');
const { createReminderService } = require('../src/services/reminderService');
const { MemoryStore } = require('../src/data/memoryStore');
const { at, makeCircle, fakeMailer, fakeAi, silentLogger } = require('./helpers');

// NOW is 09:00 local; the morning slot is 08:00, so at(-60) = 08:00.
const MORNING = '2026-11-16T08:00';
const morning = (circle, minutes) => planNotifications(circle, at(minutes)).filter((n) => n.key.startsWith(`dose:${MORNING}`));
const stagesAt = (circle, minutes) => morning(circle, minutes).map((n) => n.stage);
const markSent = (circle, minutes) => morning(circle, minutes).forEach((n) => circle.notifications.push({ key: n.key, type: 'dose', stage: n.stage, at: at(minutes).toISOString() }));

describe('care continuity ladder', () => {
  test('reminder → follow-up → primary caregiver → backup contact', () => {
    const circle = makeCircle();
    assert.deepEqual(stagesAt(circle, -75), []); // 07:45, before the reminder window
    assert.deepEqual(stagesAt(circle, -70), ['reminder']); // 07:50
    assert.deepEqual(stagesAt(circle, -45), ['followup']); // 08:15
    assert.deepEqual(stagesAt(circle, -30), ['primary']); // 08:30
    assert.deepEqual(stagesAt(circle, -15), ['primary', 'backup']); // 08:45
  });

  test('each stage reaches the right people', () => {
    const circle = makeCircle();
    assert.deepEqual(morning(circle, -70)[0].recipients.map((r) => r.role), ['elder']);
    const [primary, backup] = morning(circle, -15);
    assert.deepEqual(primary.recipients.map((r) => r.role), ['caretaker']);
    assert.deepEqual(backup.recipients.map((r) => r.role), ['family']);
  });

  test('a caregiver acknowledgement stops escalation to the backup contact', () => {
    const circle = makeCircle();
    markSent(circle, -30);
    acknowledgeAlert(circle, circle.members[1], { slot: MORNING, note: 'Called her, taking it now' }, at(-25));
    assert.deepEqual(stagesAt(circle, 0), []);
    assert.equal(careSlots(circle, at(0)).find((s) => s.slot === MORNING).state, 'caregiver_acknowledged');
  });

  test('unacknowledged alerts escalate to the backup contact (primary unavailable)', () => {
    const circle = makeCircle();
    markSent(circle, -30);
    assert.deepEqual(stagesAt(circle, -15), ['backup']);
    markSent(circle, -15);
    assert.equal(careSlots(circle, at(-10)).find((s) => s.slot === MORNING).state, 'escalated');
    assert.equal(activeAlerts(circle, at(-10)).length, 1);
  });

  test('a late confirmation resolves the slot and stops the ladder', () => {
    const circle = makeCircle();
    markSent(circle, -30);
    circle.doseLog.push({ key: 'med_metformin0001@2026-11-16@08:00', status: 'taken', at: at(-20).toISOString() });
    assert.deepEqual(stagesAt(circle, 0), []);
    assert.equal(careSlots(circle, at(0)).find((s) => s.slot === MORNING).state, 'confirmed');
  });

  test('explicitly reported missed doses are resolved, not escalated', () => {
    const circle = makeCircle();
    circle.doseLog.push({ key: 'med_metformin0001@2026-11-16@08:00', status: 'missed', at: at(-40).toISOString() });
    assert.deepEqual(stagesAt(circle, 0), []);
    assert.equal(careSlots(circle, at(0)).find((s) => s.slot === MORNING).state, 'reported_missed');
  });

  test('care states progress from scheduled to escalated', () => {
    const circle = makeCircle();
    const state = (m) => careSlots(circle, at(m)).find((s) => s.slot === MORNING).state;
    assert.equal(state(-90), 'scheduled');
    markSent(circle, -70);
    assert.equal(state(-65), 'reminder_sent');
    assert.equal(state(-50), 'awaiting_confirmation');
    markSent(circle, -30);
    assert.equal(state(-29), 'caregiver_notified');
  });

  test('duplicate notifications are never planned twice', () => {
    const circle = makeCircle();
    markSent(circle, -15);
    assert.deepEqual(stagesAt(circle, 0), []);
  });

  test('with no primary caregiver, the backup is alerted at the primary step and not twice', () => {
    const circle = makeCircle();
    circle.members = circle.members.filter((m) => m.role !== 'caretaker');
    const plan = morning(circle, 0);
    assert.deepEqual(plan.map((n) => n.stage), ['primary']);
    assert.deepEqual(plan[0].recipients.map((r) => r.role), ['family']);
  });

  test('responder levels are configurable by member, not fixed by role', () => {
    const circle = makeCircle();
    circle.members[1].responder = 'backup';
    circle.members[2].responder = 'primary';
    const [primary, backup] = morning(circle, -15);
    assert.deepEqual(primary.recipients.map((r) => r.role), ['family']);
    assert.deepEqual(backup.recipients.map((r) => r.role), ['caretaker']);
  });

  test('opted-out members and members without email are skipped', () => {
    const circle = makeCircle();
    circle.members[1].notify = false;
    circle.members[2].email = '';
    assert.deepEqual(stagesAt(circle, 0), []);
  });

  test('stale doses (over 12 hours old) are not escalated after downtime', () => {
    assert.equal(planNotifications(makeCircle(), at(13 * 60)).some((n) => n.key.includes('T08:00')), false);
  });
});

describe('appointment, stock and weekly reminders', () => {
  const quiet = (circle) => {
    circle.doseLog.push({ key: 'med_metformin0001@2026-11-16@08:00', status: 'taken' }, { key: 'med_metformin0001@2026-11-15@21:00', status: 'taken' });
    return circle;
  };

  test('appointments remind 24 hours and 2 hours ahead', () => {
    const circle = quiet(makeCircle({ appointments: [{ id: 'apt_test00000001', doctor: 'Hegde', date: '2026-11-17', time: '10:00', status: 'upcoming' }] }));
    const appt = (m) => planNotifications(circle, at(m)).filter((n) => n.type === 'appointment').map((n) => n.stage);
    assert.deepEqual(appt(0), []); // 25 hours ahead
    assert.deepEqual(appt(120), ['24h']);
    assert.deepEqual(appt(24 * 60), ['2h']);
    assert.deepEqual(appt(26 * 60), []); // already past
  });

  test('low stock alerts once per day', () => {
    const circle = makeCircle();
    circle.medications[0].stock = 2;
    const first = planNotifications(circle, at(0)).filter((n) => n.type === 'stock');
    assert.equal(first.length, 1);
    circle.notifications.push({ key: first[0].key });
    assert.equal(planNotifications(circle, at(5)).filter((n) => n.type === 'stock').length, 0);
  });

  test('weekly brief goes out on Sunday evening only', () => {
    const circle = makeCircle();
    assert.equal(planNotifications(circle, new Date('2026-11-22T13:00:00Z')).some((n) => n.type === 'brief'), true);
    assert.equal(planNotifications(circle, at(0)).some((n) => n.type === 'brief'), false);
  });
});

describe('reminder service', () => {
  test('sends each notification exactly once across repeated ticks', async () => {
    const store = new MemoryStore();
    const circle = makeCircle();
    circle.medications[0].startDate = '2026-11-16';
    await store.create(circle);
    const mailer = fakeMailer();
    const service = createReminderService({ store, mailer, ai: fakeAi(), logger: silentLogger, clock: () => at(0) });

    const first = await service.tick();
    assert.equal(first.notifications, 2); // primary + backup for the 08:00 slot
    const second = await service.tick();
    assert.equal(second.notifications, 0);
    assert.equal(mailer.sent.length, 2);
    assert.deepEqual((await store.get('cir_test00000000')).notifications.map((n) => n.status), ['sent', 'sent']);
  });

  test('demo circles simulate delivery and expire after 24 hours', async () => {
    const store = new MemoryStore();
    await store.create(makeCircle({ demo: true, createdAt: at(-60).toISOString() }));
    const mailer = fakeMailer();
    const clock = { now: at(0) };
    const service = createReminderService({ store, mailer, ai: fakeAi(), logger: silentLogger, clock: () => clock.now });
    await service.tick();
    assert.ok(mailer.sent.every((m) => m.simulate === true));
    clock.now = at(25 * 60);
    await service.tick();
    assert.equal(await store.get('cir_test00000000'), null);
  });
});
