import { el } from './dom.js';

const slots = new Set();

function installedAlready() {
  return window.matchMedia('(display-mode: standalone)').matches
    || window.matchMedia('(display-mode: fullscreen)').matches
    || window.matchMedia('(display-mode: minimal-ui)').matches
    || window.navigator.standalone === true;
}

function isAppleMobile() {
  const ua = navigator.userAgent || '';
  return /iPad|iPhone|iPod/.test(ua)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function promptEvent() {
  return window.__movesafeInstall?.prompt || null;
}

export function installSlot(variant = 'block') {
  const slot = el('div', { class: `install-slot install-${variant}` });
  slots.add(slot);
  paint(slot, variant);
  return slot;
}

function paint(slot, variant) {
  const mode = slot.dataset.variant || variant;
  slot.dataset.variant = mode;
  slot.replaceChildren();
  if (installedAlready() || window.__movesafeInstall?.installed) return;

  const deferred = promptEvent();
  if (deferred) {
    const button = el('button', {
      class: `btn install-btn ${mode === 'bar' ? 'btn-ghost' : 'btn-primary'}`,
      type: 'button',
    }, 'Install app');
    button.addEventListener('click', () => offerInstall(button));
    slot.append(button);
    return;
  }

  if (!isAppleMobile()) return;
  const text = 'iPhone and iPad: open this page in Safari, tap Share, then Add to Home Screen. A survey link still opens that visit.';
  if (mode === 'bar') {
    slot.append(el('p', { class: 'install-inline' }, 'iPhone: Safari Share, then Add to Home Screen.'));
    return;
  }
  slot.append(el('p', { class: 'install-note' }, [
    el('strong', {}, 'Add to your Home Screen. '),
    text,
  ]));
}

async function offerInstall(button) {
  const deferred = promptEvent();
  if (!deferred) return;
  button.disabled = true;
  try {
    await deferred.prompt();
    await deferred.userChoice;
  } catch {
    /* the browser already closed the prompt */
  }
  if (window.__movesafeInstall) window.__movesafeInstall.prompt = null;
  refresh();
}

function refresh() {
  for (const slot of slots) {
    if (!slot.isConnected) {
      slots.delete(slot);
      continue;
    }
    paint(slot, slot.dataset.variant || 'block');
  }
}

window.addEventListener('movesafe-install-ready', refresh);
window.matchMedia('(display-mode: standalone)').addEventListener?.('change', refresh);
refresh();
