import { api, currentStaff } from './api.js';
import { brand, el, toast } from './dom.js';
import { icon } from './icons.js';
import { mountCall } from './call.js';
import { installSlot } from './install.js';
import { renderInventory } from './inventory.js';
import { renderAdmin, renderInvite, renderSetup } from './admin.js';
import { stepUp } from './stepup.js';
import {
  copyText,
  formatBytes,
  formatCode,
  formatDuration,
  formatWhen,
  inviteText,
  routeLabel,
} from './format.js';

let renderGen = 0;
let cleanup = null;
let pollTimer = null;

function parseRoute() {
  const path = location.pathname.replace(/\/+$/, '') || '/';
  const call = path.match(/^\/c\/([A-Za-z0-9]+)$/);
  if (call) return { name: 'call', roomId: call[1] };
  const inventory = path.match(/^\/inventory\/([A-Za-z0-9]+)$/);
  if (inventory) return { name: 'inventory', roomId: inventory[1] };
  const invite = path.match(/^\/invite\/([A-Za-z0-9_-]+)$/);
  if (invite) return { name: 'invite', token: invite[1] };
  if (path === '/login') return { name: 'login' };
  if (path === '/admin') return { name: 'admin' };
  if (path === '/setup') return { name: 'setup' };
  if (path === '/recordings') return { name: 'recordings' };
  if (path === '/thanks') return { name: 'thanks' };
  if (path === '/') return { name: 'home' };
  return { name: 'missing' };
}

export function navigate(path) {
  if (location.pathname === path) {
    render();
    return;
  }
  history.pushState({}, '', path);
  render();
}

async function render() {
  const gen = ++renderGen;
  clearTimeout(pollTimer);
  if (cleanup) {
    const fn = cleanup;
    cleanup = null;
    await fn();
  }
  if (gen !== renderGen) return;
  const root = document.getElementById('app');
  document.body.classList.remove('in-call');
  root.replaceChildren(el('p', { class: 'loading' }, 'Loading…'));
  const route = parseRoute();
  try {
    if (route.name === 'call') {
      const handle = await mountCall(root, route.roomId);
      if (gen !== renderGen) {
        await handle.destroy();
        return;
      }
      cleanup = handle.destroy;
      return;
    }
    cleanup = null;
    if (route.name === 'login') await renderLogin(root);
    else if (route.name === 'admin') {
      const adminUser = await currentStaff();
      if (!adminUser) {
        navigate('/login');
        return;
      }
      await renderAdmin(root, adminUser);
    }
    else if (route.name === 'setup') await renderSetup(root);
    else if (route.name === 'invite') await renderInvite(root, route.token);
    else if (route.name === 'inventory') await renderInventory(root, route.roomId);
    else if (route.name === 'home') await renderHome(root);
    else if (route.name === 'recordings') await renderRecordings(root);
    else if (route.name === 'thanks') renderThanks(root);
    else renderMissing(root);
  } catch (err) {
    if (gen !== renderGen) return;
    root.replaceChildren(el('main', { class: 'center-page' }, [
      brand('/'),
      el('h1', {}, 'Something went wrong'),
      el('p', { class: 'lede' }, err.message || 'Reload and try again.'),
    ]));
  }
}

function shell(active, staff, children) {
  return el('div', { class: 'app-shell' }, [
    el('header', { class: 'topbar' }, [
      brand('/'),
      el('nav', { class: 'topnav' }, [
        el('a', { href: '/', class: active === 'home' ? 'active' : '' }, 'Surveys'),
        el('a', { href: '/recordings', class: active === 'recordings' ? 'active' : '' }, 'Recordings'),
        staff.role === 'owner' ? el('a', { href: '/admin', class: active === 'admin' ? 'active' : '' }, 'Admin') : null,
        installSlot('bar'),
        el('span', { class: 'who' }, staff.name),
        el('button', { class: 'btn btn-ghost', type: 'button', onclick: logout }, 'Log out'),
      ]),
    ]),
    ...children,
  ]);
}

async function logout() {
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  navigate('/login');
}

