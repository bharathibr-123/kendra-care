import { h, mount, field, showFieldErrors, timeAgo, chip, toast } from '../dom.js';
import { api } from '../api.js';
import { perform } from '../ui.js';

const BLOOD_GROUPS = ['', 'A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];

function cardView(card, medications) {
  const row = (label, value) => h('div', { class: 'field' }, h('strong', {}, label), h('p', { style: 'margin:0' }, value || '—'));
  return h(
    'div',
    {},
    h('div', { class: 'grid grid-2' }, row('Blood group', card.bloodGroup), row('Allergies', card.allergies), row('Conditions (as entered)', card.conditions), row('Notes', card.notes)),
    h('strong', {}, 'Emergency contacts'),
    card.contacts.length ? h('ul', {}, card.contacts.map((c) => h('li', {}, `${c.name}${c.relation ? ` (${c.relation})` : ''}: `, h('a', { href: `tel:${c.phone.replace(/[^\d+]/g, '')}` }, c.phone)))) : h('p', { class: 'muted' }, 'No contacts yet.'),
    h('strong', {}, 'Current medicines'),
    h('ul', {}, medications.filter((m) => m.active !== false).map((m) => h('li', {}, `${m.name} ${m.dosage || ''}`))),
  );
}

function contactRow(contact = {}, index) {
  const row = h(
    'div',
    { class: 'contact-row' },
    field({ label: `Contact ${index + 1} name`, name: 'cname', value: contact.name || '', attrs: { maxlength: 80 } }),
    field({ label: 'Phone', name: 'cphone', type: 'tel', value: contact.phone || '', attrs: { maxlength: 20, autocomplete: 'tel' } }),
    field({ label: 'Relation', name: 'crelation', value: contact.relation || '', attrs: { maxlength: 40 } }),
  );
  const remove = h('button', { type: 'button', class: 'secondary', 'aria-label': `Remove contact ${index + 1}` }, 'Remove');
  remove.addEventListener('click', () => row.remove());
  row.append(h('div', { class: 'field' }, remove));
  return row;
}

function editForm(ctx) {
  const { card } = ctx.data.emergency;
  const contacts = h('div', {}, (card.contacts.length ? card.contacts : [{}]).map(contactRow));
  const addContact = h('button', { type: 'button', class: 'secondary' }, '+ Add contact');
  addContact.addEventListener('click', () => {
    if (contacts.children.length < 5) contacts.append(contactRow({}, contacts.children.length));
  });
  const blood = h('select', { id: 'em-blood', name: 'bloodGroup' }, BLOOD_GROUPS.map((g) => h('option', { value: g, selected: g === card.bloodGroup }, g || 'Not set')));
  const form = h(
    'form',
    { novalidate: true },
    h('fieldset', {}, h('legend', {}, 'Emergency contacts'), contacts, addContact),
    h('div', { class: 'grid grid-2' }, h('div', { class: 'field' }, h('label', { for: 'em-blood' }, 'Blood group'), blood), field({ label: 'Allergies', name: 'allergies', value: card.allergies, hint: 'As you know them, e.g. "Penicillin (rash)"', attrs: { maxlength: 300 } })),
    h('div', { class: 'grid grid-2' }, field({ label: 'Existing conditions', name: 'conditions', value: card.conditions, hint: 'Only what you want responders to see', attrs: { maxlength: 300 } }), field({ label: 'Notes for responders', name: 'notes', value: card.notes, attrs: { maxlength: 300 } })),
    h('button', { type: 'submit' }, 'Save emergency card'),
  );
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const names = data.getAll('cname');
    const phones = data.getAll('cphone');
    const relations = data.getAll('crelation');
    const payload = {
      contacts: names.map((name, i) => ({ name: name.trim(), phone: phones[i].trim(), relation: relations[i].trim() })).filter((c) => c.name || c.phone),
      bloodGroup: data.get('bloodGroup'),
      allergies: data.get('allergies'),
      conditions: data.get('conditions'),
      notes: data.get('notes'),
    };
    try {
      await perform(() => api.put('/api/emergency', payload), { success: 'Emergency card saved.', refresh: ctx.refresh });
    } catch (error) {
      showFieldErrors(form, error);
    }
  });
  return form;
}

