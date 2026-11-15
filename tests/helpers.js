'use strict';

const { DEFAULT_SETTINGS, withDefaults, defaultResponder } = require('../src/domain/circle');

/** 2026-11-16 09:00 in Asia/Kolkata (a Monday). */
const NOW = new Date('2026-11-16T03:30:00Z');
const TZ = 'Asia/Kolkata';

/** Returns a Date `minutes` after NOW. */
const at = (minutes) => new Date(NOW.getTime() + minutes * 60_000);

function member(role, overrides = {}) {
  return { id: `mbr_${role}00000000`, name: role[0].toUpperCase() + role.slice(1), email: `${role}@example.com`, role, notify: true, responder: defaultResponder(role), tokenVersion: 0, joinedAt: NOW.toISOString(), ...overrides };
}

function makeCircle(overrides = {}) {
  return withDefaults({
    id: 'cir_test00000000',
    code: 'ABCDEF',
    demo: false,
    createdAt: '2026-11-01T00:00:00.000Z',
    timezone: TZ,
    elder: { name: 'Kamala' },
    security: { passcodeVersion: 0, failedAttempts: 0, lockedUntil: null },
    settings: { ...DEFAULT_SETTINGS },
    members: [member('elder'), member('caretaker'), member('family')],
    medications: [
      { id: 'med_metformin0001', name: 'Metformin', dosage: '500 mg', instructions: 'After food', times: ['08:00', '21:00'], days: [], startDate: '2026-11-01', endDate: null, stock: 10, refillAt: 3, active: true, createdAt: '2026-11-01T00:00:00.000Z' },
    ],
    appointments: [],
    doseLog: [],
    proposals: [],
    notifications: [],
    activity: [],
    ...overrides,
  });
}

function fakeMailer() {
  const sent = [];
  return {
    mode: 'smtp',
    sent,
    async send(message) {
      sent.push(message);
      return message.simulate ? { delivered: false, mode: 'simulated' } : { delivered: true, mode: 'smtp' };
    },
  };
}

function fakeAi(overrides = {}) {
  return {
    enabled: false,
    async extractPrescription() {
      return { available: true, medications: [{ name: 'Paracetamol', dosage: '650 mg', instructions: '', times: ['08:00', '20:00'], frequency: 'BD' }], warnings: [] };
    },
    async classifyIntent() {
      return null;
    },
    async writeDailyBrief(facts) {
      return { greeting: `Good morning, ${facts.elderName}`, summary: 'Facts only.', attention: [], source: 'rules' };
    },
    async writeCareBrief() {
      return { headline: 'A steady week', summary: 'All good.', wins: [], watch: [], questionsForDoctor: [], source: 'rules' };
    },
    ...overrides,
  };
}

const silentLogger = { info() {}, warn() {}, error() {} };

module.exports = { NOW, TZ, at, member, makeCircle, fakeMailer, fakeAi, silentLogger };
