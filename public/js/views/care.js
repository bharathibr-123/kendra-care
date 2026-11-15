import { h, mount, formatTime, chip, timeAgo, formatDate, field, showFieldErrors } from '../dom.js';
import { api } from '../api.js';
import { perform, emptyState, openDialog } from '../ui.js';

export const CARE_STATE_LABEL = {
  scheduled: 'Scheduled',
  reminder_sent: 'Reminder sent',
  awaiting_confirmation: 'Awaiting confirmation',
  caregiver_notified: 'Caregiver notified',
  escalated: 'Escalated to backup',
  caregiver_acknowledged: 'Caregiver acknowledged',
  confirmed: 'Confirmed taken',
  reported_missed: 'Reported missed',
};
const LADDER = ['reminder', 'followup', 'primary', 'backup'];
const LADDER_LABEL = { reminder: 'Reminder', followup: 'Follow-up', primary: 'Primary', backup: 'Backup' };
const OPEN = new Set(['awaiting_confirmation', 'caregiver_notified', 'escalated']);

function sentStagesFor(data, slot) {
  return new Set(data.notifications.filter((n) => n.type === 'dose' && n.key.startsWith(`dose:${slot}:`)).map((n) => n.stage));
}

function acknowledgeDialog(ctx, slot) {
  openDialog(`Acknowledge the ${formatTime(slot.time)} alert`, (close) => {
    const form = h(
      'form',
      { novalidate: true },
      h('p', {}, `Unconfirmed: ${slot.openDoses.join(', ')}. Acknowledging tells the circle you are handling it and stops escalation to the backup contact.`),
      field({ label: 'What did you do? (optional)', name: 'note', hint: 'e.g. "Called her, she is taking it now"', attrs: { maxlength: 200 } }),
      h('button', { type: 'submit', class: 'big' }, 'Acknowledge alert'),
    );
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      try {
        await perform(() => api.post('/api/alerts/acknowledge', { slot: slot.slot, note: new FormData(form).get('note') }), { success: 'Alert acknowledged. Backup contacts will not be alerted.', refresh: ctx.refresh });
        close();
      } catch (error) {
        showFieldErrors(form, error);
      }
    });
    return form;
  });
}

function continuitySection(ctx) {
  const { data } = ctx;
  const canAck = data.circle.me.role !== 'elder';
  const slots = data.care.slots;
  return h(
    'section',
    { class: 'panel', 'aria-labelledby': 'continuity-title' },
    h('h3', { id: 'continuity-title' }, 'Today’s care continuity'),
    h('p', { class: 'small muted' }, 'Kendra never assumes a dose was missed. Unconfirmed doses climb the ladder until someone confirms them, reports them missed, or acknowledges the alert.'),
    slots.length
      ? h(
          'ol',
          { class: 'timeline' },
          slots.map((slot) => {
            const sent = sentStagesFor(data, slot.slot);
            const open = OPEN.has(slot.state) && slot.elapsed >= 0;
            return h(
              'li',
              {},
              h('span', { class: 'dose-time', style: 'font-size:1.1rem' }, formatTime(slot.time)),
              h(
                'div',
                {},
                h('strong', {}, slot.doses.map((d) => d.name).join(', ')),
                slot.date !== data.now.date ? h('span', { class: 'small muted' }, ` (${formatDate(slot.date)})`) : null,
                h('div', { class: 'ladder-steps', 'aria-label': 'Escalation steps sent' }, LADDER.map((stage) => h('span', { class: `step${sent.has(stage) ? ' on' : ''}` }, `${sent.has(stage) ? '✓ ' : ''}${LADDER_LABEL[stage]}`))),
                slot.acknowledgement ? h('p', { class: 'small', style: 'margin:0.3rem 0 0' }, `Acknowledged by ${slot.acknowledgement.byName} ${timeAgo(slot.acknowledgement.at)}${slot.acknowledgement.note ? `: “${slot.acknowledgement.note}”` : ''}`) : null,
              ),
              h('div', { class: 'row', style: 'justify-content:flex-end' }, chip(slot.state, CARE_STATE_LABEL[slot.state]), open && canAck ? h('button', { type: 'button', onClick: () => acknowledgeDialog(ctx, slot) }, 'Acknowledge') : null),
            );
          }),
        )
      : emptyState('No doses scheduled today.'),
  );
}

