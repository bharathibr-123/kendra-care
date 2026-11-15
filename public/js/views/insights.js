import { h, mount, formatDate } from '../dom.js';
import { api } from '../api.js';
import { perform } from '../ui.js';

const SLOT_LABEL = { morning: 'Morning', afternoon: 'Afternoon', evening: 'Evening', night: 'Night' };

function stat(label, value, note) {
  return h('div', { class: 'panel stat' }, h('div', { class: 'stat-value' }, value), h('p', { style: 'margin:0.3rem 0 0', class: 'muted' }, label), note ? h('p', { class: 'small muted', style: 'margin:0' }, note) : null);
}

function driftSection(drift) {
  const confidence = (c) => h('span', { class: `chip ${c}` }, `${c} confidence`);
  const delay = (v) => (v === null ? '\u2013' : `${v >= 0 ? '+' : ''}${Math.round(v)} min`);
  return h(
    'section',
    { class: 'panel', 'aria-labelledby': 'drift-title' },
    h('h3', { id: 'drift-title' }, 'Routine drift detection'),
    h('p', { class: 'small muted' }, `Compares the last ${drift.window.recentDays} days with the ${drift.window.baselineDays} days before, using medians (robust to one-off days). ${drift.method}`),
    drift.insights.length
      ? h(
          'ul',
          { class: 'list-plain' },
          drift.insights.map((i) =>
            h('li', {}, h('div', { class: 'row spread' }, h('strong', {}, i.type === 'later_confirmations' ? 'Later than usual' : 'Repeatedly unconfirmed'), confidence(i.confidence)), h('p', { style: 'margin:0.3rem 0' }, i.message), h('p', { class: 'small', style: 'margin:0' }, `\u{1F4A1} ${i.suggestion}`), h('p', { class: 'small muted', style: 'margin:0.2rem 0 0' }, `Basis: ${i.basis}`)),
          ),
        )
      : h('p', {}, drift.hasEnoughData ? 'No change from the usual routine. \u2705' : 'Not enough history yet. Insights appear after about a week of confirmations.'),
    h(
      'details',
      {},
      h('summary', { class: 'small' }, 'See the numbers per dose time'),
      h(
        'table',
        {},
        h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Dose time'), h('th', { scope: 'col' }, 'Usual delay (median)'), h('th', { scope: 'col' }, 'Recent delay'), h('th', { scope: 'col' }, 'Status'))),
        h(
          'tbody',
          {},
          drift.groups.map((g) => h('tr', {}, h('td', {}, g.label), h('td', {}, `${delay(g.baseline.medianDelay)} (${g.baseline.confirmed} days)`), h('td', {}, `${delay(g.recent.medianDelay)} (${g.recent.confirmed}/${g.recent.days} days)`), h('td', {}, g.status === 'insufficient_data' ? h('span', { class: 'small muted' }, g.note) : g.status.replace(/_/g, ' ')))),
        ),
      ),
    ),
  );
}

function dayChart(byDay) {
  return h(
    'figure',
    { style: 'margin:0' },
    h(
      'div',
      { class: 'bars', style: `grid-template-columns: repeat(${byDay.length}, 1fr)`, role: 'img', 'aria-label': `Daily adherence: ${byDay.map((d) => `${formatDate(d.date)} ${d.rate === null ? 'no data' : `${d.rate}%`}`).join(', ')}` },
      byDay.map((d) =>
        h(
          'div',
          { class: 'bar-col' },
          h('span', { class: 'small' }, d.rate === null ? '–' : `${d.rate}%`),
          h('div', { class: `bar${d.rate === null ? ' none' : d.rate < 75 ? ' low' : ''}`, style: `height:${d.rate === null ? 3 : Math.max(4, d.rate)}%` }),
          h('span', { class: 'bar-label' }, byDay.length > 10 ? formatDate(d.date, { day: 'numeric' }) : formatDate(d.date, { weekday: 'short' })),
        ),
      ),
    ),
    h('figcaption', { class: 'small muted' }, 'Share of doses confirmed as taken, per day (unconfirmed doses count as not confirmed, never as missed). Red bars are below 75%.'),
  );
}

function briefView(brief) {
  const list = (title, items) => (items.length ? [h('h3', {}, title), h('ul', {}, items.map((i) => h('li', {}, i)))] : null);
  return h(
    'div',
    { class: 'brief' },
    h('h3', { style: 'margin-top:0' }, brief.headline),
    h('p', {}, brief.summary),
    list('Going well', brief.wins),
    list('Worth watching', brief.watch),
    list('Questions for the doctor', brief.questionsForDoctor),
    h('p', { class: 'small muted' }, brief.source === 'gemini' ? 'Written by Gemini from the numbers above. It never gives medical advice.' : 'Generated from the numbers above.'),
  );
}

