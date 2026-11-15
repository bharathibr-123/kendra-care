'use strict';

const { HttpError } = require('../http/errors');
const { withDefaults } = require('../domain/circle');

const COLLECTION = 'circles';

/**
 * Firestore rejects `undefined` field values, and our domain objects legitimately carry
 * optional fields (e.g. a proposal without a targetId). A JSON round-trip drops them and
 * guarantees the stored document is plain data.
 */
function toDocument(circle) {
  return JSON.parse(JSON.stringify(circle));
}

/**
 * Parses credentials from either FIREBASE_SERVICE_ACCOUNT (the downloaded JSON, pasted
 * as one value) or the three separate FIREBASE_* variables. Returns null when absent.
 */
function resolveCredentials({ serviceAccount, projectId, clientEmail, privateKey }) {
  if (serviceAccount) {
    let parsed;
    try {
      parsed = JSON.parse(serviceAccount);
    } catch {
      throw new Error('FIREBASE_SERVICE_ACCOUNT is not valid JSON. Paste the whole downloaded key file.');
    }
    return { projectId: parsed.project_id, clientEmail: parsed.client_email, privateKey: parsed.private_key };
  }
  return projectId && clientEmail && privateKey ? { projectId, clientEmail, privateKey } : null;
}

/**
 * Google Cloud Firestore adapter (works on the free Firebase Spark plan).
 * Same interface as MemoryStore; `update` runs in a Firestore transaction so writes
 * from several server instances stay consistent.
 */
class FirestoreStore {
  constructor(firestore) {
    this.db = firestore;
    this.collection = firestore.collection(COLLECTION);
    this.kind = 'firestore';
  }

  static fromCredentials({ projectId, clientEmail, privateKey }) {
    // Loaded lazily so the dependency is only required when Firestore is configured.
    const { initializeApp, getApps, cert } = require('firebase-admin/app');
    const { getFirestore } = require('firebase-admin/firestore');
    const app = getApps()[0] || initializeApp({ credential: cert({ projectId, clientEmail, privateKey }) });
    return new FirestoreStore(getFirestore(app));
  }

  async create(circle) {
    if (await this.findIdByCode(circle.code)) throw new HttpError(409, 'Circle code collision.');
    await this.collection.doc(circle.id).create(toDocument({ ...circle, version: 1 }));
    return circle;
  }

  async get(id) {
    const snapshot = await this.collection.doc(id).get();
    return snapshot.exists ? withDefaults(snapshot.data()) : null;
  }

  async findIdByCode(code) {
    const result = await this.collection.where('code', '==', code).limit(1).select().get();
    return result.empty ? null : result.docs[0].id;
  }

  async listIds() {
    const result = await this.collection.select().get();
    return result.docs.map((doc) => doc.id);
  }

  async delete(id) {
    await this.collection.doc(id).delete();
  }

  async update(id, mutator) {
    const ref = this.collection.doc(id);
    return this.db.runTransaction(async (tx) => {
      const snapshot = await tx.get(ref);
      if (!snapshot.exists) throw new HttpError(404, 'Care circle not found.');
      const before = JSON.stringify(toDocument(snapshot.data()));
      const draft = withDefaults(snapshot.data());
      const result = await mutator(draft);
      // Skip the write when nothing changed: most scheduler ticks are no-ops, and this
      // keeps a busy circle comfortably inside the free tier's daily write quota.
      if (JSON.stringify(toDocument(draft)) !== before) {
        draft.version = (draft.version || 0) + 1;
        tx.set(ref, toDocument(draft));
      }
      return result;
    });
  }
}

module.exports = { FirestoreStore, toDocument, resolveCredentials };
