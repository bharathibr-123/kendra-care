/**
 * Tiny DOM helpers. All user-provided text goes through textContent (never innerHTML),
 * which keeps the UI immune to stored XSS by construction.
 */

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    // CSSOM assignment is allowed by our strict CSP, unlike inline style attributes.
    else if (key === 'style') el.style.cssText = value;
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value === true) el.setAttribute(key, '');
    else el.setAttribute(key, String(value));
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export function mount(target, ...children) {
  target.replaceChildren();
  append(target, children);
}

export function announce(message) {
  const region = document.getElementById('announcer');
  region.textContent = '';
  // A new text node after a tick makes screen readers re-announce identical messages.
  setTimeout(() => {
    region.textContent = message;
  }, 50);
}

export function toast(message, { error = false } = {}) {
  const box = document.getElementById('toasts');
  const item = h('div', { class: `toast${error ? ' error' : ''}`, role: error ? 'alert' : 'status' }, message);
  box.append(item);
  setTimeout(() => item.remove(), 5000);
}

export function formatTime(time) {
  const [hh, mm] = time.split(':').map(Number);
  const suffix = hh >= 12 ? 'PM' : 'AM';
  return `${((hh + 11) % 12) + 1}:${String(mm).padStart(2, '0')} ${suffix}`;
}

export function formatDate(date, options = { weekday: 'short', day: 'numeric', month: 'short' }) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-IN', { ...options, timeZone: 'UTC' });
}

export function timeAgo(iso) {
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

/** Shows server-side validation errors next to the matching inputs. */
export function showFieldErrors(form, error) {
  form.querySelectorAll('.field-error').forEach((node) => node.remove());
  form.querySelectorAll('[aria-invalid]').forEach((node) => node.removeAttribute('aria-invalid'));
  let first = null;
  for (const field of error?.fields || []) {
    const input = form.querySelector(`[name="${CSS.escape(field.path.split('.')[0])}"]`);
    if (!input) continue;
    const id = `${input.id || input.name}-error`;
    input.setAttribute('aria-invalid', 'true');
    input.setAttribute('aria-describedby', id);
    input.closest('.field, fieldset')?.append(h('p', { class: 'field-error', id }, field.message));
    first ??= input;
  }
  first?.focus();
}

export function field({ label, name, type = 'text', value = '', hint, required, attrs = {} }) {
  const id = `f-${name}-${Math.random().toString(36).slice(2, 7)}`;
  const control =
    type === 'textarea'
      ? h('textarea', { id, name, rows: 3, required, ...attrs }, value)
      : h('input', { id, name, type, value, required, ...attrs });
  return h('div', { class: 'field' }, h('label', { for: id }, label, hint ? h('span', { class: 'hint' }, hint) : null), control);
}

export function chip(status, text = status) {
  return h('span', { class: `chip ${status}` }, text);
}
