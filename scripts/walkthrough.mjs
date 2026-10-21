import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const port = 4181;
const origin = `http://127.0.0.1:${port}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'movesafe-walk-'));
const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PORT: String(port),
    HOST: '127.0.0.1',
    DATA_DIR: dataDir,
    SESSION_SECRET: 'walkthrough-secret',
    STAFF_EMAIL: 'alex@movesaferelocation.com',
    STAFF_PASSWORD: 'walkthrough-demo',
    STAFF_NAME: 'Alex Rivera',
    NODE_ENV: 'test',
    SHOW_DEMO_BANNER: 'true',
    STORAGE: 'local',
    TRANSCODE: 'auto',
    DISPLAY: process.env.DISPLAY || ':1',
  },
  stdio: 'inherit',
});

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function place(page, bounds) {
  const session = await page.context().newCDPSession(page);
  const { windowId } = await session.send('Browser.getWindowForTarget');
  await session.send('Browser.setWindowBounds', {
    windowId,
    bounds: { windowState: 'normal', ...bounds },
  });
}

async function waitForHealth() {
  for (let i = 0; i < 50; i += 1) {
    try {
      const response = await fetch(`${origin}/api/health`);
      if (response.ok) return;
    } catch {
      /* starting */
    }
    await pause(200);
  }
  throw new Error('server did not start');
}

let browser;
try {
  await waitForHealth();
  browser = await chromium.launch({
    channel: 'chrome',
    headless: false,
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-features=WebRtcHideLocalIpsWithMdns',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '--disable-background-media-suspend',
      '--no-first-run',
      '--disable-infobars',
    ],
  });
  const staffContext = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    permissions: ['camera', 'microphone'],
  });
  const guestContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    permissions: ['camera', 'microphone'],
  });
  const staff = await staffContext.newPage();
  const guest = await guestContext.newPage();
  await place(staff, { left: 16, top: 16, width: 1320, height: 900 });
  await place(guest, { left: 1350, top: 16, width: 430, height: 900 });

  await staff.goto(`${origin}/login`);
  await pause(600);
  await staff.getByRole('button', { name: 'Use demo login' }).click();
  await staff.getByRole('heading', { name: 'Video surveys' }).waitFor();
  await pause(700);
  await staff.getByLabel('Customer name').fill('Jordan Lee');
  await staff.getByLabel('Moving from').fill('Austin, TX');
  await staff.getByLabel('Moving to').fill('Denver, CO');
  await pause(400);
  await staff.getByRole('button', { name: 'Create video survey' }).click();
  const invite = staff.locator('textarea[name="invite"]');
  await invite.waitFor();
  const link = (await invite.inputValue()).match(/https?:\/\/\S+/)?.[0];
  await pause(900);

  await guest.goto(link);
  await pause(500);
  await guest.getByRole('button', { name: 'Enable camera and mic' }).click();
  await guest.waitForFunction(() => (document.querySelector('#preview-video')?.videoWidth || 0) > 0);
  await guest.getByRole('checkbox', { name: /may be recorded/i }).check();
  await pause(500);

  await staff.getByRole('link', { name: 'Join call' }).click();
  await staff.getByRole('button', { name: 'Enable camera and mic' }).click();
  await staff.waitForFunction(() => (document.querySelector('#preview-video')?.videoWidth || 0) > 0);
  await pause(400);
  await Promise.all([
    staff.getByRole('button', { name: 'Enter survey' }).click(),
    guest.getByRole('button', { name: 'Join walkthrough' }).click(),
  ]);
  await staff.locator('.tile-state.ok', { hasText: 'Live' }).waitFor({ timeout: 25000 });
  await guest.locator('.tile-state.ok', { hasText: 'Live' }).waitFor({ timeout: 25000 });
  await place(staff, { left: 16, top: 16, width: 1320, height: 900 });
  await place(guest, { left: 1350, top: 16, width: 430, height: 900 });
  await pause(1200);

  await guest.getByRole('button', { name: 'Rear cam' }).click();
  await guest.getByRole('button', { name: 'Front cam' }).waitFor();
  await pause(800);
  await staff.getByRole('button', { name: 'Record' }).click();
  await staff.locator('#rec-banner').waitFor({ state: 'visible' });
  await guest.locator('#rec-banner').waitFor({ state: 'visible' });
  await pause(3500);

  await staff.getByRole('button', { name: 'Stop' }).click();
  await staff.locator('#rec-banner').waitFor({ state: 'hidden', timeout: 40000 });
  await pause(600);
  await staff.getByRole('link', { name: 'Library' }).click();
  await staff.getByRole('heading', { name: 'Jordan Lee' }).waitFor();
  await pause(1000);
  await staff.getByRole('button', { name: 'Play recording for Jordan Lee' }).click();
  await staff.locator('#player').waitFor();
  await staff.evaluate(() => document.querySelector('#player').play());
  await pause(2500);
  console.log('WALKTHROUGH_DONE');
} finally {
  await browser?.close().catch(() => {});
  server.kill('SIGTERM');
}
