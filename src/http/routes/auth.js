'use strict';

const express = require('express');
const schemas = require('../schemas');
const { asyncHandler, validate, authenticate } = require('../middleware');
const { HttpError } = require('../errors');
const { COOKIE_NAME, createToken, cookieOptions } = require('../../security/session');
const { verifySecret, hashSecret, generateId } = require('../../security/passcode');
const { buildCircle, toPublicCircle, defaultResponder } = require('../../domain/circle');
const { buildDemoCircle } = require('../../domain/demo');
const { recordActivity } = require('../../domain/changes');
const { ROLES } = require('../../domain/policy');

const crypto = require('node:crypto');

const MAX_FAILED_ATTEMPTS = 8;
const RECOVERY_TTL_MINUTES = 15;
const RECOVERY_MAX_ATTEMPTS = 5;
const RECOVERY_RESEND_SECONDS = 60;
const RECOVERY_ACCEPTED = 'If this circle has an elder email on file, a 6-digit code has been sent to it.';
const LOCKOUT_MINUTES = 15;
const INVALID_CREDENTIALS = 'That circle code and passcode do not match.';

function authRoutes({ store, config, clock, authLimiter, reminders, mailer }) {
  const router = express.Router();
  // Verified against when a circle code doesn't exist, so response timing doesn't reveal valid codes.
  const dummySecret = hashSecret('timing-equaliser');

  function startSession(res, circle, member) {
    const token = createToken(
      { cid: circle.id, mid: member.id, tv: member.tokenVersion, pv: circle.security.passcodeVersion },
      config.sessionSecret,
      config.sessionTtlHours,
    );
    res.cookie(COOKIE_NAME, token, cookieOptions(config));
  }

  async function createWithUniqueCode(build) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const circle = await build();
      if (!(await store.findIdByCode(circle.code))) {
        await store.create(circle);
        return circle;
      }
    }
    throw new HttpError(503, 'Could not allocate a circle code, please retry.');
  }

  router.post(
    '/circles',
    authLimiter,
    asyncHandler(async (req, res) => {
      const input = validate(schemas.createCircle, req.body);
      const circle = await createWithUniqueCode(() =>
        buildCircle({ ...input, timezone: input.timezone || config.defaultTimezone }, clock()),
      );
      startSession(res, circle, circle.members[0]);
      res.status(201).json({ circle: toPublicCircle(circle, circle.members[0]) });
    }),
  );

  router.post(
    '/demo',
    authLimiter,
    asyncHandler(async (req, res) => {
      const { role } = validate(schemas.demoRole, req.body ?? {});
      const circle = await createWithUniqueCode(() => buildDemoCircle(clock(), config.defaultTimezone));
      // Run the escalation engine once so the demo shows the reminder ladder immediately.
      await reminders.processCircle(circle.id, clock());
      const member = circle.members.find((m) => m.role === role);
      startSession(res, circle, member);
      res.status(201).json({ circle: toPublicCircle(circle, member) });
    }),
  );

  router.post(
    '/demo/role',
    authenticate({ store, config }),
    asyncHandler(async (req, res) => {
      if (!req.circle.demo) throw new HttpError(403, 'Role switching is only available in the demo.');
      const { role } = validate(schemas.demoRole, req.body ?? {});
      const member = req.circle.members.find((m) => m.role === role);
      if (!member) throw new HttpError(404, 'No member with that role in this demo.');
      startSession(res, req.circle, member);
      res.json({ circle: toPublicCircle(req.circle, member) });
    }),
  );

  router.post(
    '/session',
    authLimiter,
    asyncHandler(async (req, res) => {
      const input = validate(schemas.login, req.body);
      const now = clock();
      const circleId = await store.findIdByCode(input.code);
      const circle = circleId ? await store.get(circleId) : null;

      if (!circle) {
        await verifySecret(input.pin || input.passcode, await dummySecret);
        throw new HttpError(401, INVALID_CREDENTIALS);
      }
      if (circle.security.lockedUntil && Date.parse(circle.security.lockedUntil) > now.getTime()) {
        const minutes = Math.ceil((Date.parse(circle.security.lockedUntil) - now.getTime()) / 60_000);
        throw new HttpError(429, `Too many attempts. Please try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`);
      }

      const isElder = input.role === ROLES.ELDER;
      const valid = await verifySecret(
        isElder ? input.pin : input.passcode,
        isElder ? circle.security.elderPin : circle.security.sharePasscode,
      );

      if (!valid) {
        await store.update(circle.id, (draft) => {
          draft.security.failedAttempts += 1;
          if (draft.security.failedAttempts >= MAX_FAILED_ATTEMPTS) {
            draft.security.failedAttempts = 0;
            draft.security.lockedUntil = new Date(now.getTime() + LOCKOUT_MINUTES * 60_000).toISOString();
          }
        });
        throw new HttpError(401, INVALID_CREDENTIALS);
      }

      const { updated, member } = await store.update(circle.id, (draft) => {
        draft.security.failedAttempts = 0;
        draft.security.lockedUntil = null;
        if (isElder) return { updated: draft, member: draft.members.find((m) => m.role === ROLES.ELDER) };

        const existing = draft.members.find(
          (m) =>
            m.role === input.role &&
            ((input.email && m.email === input.email) || (!input.email && m.name.toLowerCase() === input.name.toLowerCase())),
        );
        if (existing) return { updated: draft, member: existing };

        if (draft.members.length >= 20) throw new HttpError(409, 'This circle already has the maximum of 20 members.');
        const joined = {
          id: generateId('mbr'),
          name: input.name,
          email: input.email,
          role: input.role,
          notify: true,
          responder: defaultResponder(input.role),
          tokenVersion: 0,
          joinedAt: now.toISOString(),
        };
        draft.members.push(joined);
        recordActivity(draft, joined, `Joined the care circle as ${input.role}`, now.toISOString());
        return { updated: draft, member: joined };
      });

      startSession(res, updated, member);
      res.json({ circle: toPublicCircle(updated, member) });
    }),
  );

  /**
   * PIN recovery, step 1: email a one-time code to the elder's address on file.
   * The response is identical whether or not the circle exists (no enumeration);
   * the code is stored only as a scrypt hash, expires in 15 minutes and allows 5 tries.
   */
  router.post(
    '/session/recover',
    authLimiter,
    asyncHandler(async (req, res) => {
      const { code } = validate(schemas.recoverRequest, req.body);
      const now = clock();
      const circleId = await store.findIdByCode(code);
      const circle = circleId ? await store.get(circleId) : null;
      const elder = circle?.members.find((m) => m.role === ROLES.ELDER);
      const recent = circle?.security.recovery && now.getTime() - Date.parse(circle.security.recovery.issuedAt) < RECOVERY_RESEND_SECONDS * 1000;

      if (circle && !circle.demo && elder?.email && !recent) {
        const otp = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
        const hashed = await hashSecret(otp);
        await store.update(circle.id, (draft) => {
          draft.security.recovery = { ...hashed, issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + RECOVERY_TTL_MINUTES * 60_000).toISOString(), attempts: 0 };
        });
        await mailer.send({
          to: [{ name: elder.name, email: elder.email }],
          subject: 'Your Kendra PIN reset code',
          text: `Hello ${elder.name},\n\nYour code to reset your Kendra PIN is: ${otp}\n\nIt expires in ${RECOVERY_TTL_MINUTES} minutes. If you did not ask for this, you can ignore this email; your PIN has not changed.`,
        });
      }
      res.status(202).json({ message: RECOVERY_ACCEPTED });
    }),
  );

  /** PIN recovery, step 2: verify the emailed code, set a new PIN and sign the elder in. */
  router.post(
    '/session/recover/verify',
    authLimiter,
    asyncHandler(async (req, res) => {
      const { code, otp, newPin } = validate(schemas.recoverVerify, req.body);
      const now = clock();
      const invalid = new HttpError(401, 'That code is incorrect or has expired. Request a new one.');
      const circleId = await store.findIdByCode(code);
      const circle = circleId ? await store.get(circleId) : null;
      const recovery = circle?.security.recovery;
      if (!recovery || Date.parse(recovery.expiresAt) < now.getTime() || recovery.attempts >= RECOVERY_MAX_ATTEMPTS) {
        if (!circle) await verifySecret(otp, await dummySecret);
        throw invalid;
      }

      if (!(await verifySecret(otp, recovery))) {
        await store.update(circle.id, (draft) => {
          if (draft.security.recovery) draft.security.recovery.attempts += 1;
        });
        throw invalid;
      }

      const newPinHash = await hashSecret(newPin);
      const { updated, elder } = await store.update(circle.id, (draft) => {
        const member = draft.members.find((m) => m.role === ROLES.ELDER);
        draft.security.elderPin = newPinHash;
        draft.security.recovery = null;
        draft.security.failedAttempts = 0;
        draft.security.lockedUntil = null;
        member.tokenVersion += 1; // signs out every other elder session
        recordActivity(draft, member, 'Reset the PIN using an emailed one-time code', now.toISOString());
        return { updated: draft, elder: member };
      });
      startSession(res, updated, elder);
      res.json({ circle: toPublicCircle(updated, elder) });
    }),
  );

  router.delete('/session', (_req, res) => {
    const { maxAge: _maxAge, ...options } = cookieOptions(config);
    res.clearCookie(COOKIE_NAME, options);
    res.status(204).end();
  });

  return router;
}

module.exports = { authRoutes };
