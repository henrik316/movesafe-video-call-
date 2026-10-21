import { api } from './api.js';
import { brand, el, toast } from './dom.js';
import { stepUp } from './stepup.js';

function trucksToText(trucks) {
  return trucks.map((truck) => `${truck.name}, ${truck.cubicFeet}`).join('\n');
}

function textToTrucks(value) {
  return value.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
    const [name, feet] = line.split(',');
    return { name: (name || '').trim(), cubicFeet: Number((feet || '').trim()) };
  });
}

export async function renderAdmin(root, me) {
  if (me.role !== 'owner') {
    root.replaceChildren(el('main', { class: 'center-page' }, [
      brand('/'),
      el('h1', {}, 'Owner access only'),
      el('p', { class: 'lede' }, 'Staff can run surveys and inventories. Admin settings stay with the owner.'),
      el('a', { class: 'btn btn-primary', href: '/' }, 'Back to surveys'),
    ]));
    return;
  }
  const [settings, people, invites, audit] = await Promise.all([
    api('/api/admin/settings'),
    api('/api/admin/staff'),
    api('/api/admin/invites'),
    api('/api/admin/audit'),
  ]);
  document.title = 'Owner admin · MoveSafe';
  const notice = el('p', { class: 'form-error', hidden: true });
  const company = el('input', { value: settings.companyName, required: true });
  const tagline = el('input', { value: settings.tagline || '' });
  const weight = el('input', { type: 'number', min: '1', max: '30', step: '0.5', value: String(settings.lbsPerCuft) });
  const trucks = el('textarea', { rows: '6' }, trucksToText(settings.trucks));
  const catalogFilter = el('input', { type: 'search', placeholder: 'Find an item' });
  const catalogBox = el('div', { class: 'catalog-edits' });
  const overrides = new Map(settings.catalog.filter((item) => item.overridden).map((item) => [item.key, item.cubicFeet]));
  const paintCatalog = () => {
    const needle = catalogFilter.value.trim().toLowerCase();
    catalogBox.replaceChildren(...settings.catalog.filter((item) => !needle || `${item.name} ${item.group}`.toLowerCase().includes(needle)).slice(0, 12).map((item) => {
      const input = el('input', { type: 'number', min: '0', max: '500', step: '0.5', value: String(overrides.get(item.key) ?? item.cubicFeet) });
      input.addEventListener('change', () => overrides.set(item.key, Number(input.value)));
      return el('label', { class: 'catalog-line' }, [el('span', {}, item.name), input]);
    }));
  };
  catalogFilter.addEventListener('input', paintCatalog);
  paintCatalog();

  const inviteEmail = el('input', { type: 'email', placeholder: 'name@company.com', required: true });
  const inviteResult = el('div', { class: 'share-box', hidden: true });
  const inviteList = el('div', { class: 'stack', id: 'invite-list' });
  const paintInvites = (rows) => {
    inviteList.replaceChildren(...rows.map((invite) => el('article', { class: 'inventory-row' }, [
      el('div', {}, [
        el('strong', {}, invite.email),
        el('p', { class: 'meta' }, `${invite.status} · staff · expires ${new Date(invite.expiresAt).toLocaleString()}`),
      ]),
      invite.status === 'pending' || invite.status === 'expired' ? el('div', { class: 'row-actions' }, [
        el('button', { class: 'btn btn-ghost', type: 'button', onclick: () => resend(invite) }, 'Resend'),
        invite.status === 'pending' ? el('button', { class: 'btn btn-ghost danger-text', type: 'button', onclick: () => revoke(invite) }, 'Revoke') : null,
      ]) : el('span', { class: 'meta' }, invite.status),
    ])));
    if (!rows.length) inviteList.append(el('p', { class: 'fine' }, 'No invites yet.'));
  };
  paintInvites(invites.invites);

  async function guarded(work) {
    notice.hidden = true;
    try {
      return await work();
    } catch (err) {
      if (err.message === 'Cancelled.') return null;
      notice.hidden = false;
      notice.textContent = err.message;
      return null;
    }
  }

  async function saveSettings() {
    const result = await guarded(() => stepUp('settings_update', {
      companyName: company.value,
      tagline: tagline.value,
      lbsPerCuft: Number(weight.value),
      trucks: textToTrucks(trucks.value),
      overrides: [...overrides.entries()].map(([key, cubicFeet]) => ({ key, cubicFeet })),
    }, { title: 'Save office settings', confirmLabel: 'Save settings' }));
    if (result) toast('Settings saved.');
  }

  async function sendInvite() {
    const result = await guarded(() => stepUp('invite_create', { email: inviteEmail.value }, {
      title: 'Send staff invite',
      confirmLabel: 'Send invite',
    }));
    if (!result?.link) return;
    inviteResult.hidden = false;
    inviteResult.replaceChildren(
      el('p', { class: 'eyebrow' }, result.mailed ? 'Emailed and shown here' : 'Copy this link'),
      el('p', {}, result.mailed ? 'The message was sent. The link is also here in case you want to copy it.' : 'Email is not configured, so send this one-time link yourself. It expires in 72 hours.'),
      el('textarea', { readOnly: true, rows: '3' }, result.link),
    );
    inviteEmail.value = '';
    const latest = await api('/api/admin/invites');
    paintInvites(latest.invites);
    toast('Invite created.');
  }

  async function resend(invite) {
    const result = await guarded(() => stepUp('invite_resend', { inviteId: invite.id }, {
      title: 'Resend invite',
      confirmLabel: 'Resend invite',
    }));
    if (!result?.link) return;
    inviteResult.hidden = false;
    inviteResult.replaceChildren(
      el('p', {}, 'New link. The previous one no longer works.'),
      el('textarea', { readOnly: true, rows: '3' }, result.link),
    );
    paintInvites((await api('/api/admin/invites')).invites);
  }

  async function revoke(invite) {
    const result = await guarded(() => stepUp('invite_revoke', { inviteId: invite.id }, {
      title: 'Revoke invite',
      confirmLabel: 'Revoke invite',
    }));
    if (result) paintInvites((await api('/api/admin/invites')).invites);
  }

  async function deactivate(person) {
    const result = await guarded(() => stepUp('staff_deactivate', { email: person.email }, {
      title: 'Deactivate staff',
      confirmLabel: 'Deactivate',
    }));
    if (result) location.reload();
  }

  async function remove(person) {
    const result = await guarded(() => stepUp('staff_remove', { email: person.email }, {
      title: 'Remove staff',
      confirmLabel: 'Remove account',
    }));
    if (result) location.reload();
  }

  const currentPassword = el('input', { type: 'password', autocomplete: 'current-password' });
  const newPassword = el('input', { type: 'password', autocomplete: 'new-password', minlength: '10' });

  root.replaceChildren(el('div', { class: 'app-shell' }, [
    el('header', { class: 'topbar' }, [
      brand('/'),
      el('nav', { class: 'topnav' }, [
        el('a', { href: '/' }, 'Surveys'),
        el('a', { href: '/admin', class: 'active' }, 'Admin'),
        el('span', { class: 'who' }, me.name),
      ]),
    ]),
    el('main', { class: 'page admin-page', id: 'owner-admin' }, [
      el('p', { class: 'eyebrow' }, 'Owner'),
      el('h1', {}, 'Office admin'),
      el('p', { class: 'lede' }, 'Only the owner can change settings, invite staff, and see every survey. Staff cannot promote themselves.'),
      settings.demoMode ? el('div', { class: 'demo-note' }, [
        el('p', {}, [el('strong', {}, 'Dev demo mode. '), 'This shared login is disabled when NODE_ENV is production.']),
      ]) : null,
      notice,
      el('section', { class: 'create-card', id: 'invite-panel' }, [
        el('h2', {}, 'Invite staff'),
        el('p', { class: 'fine' }, 'Invites are single-use, last 72 hours, and always create a staff account. Sending or resending texts a code to the owner phone.'),
        el('p', { class: 'meta' }, settings.smsConfigured
          ? 'SMS is configured.'
          : settings.smsDev
            ? 'Dev mode: text codes are printed in the server console and are not sent.'
            : 'SMS is not configured. Production will refuse new invites until Twilio and OWNER_PHONE are set.'),
        el('label', { class: 'field' }, [el('span', {}, 'Email'), inviteEmail]),
        el('button', { class: 'btn btn-primary', type: 'button', onclick: sendInvite }, 'Send invite'),
        inviteResult,
        inviteList,
      ]),
      el('section', { class: 'create-card', id: 'owner-settings' }, [
        el('h2', {}, 'Settings'),
        el('p', { class: 'meta' }, `AI scanning: ${settings.ai === 'live' ? 'key configured' : settings.ai === 'stub' ? 'test stub' : 'not configured'}. The key stays on the server.`),
        el('label', { class: 'field' }, [el('span', {}, 'Company name'), company]),
        el('label', { class: 'field' }, [el('span', {}, 'Tagline'), tagline]),
        el('label', { class: 'field' }, [el('span', {}, 'Pounds per cubic foot'), weight]),
        el('label', { class: 'field' }, [el('span', {}, 'Truck sizes (name, cubic feet)'), trucks]),
        el('label', { class: 'field' }, [el('span', {}, 'Reference table'), catalogFilter]),
        catalogBox,
        el('button', { class: 'btn btn-primary', type: 'button', onclick: saveSettings }, 'Save settings'),
      ]),
      el('section', { class: 'create-card' }, [
        el('h2', {}, 'Staff'),
        el('div', { class: 'stack' }, people.staff.map((person) => el('article', { class: 'inventory-row' }, [
          el('div', {}, [
            el('strong', {}, person.name),
            el('p', { class: 'meta' }, `${person.email} · ${person.role} · ${person.active ? 'active' : 'deactivated'}`),
          ]),
          person.role === 'staff' ? el('div', { class: 'row-actions' }, [
            person.active ? el('button', { class: 'btn btn-ghost', type: 'button', onclick: () => deactivate(person) }, 'Deactivate') : null,
            el('button', { class: 'btn btn-ghost danger-text', type: 'button', onclick: () => remove(person) }, 'Remove'),
          ]) : el('span', { class: 'meta' }, 'Owner'),
        ]))),
      ]),
      el('section', { class: 'create-card' }, [
        el('h2', {}, 'Your password'),
        el('label', { class: 'field' }, [el('span', {}, 'Current password'), currentPassword]),
        el('label', { class: 'field' }, [el('span', {}, 'New password'), newPassword]),
        el('button', {
          class: 'btn btn-ghost',
          type: 'button',
          onclick: () => guarded(() => stepUp('owner_password', {
            currentPassword: currentPassword.value,
            newPassword: newPassword.value,
          }, { title: 'Change owner password', confirmLabel: 'Change password' })).then((result) => {
            if (result) toast('Password changed.');
          }),
        }, 'Change password'),
      ]),
      el('section', { class: 'create-card' }, [
        el('h2', {}, 'Audit log'),
        el('div', { class: 'stack' }, audit.entries.length ? audit.entries.slice(0, 30).map((entry) => el('p', { class: 'meta' }, `${new Date(entry.at).toLocaleString()} · ${entry.actorEmail || 'system'} · ${entry.action}${entry.detail ? ` · ${entry.detail}` : ''}`)) : [el('p', { class: 'fine' }, 'No admin actions yet.')]),
      ]),
    ]),
  ]));
}

