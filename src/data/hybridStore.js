'use strict';

/**
 * Routes circles to the right backend:
 *  - demo circles live in memory (fictional, auto-expiring, high churn), so evaluators
 *    clicking "Try the demo" never consume the Firestore free-tier quota;
 *  - real circles live in the persistent store (Firestore).
 * Exposes the same repository interface as the stores it wraps.
 */
class HybridStore {
  constructor({ persistent, ephemeral }) {
    this.persistent = persistent;
    this.ephemeral = ephemeral;
    this.kind = `${persistent.kind}+${ephemeral.kind}-demo`;
  }

  async owner(id) {
    if (await this.ephemeral.get(id)) return this.ephemeral;
    return this.persistent;
  }

  create(circle) {
    return (circle.demo ? this.ephemeral : this.persistent).create(circle);
  }

  async get(id) {
    return (await this.ephemeral.get(id)) || this.persistent.get(id);
  }

  async findIdByCode(code) {
    return (await this.ephemeral.findIdByCode(code)) || this.persistent.findIdByCode(code);
  }

  async listIds() {
    const [demo, real] = await Promise.all([this.ephemeral.listIds(), this.persistent.listIds()]);
    return [...demo, ...real];
  }

  async delete(id) {
    return (await this.owner(id)).delete(id);
  }

  async update(id, mutator) {
    return (await this.owner(id)).update(id, mutator);
  }
}

module.exports = { HybridStore };
