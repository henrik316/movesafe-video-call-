import crypto from 'node:crypto';
import { ROOMS, searchCatalog } from './catalog.js';
import { actor, asyncHandler, canAccessRoom, clean, httpError, requireStaff } from './access.js';
import * as db from './db.js';
import { inventoryView, publicItem, readOffice } from './office.js';
import { visionMode, scanFrame } from './vision.js';

function loadRoom(req) {
  const room = db.getRoom(String(req.params.id || '').toUpperCase());
  if (!room || !canAccessRoom(req.staff, room)) {
    throw httpError('Survey not found.', 404);
  }
  return room;
}

function roomLabelOf(value) {
  const label = clean(value, 40);
  if (label.length < 2) throw httpError('Choose a room.', 400);
  return label;
}

function surveyInventory(room) {
  return {
    roomId: room.id,
    customerName: room.customer_name,
    origin: room.origin,
    destination: room.destination,
    moveDate: room.move_date,
    ai: visionMode(),
    rooms: ROOMS,
    ...inventoryView(room.id),
  };
}

function quantityOf(value) {
  const quantity = Math.round(Number(value));
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 500) {
    throw httpError('Quantity must be between 1 and 500.', 400);
  }
  return quantity;
}

export function registerInventoryRoutes(app) {
  app.get('/api/catalog', requireStaff, (req, res) => {
    const office = readOffice();
    const q = clean(req.query.q, 60);
    const items = searchCatalog(q).map((entry) => {
      const current = office.catalog.find((row) => row.key === entry.key) || entry;
      return { key: current.key, name: current.name, cubicFeet: current.cubicFeet, group: current.group };
    });
    res.json({ items, rooms: ROOMS });
  });

  app.get('/api/rooms/:id/inventory', requireStaff, (req, res) => {
    res.json(surveyInventory(loadRoom(req)));
  });

  app.post(
    '/api/rooms/:id/inventory/items',
    requireStaff,
    asyncHandler(async (req, res) => {
      const room = loadRoom(req);
      const office = readOffice();
      const catalogKey = clean(req.body?.catalogKey, 40);
      const known = office.catalog.find((entry) => entry.key === catalogKey);
      const name = clean(req.body?.name, 80) || known?.name;
      if (!name || name.length < 2) throw httpError('Name the item.', 400);
      let cubicFeet = req.body?.cubicFeet == null || req.body.cubicFeet === '' ? null : Number(req.body.cubicFeet);
      if (known && (cubicFeet == null || Number.isNaN(cubicFeet))) cubicFeet = known.cubicFeet;
      if (cubicFeet != null && (!Number.isFinite(cubicFeet) || cubicFeet < 0 || cubicFeet > 500)) {
        throw httpError('Cubic feet must be between 0 and 500.', 400);
      }
      const item = db.insertInventoryItem({
        id: crypto.randomBytes(9).toString('hex'),
        roomId: room.id,
        roomLabel: roomLabelOf(req.body?.roomLabel),
        catalogKey: known?.key || null,
        name,
        sizeLabel: clean(req.body?.sizeLabel, 80) || known?.name || null,
        quantity: quantityOf(req.body?.quantity || 1),
        cubicFeet,
        confidence: req.body?.source === 'ai' ? Number(req.body.confidence) || null : 1,
        source: req.body?.source === 'ai' ? 'ai' : 'manual',
        notMoving: Boolean(req.body?.notMoving),
        notes: clean(req.body?.notes, 300),
        recordingId: db.getActiveRecording(room.id)?.id || null,
      });
      res.status(201).json({ item: publicItem(item), ...inventoryView(room.id) });
    }),
  );

  app.patch(
    '/api/rooms/:id/inventory/items/:itemId',
    requireStaff,
    asyncHandler(async (req, res) => {
      const room = loadRoom(req);
      const current = db.getInventoryItem(req.params.itemId);
      if (!current || current.room_id !== room.id) throw httpError('Item not found.', 404);
      const fields = {};
      if (req.body?.roomLabel != null) fields.roomLabel = roomLabelOf(req.body.roomLabel);
      if (req.body?.name != null) {
        const name = clean(req.body.name, 80);
        if (name.length < 2) throw httpError('Name the item.', 400);
        fields.name = name;
      }
      if (req.body?.quantity != null) fields.quantity = quantityOf(req.body.quantity);
      if (req.body?.cubicFeet != null) {
        const cubicFeet = Number(req.body.cubicFeet);
        if (!Number.isFinite(cubicFeet) || cubicFeet < 0 || cubicFeet > 500) {
          throw httpError('Cubic feet must be between 0 and 500.', 400);
        }
        fields.cubicFeet = cubicFeet;
      }
      if (req.body?.notMoving != null) fields.notMoving = Boolean(req.body.notMoving);
      if (req.body?.notes != null) fields.notes = clean(req.body.notes, 300);
      if (req.body?.sizeLabel != null) fields.sizeLabel = clean(req.body.sizeLabel, 80);
      const item = db.updateInventoryItem(current.id, fields);
      res.json({ item: publicItem(item), ...inventoryView(room.id) });
    }),
  );

  app.delete(
    '/api/rooms/:id/inventory/items/:itemId',
    requireStaff,
    asyncHandler(async (req, res) => {
      const room = loadRoom(req);
      const current = db.getInventoryItem(req.params.itemId);
      if (!current || current.room_id !== room.id) throw httpError('Item not found.', 404);
      db.deleteInventoryItem(current.id);
      res.json(inventoryView(room.id));
    }),
  );

  app.post(
    '/api/rooms/:id/inventory/scan',
    requireStaff,
    asyncHandler(async (req, res) => {
      const room = loadRoom(req);
      const image = String(req.body?.image || '');
      if (!image.startsWith('data:image/') || image.length < 32 || image.length > 4_000_000) {
        throw httpError('Capture a camera frame before scanning.', 400);
      }
      const office = readOffice();
      const scanned = await scanFrame(image, office.catalog);
      db.addAudit(req.staff.email, 'inventory.scan', `${room.id} ${scanned.items.length} suggestion(s) via ${scanned.mode}`);
      res.json({
        suggestions: scanned.items.map((item) => ({ ...item, roomLabel: roomLabelOf(req.body?.roomLabel) })),
        mode: scanned.mode,
        ...surveyInventory(room),
      });
    }),
  );

  app.get('/api/rooms/:id/inventory.csv', requireStaff, (req, res) => {
    const room = loadRoom(req);
    const view = inventoryView(room.id);
    const lines = [
      ['Room', 'Item', 'Quantity', 'Cubic feet each', 'Cubic feet total', 'Not moving', 'Confidence', 'Source'],
      ...view.items.map((item) => [
        item.roomLabel,
        item.name,
        item.quantity,
        item.cubicFeet ?? '',
        item.cubicFeet == null ? '' : item.quantity * item.cubicFeet,
        item.notMoving ? 'yes' : 'no',
        item.confidence ?? '',
        item.source,
      ]),
    ];
    const csv = lines.map((line) => line.map(csvCell).join(',')).join('\n');
    const filename = `${room.customer_name.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'inventory'}-inventory.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  });

  app.get('/print/inventory/:id', (req, res, next) => {
    const user = actor(req);
    if (!user) {
      res.status(403).type('html').send('<!DOCTYPE html><title>MoveSafe</title><p>Staff login required.</p>');
      return;
    }
    try {
      const room = loadRoom({ ...req, staff: user });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(summaryHtml(room, inventoryView(room.id)));
    } catch (err) {
      next(err);
    }
  });
}

function csvCell(value) {
  const text = String(value ?? '');
  if (/[",\n]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function summaryHtml(room, view) {
  const grouped = new Map();
  for (const item of view.items) {
    const list = grouped.get(item.roomLabel) || [];
    list.push(item);
    grouped.set(item.roomLabel, list);
  }
  const sections = [...grouped.entries()].map(([label, items]) => {
    const rows = items.map((item) => {
      const line = item.cubicFeet == null ? '—' : item.quantity * item.cubicFeet;
      return `<tr class="${item.notMoving ? 'skip' : ''}">
        <td>${escapeHtml(item.name)}</td>
        <td>${item.quantity}</td>
        <td>${item.cubicFeet ?? '—'}</td>
        <td>${line}</td>
        <td>${item.notMoving ? 'Not moving' : item.confidence == null ? 'Manual' : `${Math.round(item.confidence * 100)}%`}</td>
      </tr>`;
    }).join('');
    const roomFeet = view.totals.rooms.find((entry) => entry.room === label)?.cubicFeet ?? 0;
    return `<section><h2>${escapeHtml(label)} <span>${roomFeet} cu ft</span></h2><table><thead><tr><th>Item</th><th>Qty</th><th>Cu ft each</th><th>Total</th><th>Review</th></tr></thead><tbody>${rows}</tbody></table></section>`;
  }).join('');
  const route = [room.origin, room.destination].filter(Boolean).join(' → ');
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Inventory · ${escapeHtml(room.customer_name)} · ${escapeHtml(view.companyName)}</title>
  <style>
    body { margin: 0; background: #f7f3ec; color: #17261b; font: 15px/1.45 "Segoe UI", sans-serif; }
    main { max-width: 820px; margin: 0 auto; padding: 32px 24px 64px; }
    header { display: flex; justify-content: space-between; gap: 24px; border-bottom: 3px solid #1f4d3a; padding-bottom: 16px; }
    h1 { font-family: Georgia, serif; font-size: 2rem; margin: 0 0 6px; }
    h2 { display: flex; justify-content: space-between; font-size: 1.05rem; margin: 28px 0 8px; }
    h2 span { color: #3e5146; font-weight: 600; }
    table { width: 100%; border-collapse: collapse; background: white; }
    th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #eadfce; }
    th { font-size: 0.78rem; letter-spacing: 0.04em; text-transform: uppercase; color: #3e5146; }
    tr.skip td { color: #8a8175; text-decoration: line-through; }
    .totals { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-top: 22px; }
    .totals div { background: #1f4d3a; color: #f7f3ec; border-radius: 14px; padding: 14px; }
    .totals strong { display: block; font-size: 1.4rem; }
    .note { margin-top: 18px; color: #3e5146; }
    button { margin-top: 18px; background: #1f4d3a; color: #f7f3ec; border: 0; border-radius: 999px; padding: 10px 16px; font: inherit; }
    @media print { body { background: white; } button { display: none; } .totals div { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <p style="letter-spacing:.14em;text-transform:uppercase;font-size:.75rem;font-weight:700;color:#a67c3d;">${escapeHtml(view.companyName)}</p>
        <h1>${escapeHtml(room.customer_name)}</h1>
        <p>${escapeHtml(route || 'Video survey')} · Room ${escapeHtml(room.id)}</p>
      </div>
      <div>
        <p>Moving estimate</p>
        <p>${escapeHtml(room.move_date || 'Date not set')}</p>
      </div>
    </header>
    ${sections || '<p>No items yet.</p>'}
    <div class="totals">
      <div><span>Cubic feet</span><strong>${view.totals.cubicFeet}</strong></div>
      <div><span>Est. weight</span><strong>${view.totals.weightLbs.toLocaleString()} lb</strong><span>${view.totals.lbsPerCuft} lb / cu ft</span></div>
      <div><span>Suggested truck</span><strong>${escapeHtml(view.totals.truck.name)}</strong></div>
    </div>
    <p class="note">Video estimates are approximations. Large, soft, or unusual pieces should be measured on site before the quote is sent. Items marked not moving are left out of the totals. Weight uses about ${view.totals.lbsPerCuft} pounds per cubic foot.</p>
    <button type="button" onclick="print()">Print or save as PDF</button>
  </main>
</body>
</html>`;
}
