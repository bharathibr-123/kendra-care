'use strict';

/** Minimal structured (JSON-lines) logger: easy to read in Render / Cloud Logging. */
function createLogger({ silent = false } = {}) {
  const write = (level, event, fields = {}) => {
    if (silent) return;
    const line = JSON.stringify({ time: new Date().toISOString(), level, event, ...fields });
    (level === 'error' ? process.stderr : process.stdout).write(`${line}\n`);
  };
  return {
    info: (event, fields) => write('info', event, fields),
    warn: (event, fields) => write('warn', event, fields),
    error: (event, fields) => write('error', event, fields),
  };
}

module.exports = { createLogger };
