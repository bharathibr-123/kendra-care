import { h, toast, announce } from './dom.js';

/** Accessible modal built on the native <dialog> element (focus trapping and Esc for free). */
export function openDialog(title, buildContent) {
  const titleId = `dlg-${Math.random().toString(36).slice(2, 8)}`;
  const dialog = h('dialog', { 'aria-labelledby': titleId });
  const close = () => dialog.close();
  dialog.append(
    h('div', { class: 'row spread' }, h('h2', { id: titleId }, title), h('button', { type: 'button', class: 'secondary', onClick: close, 'aria-label': 'Close dialog' }, '✕')),
    buildContent(close),
  );
  dialog.addEventListener('close', () => {
    dialog.remove();
    window.dispatchEvent(new CustomEvent('kendra:dialog-closed'));
  });
  document.body.append(dialog);
  dialog.showModal();
  return close;
}

/** Runs an API action with consistent feedback: toast, screen-reader announcement, refresh. */
export async function perform(action, { success, refresh } = {}) {
  try {
    const result = await action();
    const message = typeof success === 'function' ? success(result) : success;
    if (message) {
      toast(message);
      announce(message);
    }
    if (refresh) await refresh();
    return result;
  } catch (error) {
    toast(error.message, { error: true });
    throw error;
  }
}

/** Shared wording for change requests that may need the elder's approval (HTTP 202). */
export function changeMessage(result, doneText, elderName) {
  return result?.applied === false ? `Sent to ${elderName} for approval.` : doneText;
}

export function emptyState(text) {
  return h('p', { class: 'empty' }, text);
}

export function speak(text) {
  if (!('speechSynthesis' in window)) {
    toast('Read aloud is not supported in this browser.', { error: true });
    return;
  }
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'en-IN';
  utterance.rate = 0.9;
  window.speechSynthesis.speak(utterance);
}