export async function renderInvite(root, token) {
  document.title = 'Set your password · MoveSafe';
  let info;
  try {
    info = await api(`/api/invites/${token}`);
  } catch (err) {
    root.replaceChildren(el('main', { class: 'center-page' }, [
      brand(null),
      el('h1', {}, 'Invite not available'),
      el('p', { class: 'lede' }, err.message),
    ]));
    return;
  }
  const name = el('input', { required: true, maxlength: '80' });
  const password = el('input', { type: 'password', required: true, minlength: '10', autocomplete: 'new-password' });
  const error = el('p', { class: 'form-error', hidden: true });
  const form = el('form', { class: 'stack' }, [
    el('label', { class: 'field' }, [el('span', {}, 'Your name'), name]),
    el('label', { class: 'field' }, [el('span', {}, 'Password'), password]),
    error,
    el('button', { class: 'btn btn-primary', type: 'submit' }, 'Create my staff login'),
  ]);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    error.hidden = true;
    try {
      await api(`/api/invites/${token}`, { method: 'POST', body: { name: name.value, password: password.value } });
      location.href = '/';
    } catch (err) {
      error.hidden = false;
      error.textContent = err.message;
    }
  });
  root.replaceChildren(el('main', { class: 'center-page' }, [
    brand(null),
    el('h1', {}, 'Join the MoveSafe desk'),
    el('p', { class: 'lede' }, `Set a password for ${info.email}. This invite cannot be used twice.`),
    form,
  ]));
}

