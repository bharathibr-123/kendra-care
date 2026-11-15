'use strict';

const { HttpError } = require('../http/errors');
const { withDefaults } = require('../domain/circle');

/**
 * In-memory repository for care circles. Each circle is stored as one aggregate
 * document, and all writes go through `update(id, mutator)`, which is serialised
 * per circle so concurrent requests can never interleave a read-modify-write.
 * The Firestore adapter implements the exact same interface.
 */
class MemoryStore {
  constructor() {
    this.circles = new Map();
    this.codeIndex = new Map();
    this.locks = new Map();
    this.kind = 'memory';
  }

  async create(circle) {
    if (this.codeIndex.has(circle.code)) throw new HttpError(409, 'Circle code collision.');
    this.circles.set(circle.id, structuredClone({ ...circle, version: 1 }));
    this.codeIndex.set(circle.code, circle.id);
    return structuredClone(circle);
  }

  async get(id) {
    const circle = this.circles.get(id);
    return circle ? withDefaults(structuredClone(circle)) : null;
  }

  async findIdByCode(code) {
    return this.codeIndex.get(code) ?? null;
  }

  async listIds() {
    return [...this.circles.keys()];
  }

  async delete(id) {
    const circle = this.circles.get(id);
    if (!circle) return;
    this.codeIndex.delete(circle.code);
    this.circles.delete(id);
  }

  /**
   * Runs `mutator(draft)` against a copy of the circle and commits it only if the
   * mutator finishes without throwing. Returns whatever the mutator returns.
   */
  async update(id, mutator) {
    const previous = this.locks.get(id) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => {
      release = resolve;
    });
    const chained = previous.then(() => current);
    this.locks.set(id, chained);

    await previous;
    try {
      const existing = this.circles.get(id);
      if (!existing) throw new HttpError(404, 'Care circle not found.');
      const before = JSON.stringify(existing);
      const draft = withDefaults(structuredClone(existing));
      const result = await mutator(draft);
      if (JSON.stringify({ ...draft, version: existing.version }) !== before) {
        draft.version = (existing.version || 0) + 1;
        this.circles.set(id, draft);
      }
      return result;
    } finally {
      release();
      if (this.locks.get(id) === chained) this.locks.delete(id);
    }
  }
}

module.exports = { MemoryStore };