// The most recent link survives the re-render that follows creating it.
let lastCreated = null;

function createdView({ url, qrSvg }) {
  const img = h('img', { class: 'qr', alt: 'QR code for the emergency card link', src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(qrSvg)}` });
  const copy = h('button', { type: 'button', class: 'secondary' }, 'Copy link');
  copy.addEventListener('click', () => navigator.clipboard?.writeText(url).then(() => toast('Link copied.')).catch(() => toast('Copy failed. Select the link instead.', { error: true })));
  return h('div', { class: 'row' }, img, h('div', { class: 'stack', style: 'flex:1;min-width:220px' }, h('p', { class: 'small share-url', style: 'word-break:break-all' }, url), copy, h('p', { class: 'small muted' }, 'Print it or keep it on the fridge. It stops working when it expires or is revoked.')));
}

function sharePanel(ctx) {
  const result = h('div', { 'aria-live': 'polite' }, lastCreated ? createdView(lastCreated) : null);
  const hours = h('select', { id: 'share-hours' }, [1, 6, 24, 72].map((n) => h('option', { value: n, selected: n === 24 }, `${n} hour${n === 1 ? '' : 's'}`)));
  const create = h('button', { type: 'button' }, 'Create QR link');
  create.addEventListener('click', async () => {
    try {
      const { url, qrSvg } = await perform(() => api.post('/api/emergency/shares', { hours: Number(hours.value) }), { success: 'Emergency link created.' });
      lastCreated = { url, qrSvg };
      await ctx.refresh();
    } catch {
      /* toast already shown */
    }
  });
  const revoke = (share) => perform(() => api.del(`/api/emergency/shares/${share.id}`), { success: 'Link revoked.', refresh: ctx.refresh }).catch(() => {});
  const now = Date.now();
  return h(
    'section',
    { class: 'panel', 'aria-labelledby': 'share-title' },
    h('h3', { id: 'share-title' }, 'Share with responders (QR)'),
    h('p', { class: 'small muted' }, 'Creates a time-limited link showing only this card and current medicine names. No schedules, notes or history are shared.'),
    h('div', { class: 'row' }, h('label', { for: 'share-hours', style: 'margin:0' }, 'Valid for'), hours, create),
    result,
    ctx.data.emergency.shares.length
      ? h(
          'ul',
          { class: 'list-plain' },
          ctx.data.emergency.shares.map((s) => {
            const status = s.revokedAt ? 'revoked' : Date.parse(s.expiresAt) < now ? 'expired' : 'active';
            return h(
              'li',
              { class: 'row spread' },
              h('span', { class: 'small' }, `Created ${timeAgo(s.createdAt)} by ${s.createdBy} · expires ${new Date(s.expiresAt).toLocaleString('en-IN')} · viewed ${s.views} time${s.views === 1 ? '' : 's'}`),
              status === 'active' ? h('button', { type: 'button', class: 'danger', onClick: () => revoke(s) }, 'Revoke') : chip(status === 'revoked' ? 'declined' : 'skipped', status),
            );
          }),
        )
      : null,
  );
}

export function renderEmergency(root, ctx) {
  const { data } = ctx;
  const isElder = data.circle.me.role === 'elder';
  mount(
    root,
    h(
      'div',
      { class: 'stack' },
      h('div', {}, h('h2', {}, 'Emergency card'), h('p', { class: 'muted' }, 'In an emergency call 112 first. This card helps responders reach family and know about allergies.')),
      h('section', { class: 'panel', 'aria-labelledby': 'card-title' }, h('h3', { id: 'card-title' }, `${data.circle.elderName}`), cardView(data.emergency.card, data.medications)),
      isElder ? h('section', { class: 'panel', 'aria-labelledby': 'edit-title' }, h('h3', { id: 'edit-title' }, 'Edit my card'), editForm(ctx)) : h('p', { class: 'demo-bar' }, `Only ${data.circle.elderName} can edit or share this card.`),
      isElder ? sharePanel(ctx) : null,
    ),
  );
}
