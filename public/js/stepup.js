import { api } from './api.js';
import { el } from './dom.js';

export function askCode({ title, devSms, phoneHint, confirmLabel } = {}) {
  const input = el('input', {
    id: 'sms-code',
    type: 'text',
    inputmode: 'numeric',
    autocomplete: 'one-time-code',
    maxlength: '6',
    required: true,
  });
  const error = el('p', { class: 'form-error', role: 'alert', hidden: true });
  const dialog = el('dialog', { class: 'sms-dialog' }, [
    el('form', { class: 'stack' }, [
      el('h3', {}, title || 'Enter the text code'),
      el('p', {}, devSms
        ? 'Dev mode: this code was printed in the server console. It was not sent by text.'
        : `Enter the 6-digit code texted to the owner phone ending ${phoneHint || 'on file'}.`),
      el('label', { class: 'field' }, [el('span', {}, 'Text code'), input]),
      error,
      el('div', { class: 'row-actions' }, [
        el('button', { class: 'btn btn-ghost', type: 'button' }, 'Cancel'),
        el('button', { class: 'btn btn-primary', type: 'submit' }, confirmLabel || 'Verify code'),
      ]),
    ]),
  ]);
  document.body.append(dialog);
  dialog.showModal();
  input.focus();
  return new Promise((resolve, reject) => {
    let settled = false;
    dialog.querySelector('.btn-ghost').addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => {
      dialog.remove();
      if (!settled) reject(new Error('Cancelled.'));
    }, { once: true });
    dialog.querySelector('form').addEventListener('submit', (event) => {
      event.preventDefault();
      const code = input.value.trim();
      if (!/^\d{6}$/.test(code)) {
        error.hidden = false;
        error.textContent = 'Enter the 6-digit code.';
        return;
      }
      settled = true;
      resolve(code);
      dialog.close();
    });
  });
}

export async function stepUp(purpose, payload, options = {}) {
  const started = await api('/api/admin/challenges', {
    method: 'POST',
    body: { purpose, ...payload },
  });
  const code = await askCode({ ...options, devSms: started.devSms, phoneHint: started.phoneHint });
  return api(`/api/admin/challenges/${started.challengeId}/confirm`, {
    method: 'POST',
    body: { code },
  });
}
