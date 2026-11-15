import { h, mount, field, showFieldErrors, toast } from '../dom.js';
import { api } from '../api.js';
import { openDialog } from '../ui.js';

/** Two-step PIN recovery: email a one-time code to the elder, then set a new PIN. */
function openRecovery(onSignedIn, initialCode = '') {
  openDialog('Reset the elder\u2019s PIN', (close) => {
    const status = h('p', { class: 'muted', role: 'status', 'aria-live': 'polite' }, 'We will email a 6-digit code to the elder\u2019s email address on file.');
    const requestForm = h(
      'form',
      { novalidate: true },
      field({ label: 'Circle code', name: 'code', value: initialCode, required: true, attrs: { autocapitalize: 'characters', maxlength: 6, autocomplete: 'off' } }),
      h('button', { type: 'submit' }, 'Email me a code'),
    );
    const verifyForm = h(
      'form',
      { novalidate: true, class: 'hidden' },
      field({ label: 'Code from the email', name: 'otp', required: true, attrs: { inputmode: 'numeric', maxlength: 6, autocomplete: 'one-time-code' } }),
      field({ label: 'New 6-digit PIN', name: 'newPin', type: 'password', required: true, attrs: { inputmode: 'numeric', maxlength: 6, autocomplete: 'new-password' } }),
      h('button', { type: 'submit', class: 'big' }, 'Reset PIN and sign in'),
    );
    let code = '';
    requestForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      code = new FormData(requestForm).get('code');
      try {
        const { message } = await api.post('/api/session/recover', { code });
        status.textContent = `${message} It expires in 15 minutes.`;
        verifyForm.classList.remove('hidden');
        verifyForm.querySelector('input').focus();
      } catch (error) {
        showFieldErrors(requestForm, error);
        if (!error.fields?.length) toast(error.message, { error: true });
      }
    });
    verifyForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const values = Object.fromEntries(new FormData(verifyForm));
      try {
        const { circle } = await api.post('/api/session/recover/verify', { code, ...values });
        close();
        toast('PIN changed. You are signed in.');
        onSignedIn(circle);
      } catch (error) {
        showFieldErrors(verifyForm, error);
        if (!error.fields?.length) toast(error.message, { error: true });
      }
    });
    return h('div', { class: 'stack' }, status, requestForm, verifyForm);
  });
}

const PILLARS = [
  ['1', 'The elder decides', 'Family and caretakers can propose changes; the elder approves them. Their care stays their choice.'],
  ['2', 'Nobody is left wondering', 'An unconfirmed dose reminds the elder, then alerts the primary caregiver, then the backup contact, until someone acknowledges it.'],
  ['3', 'Snap a prescription', 'Gemini reads a prescription photo (including "1-0-1" notation) into a draft schedule a person confirms.'],
  ['4', 'Spots a changing routine', 'Statistics on confirmation times notice when doses are drifting later, and say so in plain words.'],
  ['5', 'Speaks Kannada and English', 'Ask by voice, "\u0CA8\u0CA8\u0CCD\u0CA8 \u0CAE\u0CC1\u0C82\u0CA6\u0CBF\u0CA8 \u0CA1\u0CBE\u0C95\u0CCD\u0C9F\u0CB0\u0CCD \u0C85\u0CAA\u0CBE\u0CAF\u0CBF\u0C82\u0C9F\u0CCD\u0CAE\u0CC6\u0C82\u0C9F\u0CCD \u0CAF\u0CBE\u0CB5\u0CBE\u0C97?", and hear answers from your own records.'],
];

function tabs(panels, onSelect) {
  const buttons = panels.map(([id, label], index) =>
    h('button', { type: 'button', role: 'tab', id: `tab-${id}`, 'aria-controls': `panel-${id}`, 'aria-selected': String(index === 0), tabindex: index === 0 ? '0' : '-1' }, label),
  );
  const list = h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Get started' }, buttons);

  const select = (index) => {
    buttons.forEach((button, i) => {
      button.setAttribute('aria-selected', String(i === index));
      button.tabIndex = i === index ? 0 : -1;
    });
    buttons[index].focus();
    onSelect(panels[index][0]);
  };
  buttons.forEach((button, index) => {
    button.addEventListener('click', () => select(index));
    button.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowRight') select((index + 1) % buttons.length);
      if (event.key === 'ArrowLeft') select((index - 1 + buttons.length) % buttons.length);
    });
  });
  return list;
}

function demoPanel(onSignedIn) {
  const start = async (role, button) => {
    button.disabled = true;
    try {
      const { circle } = await api.post('/api/demo', { role });
      onSignedIn(circle);
    } catch (error) {
      toast(error.message, { error: true });
      button.disabled = false;
    }
  };
  const roleButton = (role, label, description) => {
    const button = h('button', { type: 'button', class: role === 'elder' ? 'big' : 'big secondary' }, label);
    button.addEventListener('click', () => start(role, button));
    return h('div', { class: 'stack' }, button, h('p', { class: 'small muted' }, description));
  };
  return h(
    'div',
    { class: 'stack' },
    h('p', {}, 'Explore a ready-made circle for Kamala Rao (74, Mysuru) with a month of history, an unconfirmed dose, a pending approval and upcoming appointments. Demo emails are simulated.'),
    h(
      'div',
      { class: 'grid grid-3' },
      roleButton('elder', 'Enter as Kamala (elder)', 'Approve changes, mark doses, read aloud.'),
      roleButton('caretaker', 'Enter as Ravi (nurse)', 'Log doses; edits need Kamala’s approval.'),
      roleButton('family', 'Enter as Priya (daughter)', 'Follow along from another city.'),
    ),
  );
}

