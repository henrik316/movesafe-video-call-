import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { computeTotals, refineCubicFeet } from '../server/catalog.js';
import { scanFrame } from '../server/vision.js';

const port = 4211;
const origin = `http://127.0.0.1:${port}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'movesafe-office-'));
const smsFile = path.join(dataDir, 'sms.log');
const ownerPhone = '+15555550100';

delete process.env.OPENAI_API_KEY;
delete process.env.VISION_STUB;
const blocked = await scanFrame('data:image/jpeg;base64,AAAA', []).then(
  () => {
    throw new Error('scan ran without a key');
  },
  (err) => err,
);
if (blocked.status !== 409 || blocked.code !== 'ai_unconfigured') {
  throw new Error(`Expected AI to stay off, got ${blocked.message}`);
}
let fetched = false;
const originalFetch = global.fetch;
global.fetch = (...args) => {
  fetched = true;
  return originalFetch(...args);
};
await scanFrame('data:image/jpeg;base64,AAAA', []).catch(() => {});
global.fetch = originalFetch;
if (fetched) throw new Error('A frame was sent without an API key');
const sized = refineCubicFeet(60, { w: 64, h: 54, d: 86 });
if (sized.cubicFeet !== 60 || sized.usedDimensions) throw new Error(`Dimension guard failed ${JSON.stringify(sized)}`);
const close = refineCubicFeet(50, { w: 84, h: 36, d: 38 });
if (!close.usedDimensions || close.cubicFeet < 60 || close.cubicFeet > 70) {
  throw new Error(`Expected a refined sofa size, got ${JSON.stringify(close)}`);
}
const sample = computeTotals([
  { quantity: 1, cubicFeet: 50, notMoving: false, roomLabel: 'Living room' },
  { quantity: 4, cubicFeet: 3, notMoving: false, roomLabel: 'Living room' },
], 7);
if (sample.cubicFeet !== 62 || sample.weightLbs !== 434 || sample.truck.name !== 'Cargo van') {
  throw new Error(`Totals mismatch ${JSON.stringify(sample)}`);
}
console.log('Reference math and the no-key guard passed.');

const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PORT: String(port),
    HOST: '127.0.0.1',
    DATA_DIR: dataDir,
    SESSION_SECRET: 'office-session-secret',
    STAFF_EMAIL: 'alex@movesaferelocation.com',
    STAFF_PASSWORD: 'walkthrough-demo',
    STAFF_NAME: 'Alex Rivera',
    NODE_ENV: 'test',
    DEMO_MODE: 'true',
    SHOW_DEMO_BANNER: 'true',
    SMS_CAPTURE_FILE: smsFile,
    OWNER_PHONE: ownerPhone,
    VISION_STUB: '1',
    OPENAI_API_KEY: '',
    STORAGE: 'local',
  },
  stdio: 'inherit',
});

function fail(message) {
  throw new Error(message);
}

function latestCode() {
  const lines = fs.readFileSync(smsFile, 'utf8').trim().split('\n').filter(Boolean);
  return JSON.parse(lines[lines.length - 1]).code;
}

function client() {
  let cookie = '';
  return async function request(urlPath, { method = 'GET', body } = {}) {
    const response = await fetch(origin + urlPath, {
      method,
      headers: {
        ...(body != null ? { 'content-type': 'application/json' } : {}),
        ...(cookie ? { cookie } : {}),
      },
      body: body != null ? JSON.stringify(body) : undefined,
    });
    for (const line of response.headers.getSetCookie?.() || []) {
      const pair = line.split(';')[0];
      if (pair.startsWith('movesafe.sid=')) cookie = pair;
    }
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (text.includes(ownerPhone)) fail(`Response included the owner phone: ${urlPath}`);
    return { status: response.status, data, text };
  };
}

async function login(request, email, password) {
  const first = await request('/api/login', { method: 'POST', body: { email, password } });
  if (!first.data?.mfaRequired) {
    if (first.status !== 200) fail(`Login failed ${first.status} ${first.text}`);
    return first.data;
  }
  const second = await request('/api/login/mfa', {
    method: 'POST',
    body: { challengeId: first.data.challengeId, code: latestCode() },
  });
  if (second.status !== 200) fail(`MFA failed ${second.status} ${second.text}`);
  return second.data;
}

async function confirm(request, purpose, payload) {
  const started = await request('/api/admin/challenges', { method: 'POST', body: { purpose, ...payload } });
  if (started.status !== 200) fail(`Challenge ${purpose} failed ${started.status} ${started.text}`);
  const done = await request(`/api/admin/challenges/${started.data.challengeId}/confirm`, {
    method: 'POST',
    body: { code: latestCode() },
  });
  if (done.status !== 200) fail(`Confirm ${purpose} failed ${done.status} ${done.text}`);
  return done.data;
}

async function waitForHealth() {
  for (let i = 0; i < 50; i += 1) {
    try {
      const response = await fetch(`${origin}/api/health`);
      if (response.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  fail('Server did not start');
}

try {
  await waitForHealth();
  const customer = client();
  const adminDenied = await customer('/api/admin/settings');
  if (adminDenied.status !== 403) fail(`Customer admin status ${adminDenied.status}`);
  const customerInventory = await customer('/api/rooms/ABCDEFGH/inventory');
  if (customerInventory.status !== 401) fail(`Customer inventory status ${customerInventory.status}`);
  console.log('Customers are blocked from admin and inventory.');

  const owner = client();
  const who = await login(owner, 'alex@movesaferelocation.com', 'walkthrough-demo');
  if (who.role !== 'owner') fail(`Demo account role ${who.role}`);
  const badCode = await owner('/api/login/mfa', {
    method: 'POST',
    body: { challengeId: 'nope', code: '000000' },
  });
  if (badCode.status < 400) fail('Bad code was accepted');

  const created = await owner('/api/rooms', {
    method: 'POST',
    body: { customerName: 'Jordan Lee', origin: 'Austin', destination: 'Denver' },
  });
  const roomId = created.data.room.id;
  const added = await owner(`/api/rooms/${roomId}/inventory/items`, {
    method: 'POST',
    body: { catalogKey: 'sofa-3', roomLabel: 'Living room', quantity: 1 },
  });
  await owner(`/api/rooms/${roomId}/inventory/items`, {
    method: 'POST',
    body: { catalogKey: 'box-medium', roomLabel: 'Living room', quantity: 4 },
  });
  let view = await owner(`/api/rooms/${roomId}/inventory`);
  if (view.data.totals.cubicFeet !== 62 || view.data.totals.weightLbs !== 434) {
    fail(`Inventory totals ${JSON.stringify(view.data.totals)}`);
  }
  if (view.data.totals.truck.name !== 'Cargo van') fail(`Truck ${view.data.totals.truck.name}`);
  const sofa = view.data.items.find((item) => item.catalogKey === 'sofa-3');
  const scanned = await owner(`/api/rooms/${roomId}/inventory/scan`, {
    method: 'POST',
    body: { image: 'data:image/jpeg;base64,AAAAAAAAscanframe', roomLabel: 'Bedroom 1' },
  });
  const bed = scanned.data.suggestions.find((item) => item.catalogKey === 'bed-queen');
  if (!bed || bed.cubicFeet !== 60) fail(`Scan suggestion ${JSON.stringify(scanned.data.suggestions)}`);
  if (scanned.data.totals.cubicFeet !== 62) fail('Scan changed the total before staff confirmed it');
  if (!Array.isArray(scanned.data.rooms) || !scanned.data.rooms.includes('Bedroom 1') || !scanned.data.ai) {
    fail('Scan response dropped the room list');
  }
  await owner(`/api/rooms/${roomId}/inventory/items`, {
    method: 'POST',
    body: {
      catalogKey: bed.catalogKey,
      name: bed.name,
      roomLabel: 'Bedroom 1',
      quantity: bed.quantity,
      cubicFeet: bed.cubicFeet,
      confidence: bed.confidence,
      source: 'ai',
    },
  });
  const parked = await owner(`/api/rooms/${roomId}/inventory/items/${sofa.id}`, {
    method: 'PATCH',
    body: { notMoving: true },
  });
  if (parked.data.totals.cubicFeet !== 72 || parked.data.totals.weightLbs !== 504) {
    fail(`After review ${JSON.stringify(parked.data.totals)}`);
  }
  const csv = await owner(`/api/rooms/${roomId}/inventory.csv`);
  if (csv.status !== 200 || !csv.text.includes('Sofa, 3-seat') || !csv.text.includes('Bed, queen')) {
    fail('CSV export missing items');
  }
  const printed = await owner(`/print/inventory/${roomId}`);
  if (printed.status !== 200 || !printed.text.includes('Jordan Lee') || !printed.text.includes('72')) {
    fail('Printable summary missing the customer or total');
  }
  console.log('Manual inventory, stubbed scan, totals, CSV, and summary passed.');

  const invite = await confirm(owner, 'invite_create', { email: 'sam@movesaferelocation.com' });
  const token = invite.link.split('/invite/')[1];
  const staff = client();
  const joined = await staff(`/api/invites/${token}`, {
    method: 'POST',
    body: { name: 'Sam Ortiz', password: 'staff-password-1' },
  });
  if (joined.status !== 200 || joined.data.role !== 'staff') fail(`Join failed ${joined.status} ${joined.text}`);
  const reused = await client()(`/api/invites/${token}`, {
    method: 'POST',
    body: { name: 'Sam Ortiz', password: 'staff-password-1' },
  });
  if (reused.status !== 400) fail(`Used invite status ${reused.status}`);
  const staffAdmin = await staff('/api/admin/settings');
  if (staffAdmin.status !== 403) fail(`Staff admin status ${staffAdmin.status}`);
  const staffInvite = await staff('/api/admin/challenges', {
    method: 'POST',
    body: { purpose: 'invite_create', email: 'other@movesaferelocation.com' },
  });
  if (staffInvite.status !== 403) fail(`Staff invite status ${staffInvite.status}`);
  const hidden = await staff(`/api/rooms/${roomId}`);
  if (hidden.status !== 404) fail(`Staff saw another survey (${hidden.status})`);
  console.log('Invite use, staff 403, and survey isolation passed.');

  const second = await confirm(owner, 'invite_create', { email: 'casey@movesaferelocation.com' });
  const secondToken = second.link.split('/invite/')[1];
  const database = new DatabaseSync(path.join(dataDir, 'movesafe.sqlite'));
  const hash = crypto.createHash('sha256').update(secondToken).digest('hex');
  database.prepare('UPDATE invites SET expires_at = ? WHERE id = ?').run(new Date(Date.now() - 5000).toISOString(), hash);
  database.close();
  const expired = await client()(`/api/invites/${secondToken}`, {
    method: 'POST',
    body: { name: 'Casey', password: 'staff-password-1' },
  });
  if (expired.status !== 400 || !expired.text.includes('expired')) fail(`Expired invite status ${expired.status} ${expired.text}`);

  await confirm(owner, 'staff_deactivate', { email: 'sam@movesaferelocation.com' });
  const dead = await staff('/api/me');
  if (dead.status !== 401) fail(`Deactivated session status ${dead.status}`);
  const promoted = databaseOpenCheck();
  if (promoted) fail('A staff account was stored as owner');
  console.log('Expired invite and deactivation passed.');
  console.log('Office checks passed.');
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  if (!server.killed) server.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => server.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 2000)),
  ]);
}

function databaseOpenCheck() {
  const database = new DatabaseSync(path.join(dataDir, 'movesafe.sqlite'));
  const row = database.prepare(`SELECT role FROM staff WHERE email = 'sam@movesaferelocation.com'`).get();
  database.close();
  return row?.role === 'owner';
}