async function renderLogin(root) {
  const me = await currentStaff();
  if (me) {
    navigate('/');
    return;
  }
  document.title = 'Staff login · MoveSafe Relocation';
  const config = await api('/api/config').catch(() => null);
  const error = el('p', { class: 'form-error', role: 'alert', hidden: true });
  const email = el('input', { type: 'email', autocomplete: 'username', required: true });
  const password = el('input', { type: 'password', autocomplete: 'current-password', required: true });
  const form = el('form', { class: 'stack', id: 'login-form' }, [
    el('label', { class: 'field' }, [el('span', {}, 'Email'), email]),
    el('label', { class: 'field' }, [el('span', {}, 'Password'), password]),
    error,
    el('button', { class: 'btn btn-primary', type: 'submit' }, 'Sign in'),
  ]);
  const showOwnerCode = (result) => {
    const code = el('input', { id: 'sms-code', type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '6', required: true });
    const mfaError = el('p', { class: 'form-error', role: 'alert', hidden: true });
    const mfa = el('form', { class: 'stack', id: 'mfa-form' }, [
      el('p', {}, result.devSms
        ? 'Dev mode: the text code was printed in the server console. It was not sent.'
        : `Enter the 6-digit code texted to the owner phone ending ${result.phoneHint || 'on file'}.`),
      el('label', { class: 'field' }, [el('span', {}, 'Text code'), code]),
      mfaError,
      el('button', { class: 'btn btn-primary', type: 'submit' }, 'Verify code'),
    ]);
    mfa.addEventListener('submit', async (event) => {
      event.preventDefault();
      mfaError.hidden = true;
      try {
        await api('/api/login/mfa', { method: 'POST', body: { challengeId: result.challengeId, code: code.value } });
        navigate('/');
      } catch (err) {
        mfaError.hidden = false;
        mfaError.textContent = err.message;
      }
    });
    form.replaceWith(mfa);
    code.focus();
  };
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    error.hidden = true;
    const button = form.querySelector('button');
    button.disabled = true;
    try {
      const result = await api('/api/login', {
        method: 'POST',
        body: { email: email.value, password: password.value },
      });
      if (result.mfaRequired) {
        showOwnerCode(result);
        return;
      }
      navigate('/');
    } catch (err) {
      error.hidden = false;
      error.textContent = err.message;
      button.disabled = false;
    }
  });

  const demo = config?.demo
    ? el('div', { class: 'demo-note' }, [
        el('p', {}, [el('strong', {}, 'Dev demo only. '), config.demo.note || 'Disabled in production.']),
        el('p', {}, 'Owner sign-in also asks for a text code. In dev that code is printed in the server console.'),
        el('p', {}, [el('strong', {}, config.demo.email), ` · ${config.demo.password}`]),
        el('button', {
          class: 'btn btn-ghost',
          type: 'button',
          onclick: () => {
            email.value = config.demo.email;
            password.value = config.demo.password;
            form.requestSubmit();
          },
        }, 'Use demo login'),
      ])
    : null;

  root.replaceChildren(
    el('main', { class: 'auth-shell' }, [
      el('section', { class: 'brand-panel' }, [
        brand(null),
        el('h1', {}, 'Video walkthroughs for careful moves.'),
        el('p', {}, 'Survey a home with the customer, then keep the recording with the estimate. They join from a phone browser. No account is required, and installing the app is optional.'),
        el('ul', { class: 'points' }, [
          el('li', {}, 'Share a link. They walk the house on the rear camera.'),
          el('li', {}, 'Record both sides of the call when you are ready.'),
          el('li', {}, 'Play it back in the office library.'),
        ]),
      ]),
      el('section', { class: 'auth-card' }, [
        el('p', { class: 'eyebrow' }, 'Staff desk'),
        el('h2', {}, 'Sign in'),
        el('p', { class: 'lede' }, 'Staff sign in to open survey rooms. There is no public registration.'),
        form,
        demo,
        installSlot('block'),
      ]),
    ]),
  );
}

