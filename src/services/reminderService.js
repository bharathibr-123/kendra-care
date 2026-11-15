'use strict';

const { planNotifications } = require('../domain/reminders');
const { pruneCircle, isExpiredDemo } = require('../domain/circle');
const { buildBriefFacts, briefToText } = require('./insights');
const { buildRuleBasedBrief } = require('./ai');

const MAX_NOTIFICATIONS_KEPT = 300;

/**
 * Executes the escalation engine for every circle. Delivery is "reserve, send, confirm":
 * notifications are first reserved inside an atomic update (so two overlapping ticks
 * cannot both claim one), then sent, then their delivery status is recorded.
 */
function createReminderService({ store, mailer, ai, logger, clock = () => new Date() }) {
  let running = false;

  async function processCircle(id, now) {
    const reserved = await store.update(id, (circle) => {
      if (isExpiredDemo(circle, now)) return { expired: true, intents: [] };
      pruneCircle(circle, now);
      const intents = planNotifications(circle, now);
      const at = now.toISOString();
      for (const intent of intents) {
        circle.notifications.unshift({
          key: intent.key,
          type: intent.type,
          stage: intent.stage,
          subject: intent.subject,
          recipients: intent.recipients.map((r) => `${r.name} (${r.role})`),
          at,
          status: 'sending',
        });
      }
      circle.notifications.length = Math.min(circle.notifications.length, MAX_NOTIFICATIONS_KEPT);
      return { intents, demo: Boolean(circle.demo), snapshot: intents.some((i) => i.type === 'brief') ? structuredClone(circle) : null };
    });

    if (reserved.expired) {
      await store.delete(id);
      return 0;
    }
    if (reserved.intents.length === 0) return 0;

    const outcomes = new Map();
    for (const intent of reserved.intents) {
      let { subject, text } = intent;
      if (intent.type === 'brief') {
        const facts = buildBriefFacts(reserved.snapshot, now);
        // Demo emails are simulated, so skip the model call and keep demo start-up instant.
        const brief = reserved.demo ? buildRuleBasedBrief(facts) : await ai.writeCareBrief(facts);
        text = briefToText(brief);
        subject = `${subject}: ${brief.headline}`;
      }
      const result = await mailer.send({ to: intent.recipients, subject, text, simulate: reserved.demo });
      outcomes.set(intent.key, result.delivered ? 'sent' : result.mode === 'smtp' ? 'failed' : 'simulated');
    }

    await store.update(id, (circle) => {
      for (const note of circle.notifications) {
        if (outcomes.has(note.key)) note.status = outcomes.get(note.key);
      }
    });
    return reserved.intents.length;
  }

  async function tick() {
    if (running) return { skipped: true };
    running = true;
    const now = clock();
    let sent = 0;
    let circles = 0;
    try {
      for (const id of await store.listIds()) {
        circles += 1;
        try {
          sent += await processCircle(id, now);
        } catch (error) {
          logger.error('reminders.circle_failed', { circleId: id, message: error.message });
        }
      }
      if (sent > 0) logger.info('reminders.tick', { circles, notifications: sent });
      return { circles, notifications: sent };
    } finally {
      running = false;
    }
  }

  function start(intervalMs) {
    const timer = setInterval(() => {
      tick().catch((error) => logger.error('reminders.tick_failed', { message: error.message }));
    }, intervalMs);
    timer.unref();
    return () => clearInterval(timer);
  }

  return { tick, start, processCircle };
}

module.exports = { createReminderService };
