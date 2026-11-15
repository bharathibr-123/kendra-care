'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { routineDrift, median, mad } = require('../src/domain/drift');
const companion = require('../src/domain/companion');
const coordination = require('../src/domain/coordination');
const emergency = require('../src/domain/emergency');
const { buildDemoCircle } = require('../src/domain/demo');
const { wallToInstant, addDays } = require('../src/domain/time');
const { buildDailyFacts } = require('../src/services/insights');
const { buildRuleBasedDailyBrief } = require('../src/services/ai');
const { NOW, at, makeCircle } = require('./helpers');

/** Adds a confirmed 08:00 dose on `date`, confirmed `delay` minutes late. */
function confirm(circle, date, delay, time = '08:00') {
  circle.doseLog.push({ key: `med_metformin0001@${date}@${time}`, date, time, status: 'taken', at: new Date(wallToInstant(date, time, 'Asia/Kolkata').getTime() + delay * 60_000).toISOString() });
}

function historyCircle(delays) {
  const circle = makeCircle();
  circle.medications[0].times = ['08:00'];
  circle.medications[0].startDate = '2026-10-01';
  circle.medications[0].createdAt = '2026-10-01T00:00:00.000Z';
  delays.forEach((delay, i) => {
    if (delay !== null) confirm(circle, addDays('2026-11-16', -(delays.length - 1 - i)), delay);
  });
  return circle;
}

describe('routine drift detection', () => {
  test('median and MAD are robust statistics', () => {
    assert.equal(median([5, 1, 3]), 3);
    assert.equal(median([1, 2, 3, 4]), 2.5);
    assert.equal(median([]), null);
    assert.equal(mad([1, 2, 3, 4, 100]), 1);
  });

  test('detects consistently later confirmations against the personal baseline', () => {
    // 14 baseline days around +5 min, then 3 recent days around +50 min (today included).
    const circle = historyCircle([4, 6, 5, 3, 7, 5, 6, 4, 5, 6, 5, 4, 6, 5, 48, 52, 50]);
    const result = routineDrift(circle, NOW);
    const insight = result.insights.find((i) => i.type === 'later_confirmations');
    assert.ok(insight, 'expected a drift insight');
    assert.equal(insight.confidence, 'high');
    assert.ok(insight.shiftMinutes >= 40 && insight.shiftMinutes <= 50);
    assert.match(insight.message, /later than your usual pattern/);
    assert.doesNotMatch(`${insight.message} ${insight.suggestion}`, /diagnos|disease|condition/i);
  });

  test('a single late day is not enough to raise drift', () => {
    const circle = historyCircle([4, 6, 5, 3, 7, 5, 6, 4, 5, 6, 5, 4, 6, 5, 5, 6, 55]);
    assert.equal(routineDrift(circle, NOW).insights.filter((i) => i.type === 'later_confirmations').length, 0);
  });

  test('normal day-to-day variation is not flagged', () => {
    const circle = historyCircle([2, 15, 8, 20, 5, 12, 18, 3, 9, 14, 6, 11, 17, 4, 16, 13, 19]);
    assert.equal(routineDrift(circle, NOW).insights.length, 0);
  });

  test('says so when there is not enough history instead of guessing', () => {
    const circle = historyCircle([5, 50, 52]);
    const result = routineDrift(circle, NOW);
    assert.equal(result.hasEnoughData, false);
    assert.equal(result.insights.length, 0);
    assert.equal(result.groups[0].status, 'insufficient_data');
    assert.match(result.groups[0].note, /at least 5/);
  });

  test('flags repeated unconfirmed doses that break an established routine', () => {
    const circle = historyCircle([4, 6, 5, 3, 7, 5, 6, 4, 5, 6, 5, 4, 6, 5, null, null, 5]);
    const insight = routineDrift(circle, NOW).insights.find((i) => i.type === 'repeated_unconfirmed');
    assert.ok(insight);
    assert.match(insight.suggestion, /not whether medicine was taken/);
  });

  test('the demo history tells the intended story', async () => {
    const demo = await buildDemoCircle(new Date('2026-11-16T05:30:00Z'), 'Asia/Kolkata');
    const types = routineDrift(demo, new Date('2026-11-16T05:30:00Z')).insights.map((i) => i.type);
    assert.deepEqual(types.sort(), ['later_confirmations', 'repeated_unconfirmed']);
  });
});

