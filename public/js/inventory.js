import { api, currentStaff } from './api.js';
import { brand, el, toast } from './dom.js';
import { formatCode, routeLabel } from './format.js';

function moneyLike(value) {
  return Number(value || 0).toLocaleString(undefined, { maximumFractionDigits: 1 });
}

function confidenceLabel(item) {
  if (item.notMoving) return 'Not moving';
  if (item.confidence == null || item.source === 'manual') return 'Manual';
  return `${Math.round(item.confidence * 100)}% confidence`;
}

export function mountInventory(session) {
  const drawer = el('aside', { class: 'inventory-drawer', hidden: true });
  session.root.querySelector('.call-app')?.append(drawer);
  let view = null;
  let roomLabel = 'Living room';
  let suggestions = [];
  let scanning = false;
  let sample = false;
  let timer = null;

  const button = session.root.querySelector('[data-action="inventory"]');
  button?.addEventListener('click', () => {
    drawer.hidden = !drawer.hidden;
    if (!drawer.hidden) refresh();
  });

  async function refresh() {
    view = await api(`/api/rooms/${session.roomId}/inventory`);
    if (!view.rooms.includes(roomLabel)) roomLabel = view.rooms[0];
    paint();
  }

  function paint() {
    if (!view) return;
    const roomItems = view.items.filter((item) => item.roomLabel === roomLabel);
    const select = el('select', { id: 'inventory-room' }, view.rooms.map((room) => el('option', { value: room, selected: room === roomLabel }, room)));
    select.addEventListener('change', () => {
      roomLabel = select.value;
      paint();
    });
    const search = el('input', { id: 'inventory-search', type: 'search', placeholder: 'Search sofa, bed, box…' });
    const results = el('div', { class: 'inventory-results' });
    search.addEventListener('input', async () => {
      const data = await api(`/api/catalog?q=${encodeURIComponent(search.value)}`);
      results.replaceChildren(...data.items.slice(0, 6).map((entry) => el('button', {
        type: 'button',
        class: 'btn btn-ghost',
        onclick: () => addItem(entry),
      }, `${entry.name} · ${entry.cubicFeet} cu ft`)));
    });
    const scan = el('button', {
      class: 'btn btn-primary',
      type: 'button',
      disabled: view.ai === 'off' || scanning,
    }, scanning ? 'Scanning…' : 'Scan');
    scan.addEventListener('click', () => capture(false));
    const sampleBox = el('input', { type: 'checkbox', id: 'inventory-sample' });
    sampleBox.checked = sample;
    sampleBox.addEventListener('change', () => {
      sample = sampleBox.checked;
    });
    drawer.replaceChildren(
      el('div', { class: 'inventory-head' }, [
        el('div', {}, [
          el('p', { class: 'eyebrow' }, 'Furniture inventory'),
          el('h2', {}, session.room.customerName),
        ]),
        el('button', { class: 'btn btn-ghost', type: 'button', onclick: () => { drawer.hidden = true; } }, 'Close'),
      ]),
      el('label', { class: 'field' }, [el('span', {}, 'Current room'), select]),
      el('p', { class: 'fine' }, view.ai === 'off'
        ? 'AI scanning needs an API key on the server. Search the reference list and add items yourself.'
        : 'Scan uses one frame from the customer camera. Check the result before you rely on it.'),
      el('div', { class: 'row-actions' }, [
        scan,
        el('label', { class: 'check' }, [sampleBox, el('span', {}, 'Sample while recording')]),
      ]),
      suggestions.length ? el('div', { class: 'stack' }, [
        el('h3', {}, 'Suggestions'),
        ...suggestions.map((item, index) => suggestionRow(item, index)),
      ]) : null,
      el('h3', {}, roomLabel),
      roomItems.length ? el('div', { class: 'stack' }, roomItems.map(itemRow)) : el('p', { class: 'fine' }, 'Nothing in this room yet.'),
      el('label', { class: 'field' }, [el('span', {}, 'Add from the reference list'), search]),
      results,
      totalsBlock(view.totals),
      el('a', { class: 'btn btn-ghost', href: `/inventory/${session.roomId}` }, 'Review and export'),
    );
  }

  function suggestionRow(item, index) {
    return el('div', { class: 'inventory-row' }, [
      el('div', {}, [
        el('strong', {}, item.name),
        el('p', { class: 'meta' }, `${item.quantity} · ${item.cubicFeet ?? 'size needed'} cu ft · ${confidenceLabel(item)}`),
      ]),
      el('button', { class: 'btn btn-primary', type: 'button', 'aria-label': `Add ${item.name}`, onclick: () => confirmSuggestion(index) }, 'Add'),
    ]);
  }

  function itemRow(item) {
    return el('div', { class: `inventory-row${item.notMoving ? ' is-out' : ''}` }, [
      el('div', {}, [
        el('strong', {}, item.name),
        el('p', { class: 'meta' }, `${item.quantity} × ${item.cubicFeet ?? '—'} cu ft · ${confidenceLabel(item)}`),
      ]),
      el('button', {
        class: 'btn btn-ghost',
        type: 'button',
        onclick: async () => {
          await api(`/api/rooms/${session.roomId}/inventory/items/${item.id}`, { method: 'DELETE' });
          toast('Item removed.');
          refresh();
        },
      }, 'Remove'),
    ]);
  }

  async function addItem(entry) {
    await api(`/api/rooms/${session.roomId}/inventory/items`, {
      method: 'POST',
      body: { catalogKey: entry.key, roomLabel, quantity: 1, source: 'manual' },
    });
    toast(`${entry.name} added.`);
    refresh();
  }

  async function confirmSuggestion(index) {
    const item = suggestions[index];
    await api(`/api/rooms/${session.roomId}/inventory/items`, {
      method: 'POST',
      body: {
        catalogKey: item.catalogKey,
        name: item.name,
        roomLabel: item.roomLabel || roomLabel,
        quantity: item.quantity,
        cubicFeet: item.cubicFeet,
        confidence: item.confidence,
        source: 'ai',
        sizeLabel: item.sizeLabel,
      },
    });
    suggestions = suggestions.filter((_, itemIndex) => itemIndex !== index);
    toast('Added to the inventory.');
    refresh();
  }

  async function capture(automatic) {
    if (scanning) return;
    const video = [...session.root.querySelectorAll('.remote-tile video')].find((node) => node.videoWidth > 0);
    if (!video) {
      if (!automatic) toast('Wait until the customer camera is live, then scan.');
      return;
    }
    const scale = Math.min(1, 960 / video.videoWidth);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    const image = canvas.toDataURL('image/jpeg', 0.72);
    scanning = true;
    paint();
    try {
      const result = await api(`/api/rooms/${session.roomId}/inventory/scan`, {
        method: 'POST',
        body: { image, roomLabel },
      });
      const known = new Set(result.items.map((item) => `${item.roomLabel}:${item.catalogKey || item.name}`));
      const fresh = result.suggestions.filter((item) => !known.has(`${roomLabel}:${item.catalogKey || item.name}`));
      suggestions = fresh;
      view = {
        ...view,
        ...result,
        rooms: result.rooms || view.rooms,
        ai: result.ai || view.ai,
      };
      if (!automatic) toast(fresh.length ? 'Check the suggestions, then add the ones that are right.' : 'No new items in that frame.');
    } catch (err) {
      if (!automatic) toast(err.message);
    } finally {
      scanning = false;
      paint();
    }
  }

  timer = setInterval(() => {
    if (sample && session.recording?.active) capture(true);
  }, 20000);

  return {
    destroy() {
      clearInterval(timer);
      drawer.remove();
    },
  };
}

