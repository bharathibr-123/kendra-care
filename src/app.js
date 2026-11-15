'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');

const { authRoutes } = require('./http/routes/auth');
const { careRoutes } = require('./http/routes/care');
const { aiRoutes } = require('./http/routes/ai');
const { coordinationRoutes } = require('./http/routes/coordination');
const { emergencyRoutes, publicEmergencyRoutes } = require('./http/routes/emergency');
const { requireCsrfHeader, authenticate, notFound, errorHandler, asyncHandler } = require('./http/middleware');
const { HttpError } = require('./http/errors');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

/**
 * Builds the Express application. All collaborators are injected, which lets the
 * test-suite run the real HTTP stack against an in-memory store, a fake clock,
 * a fake mailer and a stubbed AI service.
 */
function createApp({ config, store, mailer, ai, reminders, logger, clock = () => new Date() }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // Render / Cloud Run terminate TLS at a single proxy hop.

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          'default-src': ["'self'"],
          'script-src': ["'self'"],
          'style-src': ["'self'", 'https://fonts.googleapis.com'],
          'font-src': ["'self'", 'https://fonts.gstatic.com'],
          'img-src': ["'self'", 'data:', 'blob:'],
          'connect-src': ["'self'"],
          'frame-ancestors': ["'none'"],
          'form-action': ["'self'"],
          'object-src': ["'none'"],
          'upgrade-insecure-requests': config.isProduction ? [] : null,
        },
      },
      crossOriginEmbedderPolicy: false,
    }),
  );
  app.use((_req, res, next) => {
    res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=(), payment=()');
    next();
  });

  const limiterDefaults = { standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Too many requests. Please slow down.' } };
  const apiLimiter = rateLimit({ ...limiterDefaults, windowMs: 15 * 60_000, limit: 600 });
  const authLimiter = rateLimit({ ...limiterDefaults, windowMs: 15 * 60_000, limit: config.authRateLimit });
  const aiLimiter = rateLimit({ ...limiterDefaults, windowMs: 60 * 60_000, limit: 40 });

  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok', store: store.kind, ai: ai.enabled ? 'gemini' : 'rules', mail: mailer.mode });
  });

  const smallJson = express.json({ limit: '100kb' });
  app.use('/api', apiLimiter, (req, res, next) => (req.path === '/ai/prescription' ? next() : smallJson(req, res, next)));
  app.use('/api', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  // Scheduler trigger for hosts that sleep when idle (Render free tier, Cloud Scheduler, cron-job.org).
  app.post(
    '/api/cron/tick',
    asyncHandler(async (req, res) => {
      const provided = Buffer.from(req.get('X-Cron-Secret') || '');
      const expected = Buffer.from(config.cronSecret);
      if (!config.cronSecret || provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
        throw new HttpError(404, 'Not found.');
      }
      res.json(await reminders.tick());
    }),
  );

  const publicLimiter = rateLimit({ ...limiterDefaults, windowMs: 15 * 60_000, limit: 60 });
  app.use('/api', publicEmergencyRoutes({ store, clock, limiter: publicLimiter }));

  app.use('/api', requireCsrfHeader);
  app.use('/api', authRoutes({ store, config, clock, authLimiter, reminders, mailer }));

  const requireSession = authenticate({ store, config });
  app.use('/api/ai', requireSession, aiRoutes({ store, ai, mailer, clock, aiLimiter }));
  app.use('/api', requireSession, careRoutes({ store, clock, ai, mailer }));
  app.use('/api', requireSession, coordinationRoutes({ store, clock }));
  app.use('/api', requireSession, emergencyRoutes({ store, clock, config }));
  app.use('/api', notFound);

  app.use(express.static(PUBLIC_DIR, { index: 'index.html', maxAge: config.isProduction ? '1h' : 0 }));
  app.get('/e/:token', (_req, res) => {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.sendFile(path.join(PUBLIC_DIR, 'emergency.html'));
  });
  app.get('*', (req, res, next) => (req.accepts('html') ? res.sendFile(path.join(PUBLIC_DIR, 'index.html')) : next()));
  app.use(notFound);
  app.use(errorHandler(logger));

  return app;
}

module.exports = { createApp };