function list(items, empty) {
  return items.length ? h('ul', { class: 'small', style: 'margin:0.1rem 0 0; padding-left:1.1rem' }, items.map((i) => h('li', {}, i))) : h('p', { class: 'small muted', style: 'margin:0' }, empty);
}

function snapshotView(snapshot) {
  const row = (title, items, empty = 'None') => [h('dt', {}, title), h('dd', {}, list(items, empty))];
  return h(
    'dl',
    { class: 'snapshot', style: 'margin:0' },
    row('Needs attention now', snapshot.alerts, 'No open alerts'),
    row('Still to confirm today', snapshot.pending),
    row('Confirmed today', snapshot.confirmed),
    snapshot.reportedMissed?.length ? row('Reported missed', snapshot.reportedMissed) : null,
    row('Appointments (next 36 h)', snapshot.appointments),
    row('Open tasks', snapshot.tasks),
    row('Notes since last handover', snapshot.notes),
  );
}

function handoverSection(ctx) {
  const { data } = ctx;
  const me = data.circle.me;
  const others = data.circle.members.filter((m) => m.id !== me.id && m.role !== 'elder');
  const select = h('select', { id: 'handover-to', name: 'toId' }, h('option', { value: '' }, 'Next caregiver (anyone)'), others.map((m) => h('option', { value: m.id }, m.name)));
  const form = h(
    'form',
    { novalidate: true },
    h('div', { class: 'field' }, h('label', { for: 'handover-to' }, 'Hand over to'), select),
    field({ label: 'Handover note', name: 'note', type: 'textarea', hint: 'Anything the next person should know', attrs: { maxlength: 500 } }),
    h('button', { type: 'submit' }, 'Create handover'),
  );
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(form));
    try {
      await perform(() => api.post('/api/handovers', { toId: values.toId || null, note: values.note }), { success: 'Handover created with a live snapshot of today.', refresh: ctx.refresh });
    } catch (error) {
      showFieldErrors(form, error);
    }
  });

  const acknowledge = (handover) => perform(() => api.post(`/api/handovers/${handover.id}/acknowledge`), { success: 'Handover acknowledged.', refresh: ctx.refresh }).catch(() => {});

  return h(
    'section',
    { class: 'panel', 'aria-labelledby': 'handover-title' },
    h('h3', { id: 'handover-title' }, 'Caregiver handover'),
    h('div', { class: 'grid grid-2' }, h('div', {}, h('h4', { style: 'margin:0 0 0.4rem' }, 'Live snapshot'), snapshotView(data.care.handoverNow)), h('div', {}, form)),
    h('h4', { style: 'margin:1.2rem 0 0.4rem' }, 'Handover history'),
    data.care.handovers.length
      ? h(
          'ul',
          { class: 'list-plain' },
          data.care.handovers.map((hd) =>
            h(
              'li',
              {},
              h(
                'div',
                { class: 'row spread' },
                h('span', {}, h('strong', {}, hd.fromName), ` → ${hd.toName || 'next caregiver'} · `, h('span', { class: 'small muted' }, timeAgo(hd.createdAt))),
                hd.acknowledgedAt
                  ? chip('done', `Acknowledged by ${hd.acknowledgedBy}`)
                  : hd.fromId !== me.id && (!hd.toId || hd.toId === me.id)
                    ? h('button', { type: 'button', onClick: () => acknowledge(hd) }, 'Acknowledge')
                    : chip('pending', 'Awaiting acknowledgement'),
              ),
              hd.note ? h('p', { style: 'margin:0.3rem 0' }, `“${hd.note}”`) : null,
              h('details', {}, h('summary', { class: 'small' }, 'What was handed over'), snapshotView(hd.snapshot)),
            ),
          ),
        )
      : h('p', { class: 'muted' }, 'No handovers yet.'),
  );
}

