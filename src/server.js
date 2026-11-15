'use strict';

const { loadConfig } = require('./config');
const { createLogger } = require('./logger');
const { createStore } = require('./data');
const { createMailer } = require('./services/mailer');
const { createAiService } = require('./services/ai');
const { createReminderService } = require('./services/reminderService');
const { createApp } = require('./app');

function main() {
  const logger = createLogger();
  const config = loadConfig();
  const store = createStore(config, logger);
  const mailer = createMailer(config, logger);
  const ai = createAiService(config, logger);
  const reminders = createReminderService({ store, mailer, ai, logger });
  const app = createApp({ config, store, mailer, ai, reminders, logger });

  const server = app.listen(config.port, () => {
    logger.info('server.started', { port: config.port, ai: ai.enabled ? ai.model : 'rules-only', mail: mailer.mode });
  });
  const stopScheduler = reminders.start(config.schedulerIntervalMs);

  const shutdown = (signal) => {
    logger.info('server.stopping', { signal });
    stopScheduler();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main();
