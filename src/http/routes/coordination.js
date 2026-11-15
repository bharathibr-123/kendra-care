'use strict';

const express = require('express');
const schemas = require('../schemas');
const { asyncHandler, validate, authorize } = require('../middleware');
const { HttpError } = require('../errors');
const { ACTIONS } = require('../../domain/policy');
const { recordActivity } = require('../../domain/changes');
const coordination = require('../../domain/coordination');

/** Care continuity and caregiver coordination: alerts, notes, tasks, handovers, responders. */
function coordinationRoutes({ store, clock }) {
  const router = express.Router();

  /** Runs a domain function inside an atomic update with the current member. */
  const mutate = (req, fn) =>
    store.update(req.circle.id, (circle) => {
      const member = circle.members.find((m) => m.id === req.member.id);
      return fn(circle, member, clock());
    });

  router.post(
    '/alerts/acknowledge',
    authorize(ACTIONS.ACK_ALERT),
    asyncHandler(async (req, res) => {
      const input = validate(schemas.acknowledge, req.body);
      res.json({ acknowledgement: await mutate(req, (c, m, now) => coordination.acknowledgeAlert(c, m, input, now)) });
    }),
  );

  router.post(
    '/notes',
    authorize(ACTIONS.COORDINATE),
    asyncHandler(async (req, res) => {
      const { text } = validate(schemas.careNote, req.body);
      res.status(201).json({ note: await mutate(req, (c, m, now) => coordination.addNote(c, m, text, now)) });
    }),
  );

  router.post(
    '/tasks',
    authorize(ACTIONS.COORDINATE),
    asyncHandler(async (req, res) => {
      const input = validate(schemas.taskCreate, req.body);
      res.status(201).json({ task: await mutate(req, (c, m, now) => coordination.createTask(c, m, input, now)) });
    }),
  );

  router.put(
    '/tasks/:id',
    authorize(ACTIONS.COORDINATE),
    asyncHandler(async (req, res) => {
      const taskId = validate(schemas.id, req.params.id);
      const input = validate(schemas.taskUpdate, req.body);
      res.json({ task: await mutate(req, (c, m, now) => coordination.updateTask(c, m, taskId, input, now)) });
    }),
  );

  router.post(
    '/handovers',
    authorize(ACTIONS.COORDINATE),
    asyncHandler(async (req, res) => {
      const input = validate(schemas.handoverCreate, req.body);
      res.status(201).json({ handover: await mutate(req, (c, m, now) => coordination.createHandover(c, m, input, now)) });
    }),
  );

  router.post(
    '/handovers/:id/acknowledge',
    authorize(ACTIONS.COORDINATE),
    asyncHandler(async (req, res) => {
      const handoverId = validate(schemas.id, req.params.id);
      res.json({ handover: await mutate(req, (c, m, now) => coordination.acknowledgeHandover(c, m, handoverId, now)) });
    }),
  );

  /** The elder decides who is the primary caregiver and who is the backup contact. */
  router.put(
    '/members/:id/responder',
    authorize(ACTIONS.MANAGE_CIRCLE),
    asyncHandler(async (req, res) => {
      const memberId = validate(schemas.id, req.params.id);
      const { responder } = validate(schemas.responder, req.body);
      await mutate(req, (circle, actor, now) => {
        const target = circle.members.find((m) => m.id === memberId);
        if (!target) throw new HttpError(404, 'Member not found.');
        if (target.role === 'elder') throw new HttpError(400, 'The elder is not their own escalation contact.');
        target.responder = responder;
        recordActivity(circle, actor, `Set ${target.name} as ${responder === 'none' ? 'not an escalation contact' : `${responder} contact`}`, now.toISOString());
      });
      res.status(204).end();
    }),
  );

  return router;
}

module.exports = { coordinationRoutes };
