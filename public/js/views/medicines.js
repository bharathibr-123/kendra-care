import { h, mount, field, showFieldErrors, formatTime, toast } from '../dom.js';
import { api } from '../api.js';
import { openDialog, perform, changeMessage, emptyState } from '../ui.js';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

function timesEditor(initial) {
  const list = h('div', { class: 'stack' });
  const addRow = (value = '') => {
    if (list.children.length >= 8) return;
    const index = list.children.length + 1;
    const input = h('input', { type: 'time', name: 'times', value, required: true, 'aria-label': `Dose time ${index}` });
    const remove = h('button', { type: 'button', class: 'secondary', 'aria-label': `Remove dose time ${index}` }, 'Remove');
    const row = h('div', { class: 'row' }, h('div', { style: 'flex:1' }, input), remove);
    remove.addEventListener('click', () => {
      if (list.children.length > 1) row.remove();
    });
    list.append(row);
  };
  (initial.length ? initial : ['08:00']).forEach(addRow);
  return h(
    'fieldset',
    {},
    h('legend', {}, 'Dose times'),
    list,
    h('button', { type: 'button', class: 'secondary', style: 'margin-top:0.6rem', onClick: () => addRow('') }, '+ Add another time'),
  );
}

function daysEditor(selected) {
  return h(
    'fieldset',
    {},
    h('legend', {}, 'Days ', h('span', { class: 'hint' }, 'Leave all unticked for every day')),
    h('div', { class: 'checks' }, DAYS.map((day, i) => h('label', {}, h('input', { type: 'checkbox', name: 'days', value: String(i), checked: selected.includes(i) }), day))),
  );
}

function readMedicationForm(form) {
  const data = new FormData(form);
  const number = (key) => (data.get(key) === '' || data.get(key) === null ? null : Number(data.get(key)));
  return {
    name: data.get('name'),
    dosage: data.get('dosage'),
    instructions: data.get('instructions'),
    times: data.getAll('times').filter(Boolean),
    days: data.getAll('days').map(Number),
    startDate: data.get('startDate') || null,
    endDate: data.get('endDate') || null,
    stock: number('stock'),
    refillAt: number('refillAt'),
  };
}

export function medicationForm(med, { onSubmit, submitLabel }) {
  const form = h(
    'form',
    { novalidate: true },
    field({ label: 'Medicine name', name: 'name', value: med.name || '', required: true, attrs: { maxlength: 80 } }),
    h('div', { class: 'grid grid-2' }, field({ label: 'Dose', name: 'dosage', value: med.dosage || '', hint: 'e.g. 500 mg, 1 tablet', attrs: { maxlength: 60 } }), field({ label: 'Instructions', name: 'instructions', value: med.instructions || '', hint: 'e.g. after food', attrs: { maxlength: 300 } })),
    timesEditor(med.times || []),
    daysEditor(med.days || []),
    h('div', { class: 'grid grid-2' }, field({ label: 'Start date', name: 'startDate', type: 'date', value: med.startDate || '' }), field({ label: 'End date', name: 'endDate', type: 'date', value: med.endDate || '', hint: 'Optional' })),
    h('div', { class: 'grid grid-2' }, field({ label: 'Doses in stock', name: 'stock', type: 'number', value: med.stock ?? '', hint: 'Optional, counts down as doses are taken', attrs: { min: 0, max: 10000 } }), field({ label: 'Alert when stock falls to', name: 'refillAt', type: 'number', value: med.refillAt ?? '', attrs: { min: 0, max: 1000 } })),
    h('button', { type: 'submit', class: 'big' }, submitLabel),
  );
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await onSubmit(readMedicationForm(form));
    } catch (error) {
      showFieldErrors(form, error);
    }
  });
  return form;
}

function openMedicationDialog(ctx, med) {
  const { data } = ctx;
  const editing = Boolean(med?.id);
  openDialog(editing ? `Edit ${med.name}` : 'Add a medicine', (close) =>
    medicationForm(med || {}, {
      submitLabel: editing ? 'Save changes' : 'Add medicine',
      onSubmit: async (values) => {
        await perform(() => (editing ? api.put(`/api/medications/${med.id}`, values) : api.post('/api/medications', values)), {
          success: (result) => changeMessage(result, editing ? 'Medicine updated.' : 'Medicine added.', data.circle.elderName),
          refresh: ctx.refresh,
        });
        close();
      },
    }),
  );
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(new Error('Could not read that file.'));
    reader.readAsDataURL(file);
  });
}

