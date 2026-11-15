'use strict';

const express = require('express');
const schemas = require('../schemas');
const { asyncHandler, validate, authorize } = require('../middleware');
const { HttpError } = require('../errors');
const { ACTIONS, ROLES } = require('../../domain/policy');
const { requestChange, decideProposal, recordActivity } = require('../../domain/changes');
const { scheduleForDate, adherenceStats, dosesForDate, doseKey } = require('../../domain/schedule');
const { localParts, addDays, wallToMinutes } = require('../../domain/time');
const { toPublicCircle } = require('../../domain/circle');
const { careSlots } = require('../../domain/continuity');
const { routineDrift } = require('../../domain/drift');
const { handoverSnapshot } = require('../../domain/coordination');
const { toPublicShare } = require('../../domain/emergency');
const { hashSecret } = require('../../security/passcode');

const DOSE_EDIT_WINDOW_DAYS = 2;
const DOSE_KEY_PATTERN = /^med_[A-Za-z0-9_-]{8,24}@\d{4}-\d{2}-\d{2}@([01]\d|2[0-3]):[0-5]\d$/;

function careRoutes({ store, clock, ai, mailer }) {
  const router = express.Router();

  /** Single round-trip payload for the app: today's doses, insights, approvals and logs. */
  router.get(
    '/dashboard',
    asyncHandler(async (req, res) => {
      const { circle, member } = req;
      const now = clock();
      const local = localParts(now, circle.timezone);
      const byWhen = (a, b) => wallToMinutes(a.date, a.time) - wallToMinutes(b.date, b.time);

      res.json({
        circle: toPublicCircle(circle, member),
        now: { date: local.date, time: local.time },
        today: scheduleForDate(circle, local.date, now),
        tomorrow: scheduleForDate(circle, addDays(local.date, 1), now),
        medications: [...circle.medications].sort((a, b) => a.name.localeCompare(b.name)),
        appointments: [...circle.appointments].sort(byWhen),
        proposals: circle.proposals.slice(0, 30),
        adherence: adherenceStats(circle, now, 7),
        adherenceMonth: adherenceStats(circle, now, 30),
        drift: routineDrift(circle, now),
        care: {
          slots: careSlots(circle, now),
          handoverNow: handoverSnapshot(circle, now),
          tasks: circle.tasks.slice(0, 50),
          notes: circle.careNotes.slice(0, 30),
          handovers: circle.handovers.slice(0, 20),
        },
        emergency: { card: circle.emergency, shares: circle.emergencyShares.slice(0, 10).map(toPublicShare) },
        notifications: circle.notifications.slice(0, 50),
        activity: circle.activity.slice(0, 50),
        services: { ai: ai.enabled, mail: mailer.mode },
      });
    }),
  );

  function changeHandler(entity, action, schema) {
    return asyncHandler(async (req, res) => {
      const data = schema ? validate(schema, req.body) : undefined;
      const targetId = action === 'create' ? undefined : validate(schemas.id, req.params.id);
      const now = clock();
      if (entity === 'medication' && action === 'create' && !data.startDate) {
        data.startDate = localParts(now, req.circle.timezone).date;
      }
      const result = await store.update(req.circle.id, (circle) => {
        const member = circle.members.find((m) => m.id === req.member.id);
        return requestChange(circle, member, { entity, action, targetId, data }, now.toISOString());
      });
      res.status(result.applied ? (action === 'create' ? 201 : 200) : 202).json(result);
    });
  }

  router.post('/medications', changeHandler('medication', 'create', schemas.medicationCreate));
  router.put('/medications/:id', changeHandler('medication', 'update', schemas.medicationUpdate));
  router.delete('/medications/:id', changeHandler('medication', 'delete'));
  router.post('/appointments', changeHandler('appointment', 'create', schemas.appointmentCreate));
  router.put('/appointments/:id', changeHandler('appointment', 'update', schemas.appointmentUpdate));
  router.delete('/appointments/:id', changeHandler('appointment', 'delete'));

  /** Records (or corrects) whether a scheduled dose was taken, keeping stock counts in sync. */
  router.post(
    '/doses',
    authorize(ACTIONS.LOG_DOSE),
    asyncHandler(async (req, res) => {
      const input = validate(schemas.doseLog, req.body);
      const now = clock();
      const entry = await store.update(req.circle.id, (circle) => {
        const today = localParts(now, circle.timezone).date;
        if (input.date > today || input.date < addDays(today, -DOSE_EDIT_WINDOW_DAYS)) {
          throw new HttpError(400, 'Doses can only be recorded for today and the previous two days.');
        }
        const key = doseKey(input.medId, input.date, input.time);
        if (!dosesForDate(circle, input.date).some((d) => d.key === key)) {
          throw new HttpError(404, 'That dose is not on the schedule.');
        }
        // A dose cannot be reported missed before it is due (reminder window opens at T - lead).
        const minutesUntilDose = wallToMinutes(input.date, input.time) - localParts(now, circle.timezone).minutes;
        if (input.status === 'missed' && minutesUntilDose > circle.settings.upcomingLeadMin) {
          throw new HttpError(400, 'A dose can only be reported missed once it is due.');
        }
        const med = circle.medications.find((m) => m.id === input.medId);
        const member = circle.members.find((m) => m.id === req.member.id);
        const existing = circle.doseLog.find((d) => d.key === key);

        if (existing?.status === input.status) return existing;
        if (med.stock != null) {
          if (existing?.status === 'taken') med.stock += 1;
          if (input.status === 'taken') med.stock = Math.max(0, med.stock - 1);
        }
        const record = { key, ...input, at: now.toISOString(), byId: member.id, byName: member.name };
        circle.doseLog = circle.doseLog.filter((d) => d.key !== key);
        circle.doseLog.push(record);
        const verb = input.status === 'taken' ? 'Confirmed' : 'Reported';
        recordActivity(circle, member, `${verb} ${med.name} (${input.time}) as ${input.status}${input.note ? `: "${input.note}"` : ''}`, record.at);
        return record;
      });
      res.json({ dose: entry });
    }),
  );

  router.delete(
    '/doses/:key',
    authorize(ACTIONS.LOG_DOSE),
    asyncHandler(async (req, res) => {
      const { key } = req.params;
      if (!DOSE_KEY_PATTERN.test(key)) throw new HttpError(400, 'Invalid dose reference.');
      const now = clock();
      await store.update(req.circle.id, (circle) => {
        const existing = circle.doseLog.find((d) => d.key === key);
        if (!existing) throw new HttpError(404, 'Nothing to undo.');
        const med = circle.medications.find((m) => m.id === existing.medId);
        if (med && med.stock != null && existing.status === 'taken') med.stock += 1;
        circle.doseLog = circle.doseLog.filter((d) => d.key !== key);
        const member = circle.members.find((m) => m.id === req.member.id);
        recordActivity(circle, member, `Undid the ${existing.time} ${med?.name ?? 'dose'} record`, now.toISOString());
      });
      res.status(204).end();
    }),
  );

  router.post(
    '/proposals/:id/decision',
    authorize(ACTIONS.DECIDE_PROPOSAL),
    asyncHandler(async (req, res) => {
      const proposalId = validate(schemas.id, req.params.id);
      const { approve } = validate(schemas.decision, req.body);
      const now = clock();
      const result = await store.update(req.circle.id, (circle) => {
        const member = circle.members.find((m) => m.id === req.member.id);
        return decideProposal(circle, member, proposalId, approve, now.toISOString());
      });
      res.json(result);
    }),
  );

  router.put(
    '/settings',
    authorize(ACTIONS.MANAGE_CIRCLE),
    asyncHandler(async (req, res) => {
      const input = validate(schemas.settings, req.body);
      const now = clock();
      const circle = await store.update(req.circle.id, (draft) => {
        const { timezone, ...rest } = input;
        const next = { ...draft.settings, ...rest };
        if (!(next.followupMin < next.escalatePrimaryMin && next.escalatePrimaryMin < next.escalateBackupMin)) {
          throw new HttpError(400, 'Timings must increase: follow-up, then primary caregiver, then backup contact.');
        }
        draft.settings = next;
        if (timezone) draft.timezone = timezone;
        recordActivity(draft, req.member, 'Updated circle settings', now.toISOString());
        return draft;
      });
      res.json({ circle: toPublicCircle(circle, req.member) });
    }),
  );

  router.put(
    '/me/notifications',
    asyncHandler(async (req, res) => {
      const input = validate(schemas.notifyPreference, req.body);
      const circle = await store.update(req.circle.id, (draft) => {
        const member = draft.members.find((m) => m.id === req.member.id);
        member.notify = input.notify;
        if (input.email) member.email = input.email;
        return draft;
      });
      const me = circle.members.find((m) => m.id === req.member.id);
      res.json({ circle: toPublicCircle(circle, me) });
    }),
  );

  router.post(
    '/circle/passcode',
    authorize(ACTIONS.MANAGE_CIRCLE),
    asyncHandler(async (req, res) => {
      const { sharePasscode } = validate(schemas.rotatePasscode, req.body);
      const hashed = await hashSecret(sharePasscode);
      const now = clock();
      await store.update(req.circle.id, (draft) => {
        draft.security.sharePasscode = hashed;
        draft.security.passcodeVersion += 1;
        recordActivity(draft, req.member, 'Changed the circle passcode (others must sign in again)', now.toISOString());
      });
      res.status(204).end();
    }),
  );

  router.delete(
    '/members/:id',
    authorize(ACTIONS.MANAGE_CIRCLE),
    asyncHandler(async (req, res) => {
      const memberId = validate(schemas.id, req.params.id);
      const now = clock();
      await store.update(req.circle.id, (draft) => {
        const target = draft.members.find((m) => m.id === memberId);
        if (!target) throw new HttpError(404, 'Member not found.');
        if (target.role === ROLES.ELDER) throw new HttpError(400, 'The elder cannot be removed from their own circle.');
        draft.members = draft.members.filter((m) => m.id !== memberId);
        recordActivity(draft, req.member, `Removed ${target.name} from the circle`, now.toISOString());
      });
      res.status(204).end();
    }),
  );

  return router;
}

module.exports = { careRoutes };