async function renderHome(root) {
  const me = await currentStaff();
  if (!me) {
    navigate('/login');
    return;
  }
  document.title = 'Video surveys · MoveSafe Relocation';
  const data = await api('/api/rooms');
  const error = el('p', { class: 'form-error', role: 'alert', hidden: true });
  const form = el('form', { class: 'stack', id: 'create-survey' }, [
    field('Customer name', 'customerName', 'text', true),
    field('Phone', 'customerPhone', 'tel', false),
    field('Moving from', 'origin', 'text', false),
    field('Moving to', 'destination', 'text', false),
    field('Move date', 'moveDate', 'date', false),
    el('label', { class: 'field' }, [
      el('span', {}, 'Office notes'),
      el('textarea', { name: 'notes', rows: '3', maxlength: '1000', placeholder: 'Stairs, parking, pianos, gate codes…' }),
    ]),
    error,
    el('button', { class: 'btn btn-primary', type: 'submit' }, 'Create video survey'),
  ]);
  let highlight = sessionStorage.getItem('movesafe-new-room');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    error.hidden = true;
    const body = Object.fromEntries(new FormData(form).entries());
    const button = form.querySelector('button');
    button.disabled = true;
    try {
      const created = await api('/api/rooms', { method: 'POST', body });
      sessionStorage.setItem('movesafe-new-room', created.room.id);
      form.reset();
      toast('Survey link is ready to send.');
      render();
    } catch (err) {
      error.hidden = false;
      error.textContent = err.message;
      button.disabled = false;
    }
  });

  const list = el('div', { class: 'card-list' });
  if (!data.rooms.length) {
    list.append(el('div', { class: 'empty' }, [
      el('h3', {}, 'No surveys yet'),
      el('p', {}, 'Create a room, send the link, and meet the customer in their browser.'),
    ]));
  }
  for (const room of data.rooms) {
    list.append(roomCard(room, room.id === highlight));
  }
  if (highlight) sessionStorage.removeItem('movesafe-new-room');

  root.replaceChildren(shell('home', me, [
    el('main', { class: 'layout' }, [
      el('section', { class: 'create-card' }, [
        el('p', { class: 'eyebrow' }, 'New survey'),
        el('h1', {}, 'Video surveys'),
        el('p', { class: 'lede' }, 'Open a room, send the link, and record the walkthrough when the customer is ready.'),
        form,
      ]),
      el('section', {}, [
        el('div', { class: 'section-head' }, [
          el('h2', {}, 'Recent rooms'),
          el('p', {}, 'Customers never need an account.'),
        ]),
        list,
      ]),
    ]),
  ]));
}

function field(label, name, type, required) {
  return el('label', { class: 'field' }, [
    el('span', {}, label),
    el('input', { name, type, required, maxlength: type === 'text' || type === 'tel' ? '80' : undefined }),
  ]);
}

function roomCard(room, expanded) {
  const link = `${location.origin}/c/${room.id}`;
  const invite = el('textarea', { name: 'invite', readOnly: true, rows: '8' });
  invite.value = inviteText({ customerName: room.customerName, link });
  const route = routeLabel(room.origin, room.destination);
  return el('article', { class: `room-card${expanded ? ' highlight' : ''}` }, [
    el('div', { class: 'room-card-top' }, [
      el('div', {}, [
        el('h3', {}, room.customerName),
        route ? el('p', { class: 'route' }, route) : null,
        el('p', { class: 'meta' }, [
          `Room ${formatCode(room.id)}`,
          ' · ',
          formatWhen(room.createdAt),
          room.inCall ? ' · In call' : '',
          room.recordingCount ? ` · ${room.recordingCount} recording${room.recordingCount === 1 ? '' : 's'}` : '',
          room.inventoryCubicFeet ? ` · ${room.inventoryCubicFeet} cu ft` : '',
        ]),
      ]),
    ]),
    expanded ? el('div', { class: 'share-box' }, [
      el('p', { class: 'eyebrow' }, 'Send this to the customer'),
      el('label', { class: 'field' }, [el('span', {}, 'Invite message'), invite]),
      el('div', { class: 'row-actions' }, [
        el('button', { class: 'btn btn-primary', type: 'button', onclick: async (event) => {
          const ok = await copyText(invite.value);
          event.currentTarget.textContent = ok ? 'Copied' : 'Copy failed';
        } }, 'Copy invite'),
        el('button', { class: 'btn btn-ghost', type: 'button', onclick: async (event) => {
          const ok = await copyText(link);
          event.currentTarget.textContent = ok ? 'Copied' : 'Copy failed';
        } }, 'Copy link'),
      ]),
    ]) : null,
    el('div', { class: 'row-actions' }, [
      el('a', { class: 'btn btn-primary', href: `/c/${room.id}` }, 'Join call'),
      el('a', { class: 'btn btn-ghost', href: `/inventory/${room.id}` }, 'Inventory'),
      el('a', { class: 'btn btn-ghost', href: `/c/${room.id}?guest=1`, target: '_blank' }, 'Customer view'),
      room.customerPhone ? el('span', { class: 'meta' }, room.customerPhone) : null,
    ]),
  ]);
}

