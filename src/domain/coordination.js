'use strict';

const { generateId } = require('../security/passcode');
const { HttpError } = require('../http/errors');
const { recordActivity } = require('./changes');
const { careSlots, CARE_STATE } = require('./continuity');
const { scheduleForDate, DOSE_STATUS } = require('./schedule');
const { localParts, wallToMinutes } = require('./time');
const { can, ACTIONS } = require('./policy');

/**
 * Caregiver coordination: alert acknowledgement, care notes, assignable tasks and
 * shift handovers. Handover snapshots are generated from live records, so the next
 * caregiver sees exactly what is confirmed, pending and open, not a free-text guess.
 */

const OPEN_STATES = new Set([CARE_STATE.AWAITING, CARE_STATE.CAREGIVER_NOTIFIED, CARE_STATE.ESCALATED, CARE_STATE.REMINDER_SENT]);
const UPCOMING_APPOINTMENT_HOURS = 36;

function findMember(circle, id) {
  return circle.members.find((m) => m.id === id);
}

function acknowledgeAlert(circle, member, { slot, note }, now) {
  if (!can(member, ACTIONS.ACK_ALERT, circle)) {
    throw new HttpError(403, 'The elder resolves alerts by confirming or reporting the dose.');
  }
  const target = careSlots(circle, now).find((s) => s.slot === slot);
  if (!target || target.openDoses.length === 0) throw new HttpError(404, 'There is no open alert for that dose time.');
  if (target.acknowledgement) throw new HttpError(409, `Already acknowledged by ${target.acknowledgement.byName}.`);
  if (target.elapsed < 0) throw new HttpError(400, 'This dose is not due yet.');

  const at = now.toISOString();
  const record = { slot, byId: member.id, byName: member.name, role: member.role, note: note || '', at };
  circle.acknowledgements.push(record);
  recordActivity(circle, member, `Acknowledged the ${target.time} unconfirmed-dose alert${note ? `: "${note}"` : ''}`, at);
  return record;
}

function addNote(circle, member, text, now) {
  const note = { id: generateId('note'), text, byId: member.id, byName: member.name, role: member.role, at: now.toISOString() };
  circle.careNotes.unshift(note);
  circle.careNotes.length = Math.min(circle.careNotes.length, 200);
  recordActivity(circle, member, 'Added a care note', note.at);
  return note;
}

function createTask(circle, member, { title, dueDate, assigneeId }, now) {
  const assignee = assigneeId ? findMember(circle, assigneeId) : null;
  if (assigneeId && !assignee) throw new HttpError(404, 'That person is not in this circle.');
  const at = now.toISOString();
  const task = { id: generateId('tsk'), title, dueDate: dueDate || null, assigneeId: assignee?.id ?? null, assigneeName: assignee?.name ?? null, status: 'open', createdBy: member.name, createdAt: at };
  circle.tasks.unshift(task);
  recordActivity(circle, member, `Added task: ${title}${assignee ? ` (assigned to ${assignee.name})` : ''}`, at);
  return task;
}

/** Complete, reopen or transfer a task to another member. */
function updateTask(circle, member, taskId, { status, assigneeId }, now) {
  const task = circle.tasks.find((t) => t.id === taskId);
  if (!task) throw new HttpError(404, 'Task not found.');
  const at = now.toISOString();
  if (assigneeId !== undefined) {
    const assignee = assigneeId ? findMember(circle, assigneeId) : null;
    if (assigneeId && !assignee) throw new HttpError(404, 'That person is not in this circle.');
    task.assigneeId = assignee?.id ?? null;
    task.assigneeName = assignee?.name ?? null;
    recordActivity(circle, member, `Transferred task "${task.title}" to ${assignee?.name ?? 'nobody'}`, at);
  }
  if (status && status !== task.status) {
    task.status = status;
    if (status === 'done') Object.assign(task, { completedAt: at, completedBy: member.name });
    else Object.assign(task, { completedAt: null, completedBy: null });
    recordActivity(circle, member, `${status === 'done' ? 'Completed' : 'Reopened'} task "${task.title}"`, at);
  }
  return task;
}

/** What the next caregiver needs to know, built from live records. */
function handoverSnapshot(circle, now) {
  const local = localParts(now, circle.timezone);
  const today = scheduleForDate(circle, local.date, now);
  const slots = careSlots(circle, now);
  const lastHandover = circle.handovers[0]?.createdAt ?? '';
  const describe = (doses) => doses.map((d) => `${d.time} ${d.name}`);

  return {
    confirmed: describe(today.filter((d) => d.status === DOSE_STATUS.TAKEN)),
    reportedMissed: describe(today.filter((d) => d.status === DOSE_STATUS.MISSED)),
    pending: describe(today.filter((d) => [DOSE_STATUS.DUE, DOSE_STATUS.UPCOMING, DOSE_STATUS.UNCONFIRMED].includes(d.status))),
    alerts: slots.filter((s) => OPEN_STATES.has(s.state) && s.elapsed >= 0).map((s) => `${s.time}: ${s.openDoses.join(', ')} (${s.state.replace(/_/g, ' ')})`),
    appointments: circle.appointments
      .filter((a) => a.status === 'upcoming')
      .filter((a) => {
        const minutes = wallToMinutes(a.date, a.time) - local.minutes;
        return minutes > 0 && minutes <= UPCOMING_APPOINTMENT_HOURS * 60;
      })
      .map((a) => `Dr. ${a.doctor}, ${a.date} ${a.time}${a.location ? ` at ${a.location}` : ''}`),
    tasks: circle.tasks.filter((t) => t.status === 'open').map((t) => `${t.title}${t.assigneeName ? ` (${t.assigneeName})` : ''}`),
    notes: circle.careNotes.filter((n) => n.at > lastHandover).slice(0, 5).map((n) => `${n.byName}: ${n.text}`),
  };
}

function createHandover(circle, member, { toId, note }, now) {
  const to = toId ? findMember(circle, toId) : null;
  if (toId && !to) throw new HttpError(404, 'That person is not in this circle.');
  if (to && to.id === member.id) throw new HttpError(400, 'Choose someone else to hand over to.');
  const at = now.toISOString();
  const handover = {
    id: generateId('hnd'),
    fromId: member.id,
    fromName: member.name,
    toId: to?.id ?? null,
    toName: to?.name ?? null,
    note: note || '',
    snapshot: handoverSnapshot(circle, now),
    createdAt: at,
    acknowledgedAt: null,
    acknowledgedBy: null,
  };
  circle.handovers.unshift(handover);
  recordActivity(circle, member, `Handed over${to ? ` to ${to.name}` : ' to the next caregiver'}`, at);
  return handover;
}

function acknowledgeHandover(circle, member, handoverId, now) {
  const handover = circle.handovers.find((h) => h.id === handoverId);
  if (!handover) throw new HttpError(404, 'Handover not found.');
  if (handover.acknowledgedAt) throw new HttpError(409, `Already acknowledged by ${handover.acknowledgedBy}.`);
  if (handover.fromId === member.id) throw new HttpError(400, 'The next caregiver acknowledges a handover, not its author.');
  if (handover.toId && handover.toId !== member.id) throw new HttpError(403, `This handover is addressed to ${handover.toName}.`);
  const at = now.toISOString();
  Object.assign(handover, { acknowledgedAt: at, acknowledgedBy: member.name });
  recordActivity(circle, member, `Acknowledged the handover from ${handover.fromName}`, at);
  return handover;
}

module.exports = { acknowledgeAlert, addNote, createTask, updateTask, handoverSnapshot, createHandover, acknowledgeHandover };