function tasksSection(ctx) {
  const { data } = ctx;
  const members = data.circle.members;
  const assigneeSelect = (id, value, label) => h('select', { id, name: 'assigneeId', 'aria-label': label }, h('option', { value: '' }, 'Unassigned'), members.map((m) => h('option', { value: m.id, selected: m.id === value }, m.name)));
  const form = h(
    'form',
    { novalidate: true, class: 'grid task-form' },
    field({ label: 'New task', name: 'title', hint: 'e.g. Book transport for the appointment', attrs: { maxlength: 120 } }),
    field({ label: 'Due', name: 'dueDate', type: 'date' }),
    h('div', { class: 'field' }, h('label', { for: 'task-assignee' }, 'Assign to'), assigneeSelect('task-assignee', null, 'Assign to')),
    h('div', { class: 'field' }, h('button', { type: 'submit' }, 'Add')),
  );
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const v = Object.fromEntries(new FormData(form));
    try {
      await perform(() => api.post('/api/tasks', { title: v.title, dueDate: v.dueDate || null, assigneeId: v.assigneeId || null }), { success: 'Task added.', refresh: ctx.refresh });
    } catch (error) {
      showFieldErrors(form, error);
    }
  });
  const update = (task, body, message) => perform(() => api.put(`/api/tasks/${task.id}`, body), { success: message, refresh: ctx.refresh }).catch(() => {});

  return h(
    'section',
    { class: 'panel', 'aria-labelledby': 'tasks-title' },
    h('h3', { id: 'tasks-title' }, 'Care tasks'),
    form,
    data.care.tasks.length
      ? h(
          'ul',
          { class: 'list-plain' },
          data.care.tasks.map((task) => {
            const reassign = assigneeSelect(`assign-${task.id}`, task.assigneeId, `Reassign ${task.title}`);
            reassign.addEventListener('change', () => update(task, { assigneeId: reassign.value || null }, 'Task transferred.'));
            return h(
              'li',
              { class: 'row spread' },
              h('div', {}, h('span', { style: task.status === 'done' ? 'text-decoration:line-through' : '' }, task.title), h('br'), h('span', { class: 'small muted' }, `${task.dueDate ? `Due ${formatDate(task.dueDate)} · ` : ''}by ${task.createdBy}${task.completedBy ? ` · done by ${task.completedBy}` : ''}`)),
              h('div', { class: 'row' }, reassign, h('button', { type: 'button', class: task.status === 'done' ? 'secondary' : '', onClick: () => update(task, { status: task.status === 'done' ? 'open' : 'done' }, task.status === 'done' ? 'Task reopened.' : 'Task completed.') }, task.status === 'done' ? 'Reopen' : 'Done')),
            );
          }),
        )
      : emptyState('No tasks yet.'),
  );
}

function notesSection(ctx) {
  const form = h('form', { novalidate: true }, field({ label: 'Add a care note', name: 'text', type: 'textarea', attrs: { maxlength: 500 } }), h('button', { type: 'submit', class: 'secondary' }, 'Save note'));
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await perform(() => api.post('/api/notes', { text: new FormData(form).get('text') }), { success: 'Note saved.', refresh: ctx.refresh });
    } catch (error) {
      showFieldErrors(form, error);
    }
  });
  return h(
    'section',
    { class: 'panel', 'aria-labelledby': 'notes-title' },
    h('h3', { id: 'notes-title' }, 'Care notes'),
    form,
    h('ul', { class: 'list-plain' }, ctx.data.care.notes.map((n) => h('li', {}, n.text, h('br'), h('span', { class: 'small muted' }, `${n.byName} · ${timeAgo(n.at)}`)))),
  );
}

function escalationHistory(ctx) {
  const items = ctx.data.notifications.filter((n) => n.type === 'dose').slice(0, 20);
  return h(
    'section',
    { class: 'panel', 'aria-labelledby': 'esc-title' },
    h('h3', { id: 'esc-title' }, 'Escalation history'),
    items.length
      ? h('table', {}, h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'When'), h('th', { scope: 'col' }, 'Step'), h('th', { scope: 'col' }, 'To'), h('th', { scope: 'col' }, 'Status'))), h('tbody', {}, items.map((n) => h('tr', {}, h('td', {}, timeAgo(n.at)), h('td', {}, LADDER_LABEL[n.stage] || n.stage), h('td', { class: 'small' }, n.recipients.join(', ')), h('td', {}, chip(n.status))))))
      : h('p', { class: 'muted' }, 'No escalations yet.'),
  );
}

export function renderCare(root, ctx) {
  mount(
    root,
    h(
      'div',
      { class: 'stack' },
      h('div', {}, h('h2', {}, 'Care continuity'), h('p', { class: 'muted' }, 'Making sure every care responsibility is acknowledged, coordinated and followed through.')),
      continuitySection(ctx),
      handoverSection(ctx),
      tasksSection(ctx),
      notesSection(ctx),
      escalationHistory(ctx),
    ),
  );
}
