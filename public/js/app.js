import { h, mount, toast, announce } from './dom.js';
import { api } from './api.js';
import { initPreferences } from './preferences.js';
import { renderLanding } from './views/landing.js';
import { renderToday } from './views/today.js';
import { renderMedicines } from './views/medicines.js';
import { renderAppointments } from './views/appointments.js';
import { renderInsights } from './views/insights.js';
import { renderCircle } from './views/circle.js';
import { renderCare } from './views/care.js';
import { renderCompanion } from './views/companion.js';
import { renderEmergency } from './views/emergency.js';

const ROUTES = {
  today: { label: 'Today', render: renderToday },
  care: { label: 'Care', render: renderCare },
  medicines: { label: 'Medicines', render: renderMedicines },
  appointments: { label: 'Appointments', render: renderAppointments },
  insights: { label: 'Insights', render: renderInsights },
  companion: { label: 'Companion', render: renderCompanion },
  emergency: { label: 'Emergency', render: renderEmergency },
  circle: { label: 'Circle', render: renderCircle },
};
const REFRESH_MS = 60_000;
const ROLE_LABEL = { elder: 'Elder', caretaker: 'Caretaker', family: 'Family' };

const viewRoot = document.getElementById('view');
const signOutButton = document.getElementById('sign-out');
const state = { data: null, timer: null, rendered: false };

function currentRoute() {
  const name = location.hash.replace(/^#\/?/, '');
  return ROUTES[name] ? name : 'today';
}

function demoBar(circle) {
  if (!circle.demo) return null;
  const switchTo = async (role) => {
    try {
      await api.post('/api/demo/role', { role });
      await refresh();
      announce(`Now viewing as ${ROLE_LABEL[role]}.`);
    } catch (error) {
      toast(error.message, { error: true });
    }
  };
  return h(
    'div',
    { class: 'demo-bar row spread', role: 'region', 'aria-label': 'Demo controls' },
    h('span', {}, h('strong', {}, 'Demo circle. '), 'Emails are simulated. Switch viewpoint to see the approval flow:'),
    h(
      'div',
      { class: 'row' },
      ['elder', 'caretaker', 'family'].map((role) =>
        h('button', { type: 'button', class: role === circle.me.role ? '' : 'secondary', 'aria-pressed': String(role === circle.me.role), onClick: () => switchTo(role) }, ROLE_LABEL[role]),
      ),
    ),
  );
}

function renderApp() {
  const { data } = state;
  const route = currentRoute();
  const pending = data.proposals.filter((p) => p.status === 'pending').length;
  const alerts = data.care.slots.filter((s) => s.state === 'caregiver_notified' || s.state === 'escalated').length;
  const badges = { today: [pending, 'pending approvals'], care: [alerts, 'active alerts'] };
  const content = h('div', {});

  mount(
    viewRoot,
    demoBar(data.circle),
    h(
      'div',
      { class: 'app-head' },
      h('h1', {}, `${data.circle.elderName}’s care circle`),
      h('p', { class: 'muted', style: 'margin:0' }, `Signed in as ${data.circle.me.name} `, h('span', { class: 'role-badge' }, ROLE_LABEL[data.circle.me.role]), ` · Circle code ${data.circle.code}`),
    ),
    h(
      'nav',
      { class: 'nav', 'aria-label': 'Sections' },
      Object.entries(ROUTES).map(([name, { label }]) =>
        h('a', { href: `#/${name}`, 'aria-current': name === route ? 'page' : null }, label, badges[name]?.[0] ? h('span', { class: 'count', 'aria-label': `${badges[name][0]} ${badges[name][1]}` }, String(badges[name][0])) : null),
      ),
    ),
    content,
  );
  ROUTES[route].render(content, { data, refresh });
  signOutButton.classList.remove('hidden');
  viewRoot.setAttribute('aria-busy', 'false');
}

function showLanding() {
  state.data = null;
  state.rendered = false;
  clearInterval(state.timer);
  signOutButton.classList.add('hidden');
  renderLanding(viewRoot, {
    onSignedIn: async () => {
      location.hash = '#/today';
      await refresh();
      document.getElementById('main').focus();
    },
  });
  viewRoot.setAttribute('aria-busy', 'false');
}

async function refresh() {
  try {
    state.data = await api.get('/api/dashboard');
    // Avoid re-rendering under an open dialog or mid-conversation, which would discard input.
    const busy = document.querySelector('dialog[open]') || (currentRoute() === 'companion' && viewRoot.querySelector('.chat'));
    if (!busy || !state.rendered) renderApp();
    state.rendered = true;
    clearInterval(state.timer);
    state.timer = setInterval(() => {
      if (document.visibilityState === 'visible' && !document.querySelector('dialog[open]')) refresh();
    }, REFRESH_MS);
  } catch (error) {
    if (error.status === 401) showLanding();
    else toast(error.message, { error: true });
  }
}

signOutButton.addEventListener('click', async () => {
  await api.del('/api/session').catch(() => {});
  location.hash = '';
  showLanding();
  announce('Signed out.');
});

window.addEventListener('hashchange', () => {
  if (!state.data) return;
  renderApp();
  document.getElementById('main').focus();
});

// Data refreshed while a dialog was open is rendered once the dialog closes.
window.addEventListener('kendra:dialog-closed', () => {
  if (state.data) renderApp();
});

initPreferences();
refresh();