describe('care companion (tool-grounded, bilingual)', () => {
  const ask = (circle, text, now = NOW) => {
    const cl = companion.classify(text);
    return companion.answer(circle, now, { ...cl, language: companion.detectLanguage(text) });
  };

  test('answers the next appointment from records in English and Kannada', () => {
    const circle = makeCircle({ appointments: [{ id: 'apt_test00000001', doctor: 'Hegde', specialty: 'Cardiologist', location: 'JSS Hospital', date: '2026-11-17', time: '10:30', status: 'upcoming' }] });
    const en = ask(circle, 'When is my next doctor appointment?');
    assert.equal(en.source, 'records');
    assert.equal(en.tool, 'appointment');
    assert.match(en.answer, /Dr\. Hegde .* 17 November at 10:30 AM/);
    const kn = ask(circle, 'ನನ್ನ ಮುಂದಿನ ಡಾಕ್ಟರ್ ಅಪಾಯಿಂಟ್ಮೆಂಟ್ ಯಾವಾಗ?');
    assert.equal(kn.language, 'kn');
    assert.match(kn.answer, /ಡಾ\. Hegde/);
  });

  test('confirmation answers reflect the actual dose log', () => {
    const circle = makeCircle();
    assert.match(ask(circle, 'Have I confirmed my morning medicine?').answer, /^Not yet\. Still awaiting confirmation: Metformin 500 mg/);
    circle.doseLog.push({ key: 'med_metformin0001@2026-11-16@08:00', status: 'taken', byName: 'Ravi' });
    assert.match(ask(circle, 'Have I confirmed my morning medicine?').answer, /^Yes\. .*recorded by Ravi/);
    assert.match(ask(circle, 'ನಾನು ಇವತ್ತು ಬೆಳಿಗ್ಗೆ ಔಷಧಿ ತೆಗೆದುಕೊಂಡಿದ್ದೇನಾ?').answer, /^ಹೌದು/);
  });

  test('never invents an answer it cannot ground in records', () => {
    const reply = ask(makeCircle(), 'What is the capital of France?');
    assert.equal(reply.intent, 'unknown');
    assert.equal(reply.source, 'general');
    assert.match(reply.answer, /can't answer that from your records/);
    assert.equal(ask(makeCircle(), 'When is my next doctor appointment?').answer, 'No upcoming appointment is recorded.');
  });

  test('refuses dosage changes and redirects emergencies to 112', () => {
    for (const q of ['Can I stop taking metformin?', 'Should I double my dose tonight?', 'ಮಾತ್ರೆ ನಿಲ್ಲಿಸಬಹುದಾ?']) {
      const reply = ask(makeCircle(), q);
      assert.equal(reply.intent, 'medical_advice', q);
      assert.equal(reply.source, 'safety');
    }
    const sos = ask(makeCircle({ emergency: { contacts: [{ name: 'Priya', phone: '+91 90000 00001' }] } }), 'I have chest pain');
    assert.equal(sos.intent, 'emergency');
    assert.match(sos.answer, /call 112 now.*Priya/);
  });

  test('"which medicine should I take" is a schedule question, not advice', () => {
    const reply = ask(makeCircle(), 'Which medicine should I take this morning?');
    assert.equal(reply.intent, 'medicines');
    assert.match(reply.answer, /Metformin 500 mg at 8:00 AM/);
  });
});

describe('caregiver coordination', () => {
  test('handover snapshot is built from live records', () => {
    const circle = makeCircle({ appointments: [{ id: 'apt_test00000001', doctor: 'Hegde', date: '2026-11-17', time: '10:00', status: 'upcoming' }] });
    circle.doseLog.push({ key: 'med_metformin0001@2026-11-16@08:00', status: 'taken' });
    const caretaker = circle.members[1];
    coordination.createTask(circle, caretaker, { title: 'Book transport', assigneeId: circle.members[2].id }, NOW);
    coordination.addNote(circle, caretaker, 'Slept well', NOW);
    const handover = coordination.createHandover(circle, caretaker, { toId: circle.members[2].id, note: 'Evening is yours' }, NOW);
    assert.deepEqual(handover.snapshot.confirmed, ['08:00 Metformin']);
    assert.deepEqual(handover.snapshot.pending, ['21:00 Metformin']);
    assert.match(handover.snapshot.appointments[0], /Dr\. Hegde/);
    assert.match(handover.snapshot.tasks[0], /Book transport \(Family\)/);
    assert.match(handover.snapshot.notes[0], /Slept well/);
  });

  test('only the addressed next caregiver can acknowledge a handover, once', () => {
    const circle = makeCircle();
    const [elder, caretaker, family] = circle.members;
    const handover = coordination.createHandover(circle, caretaker, { toId: family.id }, NOW);
    assert.throws(() => coordination.acknowledgeHandover(circle, caretaker, handover.id, NOW), /not its author/);
    assert.throws(() => coordination.acknowledgeHandover(circle, elder, handover.id, NOW), /addressed to/);
    coordination.acknowledgeHandover(circle, family, handover.id, NOW);
    assert.throws(() => coordination.acknowledgeHandover(circle, family, handover.id, NOW), /Already acknowledged/);
  });

  test('tasks can be completed and transferred to another member', () => {
    const circle = makeCircle();
    const task = coordination.createTask(circle, circle.members[0], { title: 'Refill' }, NOW);
    coordination.updateTask(circle, circle.members[1], task.id, { assigneeId: circle.members[2].id }, NOW);
    assert.equal(task.assigneeName, 'Family');
    coordination.updateTask(circle, circle.members[2], task.id, { status: 'done' }, NOW);
    assert.equal(task.completedBy, 'Family');
    assert.throws(() => coordination.updateTask(circle, circle.members[2], task.id, { assigneeId: 'mbr_nobody000000' }, NOW), /not in this circle/);
  });

  test('alerts can only be acknowledged when open, once, and not by the elder', () => {
    const circle = makeCircle();
    const slot = '2026-11-16T08:00';
    assert.throws(() => coordination.acknowledgeAlert(circle, circle.members[0], { slot }, NOW), /elder resolves/);
    assert.throws(() => coordination.acknowledgeAlert(circle, circle.members[1], { slot: '2026-11-16T21:00' }, NOW), /not due yet/);
    coordination.acknowledgeAlert(circle, circle.members[1], { slot, note: 'On it' }, NOW);
    assert.throws(() => coordination.acknowledgeAlert(circle, circle.members[2], { slot }, NOW), /Already acknowledged/);
  });
});

describe('emergency card', () => {
  test('share links store only a hash, expire, and can be revoked', () => {
    const circle = makeCircle();
    const { share, token } = emergency.createShare(circle, circle.members[0], { hours: 1 }, NOW);
    const parsed = emergency.parseToken(token);
    assert.equal(parsed.circleId, circle.id);
    assert.equal(JSON.stringify(circle).includes(parsed.secret), false, 'secret must not be stored');
    assert.ok(emergency.findActiveShare(circle, parsed.secret, NOW));
    assert.equal(emergency.findActiveShare(circle, parsed.secret, at(61)), null, 'expired');
    assert.equal(emergency.findActiveShare(circle, 'x'.repeat(43), NOW), null, 'wrong secret');
    emergency.revokeShare(circle, circle.members[0], share.id, NOW);
    assert.equal(emergency.findActiveShare(circle, parsed.secret, NOW), null, 'revoked');
    assert.equal(emergency.parseToken('../../etc/passwd'), null);
  });

  test('the public card exposes only the limited emergency fields', () => {
    const circle = makeCircle({ emergency: { contacts: [{ name: 'Priya', phone: '+91 1', relation: 'Daughter' }], allergies: 'Penicillin', conditions: '', bloodGroup: 'B+', notes: '' } });
    const card = emergency.publicCard(circle, { expiresAt: at(60).toISOString() });
    assert.deepEqual(Object.keys(card).sort(), ['allergies', 'bloodGroup', 'conditions', 'contacts', 'expiresAt', 'medications', 'name', 'notes']);
    assert.equal(JSON.stringify(card).includes('example.com'), false, 'no member emails');
  });
});

describe('daily care brief', () => {
  test('facts are computed from records and the fallback wording uses only them', () => {
    const circle = makeCircle();
    circle.doseLog.push({ key: 'med_metformin0001@2026-11-15@21:00', status: 'taken' });
    const facts = buildDailyFacts(circle, NOW);
    assert.deepEqual(facts.medications, { scheduled: 2, confirmed: 0, awaiting: 1, unconfirmed: 1, reportedMissed: 0 });
    assert.equal(facts.caregivers, 2);
    const brief = buildRuleBasedDailyBrief(facts);
    assert.equal(brief.greeting, 'Good morning, Kamala');
    assert.match(brief.summary, /2 doses scheduled today, 0 confirmed/);
  });
});
