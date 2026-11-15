'use strict';

const express = require('express');
const schemas = require('../schemas');
const { asyncHandler, validate, authorize } = require('../middleware');
const { ACTIONS } = require('../../domain/policy');
const { recordActivity } = require('../../domain/changes');
const { recipients } = require('../../domain/reminders');
const { buildBriefFacts, briefToText, buildDailyFacts, dailyBriefToText } = require('../../services/insights');
const companion = require('../../domain/companion');

const MAX_CONVERSATIONS = 100;

function aiRoutes({ store, ai, mailer, clock, aiLimiter }) {
  const router = express.Router();

  /** Reads a prescription photo into draft medications. Nothing is saved here. */
  router.post(
    '/prescription',
    aiLimiter,
    express.json({ limit: '6mb' }),
    asyncHandler(async (req, res) => {
      const image = validate(schemas.prescriptionImage, req.body);
      const result = await ai.extractPrescription(image);
      res.json(result);
    }),
  );

  /**
   * Care Companion. Rules classify first; Gemini may only pick an intent from a closed
   * list when rules find none. The answer itself always comes from the records tools.
   */
  router.post(
    '/companion',
    aiLimiter,
    asyncHandler(async (req, res) => {
      const { text } = validate(schemas.companionQuestion, req.body);
      const now = clock();
      const language = companion.detectLanguage(text); // reply in the language the question was asked in
      let classification = companion.classify(text);
      let classifiedBy = 'rules';
      if (classification.intent === 'unknown') {
        const aiGuess = await ai.classifyIntent(text);
        if (aiGuess && aiGuess.intent !== 'unknown') {
          classification = { intent: aiGuess.intent, period: classification.period || aiGuess.period };
          classifiedBy = 'gemini';
        }
      }
      const reply = { ...companion.answer(req.circle, now, { ...classification, language }), classifiedBy };
      await store.update(req.circle.id, (circle) => {
        circle.conversations.unshift({ at: now.toISOString(), memberId: req.member.id, question: text, answer: reply.answer, intent: reply.intent, language, source: reply.source });
        circle.conversations.length = Math.min(circle.conversations.length, MAX_CONVERSATIONS);
      });
      res.json(reply);
    }),
  );

  /** Daily brief: facts computed from records, wording optionally by Gemini. */
  router.get(
    '/daily-brief',
    aiLimiter,
    asyncHandler(async (req, res) => {
      const facts = buildDailyFacts(req.circle, clock());
      res.json({ facts, brief: await ai.writeDailyBrief(facts) });
    }),
  );

  router.get(
    '/brief',
    aiLimiter,
    asyncHandler(async (req, res) => {
      const facts = buildBriefFacts(req.circle, clock());
      const brief = await ai.writeCareBrief(facts);
      res.json({ brief, facts: { adherence: facts.adherence.totals, from: facts.adherence.from, to: facts.adherence.to } });
    }),
  );

  router.post(
    '/brief/send',
    aiLimiter,
    authorize(ACTIONS.SEND_BRIEF),
    asyncHandler(async (req, res) => {
      const { period } = validate(schemas.briefSend, req.body ?? {});
      const now = clock();
      const to = recipients(req.circle, ['elder', 'caretaker', 'family']);
      let subject;
      let text;
      let brief;
      if (period === 'daily') {
        const facts = buildDailyFacts(req.circle, now);
        brief = await ai.writeDailyBrief(facts);
        subject = `Daily care brief for ${req.circle.elder.name}`;
        text = dailyBriefToText(brief, facts);
      } else {
        brief = await ai.writeCareBrief(buildBriefFacts(req.circle, now));
        subject = `Care brief for ${req.circle.elder.name}: ${brief.headline}`;
        text = briefToText(brief);
      }
      const result = await mailer.send({ to, subject, text, simulate: req.circle.demo });
      const status = result.delivered ? 'sent' : result.mode === 'smtp' ? 'failed' : 'simulated';

      await store.update(req.circle.id, (circle) => {
        circle.notifications.unshift({
          key: `brief-manual:${period}:${now.getTime()}`,
          type: 'brief',
          stage: 'manual',
          subject,
          recipients: to.map((r) => `${r.name} (${r.role})`),
          at: now.toISOString(),
          status,
        });
        recordActivity(circle, req.member, `Shared the ${period} care brief with the circle`, now.toISOString());
      });
      res.json({ status, recipients: to.length, brief });
    }),
  );

  return router;
}

module.exports = { aiRoutes };
