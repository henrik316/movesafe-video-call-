import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const port = Number(process.env.PORT || 4223);
const origin = `http://127.0.0.1:${port}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'movesafe-capture-'));
const smsFile = path.join(dataDir, 'sms.log');
const shotDir = process.env.SHOT_DIR || '/opt/cursor/artifacts';
fs.mkdirSync(shotDir, { recursive: true });

const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PORT: String(port),
    HOST: '127.0.0.1',
    DATA_DIR: dataDir,
    SESSION_SECRET: 'capture-session-secret',
    NODE_ENV: 'test',
    DEMO_MODE: 'true',
    SHOW_DEMO_BANNER: 'true',
    VISION_STUB: '1',
    SMS_CAPTURE_FILE: smsFile,
    OWNER_PHONE: '+15555550100',
    STORAGE: 'local',
    TRANSCODE: 'auto',
  },
  stdio: 'inherit',
});

function stopServer() {
  if (!server.killed) server.kill('SIGTERM');
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
  throw new Error('Server did not start');
}

function latestSmsCode() {
  const lines = fs.readFileSync(smsFile, 'utf8').trim().split('\n').filter(Boolean);
  return JSON.parse(lines.at(-1)).code;
}

async function confirmSms(page, buttonName) {
  const dialog = page.locator('dialog.sms-dialog');
  await dialog.waitFor();
  await dialog.getByLabel('Text code').fill(latestSmsCode());
  await dialog.getByRole('button', { name: buttonName }).click();
  await dialog.waitFor({ state: 'detached' });
}

let browser;
try {
  await waitForHealth();
  browser = await chromium.launch({
    channel: 'chrome',
    headless: process.env.HEADED !== '1',
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-features=WebRtcHideLocalIpsWithMdns',
      '--disable-background-timer-throttling',
      '--window-position=40,40',
      '--window-size=1440,900',
    ],
  });

  const staffContext = await browser.newContext({
    baseURL: origin,
    viewport: { width: 1440, height: 900 },
    permissions: ['camera', 'microphone'],
  });
  const guestContext = await browser.newContext({
    baseURL: origin,
    viewport: { width: 390, height: 844 },
    permissions: ['camera', 'microphone'],
  });
  const staff = await staffContext.newPage();
  const guest = await guestContext.newPage();

  await staff.goto('/login');
  await staff.getByLabel('Email').fill('alex@movesaferelocation.com');
  await staff.getByLabel('Password').fill('walkthrough-demo');
  await staff.getByRole('button', { name: 'Sign in' }).click();
  await staff.getByLabel('Text code').waitFor();
  await staff.getByLabel('Text code').fill(latestSmsCode());
  await staff.getByRole('button', { name: 'Verify code' }).click();
  await staff.getByRole('heading', { name: 'Video surveys' }).waitFor();

  await staff.goto('/admin');
  await staff.getByRole('heading', { name: 'Office admin' }).waitFor();
  await staff.getByLabel('Email').fill('casey@example.com');
  await staff.getByRole('button', { name: 'Send invite' }).click();
  await confirmSms(staff, 'Send invite');
  await staff.locator('#invite-panel textarea').waitFor();
  await staff.locator('#invite-panel').screenshot({ path: path.join(shotDir, 'owner_invites.png') });
  await staff.locator('#owner-settings').screenshot({ path: path.join(shotDir, 'owner_admin.png') });

  await staff.goto('/');
  await staff.getByLabel('Customer name').fill('Jordan Lee');
  await staff.getByLabel('Moving from').fill('Austin, TX');
  await staff.getByLabel('Moving to').fill('Denver, CO');
  await staff.getByRole('button', { name: 'Create video survey' }).click();
  const invite = staff.locator('textarea[name="invite"]');
  await invite.waitFor();
  const link = (await invite.inputValue()).match(/https?:\/\/\S+/)?.[0];
  if (!link) throw new Error('Missing customer link');
  const roomId = link.split('/c/')[1];

  await guest.goto(link);
  await guest.getByRole('button', { name: 'Enable camera and mic' }).click();
  await guest.waitForFunction(() => (document.querySelector('#preview-video')?.videoWidth || 0) > 0);
  await guest.getByRole('checkbox', { name: /may be recorded/i }).check();

  await staff.getByRole('link', { name: 'Join call' }).click();
  await staff.getByRole('button', { name: 'Enable camera and mic' }).click();
  await staff.waitForFunction(() => (document.querySelector('#preview-video')?.videoWidth || 0) > 0);
  await Promise.all([
    staff.getByRole('button', { name: 'Enter survey' }).click(),
    guest.getByRole('button', { name: 'Join walkthrough' }).click(),
  ]);
  await staff.locator('.tile-state.ok', { hasText: 'Live' }).waitFor({ timeout: 25000 });
  await staff.waitForFunction(() => (document.querySelector('.remote-tile video')?.videoWidth || 0) > 0);

  await staff.getByRole('button', { name: 'Inventory' }).click();
  await staff.locator('.inventory-drawer').waitFor();
  await staff.locator('#inventory-search').fill('sofa');
  await staff.getByRole('button', { name: /Sofa, 3-seat/ }).click();
  await staff.getByText('1 × 50 cu ft').waitFor();
  await staff.getByRole('button', { name: 'Scan' }).click();
  await staff.getByRole('heading', { name: 'Suggestions' }).waitFor();
  await staff.getByText('Bed, queen').waitFor();
  await staff.locator('.inventory-drawer').getByRole('button', { name: 'Add Bed, queen' }).click();
  await staff.getByText('1 × 60 cu ft').waitFor();
  await staff.screenshot({ path: path.join(shotDir, 'inventory_call_panel.png') });

  await staff.goto(`/inventory/${roomId}`);
  await staff.getByRole('heading', { name: 'Jordan Lee' }).waitFor();
  const qty = staff.getByLabel('Qty').first();
  await qty.fill('2');
  await staff.getByRole('button', { name: 'Save' }).first().click();
  await staff.getByText('160 cu ft').waitFor();
  await staff.screenshot({ path: path.join(shotDir, 'inventory_review.png'), fullPage: true });

  await staff.goto(`/print/inventory/${roomId}`);
  await staff.getByRole('heading', { name: 'Jordan Lee' }).waitFor();
  await staff.getByText('160', { exact: true }).waitFor();
  await staff.getByRole('button', { name: 'Print or save as PDF' }).waitFor();
  await staff.screenshot({ path: path.join(shotDir, 'inventory_summary.png'), fullPage: true });

  const csv = await staff.request.get(`/api/rooms/${roomId}/inventory.csv`);
  const text = await csv.text();
  if (!csv.ok() || !text.includes('Sofa, 3-seat') || !text.includes('Bed, queen')) {
    throw new Error(`CSV missing items: ${text.slice(0, 400)}`);
  }
  console.log('Captured office screenshots', { roomId, shotDir });
} finally {
  await browser?.close();
  stopServer();
}