export async function renderSetup(root) {
  document.title = 'Owner setup · MoveSafe';
  const status = await api('/api/setup').catch(() => ({ open: false }));
  if (!status.open) {
    root.replaceChildren(el('main', { class: 'center-page' }, [
      brand('/'),
      el('h1', {}, 'Setup is closed'),
      el('p', { class: 'lede' }, 'An owner account already exists, or the one-time token has expired.'),
    ]));
    return;
  }
  const token = el('input', { required: true, autocomplete: 'off' });
  const name = el('input', { required: true });
  const password = el('input', { type: 'password', required: true, minlength: '10' });
  const error = el('p', { class: 'form-error', hidden: true });
  const form = el('form', { class: 'stack' }, [
    el('label', { class: 'field' }, [el('span', {}, 'Setup token'), token]),
    el('label', { class: 'field' }, [el('span', {}, 'Your name'), name]),
    el('label', { class: 'field' }, [el('span', {}, 'Password'), password]),
    error,
    el('button', { class: 'btn btn-primary', type: 'submit' }, 'Create owner login'),
  ]);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await api('/api/setup', { method: 'POST', body: { token: token.value, name: name.value, password: password.value } });
      location.href = '/admin';
    } catch (err) {
      error.hidden = false;
      error.textContent = err.message;
    }
  });
  root.replaceChildren(el('main', { class: 'center-page' }, [
    brand(null),
    el('h1', {}, 'Create the owner login'),
    el('p', { class: 'lede' }, 'Use the one-time token printed in the server console the first time MoveSafe started.'),
    form,
  ]));
}