let period = 'week';

export function renderInsights(root, ctx) {
  const { data } = ctx;
  const { circle } = data;
  const adherence = period === 'week' ? data.adherence : data.adherenceMonth;
  const periodToggle = h(
    'div',
    { class: 'seg', role: 'group', 'aria-label': 'Period' },
    ['week', 'month'].map((p) =>
      h('button', { type: 'button', 'aria-pressed': String(p === period), onClick: () => { period = p; renderInsights(root, ctx); } }, p === 'week' ? 'Last 7 days' : 'Last 30 days'),
    ),
  );
  const canSend = circle.me.role === 'elder' || circle.me.role === 'caretaker';
  const briefBox = h('div', { 'aria-live': 'polite' }, h('p', { class: 'muted' }, 'Turn this week’s numbers into a short, plain-language summary for the family and the next doctor visit.'));

  const generate = async (button) => {
    button.disabled = true;
    briefBox.replaceChildren(h('p', { class: 'muted' }, 'Writing the brief…'));
    try {
      const { brief } = await api.get('/api/ai/brief');
      briefBox.replaceChildren(briefView(brief));
    } catch (error) {
      briefBox.replaceChildren(h('p', { class: 'field-error' }, error.message));
    } finally {
      button.disabled = false;
    }
  };
  const send = () =>
    perform(() => api.post('/api/ai/brief/send'), {
      success: (r) => (r.status === 'sent' ? `Brief emailed to ${r.recipients} people.` : r.status === 'simulated' ? 'Brief recorded (email simulated in this mode).' : 'The email could not be delivered.'),
      refresh: ctx.refresh,
    }).catch(() => {});

  const generateButton = h('button', { type: 'button' }, data.services.ai ? '✨ Write care brief with Gemini' : 'Write care brief');
  generateButton.addEventListener('click', () => generate(generateButton));
  const { totals } = adherence;

  mount(
    root,
    h(
      'div',
      { class: 'stack' },
      h('div', { class: 'row spread' }, h('h2', { style: 'margin:0' }, 'Insights'), periodToggle),
      h(
        'div',
        { class: 'grid grid-3' },
        stat('confirmation rate', totals.rate === null ? '\u2013' : `${totals.rate}%`, `${formatDate(adherence.from)} \u2013 ${formatDate(adherence.to)}`),
        stat('days in a row, all confirmed', String(adherence.streakDays)),
        stat('unconfirmed doses', String(totals.unconfirmed), `${totals.missed} reported missed \u00B7 ${totals.taken} confirmed`),
      ),
      driftSection(data.drift),
      h('section', { class: 'panel', 'aria-labelledby': 'daily-title' }, h('h3', { id: 'daily-title' }, 'Day by day'), dayChart(adherence.byDay)),
      h(
        'div',
        { class: 'grid grid-2' },
        h(
          'section',
          { class: 'panel', 'aria-labelledby': 'med-title' },
          h('h3', { id: 'med-title' }, 'By medicine'),
          h('table', {}, h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Medicine'), h('th', { scope: 'col' }, 'Confirmed'), h('th', { scope: 'col' }, 'Rate'))), h('tbody', {}, adherence.byMedication.map((m) => h('tr', {}, h('td', {}, m.name), h('td', {}, `${m.taken}/${m.scheduled}`), h('td', {}, m.rate === null ? '–' : `${m.rate}%`))))),
        ),
        h(
          'section',
          { class: 'panel', 'aria-labelledby': 'slot-title' },
          h('h3', { id: 'slot-title' }, 'By time of day'),
          h('table', {}, h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Time'), h('th', { scope: 'col' }, 'Unconfirmed'), h('th', { scope: 'col' }, 'Rate'))), h('tbody', {}, Object.entries(adherence.bySlot).filter(([, s]) => s.scheduled > 0).map(([slot, s]) => h('tr', {}, h('td', {}, SLOT_LABEL[slot]), h('td', {}, String(s.unconfirmed + s.missed)), h('td', {}, s.rate === null ? '–' : `${s.rate}%`))))),
        ),
      ),
      h(
        'section',
        { class: 'panel', 'aria-labelledby': 'brief-title' },
        h('div', { class: 'row spread' }, h('h3', { id: 'brief-title', style: 'margin:0' }, 'Weekly care brief'), h('div', { class: 'row' }, generateButton, canSend ? h('button', { type: 'button', class: 'secondary', onClick: send }, 'Email to the circle') : null)),
        briefBox,
        h('p', { class: 'small muted' }, 'The brief is also emailed automatically every Sunday evening.'),
      ),
    ),
  );
}
