'use strict';

const { generateId } = require('../security/passcode');
const { can, ACTIONS } = require('./policy');
const { HttpError } = require('../http/errors');

/**
 * Every create/update/delete of a medication or appointment flows through
 * `requestChange`. It either applies the change immediately (elder, or approval
 * disabled) or records a proposal for the elder to approve. Approved proposals are
 * applied by exactly the same `applyChange` function, so there is one code path.
 */

const ENTITIES = Object.freeze({
  medication: { collection: 'medications', label: (item) => item.name, prefix: 'med' },
  appointment: { collection: 'appointments', label: (item) => `Dr. ${item.doctor}`, prefix: 'apt' },
});

const MAX_ACTIVITY = 200;

function recordActivity(circle, actor, text, at) {
  circle.activity.unshift({ at, actor: actor.name, role: actor.role, text });
  circle.activity.length = Math.min(circle.activity.length, MAX_ACTIVITY);
}

function findItem(circle, entity, id) {
  const spec = ENTITIES[entity];
  return circle[spec.collection].find((item) => item.id === id);
}

function describe(change, circle) {
  const spec = ENTITIES[change.entity];
  const target = change.targetId ? findItem(circle, change.entity, change.targetId) : null;
  const label = spec.label({ ...target, ...change.data });
  const verb = { create: 'add', update: 'update', delete: 'remove' }[change.action];
  return `${verb} ${change.entity} "${label}"`;
}

function applyChange(circle, change, actor, at) {
  const spec = ENTITIES[change.entity];
  const items = circle[spec.collection];

  if (change.action === 'create') {
    const item = { id: generateId(spec.prefix), ...change.data, createdAt: at, updatedAt: at };
    items.push(item);
    recordActivity(circle, actor, `${describe(change, circle).replace(/^add/, 'Added')}`, at);
    return item;
  }

  const index = items.findIndex((item) => item.id === change.targetId);
  if (index === -1) throw new HttpError(404, `That ${change.entity} no longer exists.`);

  if (change.action === 'update') {
    const description = describe(change, circle);
    items[index] = { ...items[index], ...change.data, id: items[index].id, updatedAt: at };
    recordActivity(circle, actor, description.replace(/^update/, 'Updated'), at);
    return items[index];
  }

  const description = describe(change, circle);
  const [removed] = items.splice(index, 1);
  recordActivity(circle, actor, description.replace(/^remove/, 'Removed'), at);
  return removed;
}

function requestChange(circle, member, change, at) {
  if (!ENTITIES[change.entity]) throw new HttpError(400, 'Unknown entity.');
  if (change.action !== 'create' && !findItem(circle, change.entity, change.targetId)) {
    throw new HttpError(404, `That ${change.entity} does not exist.`);
  }

  if (can(member, ACTIONS.APPLY_CHANGE, circle)) {
    return { applied: true, item: applyChange(circle, change, member, at) };
  }

  const proposal = {
    id: generateId('prp'),
    ...change,
    summary: describe(change, circle),
    proposedBy: { id: member.id, name: member.name, role: member.role },
    createdAt: at,
    status: 'pending',
  };
  circle.proposals.unshift(proposal);
  recordActivity(circle, member, `Proposed to ${proposal.summary} (awaiting elder approval)`, at);
  return { applied: false, proposal };
}

function decideProposal(circle, member, proposalId, approve, at) {
  if (!can(member, ACTIONS.DECIDE_PROPOSAL, circle)) {
    throw new HttpError(403, 'Only the elder can approve or decline changes.');
  }
  const proposal = circle.proposals.find((p) => p.id === proposalId);
  if (!proposal) throw new HttpError(404, 'Proposal not found.');
  if (proposal.status !== 'pending') throw new HttpError(409, 'This proposal was already decided.');

  proposal.decidedAt = at;
  if (!approve) {
    proposal.status = 'declined';
    recordActivity(circle, member, `Declined: ${proposal.summary} (from ${proposal.proposedBy.name})`, at);
    return { proposal };
  }

  const proposer = circle.members.find((m) => m.id === proposal.proposedBy.id) || proposal.proposedBy;
  const item = applyChange(circle, proposal, proposer, at);
  proposal.status = 'approved';
  recordActivity(circle, member, `Approved: ${proposal.summary} (from ${proposal.proposedBy.name})`, at);
  return { proposal, item };
}

module.exports = { requestChange, decideProposal, applyChange, recordActivity, ENTITIES };
