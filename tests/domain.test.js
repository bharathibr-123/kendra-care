'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const time = require('../src/domain/time');
const { frequencyToTimes, normaliseTime, resolveTimes } = require('../src/domain/frequency');
const { scheduleForDate, adherenceStats, dosesForDate } = require('../src/domain/schedule');
const { requestChange, decideProposal } = require('../src/domain/changes');
const { can, ACTIONS } = require('../src/domain/policy');
const { NOW, at, makeCircle, member } = require('./helpers');

describe('time helpers', () => {
  test('localParts converts an instant into the circle timezone', () => {
    assert.deepEqual(time.localParts(NOW, 'Asia/Kolkata'), { date: '2026-11-16', time: '09:00', minutes: time.wallToMinutes('2026-11-16', '09:00') });
    assert.equal(time.localParts(NOW, 'America/New_York').date, '2026-11-15');
  });

  test('addDays crosses month and year boundaries', () => {
    assert.equal(time.addDays('2026-12-31', 1), '2027-01-01');
    assert.equal(time.addDays('2026-03-01', -1), '2026-02-28');
  });

  test('dayOfWeek and isoWeekKey', () => {
    assert.equal(time.dayOfWeek('2026-11-16'), 1);
    assert.equal(time.isoWeekKey('2026-11-16'), '2026-W47');
    assert.equal(time.isoWeekKey('2027-01-01'), '2026-W53');
  });

  test('isValidTimezone rejects unknown zones', () => {
    assert.equal(time.isValidTimezone('Asia/Kolkata'), true);
    assert.equal(time.isValidTimezone('Mars/Olympus'), false);
  });
});

describe('prescription frequency parsing', () => {
  test('Indian 1-0-1 notation maps to morning and night', () => {
    assert.deepEqual(frequencyToTimes('1-0-1'), ['08:00', '21:00']);
    assert.deepEqual(frequencyToTimes('1 - 1 - 1'), ['08:00', '14:00', '21:00']);
    assert.deepEqual(frequencyToTimes('0-0-1'), ['21:00']);
    assert.equal(frequencyToTimes('0-0-0'), null);
  });

  test('Latin abbreviations', () => {
    assert.deepEqual(frequencyToTimes('BD'), ['08:00', '20:00']);
    assert.deepEqual(frequencyToTimes('tds after food'), ['08:00', '14:00', '20:00']);
    assert.deepEqual(frequencyToTimes('HS'), ['21:00']);
    assert.equal(frequencyToTimes('as needed'), null);
  });

  test('normaliseTime handles 12-hour input and rejects junk', () => {
    assert.equal(normaliseTime('8:30 pm'), '20:30');
    assert.equal(normaliseTime('12:00 am'), '00:00');
    assert.equal(normaliseTime('25:00'), null);
    assert.equal(normaliseTime('noon'), null);
  });

  test('resolveTimes prefers explicit times, then frequency, then once daily', () => {
    assert.deepEqual(resolveTimes(['21:00', '8:00'], 'OD'), ['08:00', '21:00']);
    assert.deepEqual(resolveTimes([], '1-0-1'), ['08:00', '21:00']);
    assert.deepEqual(resolveTimes(['bad'], 'unknown'), ['08:00']);
  });
});

