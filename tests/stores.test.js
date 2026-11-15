'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { FirestoreStore, toDocument, resolveCredentials } = require('../src/data/firestoreStore');
const { HybridStore } = require('../src/data/hybridStore');
const { MemoryStore } = require('../src/data/memoryStore');
const { makeCircle } = require('./helpers');

/** Minimal in-memory Firestore double. Like the real service, it rejects `undefined` values. */
function fakeFirestore() {
  const docs = new Map();
  const stats = { reads: 0, writes: 0 };
  const assertNoUndefined = (value, path = 'doc') => {
    if (value === undefined) throw new Error(`Cannot use "undefined" as a Firestore value (found in field "${path}")`);
    if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) assertNoUndefined(v, `${path}.${k}`);
  };
  const snapshot = (id) => ({ id, exists: docs.has(id), data: () => structuredClone(docs.get(id)) });
  const query = (filter) => ({
    limit: () => query(filter),
    select: () => ({
      get: async () => {
        const matches = [...docs.entries()].filter(([, d]) => !filter || d[filter.field] === filter.value).map(([id]) => ({ id }));
        stats.reads += matches.length;
        return { empty: matches.length === 0, docs: matches };
      },
    }),
  });
  const write = (id, data) => {
    assertNoUndefined(data);
    stats.writes += 1;
    docs.set(id, structuredClone(data));
  };
  const collection = {
    doc: (id) => ({
      id,
      get: async () => {
        stats.reads += 1;
        return snapshot(id);
      },
      create: async (data) => {
        if (docs.has(id)) throw new Error('ALREADY_EXISTS');
        write(id, data);
      },
      delete: async () => docs.delete(id),
    }),
    where: (field, _op, value) => query({ field, value }),
    select: () => query(null).select(),
  };
  return {
    stats,
    docs,
    collection: () => collection,
    runTransaction: async (fn) =>
      fn({
        get: async (ref) => {
          stats.reads += 1;
          return snapshot(ref.id);
        },
        set: (ref, data) => write(ref.id, data),
      }),
  };
}

describe('Firestore adapter', () => {
  test('stores circles containing optional undefined fields (real Firestore rejects them)', async () => {
    const db = fakeFirestore();
    const store = new FirestoreStore(db);
    const circle = makeCircle();
    circle.proposals.push({ id: 'prp_test00000001', entity: 'medication', action: 'create', targetId: undefined, data: { name: 'X' }, status: 'pending' });
    await store.create(circle);
    await store.update(circle.id, (c) => {
      c.medications[0].endDate = undefined;
      c.activity.push({ text: 'changed' });
    });
    const saved = await store.get(circle.id);
    assert.equal(saved.proposals[0].targetId, undefined);
    assert.equal(saved.version, 2);
    assert.equal(await store.findIdByCode('ABCDEF'), circle.id);
    assert.deepEqual(await store.listIds(), [circle.id]);
  });

  test('skips the write when an update changes nothing (quota-friendly scheduler ticks)', async () => {
    const db = fakeFirestore();
    const store = new FirestoreStore(db);
    await store.create(makeCircle());
    const writesBefore = db.stats.writes;
    await store.update('cir_test00000000', () => 'no-op');
    assert.equal(db.stats.writes, writesBefore);
    await store.update('cir_test00000000', (c) => {
      c.elder.name = 'Kamala R';
    });
    assert.equal(db.stats.writes, writesBefore + 1);
  });

  test('rejects duplicate circle codes and reports missing circles', async () => {
    const store = new FirestoreStore(fakeFirestore());
    await store.create(makeCircle());
    await assert.rejects(store.create(makeCircle({ id: 'cir_other0000000' })), /collision/);
    await assert.rejects(store.update('cir_missing000000', () => {}), /not found/);
    await store.delete('cir_test00000000');
    assert.equal(await store.get('cir_test00000000'), null);
  });

  test('toDocument strips undefined and keeps plain data', () => {
    assert.deepEqual(toDocument({ a: 1, b: undefined, c: [{ d: undefined, e: 'x' }] }), { a: 1, c: [{ e: 'x' }] });
  });

  test('credentials come from one JSON variable or three separate ones', () => {
    const json = JSON.stringify({ project_id: 'kendra-care', client_email: 'svc@kendra.iam.gserviceaccount.com', private_key: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n' });
    assert.deepEqual(resolveCredentials({ serviceAccount: json }), { projectId: 'kendra-care', clientEmail: 'svc@kendra.iam.gserviceaccount.com', privateKey: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n' });
    assert.equal(resolveCredentials({ projectId: 'p', clientEmail: 'e', privateKey: 'k' }).projectId, 'p');
    assert.equal(resolveCredentials({}), null);
    assert.throws(() => resolveCredentials({ serviceAccount: '{not json' }), /not valid JSON/);
  });
});

describe('hybrid store', () => {
  test('demo circles stay in memory; real circles persist in Firestore', async () => {
    const db = fakeFirestore();
    const store = new HybridStore({ persistent: new FirestoreStore(db), ephemeral: new MemoryStore() });
    await store.create(makeCircle({ id: 'cir_demo00000000', code: 'DEMO22', demo: true }));
    await store.create(makeCircle({ id: 'cir_real00000000', code: 'REAL22' }));

    assert.deepEqual([...db.docs.keys()], ['cir_real00000000'], 'only the real circle reaches Firestore');
    assert.equal((await store.listIds()).length, 2);
    assert.equal(await store.findIdByCode('DEMO22'), 'cir_demo00000000');
    assert.equal(await store.findIdByCode('REAL22'), 'cir_real00000000');

    await store.update('cir_demo00000000', (c) => {
      c.elder.name = 'Demo';
    });
    await store.update('cir_real00000000', (c) => {
      c.elder.name = 'Real';
    });
    assert.equal((await store.get('cir_demo00000000')).elder.name, 'Demo');
    assert.equal(db.docs.get('cir_real00000000').elder.name, 'Real');

    await store.delete('cir_demo00000000');
    assert.equal(await store.get('cir_demo00000000'), null);
    assert.equal(store.kind, 'firestore+memory-demo');
  });
});
