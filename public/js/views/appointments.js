import { h, mount, field, showFieldErrors, formatTime, formatDate, chip } from '../dom.js';
import { api } from '../api.js';
import { openDialog, perform, changeMessage, emptyState } from '../ui.js';

/** Builds an "Add to Google Calendar" link (no API key or OAuth needed). */
export function googleCalendarUrl(appt, elderName, timezone) {
  const start = `${appt.date.replaceAll('-', '')}T${appt.time.replace(':', '')}00`;
  const [hh, mm] = appt.time.split(':').map(Number);
  const endMinutes = hh * 60 + mm + 60;
  const end = endMinutes < 24 * 60
    ? `${appt.date.replaceAll('-', '')}T${String(Math.floor(endMinutes / 60)).padStart(2, '0')}${String(endMinutes % 60).padStart(2, '0')}00`
    : `${appt.date.replaceAll('-', '')}T235900`;
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: `${elderName}: Dr. ${appt.doctor}${appt.specialty ? ` (${appt.specialty})` : ''}`,
    dates: `${start}/${end}`,
    ctz: timezone,
    details: appt.notes || 'Added from Kendra care circle',
    location: appt.location || '',
  });
  return `https://calendar.google.com/calendar/render?${params}`;
}

/** Opens Google Maps directions to the clinic (no API key needed). */
export function googleMapsUrl(location) {
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(location)}`;
}

function appointmentForm(appt, { onSubmit, submitLabel }) {
  const form = h(
    'form',
    { novalidate: true },
    h('div', { class: 'grid grid-2' }, field({ label: 'Doctor’s name', name: 'doctor', value: appt.doctor || '', required: true, hint: 'Without "Dr."', attrs: { maxlength: 80 } }), field({ label: 'Speciality', name: 'specialty', value: appt.specialty || '', attrs: { maxlength: 60 } })),
    h('div', { class: 'grid grid-2' }, field({ label: 'Date', name: 'date', type: 'date', value: appt.date || '', required: true }), field({ label: 'Time', name: 'time', type: 'time', value: appt.time || '', required: true })),
    field({ label: 'Hospital or clinic', name: 'location', value: appt.location || '', attrs: { maxlength: 120 } }),
    field({ label: 'Notes', name: 'notes', type: 'textarea', value: appt.notes || '', hint: 'Reports to carry, fasting, questions to ask', attrs: { maxlength: 500 } }),
    h('button', { type: 'submit', class: 'big' }, submitLabel),
  );
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await onSubmit(Object.fromEntries(new FormData(form)));
    } catch (error) {
      showFieldErrors(form, error);
    }
  });
  return form;
}

function openAppointmentDialog(ctx, appt) {
  const editing = Boolean(appt?.id);
  openDialog(editing ? 'Edit appointment' : 'Add an appointment', (close) =>
    appointmentForm(appt || {}, {
      submitLabel: editing ? 'Save changes' : 'Add appointment',
      onSubmit: async (values) => {
        await perform(() => (editing ? api.put(`/api/appointments/${appt.id}`, values) : api.post('/api/appointments', values)), {
          success: (result) => changeMessage(result, editing ? 'Appointment updated.' : 'Appointment added. Everyone will be reminded 24 hours and 2 hours before.', ctx.data.circle.elderName),
          refresh: ctx.refresh,
        });
        close();
      },
    }),
  );
}

function appointmentCard(appt, ctx, isPast) {
  const { circle } = ctx.data;
  const setStatus = (status) =>
    perform(() => api.put(`/api/appointments/${appt.id}`, { status }), {
      success: (result) => changeMessage(result, status === 'done' ? 'Marked as done.' : 'Appointment cancelled.', circle.elderName),
      refresh: ctx.refresh,
    }).catch(() => {});
  const remove = () => {
    if (!window.confirm('Delete this appointment?')) return;
    perform(() => api.del(`/api/appointments/${appt.id}`), { success: (result) => changeMessage(result, 'Appointment deleted.', circle.elderName), refresh: ctx.refresh }).catch(() => {});
  };

  return h(
    'li',
    { class: 'panel' },
    h('div', { class: 'row spread' }, h('h3', { style: 'margin:0' }, `Dr. ${appt.doctor}`), chip(appt.status === 'upcoming' && isPast ? 'due' : appt.status === 'done' ? 'taken' : appt.status === 'cancelled' ? 'skipped' : 'upcoming', appt.status === 'upcoming' && isPast ? 'Needs update' : appt.status)),
    appt.specialty ? h('p', { class: 'muted', style: 'margin:0' }, appt.specialty) : null,
    h('p', { class: 'dose-name', style: 'margin-top:0.4rem' }, `${formatDate(appt.date, { weekday: 'long', day: 'numeric', month: 'long' })} · ${formatTime(appt.time)}`),
    appt.location ? h('p', {}, appt.location) : null,
    appt.notes ? h('p', { class: 'small muted' }, appt.notes) : null,
    h(
      'div',
      { class: 'row' },
      appt.status === 'upcoming' && !isPast ? h('a', { class: 'button secondary', href: googleCalendarUrl(appt, circle.elderName, circle.timezone), target: '_blank', rel: 'noopener noreferrer' }, 'Add to Google Calendar') : null,
      appt.status === 'upcoming' && !isPast && appt.location ? h('a', { class: 'button secondary', href: googleMapsUrl(appt.location), target: '_blank', rel: 'noopener noreferrer', 'aria-label': `Directions to ${appt.location} in Google Maps` }, 'Directions') : null,
      appt.status === 'upcoming' ? h('button', { type: 'button', class: 'secondary', onClick: () => setStatus('done') }, 'Mark done') : null,
      h('button', { type: 'button', class: 'secondary', onClick: () => openAppointmentDialog(ctx, appt) }, 'Edit'),
      appt.status === 'upcoming' ? h('button', { type: 'button', class: 'danger', onClick: () => setStatus('cancelled') }, 'Cancel') : h('button', { type: 'button', class: 'danger', onClick: remove }, 'Delete'),
    ),
  );
}

export function renderAppointments(root, ctx) {
  const { data } = ctx;
  const nowKey = `${data.now.date}T${data.now.time}`;
  const upcoming = data.appointments.filter((a) => a.status === 'upcoming' && `${a.date}T${a.time}` >= nowKey);
  const past = data.appointments.filter((a) => !upcoming.includes(a)).reverse();

  mount(
    root,
    h(
      'div',
      { class: 'stack' },
      h('div', { class: 'row spread' }, h('h2', {}, 'Appointments'), h('button', { type: 'button', onClick: () => openAppointmentDialog(ctx) }, '+ Add appointment')),
      h('section', { 'aria-labelledby': 'upcoming-title' }, h('h3', { id: 'upcoming-title' }, 'Upcoming'), upcoming.length ? h('ul', { class: 'grid grid-2 dose-list' }, upcoming.map((a) => appointmentCard(a, ctx, false))) : emptyState('No upcoming appointments.')),
      past.length ? h('section', { 'aria-labelledby': 'past-title' }, h('h3', { id: 'past-title' }, 'Past and cancelled'), h('ul', { class: 'grid grid-2 dose-list' }, past.map((a) => appointmentCard(a, ctx, true)))) : null,
    ),
  );
}
