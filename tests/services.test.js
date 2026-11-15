'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { createAiService, buildRuleBasedBrief } = require('../src/services/ai');
const { hashSecret, verifySecret, generateCircleCode, CODE_ALPHABET } = require('../src/security/passcode');
const { createToken, verifyToken, parseCookies } = require('../src/security/session');
const { escapeHtml, renderHtml } = require('../src/services/mailer');
const { MemoryStore } = require('../src/data/memoryStore');
const { loadConfig } = require('../src/config');
const { buildBriefFacts } = require('../src/services/insights');
const { makeCircle, NOW, silentLogger } = require('./helpers');

const geminiConfig = (apiKey = 'test-key') => ({ gemini: { apiKey, model: 'gemini-test', timeoutMs: 1000 } });
const geminiReply = (payload) => async () => ({ ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }] }) });

describe('Gemini service', () => {
  test('prescription drafts get deterministic times from the frequency', async () => {
    let request;
    const fetchStub = async (url, options) => {
      request = { url, body: JSON.parse(options.body), headers: options.headers };
      return geminiReply({ medications: [{ name: 'Metformin', dosage: '500 mg', frequency: '1-0-1', instructions: 'after food' }] })();
    };
    const ai = createAiService(geminiConfig(), silentLogger, fetchStub);
    const result = await ai.extractPrescription({ data: 'aGVsbG8=', mimeType: 'image/png' });

    assert.deepEqual(result.medications[0].times, ['08:00', '21:00']);
    assert.match(request.url, /gemini-test:generateContent$/);
    assert.equal(request.headers['x-goog-api-key'], 'test-key');
    assert.equal(request.body.generationConfig.responseMimeType, 'application/json');
  });

  test('malformed model output is discarded safely', async () => {
    const ai = createAiService(geminiConfig(), silentLogger, geminiReply({ medications: 'DROP TABLE' }));
    const result = await ai.extractPrescription({ data: 'aGVsbG8=', mimeType: 'image/png' });
    assert.deepEqual(result.medications, []);
    assert.equal(result.warnings.length, 1);
  });

  test('care brief falls back to rules when Gemini fails or is not configured', async () => {
    const facts = buildBriefFacts(makeCircle(), NOW);
    const failing = createAiService(geminiConfig(), silentLogger, async () => ({ ok: false, status: 500 }));
    assert.equal((await failing.writeCareBrief(facts)).source, 'rules');
    const offline = createAiService(geminiConfig(''), silentLogger);
    assert.equal(offline.enabled, false);
    assert.equal((await offline.writeCareBrief(facts)).source, 'rules');
    assert.equal((await offline.extractPrescription({})).available, false);
  });

  test('care brief from Gemini is schema-validated', async () => {
    const ai = createAiService(geminiConfig(), silentLogger, geminiReply({ headline: 'Good week', summary: 'Well done.', wins: ['All morning doses'], watch: [], questionsForDoctor: [] }));
    const brief = await ai.writeCareBrief(buildBriefFacts(makeCircle(), NOW));
    assert.equal(brief.source, 'gemini');
    assert.equal(brief.headline, 'Good week');
  });

  test('rule-based brief highlights the weakest time of day', () => {
    const brief = buildRuleBasedBrief(buildBriefFacts(makeCircle(), NOW));
    assert.match(brief.watch.join(' '), /Morning doses went unconfirmed or were reported missed 7 times/);
    assert.match(brief.headline, /attention/);
  });
});

describe('security primitives', () => {
  test('passcodes are salted, hashed and verified', async () => {
    const record = await hashSecret('123456');
    assert.notEqual(record.hash, '123456');
    assert.notEqual((await hashSecret('123456')).salt, record.salt);
    assert.equal(await verifySecret('123456', record), true);
    assert.equal(await verifySecret('654321', record), false);
    assert.equal(await verifySecret('123456', null), false);
  });

  test('session tokens reject tampering and expiry', () => {
    const token = createToken({ cid: 'cir_1', mid: 'mbr_1' }, 'secret', 1);
    assert.equal(verifyToken(token, 'secret').cid, 'cir_1');
    assert.equal(verifyToken(token, 'other-secret'), null);
    const [body, sig] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ cid: 'cir_2', mid: 'mbr_1', exp: Date.now() + 1e6 })).toString('base64url');
    assert.equal(verifyToken(`${forged}.${sig}`, 'secret'), null);
    assert.equal(verifyToken(`${body}`, 'secret'), null);
    assert.equal(verifyToken(createToken({ cid: 'x' }, 'secret', -1), 'secret'), null);
  });

  test('cookie parsing and circle codes', () => {
    assert.deepEqual(parseCookies('a=1; kendra_session=abc%3D; bad'), { a: '1', kendra_session: 'abc=' });
    const code = generateCircleCode();
    assert.equal(code.length, 6);
    assert.ok([...code].every((c) => CODE_ALPHABET.includes(c)));
  });

  test('email HTML escapes user-provided content', () => {
    assert.equal(escapeHtml('<script>"x"</script>'), '&lt;script&gt;&quot;x&quot;&lt;/script&gt;');
    assert.doesNotMatch(renderHtml('<b>', '<img src=x onerror=alert(1)>', ''), /<img/);
  });

  test('production refuses to start without a strong session secret', () => {
    assert.throws(() => loadConfig({ NODE_ENV: 'production' }), /SESSION_SECRET/);
    assert.equal(loadConfig({ NODE_ENV: 'production', SESSION_SECRET: 'x'.repeat(32) }).isProduction, true);
  });
});

describe('memory store', () => {
  test('updates are atomic and serialised per circle', async () => {
    const store = new MemoryStore();
    await store.create(makeCircle({ activity: [] }));
    await Promise.all(Array.from({ length: 25 }, (_, i) => store.update('cir_test00000000', async (c) => {
      await new Promise((r) => setTimeout(r, Math.random() * 3));
      c.activity.push(i);
    })));
    const saved = await store.get('cir_test00000000');
    assert.equal(saved.activity.length, 25);
    assert.equal(saved.version, 26);
  });

  test('a failing mutator leaves the stored circle untouched', async () => {
    const store = new MemoryStore();
    await store.create(makeCircle());
    await assert.rejects(store.update('cir_test00000000', (c) => {
      c.medications = [];
      throw new Error('boom');
    }));
    assert.equal((await store.get('cir_test00000000')).medications.length, 1);
    assert.equal(await store.findIdByCode('ABCDEF'), 'cir_test00000000');
  });
});
