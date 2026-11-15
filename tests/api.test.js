'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { createApp } = require('../src/app');
const { loadConfig } = require('../src/config');
const { MemoryStore } = require('../src/data/memoryStore');
const { createReminderService } = require('../src/services/reminderService');
const { NOW, fakeMailer, fakeAi, silentLogger } = require('./helpers');

/** Boots the real app on a random port with injected fakes. */
async function startServer(overrides = {}) {
  // The whole suite shares one IP, so the per-IP sign-in limit is raised for tests only.
  const config = loadConfig({ SESSION_SECRET: 'k'.repeat(48), CRON_SECRET: 'cron-secret-value', AUTH_RATE_LIMIT: '1000', ...overrides });
  const store = new MemoryStore();
  const mailer = fakeMailer();
  const ai = fakeAi();
  const clock = () => NOW;
  const reminders = createReminderService({ store, mailer, ai, logger: silentLogger, clock });
  const app = createApp({ config, store, mailer, ai, reminders, logger: silentLogger, clock });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  return { server, store, mailer, base: `http://127.0.0.1:${server.address().port}` };
}

/** A minimal cookie-keeping client, one per simulated person. */
function client(base) {
  let cookie = '';
  const call = async (method, path, body, headers = {}) => {
    const response = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'kendra', ...(cookie && { Cookie: cookie }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const text = await response.text();
    return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null };
  };
  return {
    get: (p, h) => call('GET', p, undefined, h),
    post: (p, b, h) => call('POST', p, b, h),
    put: (p, b) => call('PUT', p, b),
    del: (p) => call('DELETE', p),
    get cookie() {
      return cookie;
    },
  };
}

const newCircle = { elderName: 'Kamala Rao', elderEmail: 'kamala@example.com', elderPin: '482913', sharePasscode: 'family-passcode', timezone: 'Asia/Kolkata' };
const metformin = { name: 'Metformin', dosage: '500 mg', instructions: 'After food', times: ['21:00', '08:00'], stock: 5, refillAt: 2 };

