'use strict';

const crypto = require('node:crypto');

/**
 * Stateless, tamper-proof session tokens: base64url(JSON payload) + "." + HMAC-SHA256.
 * The token only identifies a member; every request re-checks that the member still
 * exists and that their tokenVersion matches, so removing a member or rotating the
 * circle passcode revokes access immediately.
 */

const COOKIE_NAME = 'kendra_session';

function sign(data, secret) {
  return crypto.createHmac('sha256', secret).update(data).digest('base64url');
}

function createToken(payload, secret, ttlHours) {
  const body = Buffer.from(
    JSON.stringify({ ...payload, exp: Date.now() + ttlHours * 3_600_000 }),
  ).toString('base64url');
  return `${body}.${sign(body, secret)}`;
}

function verifyToken(token, secret) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, signature] = token.split('.');
  const expected = sign(body, secret);
  const a = Buffer.from(signature || '');
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

function parseCookies(header = '') {
  const cookies = {};
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) {
      try {
        cookies[key] = decodeURIComponent(value);
      } catch {
        cookies[key] = value;
      }
    }
  }
  return cookies;
}

function cookieOptions(config) {
  return {
    httpOnly: true,
    secure: config.isProduction,
    sameSite: 'strict',
    path: '/',
    maxAge: config.sessionTtlHours * 3_600_000,
  };
}

module.exports = { COOKIE_NAME, createToken, verifyToken, parseCookies, cookieOptions };
