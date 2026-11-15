'use strict';

const { MemoryStore } = require('./memoryStore');
const { FirestoreStore, resolveCredentials } = require('./firestoreStore');
const { HybridStore } = require('./hybridStore');

/**
 * Real circles go to Firestore when credentials are configured; demo circles always stay
 * in memory. Without credentials everything is in memory (and the logs say so).
 */
function createStore(config, logger) {
  try {
    const credentials = resolveCredentials(config.firestore);
    if (credentials) {
      const store = new HybridStore({ persistent: FirestoreStore.fromCredentials(credentials), ephemeral: new MemoryStore() });
      logger.info('store.ready', { kind: store.kind, projectId: credentials.projectId });
      return store;
    }
  } catch (error) {
    logger.error('store.firestore_failed', { message: error.message });
  }
  logger.warn('store.ready', { kind: 'memory', note: 'Data resets on restart. Configure Firestore for persistence.' });
  return new MemoryStore();
}

module.exports = { createStore, MemoryStore, HybridStore };
