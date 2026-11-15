import { h, mount } from './dom.js';

/** Public, read-only emergency card opened from a QR code. No sign-in, no other data. */
async function load() {
  const root = document.getElementById('card');
  const token = decodeURIComponent(location.pathname.split('/').pop() || '');
  try {
    const response = await fetch(`/api/public/emergency/${encodeURIComponent(token)}`, { credentials: 'omit' });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || 'This link is not valid.');
    const c = body.card;
    const row = (label, value) => (value ? h('p', {}, h('strong', {}, `${label}: `), value) : null);
    mount(
      root,
      h(
        'section',
        { class: 'panel' },
        h('h2', {}, c.name),
        row('Blood group', c.bloodGroup),
        row('Allergies', c.allergies),
        row('Conditions', c.conditions),
        row('Notes', c.notes),
      ),
      h(
        'section',
        { class: 'panel' },
        h('h2', {}, 'Call family'),
        c.contacts.length
          ? h('ul', { class: 'list-plain' }, c.contacts.map((p) => h('li', { class: 'row spread' }, h('span', {}, h('strong', {}, p.name), p.relation ? ` (${p.relation})` : ''), h('a', { class: 'button', href: `tel:${p.phone.replace(/[^\d+]/g, '')}` }, `Call ${p.phone}`))))
          : h('p', { class: 'muted' }, 'No contacts listed.'),
      ),
      h('section', { class: 'panel' }, h('h2', {}, 'Current medicines'), h('ul', {}, c.medications.map((m) => h('li', {}, `${m.name} ${m.dosage}${m.instructions ? ` (${m.instructions})` : ''}`)))),
      h('p', { class: 'small muted' }, `This link expires ${new Date(c.expiresAt).toLocaleString('en-IN')}.`),
    );
  } catch (error) {
    mount(root, h('div', { class: 'panel' }, h('h2', {}, 'Link not available'), h('p', {}, error.message)));
  }
}

load();
