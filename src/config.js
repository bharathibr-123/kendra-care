'use strict';

const crypto = require('node:crypto');

/**
 * Centralised, validated runtime configuration.
 * Every environment variable the app reads is declared here and nowhere else.
 */

function int(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function loadConfig(env = process.env) {
  const isProduction = env.NODE_ENV === 'production';

  let sessionSecret = env.SESSION_SECRET;
  if (!sessionSecret || sessionSecret.length < 32) {
    if (isProduction) {
      throw new Error('SESSION_SECRET must be set to at least 32 characters in production.');
    }
    // Development only: an ephemeral secret means sessions reset on restart.
    sessionSecret = crypto.randomBytes(48).toString('hex');
  }

  return Object.freeze({
    isProduction,
    port: int(env.PORT, 8080),
    sessionSecret,
    sessionTtlHours: int(env.SESSION_TTL_HOURS, 12),
    defaultTimezone: env.DEFAULT_TIMEZONE || 'Asia/Kolkata',
    publicUrl: (env.PUBLIC_URL || '').replace(/\/$/, ''),
    cronSecret: env.CRON_SECRET || '',
    // Sign-in, demo and PIN-recovery requests allowed per IP per 15 minutes.
    authRateLimit: int(env.AUTH_RATE_LIMIT, 30),
    // Every stage window is at least 5 minutes wide, so a 2-minute tick never skips a reminder.
    schedulerIntervalMs: int(env.SCHEDULER_INTERVAL_MS, 120_000),
    gemini: Object.freeze({
      apiKey: env.GEMINI_API_KEY || '',
      model: env.GEMINI_MODEL || 'gemini-2.5-flash',
      timeoutMs: int(env.GEMINI_TIMEOUT_MS, 20_000),
    }),
    smtp: Object.freeze({
      host: env.SMTP_HOST || 'smtp.gmail.com',
      port: int(env.SMTP_PORT, 465),
      user: env.SMTP_USER || '',
      pass: env.SMTP_PASS || '',
      from: env.MAIL_FROM || env.SMTP_USER || '',
    }),
    firestore: Object.freeze({
      // Either paste the whole downloaded service-account JSON into one variable...
      serviceAccount: (env.FIREBASE_SERVICE_ACCOUNT || '').trim(),
      // ...or provide the three fields separately.
      projectId: env.FIREBASE_PROJECT_ID || '',
      clientEmail: env.FIREBASE_CLIENT_EMAIL || '',
      // Private keys pasted into dashboards usually arrive with escaped newlines.
      privateKey: (env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    }),
  });
}

module.exports = { loadConfig };
