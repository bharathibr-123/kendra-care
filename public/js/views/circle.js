import { h, mount, field, showFieldErrors, chip, timeAgo } from '../dom.js';
import { api } from '../api.js';
import { perform } from '../ui.js';

const ROLE_LABEL = { elder: 'Elder', caretaker: 'Caretaker', family: 'Family' };
const RESPONDER_LABEL = { primary: 'Primary caregiver', backup: 'Backup contact', none: 'Not alerted' };

function responderSelect(ctx, member) {
  const select = h('select', { 'aria-label': `Escalation role for ${member.name}` }, Object.entries(RESPONDER_LABEL).map(([value, label]) => h('option', { value, selected: value === member.responder }, label)));
  select.addEventListener('change', () => perform(() => api.put(`/api/members/${member.id}/responder`, { responder: select.value }), { success: `${member.name} is now: ${RESPONDER_LABEL[select.value]}.`, refresh: ctx.refresh }).catch(() => {}));
  return select;
}

function membersSection(ctx) {
  const { circle } = ctx.data;
  const isElder = circle.me.role === 'elder';
  const remove = (member) => {
    if (!window.confirm(`Remove ${member.name}? They will be signed out immediately.`)) return;
    perform(() => api.del(`/api/members/${member.id}`), { success: `${member.name} removed.`, refresh: ctx.refresh }).catch(() => {});
  };
  return h(
    'section',
    { class: 'panel', 'aria-labelledby': 'members-title' },
    h('h3', { id: 'members-title' }, 'People in this circle'),
    h(
      'ul',
      { class: 'list-plain' },
      circle.members.map((m) =>
        h(
          'li',
          { class: 'row spread' },
          h('div', {}, h('strong', {}, m.name), m.id === circle.me.id ? ' (you)' : '', h('br'), h('span', { class: 'role-badge' }, ROLE_LABEL[m.role]), ' ', h('span', { class: 'small muted' }, m.hasEmail ? (m.notify ? 'Gets email alerts' : 'Alerts paused') : 'No email')),
          m.role === 'elder'
            ? null
            : isElder
              ? h('div', { class: 'row' }, responderSelect(ctx, m), h('button', { type: 'button', class: 'danger', onClick: () => remove(m), 'aria-label': `Remove ${m.name}` }, 'Remove'))
              : h('span', { class: 'chip' }, RESPONDER_LABEL[m.responder]),
        ),
      ),
    ),
  );
}

function shareSection(ctx) {
  const { circle } = ctx.data;
  const isElder = circle.me.role === 'elder';
  const form = h(
    'form',
    { novalidate: true },
    field({ label: 'New circle passcode', name: 'sharePasscode', type: 'password', hint: 'Everyone except the elder will need to sign in again.', attrs: { minlength: 8, maxlength: 64, autocomplete: 'new-password' } }),
    h('button', { type: 'submit', class: 'secondary' }, 'Change passcode'),
  );
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await perform(() => api.post('/api/circle/passcode', Object.fromEntries(new FormData(form))), { success: 'Passcode changed.', refresh: ctx.refresh });
      form.reset();
    } catch (error) {
      showFieldErrors(form, error);
    }
  });
  return h(
    'section',
    { class: 'panel', 'aria-labelledby': 'share-title' },
    h('h3', { id: 'share-title' }, 'Invite someone'),
    h('p', {}, 'Share the circle code and the circle passcode. They choose "Join a circle" on the home page.'),
    h('p', {}, 'Circle code: ', h('span', { class: 'code-box' }, circle.code)),
    isElder ? form : null,
  );
}

function myAlertsSection(ctx) {
  const { me } = ctx.data.circle;
  const form = h(
    'form',
    { novalidate: true },
    field({ label: 'My email for alerts', name: 'email', type: 'email', value: me.email || '', attrs: { autocomplete: 'email' } }),
    h('div', { class: 'checks field' }, h('label', {}, h('input', { type: 'checkbox', name: 'notify', checked: me.notify }), 'Send me email reminders and alerts')),
    h('button', { type: 'submit', class: 'secondary' }, 'Save'),
  );
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = new FormData(form);
    try {
      await perform(() => api.put('/api/me/notifications', { email: data.get('email'), notify: data.get('notify') === 'on' }), { success: 'Alert settings saved.', refresh: ctx.refresh });
    } catch (error) {
      showFieldErrors(form, error);
    }
  });
  return h('section', { class: 'panel', 'aria-labelledby': 'alerts-title' }, h('h3', { id: 'alerts-title' }, 'My alerts'), form);
}