async function renderRecordings(root) {
  const me = await currentStaff();
  if (!me) {
    navigate('/login');
    return;
  }
  document.title = 'Recordings · MoveSafe Relocation';
  const data = await api('/api/recordings');
  const search = el('input', { type: 'search', placeholder: 'Search by customer or room' });
  const grid = el('div', { class: 'rec-grid' });
  const empty = el('div', { class: 'empty', hidden: data.recordings.length > 0 }, [
    el('h3', {}, 'No recordings yet'),
    el('p', {}, 'Start a video survey and press Record. The saved walkthrough shows up here for playback and download.'),
  ]);
  const none = el('p', { class: 'empty', hidden: true }, 'No recordings match that search.');

  const paint = () => {
    const query = search.value.trim().toLowerCase();
    let shown = 0;
    grid.replaceChildren();
    for (const rec of data.recordings) {
      const hay = `${rec.customerName} ${rec.roomId} ${rec.origin || ''} ${rec.destination || ''}`.toLowerCase();
      if (query && !hay.includes(query)) continue;
      shown += 1;
      grid.append(recordingCard(rec, me, () => render()));
    }
    empty.hidden = data.recordings.length !== 0;
    none.hidden = !(data.recordings.length && shown === 0);
  };
  search.addEventListener('input', paint);
  paint();
  if (data.recordings.some((rec) => rec.status === 'recording')) {
    pollTimer = setTimeout(() => {
      if (parseRoute().name === 'recordings') render();
    }, 4000);
  }

  root.replaceChildren(shell('recordings', me, [
    el('main', { class: 'page' }, [
      el('div', { class: 'section-head' }, [
        el('div', {}, [
          el('p', { class: 'eyebrow' }, 'Office library'),
          el('h1', {}, 'Recordings'),
        ]),
        el('label', { class: 'search' }, [el('span', { class: 'sr' }, 'Search recordings'), search]),
      ]),
      empty,
      none,
      grid,
    ]),
  ]));
}