describe('HTTP API', () => {
  let ctx;
  before(async () => {
    ctx = await startServer();
  });
  after(() => ctx.server.close());

  test('health check and security headers', async () => {
    const res = await client(ctx.base).get('/healthz');
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'ok');
    assert.match(res.headers.get('content-security-policy'), /script-src 'self'/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-powered-by'), null);
  });

  test('serves the accessible frontend', async () => {
    const res = await fetch(`${ctx.base}/`);
    const html = await res.text();
    assert.equal(res.status, 200);
    assert.match(html, /<html lang="en">/);
    assert.match(html, /Skip to main content/);
  });

  test('state-changing requests require the CSRF header', async () => {
    const res = await fetch(`${ctx.base}/api/circles`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(newCircle) });
    assert.equal(res.status, 403);
  });

  test('protected routes reject anonymous and forged sessions', async () => {
    assert.equal((await client(ctx.base).get('/api/dashboard')).status, 401);
    assert.equal((await client(ctx.base).get('/api/dashboard', { Cookie: 'kendra_session=eyJjaWQiOiJ4In0.fake' })).status, 401);
  });

  test('validation rejects bad input and unknown fields', async () => {
    const c = client(ctx.base);
    const res = await c.post('/api/circles', { ...newCircle, elderPin: '12', role: 'admin' });
    assert.equal(res.status, 400);
    const paths = res.body.fields.map((f) => f.path);
    assert.ok(paths.includes('elderPin'));
    assert.ok(res.body.fields.some((f) => /Unrecognized key/.test(f.message)));
  });

  test('full care-circle journey: create, join, propose, approve, log doses', async () => {
    const elder = client(ctx.base);
    const created = await elder.post('/api/circles', newCircle);
    assert.equal(created.status, 201);
    assert.match(elder.cookie, /^kendra_session=/);
    const { code } = created.body.circle;
    assert.equal(created.body.circle.me.role, 'elder');
    assert.equal(JSON.stringify(created.body).includes('hash'), false, 'secrets must never be returned');

    // Elder adds a medicine directly.
    const med = await elder.post('/api/medications', metformin);
    assert.equal(med.status, 201);
    assert.deepEqual(med.body.item.times, ['08:00', '21:00']);
    const medId = med.body.item.id;

    // Caretaker joins with the shared passcode.
    const nurse = client(ctx.base);
    assert.equal((await nurse.post('/api/session', { role: 'caretaker', code, passcode: 'wrong-passcode', name: 'Ravi' })).status, 401);
    const joined = await nurse.post('/api/session', { role: 'caretaker', code: code.toLowerCase(), passcode: 'family-passcode', name: 'Ravi', email: 'ravi@example.com' });
    assert.equal(joined.status, 200);
    assert.equal(joined.body.circle.me.role, 'caretaker');

    // The caretaker's edit becomes a proposal; nothing changes yet.
    const proposed = await nurse.put(`/api/medications/${medId}`, { times: ['09:00'] });
    assert.equal(proposed.status, 202);
    assert.equal(proposed.body.applied, false);
    assert.equal((await nurse.post(`/api/proposals/${proposed.body.proposal.id}/decision`, { approve: true })).status, 403);

    // The elder approves, and the change is applied.
    const decided = await elder.post(`/api/proposals/${proposed.body.proposal.id}/decision`, { approve: true });
    assert.equal(decided.status, 200);
    assert.deepEqual(decided.body.item.times, ['09:00']);

    // 09:00 dose (NOW is 09:00 IST) can be logged by the caretaker; stock counts down and undo restores it.
    const dose = { medId, date: '2026-11-16', time: '09:00', status: 'taken' };
    assert.equal((await nurse.post('/api/doses', dose)).status, 200);
    let dashboard = await elder.get('/api/dashboard');
    assert.equal(dashboard.body.today[0].status, 'taken');
    assert.equal(dashboard.body.today[0].loggedBy, 'Ravi');
    assert.equal(dashboard.body.medications[0].stock, 4);

    assert.equal((await nurse.post('/api/doses', dose)).status, 200, 'logging twice is idempotent');
    assert.equal((await elder.get('/api/dashboard')).body.medications[0].stock, 4);

    assert.equal((await nurse.del(`/api/doses/${encodeURIComponent(`${medId}@2026-11-16@09:00`)}`)).status, 204);
    dashboard = await elder.get('/api/dashboard');
    assert.equal(dashboard.body.medications[0].stock, 5);
    assert.notEqual(dashboard.body.today[0].status, 'taken');

    // A later dose cannot be reported missed before it is due.
    await elder.post('/api/medications', { name: 'Atorvastatin', times: ['21:30'] });
    const atorvaId = (await elder.get('/api/dashboard')).body.medications.find((m) => m.name === 'Atorvastatin').id;
    const early = await elder.post('/api/doses', { medId: atorvaId, date: '2026-11-16', time: '21:30', status: 'missed' });
    assert.equal(early.status, 400);
    assert.match(early.body.error, /once it is due/);

    // Doses that are not on the schedule, or in the future, are rejected.
    assert.equal((await nurse.post('/api/doses', { ...dose, time: '10:00' })).status, 404);
    assert.equal((await nurse.post('/api/doses', { ...dose, date: '2026-11-17' })).status, 400);

    // Family can read but cannot manage the circle.
    const daughter = client(ctx.base);
    await daughter.post('/api/session', { role: 'family', code, passcode: 'family-passcode', name: 'Priya' });
    assert.equal((await daughter.put('/api/settings', { requireApproval: false })).status, 403);
    assert.equal((await daughter.post('/api/ai/brief/send')).status, 403);

    // Settings are validated: family must be alerted after caretakers.
    assert.equal((await elder.put('/api/settings', { escalatePrimaryMin: 90, escalateBackupMin: 60 })).status, 400);
    assert.equal((await elder.put('/api/settings', { escalatePrimaryMin: 20, escalateBackupMin: 45 })).status, 200);

    // Removing a member revokes their session immediately.
    const daughterId = (await elder.get('/api/dashboard')).body.circle.members.find((m) => m.role === 'family').id;
    assert.equal((await elder.del(`/api/members/${daughterId}`)).status, 204);
    assert.equal((await daughter.get('/api/dashboard')).status, 401);

    // Rotating the passcode signs out caretakers but not the elder.
    assert.equal((await elder.post('/api/circle/passcode', { sharePasscode: 'a-brand-new-passcode' })).status, 204);
    assert.equal((await nurse.get('/api/dashboard')).status, 401);
    assert.equal((await elder.get('/api/dashboard')).status, 200);

    // Appointments get a Google-Calendar-ready shape and an audit trail.
    const appt = await elder.post('/api/appointments', { doctor: 'Hegde', specialty: 'Cardiology', date: '2026-11-17', time: '10:30' });
    assert.equal(appt.status, 201);
    assert.equal(appt.body.item.status, 'upcoming');
    const activity = (await elder.get('/api/dashboard')).body.activity.map((a) => a.text);
    assert.ok(activity.some((t) => /Approved: update medication "Metformin"/.test(t)));
  });

  test('elder sign-in with PIN and brute-force lockout', async () => {
    const owner = client(ctx.base);
    const { code } = (await owner.post('/api/circles', { ...newCircle, elderPin: '111111' })).body.circle;
    const attacker = client(ctx.base);
    for (let i = 0; i < 8; i += 1) {
      assert.equal((await attacker.post('/api/session', { role: 'elder', code, pin: '000000' })).status, 401);
    }
    const locked = await attacker.post('/api/session', { role: 'elder', code, pin: '111111' });
    assert.equal(locked.status, 429);
    assert.match(locked.body.error, /Too many attempts/);
  });

  test('unknown circle codes return the same error as wrong passcodes', async () => {
    const res = await client(ctx.base).post('/api/session', { role: 'elder', code: 'ZZZZZZ', pin: '123456' });
    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'That circle code and passcode do not match.');
  });

  test('demo circle: role switching and immediate reminder ladder', async () => {
    const visitor = client(ctx.base);
    const demo = await visitor.post('/api/demo', { role: 'caretaker' });
    assert.equal(demo.status, 201);
    assert.equal(demo.body.circle.me.role, 'caretaker');
    const switched = await visitor.post('/api/demo/role', { role: 'elder' });
    assert.equal(switched.body.circle.me.role, 'elder');
    const dashboard = await visitor.get('/api/dashboard');
    assert.ok(dashboard.body.proposals.some((p) => p.status === 'pending'));
    assert.ok(dashboard.body.notifications.length > 0);
    assert.ok(dashboard.body.notifications.every((n) => n.status === 'simulated'));
  });

  test('AI endpoints: prescription drafts and care brief', async () => {
    const elder = client(ctx.base);
    await elder.post('/api/circles', newCircle);
    assert.equal((await elder.post('/api/ai/prescription', { mimeType: 'image/gif', data: 'x'.repeat(200) })).status, 400);
    const scan = await elder.post('/api/ai/prescription', { mimeType: 'image/png', data: 'A'.repeat(400) });
    assert.equal(scan.status, 200);
    assert.equal(scan.body.medications[0].name, 'Paracetamol');
    const brief = await elder.get('/api/ai/brief');
    assert.equal(brief.body.brief.headline, 'A steady week');
    const sent = await elder.post('/api/ai/brief/send');
    assert.equal(sent.body.status, 'sent');
    assert.ok(ctx.mailer.sent.some((m) => m.subject.startsWith('Care brief for Kamala Rao')));
  });

  test('cron tick requires the shared secret', async () => {
    const c = client(ctx.base);
    assert.equal((await c.post('/api/cron/tick', {})).status, 404);
    assert.equal((await c.post('/api/cron/tick', {}, { 'X-Cron-Secret': 'nope' })).status, 404);
    const ok = await c.post('/api/cron/tick', {}, { 'X-Cron-Secret': 'cron-secret-value' });
    assert.equal(ok.status, 200);
    assert.equal(typeof ok.body.circles, 'number');
  });

  test('sign-in endpoints are rate limited per IP', async () => {
    const limited = await startServer({ AUTH_RATE_LIMIT: '3' });
    try {
      const c = client(limited.base);
      const attempts = [];
      for (let i = 0; i < 4; i += 1) attempts.push((await c.post('/api/session', { role: 'elder', code: 'ZZZZZZ', pin: '123456' })).status);
      assert.deepEqual(attempts, [401, 401, 401, 429]);
    } finally {
      limited.server.close();
    }
  });

  test('unknown API routes reveal nothing without a session', async () => {
    const res = await client(ctx.base).get('/api/does-not-exist');
    assert.equal(res.status, 401); // authentication is checked before routing leaks anything
  });

  test('care continuity over HTTP: report missed, acknowledge, handover, tasks, responders', async () => {
    const elder = client(ctx.base);
    const { code, id: circleId } = (await elder.post('/api/circles', newCircle)).body.circle;
    const medId = (await elder.post('/api/medications', { ...metformin, times: ['08:00'], startDate: '2026-11-16' })).body.item.id;
    // Backdate creation so the 08:00 dose existed before "now" (09:00 on the fake clock).
    await ctx.store.update(circleId, (c) => {
      c.medications[0].createdAt = '2026-11-15T00:00:00.000Z';
    });
    const nurse = client(ctx.base);
    await nurse.post('/api/session', { role: 'caretaker', code, passcode: 'family-passcode', name: 'Ravi', email: 'ravi@example.com' });
    const daughter = client(ctx.base);
    await daughter.post('/api/session', { role: 'family', code, passcode: 'family-passcode', name: 'Priya', email: 'priya@example.com' });

    // 08:00 dose at 09:00 is unconfirmed (not missed) and caregivers can see it.
    let dash = await nurse.get('/api/dashboard');
    assert.equal(dash.body.today[0].status, 'unconfirmed');
    assert.equal(dash.body.care.slots[0].openDoses[0], 'Metformin');

    // Elder cannot acknowledge; caretaker can, once.
    assert.equal((await elder.post('/api/alerts/acknowledge', { slot: '2026-11-16T08:00' })).status, 403);
    const ack = await nurse.post('/api/alerts/acknowledge', { slot: '2026-11-16T08:00', note: 'Called her' });
    assert.equal(ack.status, 200);
    assert.equal((await daughter.post('/api/alerts/acknowledge', { slot: '2026-11-16T08:00' })).status, 409);
    assert.equal((await nurse.post('/api/alerts/acknowledge', { slot: 'not-a-slot' })).status, 400);
    dash = await elder.get('/api/dashboard');
    assert.equal(dash.body.care.slots[0].state, 'caregiver_acknowledged');

    // Explicit missed report with a note.
    const missed = await elder.post('/api/doses', { medId, date: '2026-11-16', time: '08:00', status: 'missed', note: 'Felt nauseous' });
    assert.equal(missed.status, 200);
    dash = await elder.get('/api/dashboard');
    assert.equal(dash.body.today[0].status, 'missed');
    assert.equal(dash.body.care.slots[0].state, 'reported_missed');

    // Tasks, notes, handover with live snapshot, acknowledgement by the addressee only.
    const daughterId = dash.body.circle.members.find((m) => m.role === 'family').id;
    const task = await nurse.post('/api/tasks', { title: 'Book transport', assigneeId: daughterId });
    assert.equal(task.status, 201);
    assert.equal((await daughter.put(`/api/tasks/${task.body.task.id}`, { status: 'done' })).body.task.status, 'done');
    assert.equal((await nurse.post('/api/notes', { text: 'BP diary updated' })).status, 201);
    const handover = await nurse.post('/api/handovers', { toId: daughterId, note: 'Evening is yours' });
    assert.equal(handover.status, 201);
    assert.deepEqual(handover.body.handover.snapshot.reportedMissed, ['08:00 Metformin']);
    assert.equal((await elder.post(`/api/handovers/${handover.body.handover.id}/acknowledge`)).status, 403);
    assert.equal((await daughter.post(`/api/handovers/${handover.body.handover.id}/acknowledge`)).status, 200);

    // Only the elder assigns escalation roles.
    const nurseId = dash.body.circle.members.find((m) => m.role === 'caretaker').id;
    assert.equal((await daughter.put(`/api/members/${nurseId}/responder`, { responder: 'backup' })).status, 403);
    assert.equal((await elder.put(`/api/members/${nurseId}/responder`, { responder: 'backup' })).status, 204);
    assert.equal((await elder.get('/api/dashboard')).body.circle.members.find((m) => m.id === nurseId).responder, 'backup');

    // Settings enforce follow-up < primary < backup.
    assert.equal((await elder.put('/api/settings', { followupMin: 40, escalatePrimaryMin: 30 })).status, 400);
  });

  test('emergency card: elder-only editing, QR link, limited public view, revoke', async () => {
    const elder = client(ctx.base);
    const { code } = (await elder.post('/api/circles', newCircle)).body.circle;
    const family = client(ctx.base);
    await family.post('/api/session', { role: 'family', code, passcode: 'family-passcode', name: 'Priya' });

    const card = { contacts: [{ name: 'Priya', phone: '+91 90000 00001', relation: 'Daughter' }], allergies: 'Penicillin', bloodGroup: 'B+' };
    assert.equal((await family.put('/api/emergency', card)).status, 403);
    assert.equal((await elder.put('/api/emergency', { ...card, contacts: [{ name: 'X', phone: 'call me maybe' }] })).status, 400);
    assert.equal((await elder.put('/api/emergency', card)).status, 200);

    assert.equal((await family.post('/api/emergency/shares', { hours: 24 })).status, 403);
    const share = await elder.post('/api/emergency/shares', { hours: 24 });
    assert.equal(share.status, 201);
    assert.match(share.body.qrSvg, /^<svg/);
    assert.equal(share.body.share.secretHash, undefined);
    const token = share.body.url.split('/e/')[1];

    const publicView = await fetch(`${ctx.base}/api/public/emergency/${token}`);
    const body = await publicView.json();
    assert.equal(publicView.status, 200);
    assert.equal(body.card.allergies, 'Penicillin');
    assert.equal(body.card.contacts[0].phone, '+91 90000 00001');
    assert.equal(JSON.stringify(body).includes('kamala@example.com'), false);
    assert.equal((await fetch(`${ctx.base}/e/${token}`)).status, 200);

    assert.equal((await fetch(`${ctx.base}/api/public/emergency/${token.slice(0, -2)}xx`)).status, 404);
    assert.equal((await elder.del(`/api/emergency/shares/${share.body.share.id}`)).status, 204);
    assert.equal((await fetch(`${ctx.base}/api/public/emergency/${token}`)).status, 404);
    const views = (await elder.get('/api/dashboard')).body.emergency.shares[0].views;
    assert.equal(views, 1);
  });

  test('companion and daily brief answer from the signed-in circle only', async () => {
    const elder = client(ctx.base);
    await elder.post('/api/circles', newCircle);
    await elder.post('/api/appointments', { doctor: 'Hegde', date: '2026-11-17', time: '10:30' });
    const en = await elder.post('/api/ai/companion', { text: 'When is my next doctor appointment?' });
    assert.equal(en.status, 200);
    assert.equal(en.body.source, 'records');
    assert.match(en.body.answer, /Dr\. Hegde/);
    const kn = await elder.post('/api/ai/companion', { text: 'ನನ್ನ ಮುಂದಿನ ಡಾಕ್ಟರ್ ಅಪಾಯಿಂಟ್ಮೆಂಟ್ ಯಾವಾಗ?' });
    assert.equal(kn.body.language, 'kn');
    assert.equal((await elder.post('/api/ai/companion', { text: '' })).status, 400);
    assert.equal((await client(ctx.base).post('/api/ai/companion', { text: 'hi' })).status, 401);

    const daily = await elder.get('/api/ai/daily-brief');
    assert.equal(daily.status, 200);
    assert.equal(daily.body.facts.appointments[0].doctor, 'Hegde');
    const sent = await elder.post('/api/ai/brief/send', { period: 'daily' });
    assert.equal(sent.body.status, 'sent');
    assert.ok(ctx.mailer.sent.some((m) => m.subject.startsWith('Daily care brief') && m.text.includes('Facts from the records')));
  });

  test('PIN recovery: emailed one-time code, no enumeration, limited attempts, old sessions revoked', async () => {
    const elder = client(ctx.base);
    const { code } = (await elder.post('/api/circles', { ...newCircle, elderPin: '135790' })).body.circle;
    const visitor = client(ctx.base);

    // Same response for real and unknown circles.
    const unknown = await visitor.post('/api/session/recover', { code: 'ZZZZZZ' });
    const known = await visitor.post('/api/session/recover', { code });
    assert.equal(unknown.status, 202);
    assert.deepEqual(unknown.body, known.body);

    const mail = ctx.mailer.sent.findLast((m) => m.subject === 'Your Kendra PIN reset code');
    assert.ok(mail, 'code emailed to the elder');
    assert.deepEqual(mail.to.map((r) => r.email), ['kamala@example.com']);
    const otp = mail.text.match(/\b(\d{6})\b/)[1];

    // The code is never stored in plain text.
    const circleId = await ctx.store.findIdByCode(code);
    assert.equal(JSON.stringify(await ctx.store.get(circleId)).includes(otp), false);

    // Wrong code fails; right code resets the PIN, signs in, and revokes the old elder session.
    const wrong = otp === '000000' ? '111111' : '000000';
    assert.equal((await visitor.post('/api/session/recover/verify', { code, otp: wrong, newPin: '246802' })).status, 401);
    const ok = await visitor.post('/api/session/recover/verify', { code, otp, newPin: '246802' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.circle.me.role, 'elder');
    assert.equal((await elder.get('/api/dashboard')).status, 401, 'old elder session revoked');
    assert.equal((await client(ctx.base).post('/api/session', { role: 'elder', code, pin: '135790' })).status, 401);
    assert.equal((await client(ctx.base).post('/api/session', { role: 'elder', code, pin: '246802' })).status, 200);

    // A used code cannot be replayed.
    assert.equal((await visitor.post('/api/session/recover/verify', { code, otp, newPin: '111111' })).status, 401);
  });

  test('PIN recovery locks after 5 wrong codes', async () => {
    const owner = client(ctx.base);
    const { code } = (await owner.post('/api/circles', newCircle)).body.circle;
    await owner.post('/api/session/recover', { code });
    const otp = ctx.mailer.sent.findLast((m) => m.subject === 'Your Kendra PIN reset code').text.match(/\b(\d{6})\b/)[1];
    const wrong = otp === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i += 1) await owner.post('/api/session/recover/verify', { code, otp: wrong, newPin: '222222' });
    assert.equal((await owner.post('/api/session/recover/verify', { code, otp, newPin: '222222' })).status, 401, 'correct code refused after 5 failures');
  });
});
