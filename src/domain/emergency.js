'use strict';

const crypto = require('node:crypto');
const { generateId } = require('../security/passcode');
const { HttpError } = require('../http/errors');
const { recordActivity } = require('./changes');

/**
 * Emergency card with consent-based, expiring access.
 *
 * The elder decides what goes on the card and creates time-limited share links
 * (shown as a QR code). The link holds a random 256-bit secret; only its SHA-256
 * hash is stored, so a database leak cannot be replayed into working links.
 * The public view is deliberately limited: no schedule history, notes, adherence,
 * appointments or member emails. Every view is counted and links can be revoked.
 */

const MAX_SHARES = 10;

function hashSecret(secret) {
  return crypto.createHash('sha256').update(secret).digest('hex');
}

function updateEmergency(circle, member, data, now) {
  circle.emergency = { ...circle.emergency, ...data };
  recordActivity(circle, member, 'Updated the emergency card', now.toISOString());
  return circle.emergency;
}

function createShare(circle, member, { hours }, now) {
  const active = circle.emergencyShares.filter((s) => !s.revokedAt && Date.parse(s.expiresAt) > now.getTime());
  if (active.length >= MAX_SHARES) throw new HttpError(409, 'Too many active links. Revoke one first.');
  const secret = crypto.randomBytes(32).toString('base64url');
  const share = {
    id: generateId('shr'),
    secretHash: hashSecret(secret),
    createdAt: now.toISOString(),
    createdBy: member.name,
    expiresAt: new Date(now.getTime() + hours * 3_600_000).toISOString(),
    revokedAt: null,
    views: 0,
    lastViewedAt: null,
  };
  circle.emergencyShares.unshift(share);
  recordActivity(circle, member, `Created an emergency card link valid for ${hours} hour${hours === 1 ? '' : 's'}`, share.createdAt);
  return { share, token: `${circle.id}.${secret}` };
}

function revokeShare(circle, member, shareId, now) {
  const share = circle.emergencyShares.find((s) => s.id === shareId);
  if (!share) throw new HttpError(404, 'Link not found.');
  share.revokedAt = now.toISOString();
  recordActivity(circle, member, 'Revoked an emergency card link', share.revokedAt);
  return share;
}

/** Splits "cir_xxx.secret" into its parts; returns null for malformed tokens. */
function parseToken(token) {
  const match = /^(cir_[A-Za-z0-9_-]{8,24})\.([A-Za-z0-9_-]{43})$/.exec(token || '');
  return match ? { circleId: match[1], secret: match[2] } : null;
}

function findActiveShare(circle, secret, now) {
  const hash = Buffer.from(hashSecret(secret), 'hex');
  return circle.emergencyShares.find((s) => {
    const candidate = Buffer.from(s.secretHash, 'hex');
    return candidate.length === hash.length && crypto.timingSafeEqual(candidate, hash) && !s.revokedAt && Date.parse(s.expiresAt) > now.getTime();
  }) || null;
}

/** The limited, read-only card shown to whoever scans the QR code. */
function publicCard(circle, share) {
  const { emergency } = circle;
  return {
    name: circle.elder.name,
    bloodGroup: emergency.bloodGroup || '',
    allergies: emergency.allergies || '',
    conditions: emergency.conditions || '',
    notes: emergency.notes || '',
    contacts: emergency.contacts,
    medications: circle.medications.filter((m) => m.active !== false).map((m) => ({ name: m.name, dosage: m.dosage || '', instructions: m.instructions || '' })),
    expiresAt: share.expiresAt,
  };
}

function toPublicShare(share) {
  const { secretHash: _secretHash, ...rest } = share;
  return rest;
}

module.exports = { updateEmergency, createShare, revokeShare, parseToken, findActiveShare, publicCard, toPublicShare, hashSecret };