function recordingCard(rec, me, onChange) {
  const route = routeLabel(rec.origin, rec.destination);
  const poster = el('div', { class: 'poster-wrap' });
  if (rec.hasPoster) {
    const img = el('img', { alt: '', src: `/api/recordings/${rec.id}/poster` });
    img.addEventListener('error', () => img.replaceWith(posterFallback(rec.customerName)));
    poster.append(img);
  } else {
    poster.append(posterFallback(rec.customerName));
  }
  if (rec.status === 'ready') {
    poster.append(el('span', { class: 'duration-badge' }, formatDuration(rec.durationSec)));
  }
  const actions = [];
  if (rec.status === 'ready') {
    actions.push(el('button', {
      class: 'btn btn-primary',
      type: 'button',
      onclick: () => openPlayer(rec),
    }, [icon('play'), 'Play']));
    actions.push(el('a', {
      class: 'btn btn-ghost',
      href: `/api/recordings/${rec.id}/file?download=1`,
    }, [icon('download'), 'Download']));
  } else if (rec.status === 'recording') {
    actions.push(el('span', { class: 'meta' }, 'Recording in progress'));
  } else {
    actions.push(el('span', { class: 'meta' }, 'Recording failed'));
  }
  actions.push(el('a', { class: 'btn btn-ghost', href: `/inventory/${rec.roomId}` }, 'Inventory'));
  actions.push(el('button', {
    class: 'btn btn-ghost danger-text',
    type: 'button',
    onclick: async () => {
      try {
        if (me.role === 'owner') {
          await stepUp('recording_delete', { recordingId: rec.id }, {
            title: 'Delete recording',
            confirmLabel: 'Confirm delete',
          });
        } else {
          if (!confirm(`Delete the recording for ${rec.customerName}? This cannot be undone.`)) return;
          await api(`/api/recordings/${rec.id}`, { method: 'DELETE' });
        }
        toast('Recording deleted.');
        onChange();
      } catch (err) {
        if (err.message !== 'Cancelled.') toast(err.message);
      }
    },
  }, [icon('trash'), 'Delete']));

  const playName = rec.status === 'ready' ? `Play recording for ${rec.customerName}` : '';
  if (playName) actions[0].setAttribute('aria-label', playName);
  const deleteBtn = actions[actions.length - 1];
  deleteBtn.setAttribute('aria-label', `Delete recording for ${rec.customerName}`);

  return el('article', { class: 'rec-card' }, [
    poster,
    el('div', { class: 'rec-body' }, [
      el('h3', {}, rec.customerName),
      route ? el('p', { class: 'route' }, route) : null,
      el('p', { class: 'meta' }, `${formatWhen(rec.startedAt)} · Room ${formatCode(rec.roomId)}`),
      el('p', { class: 'meta' }, `Recorded by ${rec.startedByName} · ${formatBytes(rec.bytes)}`),
      el('div', { class: 'row-actions' }, actions),
    ]),
  ]);
}

function posterFallback(name) {
  const letter = (name || '?').trim().slice(0, 1).toUpperCase();
  return el('div', { class: 'poster-fallback' }, letter);
}

function openPlayer(rec) {
  const video = el('video');
  video.id = 'player';
  video.controls = true;
  video.playsInline = true;
  video.autoplay = true;
  video.src = `/api/recordings/${rec.id}/file`;
  const dialog = el('dialog', { class: 'player' }, [
    video,
    el('div', { class: 'player-meta' }, [
      el('div', {}, [
        el('h3', {}, rec.customerName),
        el('p', { class: 'meta' }, [
          formatWhen(rec.startedAt),
          ' · ',
          `Room ${formatCode(rec.roomId)}`,
          rec.durationSec != null ? ` · ${formatDuration(rec.durationSec)}` : '',
        ]),
      ]),
      el('div', { class: 'row-actions' }, [
        el('a', { class: 'btn btn-primary', href: `/api/recordings/${rec.id}/file?download=1` }, 'Download'),
        el('button', { class: 'btn btn-ghost', type: 'button', onclick: () => dialog.close() }, 'Close'),
      ]),
    ]),
  ]);
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
  dialog.addEventListener('close', () => {
    video.pause();
    dialog.remove();
  });
  document.body.append(dialog);
  dialog.showModal();
}

function renderThanks(root) {
  document.title = 'You’re all set · MoveSafe Relocation';
  root.replaceChildren(el('main', { class: 'center-page' }, [
    brand(null),
    el('h1', {}, 'You’re all set'),
    el('p', { class: 'lede' }, 'Thanks for walking through the home with MoveSafe Relocation. You can close this page.'),
    el('p', { class: 'fine' }, 'If this visit was recorded, it is used to prepare your moving estimate and is kept by the MoveSafe office.'),
    installSlot('block'),
  ]));
}

function renderMissing(root) {
  document.title = 'Not found · MoveSafe Relocation';
  root.replaceChildren(el('main', { class: 'center-page' }, [
    brand('/'),
    el('h1', {}, 'Page not found'),
    el('p', { class: 'lede' }, 'That address is not part of the MoveSafe video desk.'),
    el('a', { class: 'btn btn-primary', href: '/' }, 'Back to surveys'),
  ]));
}

document.addEventListener('click', (event) => {
  const link = event.target.closest('a[href]');
  if (!link) return;
  if (link.target === '_blank' || link.hasAttribute('download')) return;
  const url = new URL(link.href, location.origin);
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/print/')) return;
  event.preventDefault();
  navigate(url.pathname + url.search);
});

window.addEventListener('popstate', () => render());
render();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
