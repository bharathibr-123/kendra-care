'use strict';

const crypto = require('node:crypto');
const { ZodError } = require('zod');
const { HttpError } = require('./errors');
const { COOKIE_NAME, verifyToken, parseCookies } = require('../security/session');
const { can } = require('../domain/policy');

/** Wraps async route handlers so rejected promises reach the error handler. */
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function validate(schema, value) {
  return schema.parse(value);
}

/**
 * CSRF defence in depth: session cookies are SameSite=Strict, and every state-changing
 * API call must also carry a custom header, which cross-site forms cannot set.
 */
function requireCsrfHeader(req, _res, next) {
  const safe = ['GET', 'HEAD', 'OPTIONS'].includes(req.method);
  if (safe || req.get('X-Requested-With') === 'kendra') return next();
  return next(new HttpError(403, 'Missing request header.'));
}

/** Loads the session's circle and member; rejects stale or revoked sessions. */
function authenticate({ store, config }) {
  return asyncHandler(async (req, _res, next) => {
    const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
    const session = verifyToken(token, config.sessionSecret);
    if (!session) throw new HttpError(401, 'Please sign in to your care circle.');

    const circle = await store.get(session.cid);
    const member = circle?.members.find((m) => m.id === session.mid);
    // Rotating the shared passcode signs out caretakers and family, but not the elder (who uses a PIN).
    const passcodeRotated = member && member.role !== 'elder' && circle.security.passcodeVersion !== session.pv;
    if (!circle || !member || member.tokenVersion !== session.tv || passcodeRotated) {
      throw new HttpError(401, 'Your session has ended. Please sign in again.');
    }
    req.circle = circle;
    req.member = member;
    return next();
  });
}

function authorize(action) {
  return (req, _res, next) => {
    if (can(req.member, action, req.circle)) return next();
    return next(new HttpError(403, 'You do not have permission to do that.'));
  };
}

function notFound(_req, _res, next) {
  next(new HttpError(404, 'Not found.'));
}

function errorHandler(logger) {
  // Express recognises error handlers by their four-argument signature.
  return (error, req, res, _next) => {
    if (error instanceof ZodError) {
      return res.status(400).json({
        error: 'Please check the highlighted fields.',
        fields: error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
      });
    }
    if (error instanceof HttpError) {
      return res.status(error.status).json({ error: error.message, ...(error.details && { details: error.details }) });
    }
    if (error.type === 'entity.too.large') return res.status(413).json({ error: 'Upload is too large.' });
    if (error.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed JSON.' });

    const reference = crypto.randomUUID();
    logger.error('http.unhandled', { reference, path: req.path, message: error.message, stack: error.stack });
    return res.status(500).json({ error: 'Something went wrong. Please try again.', reference });
  };
}

module.exports = { asyncHandler, validate, requireCsrfHeader, authenticate, authorize, notFound, errorHandler };
