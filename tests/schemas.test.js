'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const schemas = require('../src/http/schemas');

describe('request schemas', () => {
  test('partial updates never inject defaults into untouched fields', () => {
    // Regression: pausing a medicine must not wipe its weekday selection.
    assert.deepEqual(schemas.medicationUpdate.parse({ active: false }), { active: false });
    assert.deepEqual(schemas.appointmentUpdate.parse({ status: 'done' }), { status: 'done' });
  });

  test('creation fills safe defaults and normalises times', () => {
    const med = schemas.medicationCreate.parse({ name: ' Metformin ', times: ['21:00', '08:00', '08:00'] });
    assert.equal(med.name, 'Metformin');
    assert.deepEqual(med.times, ['08:00', '21:00']);
    assert.deepEqual(med.days, []);
    assert.equal(med.active, true);
  });

  test('rejects impossible dates, bad times, reversed ranges and extra fields', () => {
    assert.throws(() => schemas.appointmentCreate.parse({ doctor: 'A', date: '2026-02-30', time: '10:00' }));
    assert.throws(() => schemas.medicationCreate.parse({ name: 'X', times: ['24:00'] }));
    assert.throws(() => schemas.medicationCreate.parse({ name: 'X', times: ['08:00'], startDate: '2026-11-20', endDate: '2026-11-01' }));
    assert.throws(() => schemas.medicationUpdate.parse({ id: 'med_hijack000000' }));
  });

  test('login shapes differ for elder (PIN) and others (passcode)', () => {
    assert.equal(schemas.login.parse({ role: 'elder', code: 'abcdef', pin: '123456' }).code, 'ABCDEF');
    assert.throws(() => schemas.login.parse({ role: 'elder', code: 'ABCDEF', passcode: 'longenough' }));
    assert.throws(() => schemas.login.parse({ role: 'admin', code: 'ABCDEF', passcode: 'longenough', name: 'X' }));
  });

  test('prescription uploads are limited to safe image types', () => {
    assert.throws(() => schemas.prescriptionImage.parse({ mimeType: 'image/svg+xml', data: 'A'.repeat(200) }));
    assert.throws(() => schemas.prescriptionImage.parse({ mimeType: 'image/png', data: '<script>'.repeat(30) }));
  });
});