function openScanDialog(ctx) {
  const { data } = ctx;
  openDialog('Scan a prescription', (close) => {
    const status = h('p', { class: 'muted', role: 'status', 'aria-live': 'polite' }, 'Take a clear photo of the prescription or medicine strip. Gemini reads it into a draft that you check before saving.');
    const results = h('div', { class: 'stack' });
    const input = h('input', { type: 'file', id: 'rx-file', accept: 'image/jpeg,image/png,image/webp', capture: 'environment' });

    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      if (file.size > MAX_IMAGE_BYTES) {
        status.textContent = 'That image is larger than 4 MB. Please use a smaller photo.';
        return;
      }
      status.textContent = 'Reading the prescription…';
      results.replaceChildren();
      try {
        const scan = await api.post('/api/ai/prescription', { mimeType: file.type, data: await fileToBase64(file) });
        status.textContent = scan.medications.length ? `Found ${scan.medications.length} medicine(s). Please check each one carefully.` : 'No medicines could be read.';
        scan.warnings.forEach((w) => results.append(h('p', { class: 'chip due' }, w)));
        scan.medications.forEach((draft) => {
          const box = h('div', { class: 'panel' }, h('p', { class: 'small muted' }, draft.frequency ? `Read as "${draft.frequency}"` : 'Draft from the photo'));
          box.append(
            medicationForm(draft, {
              submitLabel: `Save ${draft.name}`,
              onSubmit: async (values) => {
                await perform(() => api.post('/api/medications', values), {
                  success: (result) => changeMessage(result, `${values.name} added.`, data.circle.elderName),
                  refresh: ctx.refresh,
                });
                box.replaceChildren(h('p', {}, `✓ ${values.name} saved.`));
              },
            }),
          );
          results.append(box);
        });
      } catch (error) {
        status.textContent = error.message;
      }
    });

    return h('div', { class: 'stack' }, status, h('div', { class: 'field' }, h('label', { for: 'rx-file' }, 'Prescription photo'), input), results, h('button', { type: 'button', class: 'secondary', onClick: close }, 'Done'));
  });
}

export function renderMedicines(root, ctx) {
  const { data } = ctx;
  const remove = (med) => {
    if (!window.confirm(`Remove ${med.name} from the schedule?`)) return;
    perform(() => api.del(`/api/medications/${med.id}`), {
      success: (result) => changeMessage(result, `${med.name} removed.`, data.circle.elderName),
      refresh: ctx.refresh,
    }).catch(() => {});
  };
  const togglePause = (med) =>
    perform(() => api.put(`/api/medications/${med.id}`, { active: med.active === false }), {
      success: (result) => changeMessage(result, med.active === false ? `${med.name} resumed.` : `${med.name} paused.`, data.circle.elderName),
      refresh: ctx.refresh,
    }).catch(() => {});

  const needsApproval = data.circle.me.role !== 'elder' && data.circle.settings.requireApproval;

  mount(
    root,
    h(
      'div',
      { class: 'stack' },
      h(
        'div',
        { class: 'row spread' },
        h('h2', {}, 'Medicines'),
        h(
          'div',
          { class: 'row' },
          h('button', { type: 'button', class: 'secondary', onClick: () => (data.services.ai ? openScanDialog(ctx) : toast('Prescription scanning needs a Gemini API key on the server.', { error: true })) }, '\u{1F4F7} Scan prescription'),
          h('button', { type: 'button', onClick: () => openMedicationDialog(ctx) }, '+ Add medicine'),
        ),
      ),
      needsApproval ? h('p', { class: 'demo-bar' }, `Changes you make are sent to ${data.circle.elderName} for approval first.`) : null,
      data.medications.length
        ? h(
            'ul',
            { class: 'grid grid-2 dose-list' },
            data.medications.map((med) =>
              h(
                'li',
                { class: 'panel' },
                h('div', { class: 'row spread' }, h('h3', { style: 'margin:0' }, med.name), med.active === false ? h('span', { class: 'chip skipped' }, 'Paused') : null),
                h('p', { class: 'muted' }, [med.dosage, med.instructions].filter(Boolean).join(' · ') || ' '),
                h('p', {}, h('strong', {}, med.times.map(formatTime).join(', ')), ' · ', med.days?.length ? med.days.map((d) => DAYS[d]).join(', ') : 'Every day'),
                med.stock != null ? h('p', { class: 'small' }, `${med.stock} in stock`, med.refillAt != null && med.stock <= med.refillAt ? h('span', { class: 'chip missed', style: 'margin-left:0.4rem' }, 'Refill soon') : null) : null,
                h(
                  'div',
                  { class: 'row' },
                  h('button', { type: 'button', class: 'secondary', onClick: () => openMedicationDialog(ctx, med), 'aria-label': `Edit ${med.name}` }, 'Edit'),
                  h('button', { type: 'button', class: 'secondary', onClick: () => togglePause(med), 'aria-label': `${med.active === false ? 'Resume' : 'Pause'} ${med.name}` }, med.active === false ? 'Resume' : 'Pause'),
                  h('button', { type: 'button', class: 'danger', onClick: () => remove(med), 'aria-label': `Remove ${med.name}` }, 'Remove'),
                ),
              ),
            ),
          )
        : emptyState('No medicines yet. Add one, or scan a prescription.'),
    ),
  );
}
