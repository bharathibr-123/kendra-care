'use strict';

const crypto = require('node:crypto');
const { promisify } = require('node:util');

const scrypt = promisify(crypto.scrypt);

/**
 * Passcodes are never stored in plain text. We use scrypt (memory-hard, built into
 * Node, no native add-on) with a per-secret random salt, and compare in constant time.
 */
const KEY_LENGTH = 64;
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

async function hashSecret(secret) {
  const salt = crypto.randomBytes(16);
  const derived = await scrypt(secret, salt, KEY_LENGTH, SCRYPT_OPTIONS);
  return { salt: salt.toString('base64'), hash: derived.toString('base64') };
}

async function verifySecret(secret, record) {
  if (!record || typeof secret !== 'string') return false;
  const expected = Buffer.from(record.hash, 'base64');
  const derived = await scrypt(secret, Buffer.from(record.salt, 'base64'), expected.length, SCRYPT_OPTIONS);
  return crypto.timingSafeEqual(derived, expected);
}

/** Circle codes avoid look-alike characters (0/O, 1/I/L) so elders can read them aloud. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function generateCircleCode(length = 6) {
  let code = '';
  for (let i = 0; i < length; i += 1) {
    code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  }
  return code;
}

function generateId(prefix) {
  return `${prefix}_${crypto.randomBytes(9).toString('base64url')}`;
}

module.exports = { hashSecret, verifySecret, generateCircleCode, generateId, CODE_ALPHABET };