describe('dose schedule', () => {
  test('statuses follow the clock: upcoming, due, unconfirmed (never auto-missed), taken', () => {
    const circle = makeCircle();
    const statusAt = (minutes) => scheduleForDate(circle, '2026-11-16', at(minutes)).map((d) => d.status);
    assert.deepEqual(statusAt(-80), ['upcoming', 'upcoming']); // 07:40
    assert.deepEqual(statusAt(-65), ['due', 'upcoming']); // 07:55, within 10 min lead
    assert.deepEqual(statusAt(-25), ['unconfirmed', 'upcoming']); // 08:35, past 30 min: labelled, not missed
    circle.doseLog.push({ key: 'med_metformin0001@2026-11-16@08:00', status: 'taken', at: NOW.toISOString(), byName: 'Kamala' });
    assert.deepEqual(statusAt(-25), ['taken', 'upcoming']);
    circle.doseLog[0].status = 'missed';
    assert.deepEqual(statusAt(-25), ['missed', 'upcoming'], 'missed only when explicitly reported');
  });

  test('respects weekdays, date range, paused medicines and creation time', () => {
    const circle = makeCircle();
    const med = circle.medications[0];
    med.days = [0];
    assert.equal(dosesForDate(circle, '2026-11-16').length, 0); // Monday
    med.days = [];
    med.endDate = '2026-11-15';
    assert.equal(dosesForDate(circle, '2026-11-16').length, 0);
    med.endDate = null;
    med.active = false;
    assert.equal(dosesForDate(circle, '2026-11-16').length, 0);
    med.active = true;
    med.createdAt = NOW.toISOString(); // added at 09:00, so the 08:00 dose never existed
    assert.deepEqual(dosesForDate(circle, '2026-11-16').map((d) => d.time), ['21:00']);
  });

  test('adherence counts only final outcomes and computes streaks', () => {
    const circle = makeCircle();
    for (const date of ['2026-11-13', '2026-11-14', '2026-11-15']) {
      for (const t of ['08:00', '21:00']) circle.doseLog.push({ key: `med_metformin0001@${date}@${t}`, date, time: t, status: 'taken' });
    }
    const stats = adherenceStats(circle, NOW, 7);
    assert.equal(stats.streakDays, 3);
    // Nov 10-12: 6 unconfirmed, Nov 13-15: 6 taken, today 08:00 unconfirmed (09:00 now), 21:00 pending.
    assert.equal(stats.totals.taken, 6);
    assert.equal(stats.totals.unconfirmed, 7);
    assert.equal(stats.totals.missed, 0, 'nothing was reported missed');
    assert.equal(stats.totals.rate, 46);
    assert.equal(stats.bySlot.night.unconfirmed, 3);
  });
});

describe('elder-centred change approval', () => {
  const change = { entity: 'medication', action: 'create', data: { name: 'Aspirin', times: ['09:00'], days: [] } };

  test('elder changes apply immediately', () => {
    const circle = makeCircle();
    const result = requestChange(circle, circle.members[0], change, NOW.toISOString());
    assert.equal(result.applied, true);
    assert.equal(circle.medications.length, 2);
  });

  test('caretaker changes become proposals until the elder approves', () => {
    const circle = makeCircle();
    const [elder, caretaker] = circle.members;
    const { applied, proposal } = requestChange(circle, caretaker, change, NOW.toISOString());
    assert.equal(applied, false);
    assert.equal(circle.medications.length, 1);
    assert.throws(() => decideProposal(circle, caretaker, proposal.id, true, NOW.toISOString()), /Only the elder/);

    decideProposal(circle, elder, proposal.id, true, NOW.toISOString());
    assert.equal(circle.medications.length, 2);
    assert.equal(proposal.status, 'approved');
    assert.throws(() => decideProposal(circle, elder, proposal.id, true, NOW.toISOString()), /already decided/);
  });

  test('declined proposals change nothing; approval can be switched off by the elder', () => {
    const circle = makeCircle();
    const { proposal } = requestChange(circle, circle.members[2], { entity: 'medication', action: 'delete', targetId: 'med_metformin0001' }, NOW.toISOString());
    decideProposal(circle, circle.members[0], proposal.id, false, NOW.toISOString());
    assert.equal(circle.medications.length, 1);

    circle.settings.requireApproval = false;
    assert.equal(requestChange(circle, circle.members[2], change, NOW.toISOString()).applied, true);
  });

  test('changes to unknown items are rejected', () => {
    const circle = makeCircle();
    assert.throws(() => requestChange(circle, circle.members[0], { entity: 'medication', action: 'update', targetId: 'med_missing00000', data: {} }, NOW.toISOString()), /does not exist/);
  });

  test('policy matrix', () => {
    const circle = makeCircle();
    assert.equal(can(member('family'), ACTIONS.MANAGE_CIRCLE, circle), false);
    assert.equal(can(member('family'), ACTIONS.SEND_BRIEF, circle), false);
    assert.equal(can(member('caretaker'), ACTIONS.SEND_BRIEF, circle), true);
    assert.equal(can(member('elder'), ACTIONS.DECIDE_PROPOSAL, circle), true);
    assert.equal(can(null, ACTIONS.VIEW, circle), false);
  });
});