function totalsBlock(totals) {
  return el('div', { class: 'inventory-totals' }, [
    el('p', {}, [el('strong', {}, `${moneyLike(totals.cubicFeet)} cu ft`)]),
    el('p', {}, `${totals.weightLbs.toLocaleString()} lb at ${totals.lbsPerCuft} lb/cu ft`),
    el('p', {}, `Truck: ${totals.truck.name}`),
  ]);
}

export async function renderInventory(root, roomId) {
  const me = await currentStaff();
  if (!me) {
    location.href = '/login';
    return;
  }
  const view = await api(`/api/rooms/${roomId}/inventory`);
  document.title = `Inventory · ${view.customerName}`;
  const body = el('div', { class: 'stack', id: 'inventory-review' });
  const paint = (next) => {
    const grouped = new Map();
    for (const item of next.items) {
      const list = grouped.get(item.roomLabel) || [];
      list.push(item);
      grouped.set(item.roomLabel, list);
    }
    body.replaceChildren(
      ...[...grouped.entries()].map(([label, items]) => el('section', { class: 'room-card' }, [
        el('h2', {}, label),
        ...items.map((item) => editor(item, next, paint)),
      ])),
      next.items.length ? null : el('p', { class: 'lede' }, 'No items yet. Add them during the call or from the list below.'),
    );
  };
  const search = el('input', { type: 'search', placeholder: 'Add a sofa, bed, box…' });
  const roomPick = el('select', {}, view.rooms.map((room) => el('option', { value: room }, room)));
  const results = el('div', { class: 'inventory-results' });
  search.addEventListener('input', async () => {
    const data = await api(`/api/catalog?q=${encodeURIComponent(search.value)}`);
    results.replaceChildren(...data.items.slice(0, 8).map((entry) => el('button', {
      type: 'button',
      class: 'btn btn-ghost',
      onclick: async () => {
        const created = await api(`/api/rooms/${roomId}/inventory/items`, {
          method: 'POST',
          body: { catalogKey: entry.key, roomLabel: roomPick.value, quantity: 1 },
        });
        toast(`${entry.name} added.`);
        paint(created);
        totals.replaceChildren(totalsBlock(created.totals));
      },
    }, `${entry.name} · ${entry.cubicFeet} cu ft`)));
  });
  const totals = el('div', {});
  totals.append(totalsBlock(view.totals));
  paint(view);
  const route = routeLabel(view.origin, view.destination);
  root.replaceChildren(el('div', { class: 'app-shell' }, [
    el('header', { class: 'topbar' }, [
      brand('/'),
      el('nav', { class: 'topnav' }, [
        el('a', { href: `/c/${roomId}` }, 'Back to call'),
        el('a', { href: '/recordings' }, 'Library'),
        el('span', { class: 'who' }, me.name),
      ]),
    ]),
    el('main', { class: 'page' }, [
      el('p', { class: 'eyebrow' }, 'Review the estimate'),
      el('h1', {}, view.customerName),
      el('p', { class: 'lede' }, `${route || 'Survey'} · Room ${formatCode(view.roomId)}. Change anything that the camera got wrong. Not-moving items stay on the list and drop out of the total.`),
      totals,
      el('div', { class: 'row-actions' }, [
        el('a', { class: 'btn btn-primary', href: `/api/rooms/${roomId}/inventory.csv` }, 'Download CSV'),
        el('a', { class: 'btn btn-ghost', href: `/print/inventory/${roomId}`, target: '_blank' }, 'Printable summary'),
      ]),
      el('section', { class: 'create-card' }, [
        el('h2', {}, 'Add an item'),
        el('label', { class: 'field' }, [el('span', {}, 'Room'), roomPick]),
        el('label', { class: 'field' }, [el('span', {}, 'Reference list'), search]),
        results,
      ]),
      body,
    ]),
  ]));
}

