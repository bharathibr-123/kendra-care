'use strict';

const express = require('express');
const QRCode = require('qrcode');
const schemas = require('../schemas');
const { asyncHandler, validate, authorize } = require('../middleware');
const { HttpError } = require('../errors');
const { ACTIONS } = require('../../domain/policy');
const emergency = require('../../domain/emergency');

/** Elder-managed emergency card and its expiring share links (authenticated). */
function emergencyRoutes({ store, clock, config }) {
  const router = express.Router();

  router.put(
    '/emergency',
    authorize(ACTIONS.MANAGE_EMERGENCY),
    asyncHandler(async (req, res) => {
      const input = validate(schemas.emergency, req.body);
      const card = await store.update(req.circle.id, (circle) => emergency.updateEmergency(circle, req.member, input, clock()));
      res.json({ card });
    }),
  );

  router.post(
    '/emergency/shares',
    authorize(ACTIONS.MANAGE_EMERGENCY),
    asyncHandler(async (req, res) => {
      const input = validate(schemas.emergencyShare, req.body);
      const { share, token } = await store.update(req.circle.id, (circle) => emergency.createShare(circle, req.member, input, clock()));
      const base = config.publicUrl || `${req.protocol}://${req.get('host')}`;
      const url = `${base}/e/${token}`;
      const qrSvg = await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
      res.status(201).json({ share: emergency.toPublicShare(share), url, qrSvg });
    }),
  );

  router.delete(
    '/emergency/shares/:id',
    authorize(ACTIONS.MANAGE_EMERGENCY),
    asyncHandler(async (req, res) => {
      const shareId = validate(schemas.id, req.params.id);
      await store.update(req.circle.id, (circle) => emergency.revokeShare(circle, req.member, shareId, clock()));
      res.status(204).end();
    }),
  );

  return router;
}

/** Public, rate-limited, read-only view for whoever scans a valid, unexpired QR link. */
function publicEmergencyRoutes({ store, clock, limiter }) {
  const router = express.Router();
  router.get(
    '/public/emergency/:token',
    limiter,
    asyncHandler(async (req, res) => {
      const parsed = emergency.parseToken(req.params.token);
      const notFound = new HttpError(404, 'This emergency link is invalid, expired or revoked.');
      if (!parsed || !(await store.get(parsed.circleId))) throw notFound;
      const card = await store.update(parsed.circleId, (circle) => {
        const now = clock();
        const share = emergency.findActiveShare(circle, parsed.secret, now);
        if (!share) throw notFound;
        share.views += 1;
        share.lastViewedAt = now.toISOString();
        return emergency.publicCard(circle, share);
      });
      res.setHeader('X-Robots-Tag', 'noindex, nofollow');
      res.json({ card });
    }),
  );
  return router;
}

module.exports = { emergencyRoutes, publicEmergencyRoutes };