function settingsSection(ctx) {
  const { settings } = ctx.data.circle;
  const number = (label, name, value, hint, min, max) => field({ label, name, type: 'number', value, hint, attrs: { min, max, required: true } });
  const form = h(
    'form',
    { novalidate: true },
    h('div', { class: 'checks field' }, h('label', {}, h('input', { type: 'checkbox', name: 'requireApproval', checked: settings.requireApproval }), 'Changes by others need my approval')),
    h(
      'div',
      { class: 'grid', style: 'grid-template-columns: repeat(auto-fit, minmax(190px, 1fr))' },
      number('Remind me before a dose (min)', 'upcomingLeadMin', settings.upcomingLeadMin, null, 0, 60),
      number('Follow-up reminder after (min)', 'followupMin', settings.followupMin, null, 5, 120),
      number('Alert primary caregiver after (min)', 'escalatePrimaryMin', settings.escalatePrimaryMin, null, 10, 240),
      number('Alert backup contact after (min)', 'escalateBackupMin', settings.escalateBackupMin, null, 15, 480),
    ),
    h('button', { type: 'submit', class: 'secondary' }, 'Save settings'),
  );
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const payload = {
      requireApproval: data.get('requireApproval') === 'on',
      upcomingLeadMin: Number(data.get('upcomingLeadMin')),
      followupMin: Number(data.get('followupMin')),
      escalatePrimaryMin: Number(data.get('escalatePrimaryMin')),
      escalateBackupMin: Number(data.get('escalateBackupMin')),
    };
    try {
      await perform(() => api.put('/api/settings', payload), { success: 'Settings saved.', refresh: ctx.refresh });
    } catch (error) {
      showFieldErrors(form, error);
    }
  });
  return h('section', { class: 'panel', 'aria-labelledby': 'settings-title' }, h('h3', { id: 'settings-title' }, 'My care rules'), h('p', { class: 'small muted' }, 'Choose who is alerted, and when, if a dose is not confirmed. Pick primary and backup contacts in the list of people above.'), form);
}

function logSection(title, id, items, render) {
  return h('section', { class: 'panel', 'aria-labelledby': id }, h('h3', { id }, title), items.length ? h('ul', { class: 'list-plain' }, items.map(render)) : h('p', { class: 'muted' }, 'Nothing yet.'));
}

export function renderCircle(root, ctx) {
  const { data } = ctx;
  const isElder = data.circle.me.role === 'elder';
  const decided = data.proposals.filter((p) => p.status !== 'pending').slice(0, 10);

  mount(
    root,
    h(
      'div',
      { class: 'stack' },
      h('h2', {}, 'Care circle'),
      h('div', { class: 'grid grid-2' }, membersSection(ctx), h('div', { class: 'stack' }, shareSection(ctx), myAlertsSection(ctx))),
      isElder ? settingsSection(ctx) : null,
      h(
        'div',
        { class: 'grid grid-2' },
        logSection('Emails and alerts', 'notes-title', data.notifications.slice(0, 15), (n) =>
          h('li', {}, h('div', { class: 'row spread' }, h('span', {}, n.subject), chip(n.status)), h('span', { class: 'small muted' }, `To ${n.recipients.join(', ')} · ${timeAgo(n.at)}`)),
        ),
        logSection('Activity', 'activity-title', data.activity.slice(0, 15), (a) => h('li', {}, h('strong', {}, a.actor), ` ${a.text.charAt(0).toLowerCase()}${a.text.slice(1)}`, h('br'), h('span', { class: 'small muted' }, timeAgo(a.at)))),
      ),
      decided.length
        ? logSection('Past decisions', 'decisions-title', decided, (p) => h('li', { class: 'row spread' }, h('span', {}, `${p.proposedBy.name}: ${p.summary}`), chip(p.status === 'approved' ? 'taken' : 'declined', p.status)))
        : null,
    ),
  );
}