function editor(item, view, paint) {
  const quantity = el('input', { type: 'number', min: '1', max: '500', value: String(item.quantity) });
  const feet = el('input', { type: 'number', min: '0', max: '500', step: '0.5', value: item.cubicFeet ?? '' });
  const moving = el('input', { type: 'checkbox' });
  moving.checked = !item.notMoving;
  const save = async () => {
    const updated = await api(`/api/rooms/${item.roomId}/inventory/items/${item.id}`, {
      method: 'PATCH',
      body: {
        quantity: Number(quantity.value),
        cubicFeet: feet.value === '' ? 0 : Number(feet.value),
        notMoving: !moving.checked,
      },
    });
    toast('Saved.');
    const totals = document.querySelector('.inventory-totals');
    totals?.replaceWith(totalsBlock(updated.totals));
    paint(updated);
  };
  return el('div', { class: 'inventory-edit' }, [
    el('div', {}, [
      el('strong', {}, item.name),
      el('p', { class: 'meta' }, confidenceLabel(item)),
    ]),
    el('label', { class: 'field' }, [el('span', {}, 'Qty'), quantity]),
    el('label', { class: 'field' }, [el('span', {}, 'Cu ft each'), feet]),
    el('label', { class: 'check' }, [moving, el('span', {}, 'Moving')]),
    el('div', { class: 'row-actions' }, [
      el('button', { class: 'btn btn-primary', type: 'button', onclick: save }, 'Save'),
      el('button', {
        class: 'btn btn-ghost danger-text',
        type: 'button',
        onclick: async () => {
          const updated = await api(`/api/rooms/${item.roomId}/inventory/items/${item.id}`, { method: 'DELETE' });
          toast('Removed.');
          paint(updated);
          document.querySelector('.inventory-totals')?.replaceWith(totalsBlock(updated.totals));
        },
      }, 'Remove'),
    ]),
  ]);
}