function createPanel(onSignedIn) {
  const form = h(
    'form',
    { novalidate: true },
    field({ label: 'Elder’s name', name: 'elderName', required: true, attrs: { autocomplete: 'name', maxlength: 80 } }),
    field({ label: 'Elder’s email', name: 'elderEmail', type: 'email', hint: 'Optional. Used for gentle dose reminders.', attrs: { autocomplete: 'email' } }),
    field({ label: 'Elder’s 6-digit PIN', name: 'elderPin', type: 'password', hint: 'Only the elder uses this to sign in.', required: true, attrs: { inputmode: 'numeric', pattern: '\\d{6}', maxlength: 6, autocomplete: 'new-password' } }),
    field({ label: 'Circle passcode for family & caretakers', name: 'sharePasscode', type: 'password', hint: 'At least 8 characters. Share it only with people you trust; you can change it anytime.', required: true, attrs: { minlength: 8, maxlength: 64, autocomplete: 'new-password' } }),
    h('button', { type: 'submit', class: 'big' }, 'Create care circle'),
  );
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    data.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    try {
      const { circle } = await api.post('/api/circles', data);
      toast(`Circle created. Your circle code is ${circle.code}.`);
      onSignedIn(circle);
    } catch (error) {
      showFieldErrors(form, error);
      if (!error.fields?.length) toast(error.message, { error: true });
    }
  });
  return form;
}

function joinPanel(onSignedIn) {
  const roleSelect = h(
    'select',
    { id: 'join-role', name: 'role' },
    h('option', { value: 'caretaker' }, 'Caretaker'),
    h('option', { value: 'family' }, 'Family member'),
    h('option', { value: 'elder' }, 'I am the elder'),
  );
  const forgot = h('button', { type: 'button', class: 'secondary' }, 'Forgot your PIN?');
  const elderFields = h('div', { class: 'hidden' }, field({ label: '6-digit PIN', name: 'pin', type: 'password', attrs: { inputmode: 'numeric', maxlength: 6, autocomplete: 'current-password' } }), h('p', {}, forgot));
  const memberFields = h(
    'div',
    {},
    field({ label: 'Circle passcode', name: 'passcode', type: 'password', attrs: { autocomplete: 'current-password' } }),
    field({ label: 'Your name', name: 'name', attrs: { autocomplete: 'name', maxlength: 80 } }),
    field({ label: 'Your email', name: 'email', type: 'email', hint: 'Optional, for missed-dose and appointment alerts.', attrs: { autocomplete: 'email' } }),
  );
  roleSelect.addEventListener('change', () => {
    const isElder = roleSelect.value === 'elder';
    elderFields.classList.toggle('hidden', !isElder);
    memberFields.classList.toggle('hidden', isElder);
  });

  const form = h(
    'form',
    { novalidate: true },
    field({ label: 'Circle code', name: 'code', hint: '6 letters and numbers, from the elder.', required: true, attrs: { autocapitalize: 'characters', maxlength: 6, autocomplete: 'off', spellcheck: 'false' } }),
    h('div', { class: 'field' }, h('label', { for: 'join-role' }, 'I am joining as'), roleSelect),
    elderFields,
    memberFields,
    h('button', { type: 'submit', class: 'big' }, 'Sign in'),
  );
  forgot.addEventListener('click', () => openRecovery(onSignedIn, form.querySelector('[name=code]').value));
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const all = Object.fromEntries(new FormData(form));
    const payload =
      all.role === 'elder'
        ? { role: 'elder', code: all.code, pin: all.pin }
        : { role: all.role, code: all.code, passcode: all.passcode, name: all.name, email: all.email };
    try {
      const { circle } = await api.post('/api/session', payload);
      onSignedIn(circle);
    } catch (error) {
      showFieldErrors(form, error);
      if (!error.fields?.length) toast(error.message, { error: true });
    }
  });
  return form;
}

export function renderLanding(root, { onSignedIn }) {
  const panels = [
    ['demo', 'Try the live demo', demoPanel(onSignedIn)],
    ['create', 'Create a circle', createPanel(onSignedIn)],
    ['join', 'Join a circle', joinPanel(onSignedIn)],
  ];
  const panelNodes = panels.map(([id, , content], index) =>
    h('div', { role: 'tabpanel', id: `panel-${id}`, 'aria-labelledby': `tab-${id}`, class: index === 0 ? '' : 'hidden', tabindex: '0' }, content),
  );
  const tabList = tabs(panels, (selected) => {
    panelNodes.forEach((node) => node.classList.toggle('hidden', node.id !== `panel-${selected}`));
  });

  mount(
    root,
    h(
      'section',
      { class: 'hero', 'aria-labelledby': 'hero-title' },
      h(
        'div',
        {},
        h('h1', { id: 'hero-title' }, 'Care that circles around them. Decisions that stay with them.'),
        h('p', { class: 'tagline' }, 'Kendra (ಕೇಂದ್ರ, "centre") keeps an elder’s medicines, appointments and caregivers in one shared, passcode-protected circle, with the elder at the centre.'),
        h(
          'ul',
          { class: 'pillars' },
          PILLARS.map(([n, title, text]) => h('li', {}, h('span', { class: 'pillar-dot', 'aria-hidden': 'true' }, n), h('div', {}, h('strong', {}, title), h('br'), h('span', { class: 'muted' }, text)))),
        ),
      ),
      h('div', { class: 'panel' }, tabList, panelNodes),
    ),
  );
}
