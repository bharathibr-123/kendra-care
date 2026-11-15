import { h, mount, formatTime, formatDate, chip, timeAgo } from '../dom.js';
import { api } from '../api.js';
import { perform, emptyState, speak } from '../ui.js';
import { googleMapsUrl } from './appointments.js';

const STATUS_TEXT = { taken: 'Confirmed taken', missed: 'Reported missed', unconfirmed: 'Not confirmed yet', due: 'Due now', upcoming: 'Later today' };

function greeting(time) {
  const hour = Number(time.slice(0, 2));
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

function doseCard(dose, ctx) {
  const log = (status) =>
    perform(() => api.post('/api/doses', { medId: dose.medId, date: dose.date, time: dose.time, status }), {
      success: status === 'taken' ? `${dose.name} confirmed as taken.` : `${dose.name} reported as missed. Caregivers will not be chased for it.`,
      refresh: ctx.refresh,
    }).catch(() => {});
  const undo = () => perform(() => api.del(`/api/doses/${encodeURIComponent(dose.key)}`), { success: 'Record removed.', refresh: ctx.refresh }).catch(() => {});

  const logged = dose.status === 'taken' || dose.status === 'missed';
  const actions = logged
    ? [h('span', { class: 'small muted' }, `by ${dose.loggedBy}`), h('button', { type: 'button', class: 'secondary', onClick: undo }, 'Undo')]
    : [
        h('button', { type: 'button', class: 'big', onClick: () => log('taken'), 'aria-label': `I took ${dose.name} ${dose.dosage}` }, 'I took it'),
        // Only a dose that is due (or overdue) can be reported missed.
        dose.status === 'upcoming' ? null : h('button', { type: 'button', class: 'secondary', onClick: () => log('missed'), 'aria-label': `Report ${dose.name} as missed` }, 'Report missed'),
      ];

  return h(
    'li',
    { class: 'panel dose', dataset: { status: dose.status } },
    h('div', { class: 'dose-time' }, formatTime(dose.time)),
    h(
      'div',
      {},
      h('p', { class: 'dose-name' }, dose.name, dose.dosage ? h('span', { class: 'muted' }, ` · ${dose.dosage}`) : null),
      dose.instructions ? h('p', { class: 'muted', style: 'margin:0' }, dose.instructions) : null,
      chip(dose.status, STATUS_TEXT[dose.status]),
    ),
    h('div', { class: 'dose-actions' }, actions),
  );
}

function approvals(ctx) {
  const { data } = ctx;
  const pending = data.proposals.filter((p) => p.status === 'pending');
  if (pending.length === 0) return null;
  const isElder = data.circle.me.role === 'elder';
  const decide = (proposal, approve) =>
    perform(() => api.post(`/api/proposals/${proposal.id}/decision`, { approve }), {
      success: approve ? 'Change approved and applied.' : 'Change declined.',
      refresh: ctx.refresh,
    }).catch(() => {});

  return h(
    'section',
    { class: 'panel', 'aria-labelledby': 'approvals-title', style: 'border-color: var(--amber)' },
    h('h2', { id: 'approvals-title' }, isElder ? 'Waiting for your decision' : `Waiting for ${data.circle.elderName}’s approval`),
    h(
      'ul',
      { class: 'list-plain' },
      pending.map((p) =>
        h(
          'li',
          { class: 'row spread' },
          h('div', {}, h('strong', {}, p.proposedBy.name), ` wants to ${p.summary}.`, h('br'), h('span', { class: 'small muted' }, timeAgo(p.createdAt))),
          isElder
            ? h('div', { class: 'row' }, h('button', { type: 'button', onClick: () => decide(p, true) }, 'Approve'), h('button', { type: 'button', class: 'danger', onClick: () => decide(p, false) }, 'Decline'))
            : chip('pending', 'Pending'),
        ),
      ),
    ),
  );
}

/** Daily brief: facts from records first, then optional AI wording, clearly separated. */
function dailyBrief() {
  const box = h('section', { class: 'panel brief-card', 'aria-labelledby': 'daily-title', 'aria-live': 'polite' }, h('h2', { id: 'daily-title' }, 'Today\u2019s care brief'), h('p', { class: 'muted' }, 'Loading\u2026'));
  api
    .get('/api/ai/daily-brief')
    .then(({ facts, brief }) => {
      const m = facts.medications;
      const fact = (value, label) => h('div', { class: 'fact' }, h('strong', {}, String(value)), h('span', {}, label));
      box.replaceChildren(
        h('div', { class: 'row spread' }, h('h2', { id: 'daily-title', style: 'margin:0' }, brief.greeting), h('span', { class: 'chip' }, 'Facts from records')),
        h('div', { class: 'facts' }, fact(m.scheduled, 'scheduled'), fact(m.confirmed, 'confirmed'), fact(m.awaiting, 'to come'), fact(m.unconfirmed, 'unconfirmed'), fact(facts.appointments.length, 'appointments in 48 h'), fact(facts.caregivers, 'caregivers')),
        h('p', { style: 'margin-top:0.8rem' }, brief.summary),
        brief.attention.length ? h('ul', { class: 'attention' }, brief.attention.map((a) => h('li', {}, a))) : null,
        h('p', { class: 'small muted', style: 'margin:0' }, brief.source === 'gemini' ? 'Wording by Gemini from the facts above.' : 'Wording generated from the facts above.'),
      );
    })
    .catch(() => box.replaceChildren(h('h2', { id: 'daily-title' }, 'Today\u2019s care brief'), h('p', { class: 'muted' }, 'The brief is unavailable right now.')));
  return box;
}

function sidebar(ctx) {
  const { data } = ctx;
  const next = data.appointments.find((a) => a.status === 'upcoming' && `${a.date}T${a.time}` >= `${data.now.date}T${data.now.time}`);
  const lowStock = data.medications.filter((m) => m.active !== false && m.stock != null && m.refillAt != null && m.stock <= m.refillAt);
  const ladder = data.notifications.filter((n) => n.type === 'dose').slice(0, 4);
  const alerts = data.care.slots.filter((sl) => sl.state === 'caregiver_notified' || sl.state === 'escalated');

  return h(
    'div',
    { class: 'stack' },
    h(
      'section',
      { class: 'panel', 'aria-labelledby': 'next-appt' },
      h('h2', { id: 'next-appt' }, 'Next appointment'),
      next
        ? h('div', {}, h('p', { class: 'dose-name' }, `Dr. ${next.doctor}`), h('p', { class: 'muted' }, `${next.specialty || ''}`), h('p', {}, `${formatDate(next.date)} at ${formatTime(next.time)}`), next.location ? h('p', { class: 'small' }, next.location, ' \u00B7 ', h('a', { href: googleMapsUrl(next.location), target: '_blank', rel: 'noopener noreferrer' }, 'Directions')) : null)
        : h('p', { class: 'muted' }, 'Nothing scheduled.'),
    ),
    lowStock.length
      ? h('section', { class: 'panel', 'aria-labelledby': 'refill' }, h('h2', { id: 'refill' }, 'Refill soon'), h('ul', { class: 'list-plain' }, lowStock.map((m) => h('li', {}, h('strong', {}, m.name), ` — ${m.stock} left`))))
      : null,
    alerts.length
      ? h('section', { class: 'panel alert-panel', 'aria-labelledby': 'alerts-now' }, h('h2', { id: 'alerts-now' }, 'Caregivers alerted'), h('p', {}, `${alerts.map((a) => a.time).join(', ')} dose${alerts.length > 1 ? 's are' : ' is'} unconfirmed. `, h('a', { href: '#/care' }, 'Open care continuity')))
      : null,
    h(
      'section',
      { class: 'panel', 'aria-labelledby': 'ladder' },
      h('h2', { id: 'ladder' }, 'Reminder ladder'),
      ladder.length
        ? h('ul', { class: 'list-plain' }, ladder.map((n) => h('li', {}, h('div', { class: 'row spread' }, h('span', { class: 'small' }, n.subject), chip(n.status)), h('span', { class: 'small muted' }, `${n.recipients.join(', ')} · ${timeAgo(n.at)}`))))
        : h('p', { class: 'muted small' }, `Reminder, then a follow-up after ${data.circle.settings.followupMin} min, the primary caregiver after ${data.circle.settings.escalatePrimaryMin} min, and the backup contact after ${data.circle.settings.escalateBackupMin} min.`),
    ),
  );
}

export function renderToday(root, ctx) {
  const { data } = ctx;
  const { circle, today, now } = data;
  const isElder = circle.me.role === 'elder';
  const remaining = today.filter((d) => d.status === 'due' || d.status === 'upcoming' || d.status === 'unconfirmed');

  const readAloud = () => {
    const parts = [`${greeting(now.time)}, ${circle.elderName}.`];
    if (remaining.length === 0) parts.push('All of today’s medicines are done. Well done.');
    else parts.push(`You have ${remaining.length} medicine${remaining.length === 1 ? '' : 's'} left today.`, ...remaining.map((d) => `${formatTime(d.time)}: ${d.name} ${d.dosage}. ${d.instructions}`));
    speak(parts.join(' '));
  };

  mount(
    root,
    h(
      'div',
      { class: 'stack' },
      h(
        'div',
        { class: 'row spread' },
        h('div', {}, h('h2', {}, isElder ? `${greeting(now.time)}, ${circle.elderName.split(' ')[0]}` : `${circle.elderName}’s day`), h('p', { class: 'muted' }, formatDate(now.date, { weekday: 'long', day: 'numeric', month: 'long' }))),
        h('div', { class: 'row' }, h('a', { class: 'button secondary big', href: '#/companion' }, '\u{1F3A4} Ask Kendra'), h('button', { type: 'button', class: 'secondary big', onClick: readAloud }, '\u{1F50A} Read my day aloud')),
      ),
      approvals(ctx),
      dailyBrief(),
      h(
        'div',
        { class: 'grid today-grid' },
        h(
          'section',
          { 'aria-labelledby': 'doses-title' },
          h('h2', { id: 'doses-title', class: 'visually-hidden' }, 'Today’s medicines'),
          today.length ? h('ol', { class: 'dose-list stack' }, today.map((d) => doseCard(d, ctx))) : emptyState('No medicines scheduled today. Add them under Medicines.'),
        ),
        sidebar(ctx),
      ),
    ),
  );
}
