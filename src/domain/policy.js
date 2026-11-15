'use strict';

/**
 * Role-based permissions, declared in one place.
 *
 * Design principle from the brief: the elder stays at the centre of their own
 * healthcare decisions. Caretakers and family can see everything and propose any
 * change, but when "requireApproval" is on (the default) their edits become
 * proposals that only the elder can approve.
 */

const ROLES = Object.freeze({ ELDER: 'elder', CARETAKER: 'caretaker', FAMILY: 'family' });

const ACTIONS = Object.freeze({
  VIEW: 'view',
  LOG_DOSE: 'dose:log',
  PROPOSE_CHANGE: 'change:propose',
  APPLY_CHANGE: 'change:apply',
  DECIDE_PROPOSAL: 'proposal:decide',
  MANAGE_CIRCLE: 'circle:manage',
  SEND_BRIEF: 'brief:send',
  ACK_ALERT: 'alert:acknowledge',
  COORDINATE: 'care:coordinate',
  MANAGE_EMERGENCY: 'emergency:manage',
});

function can(member, action, circle) {
  if (!member) return false;
  const isElder = member.role === ROLES.ELDER;
  switch (action) {
    case ACTIONS.VIEW:
    case ACTIONS.LOG_DOSE:
    case ACTIONS.PROPOSE_CHANGE:
    case ACTIONS.COORDINATE:
      return true;
    case ACTIONS.ACK_ALERT:
      return !isElder; // the elder resolves an alert by confirming or reporting the dose
    case ACTIONS.MANAGE_EMERGENCY:
      return isElder;
    case ACTIONS.APPLY_CHANGE:
      return isElder || circle.settings.requireApproval === false;
    case ACTIONS.DECIDE_PROPOSAL:
    case ACTIONS.MANAGE_CIRCLE:
      return isElder;
    case ACTIONS.SEND_BRIEF:
      return isElder || member.role === ROLES.CARETAKER;
    default:
      return false;
  }
}

module.exports = { ROLES, ACTIONS, can };
