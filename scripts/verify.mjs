import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const port = 4179;
const origin = `http://127.0.0.1:${port}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'movesafe-'));
const smsFile = path.join(dataDir, 'sms.log');
const shotDir = process.env.SHOT_DIR || path.join(os.tmpdir(), 'movesafe-shots');
fs.mkdirSync(shotDir, { recursive: true });

const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PORT: String(port),
    HOST: '127.0.0.1',
    DATA_DIR: dataDir,
    SESSION_SECRET: 'verify-session-secret',
    STAFF_EMAIL: 'alex@movesaferelocation.com',
    STAFF_PASSWORD: 'walkthrough-demo',
    STAFF_NAME: 'Alex Rivera',
    NODE_ENV: 'test',
    SHOW_DEMO_BANNER: 'true',
    DEMO_MODE: 'true',
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

function latestSmsCode(file) {
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
  return JSON.parse(lines[lines.length - 1]).code;
}

function watch(page, label) {
  page.on('pageerror', (err) => console.error(`[${label}]`, err));
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    if (text.includes('401') || text.includes('ERR_CONNECTION_REFUSED')) return;
    console.error(`[${label}]`, text);
  });
}

let browser;
try {
  await waitForHealth();
  browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-features=WebRtcHideLocalIpsWithMdns',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '--disable-background-media-suspend',
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
    isMobile: true,
    hasTouch: true,
    permissions: ['camera', 'microphone'],
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  });
  const staff = await staffContext.newPage();
  const guest = await guestContext.newPage();
  watch(staff, 'staff');
  watch(guest, 'guest');

  const denied = await guest.request.get('/api/recordings');
  if (denied.status() !== 401) throw new Error(`Guest recordings status ${denied.status()}`);

  console.log('step login');
  await staff.goto('/login');
  await staff.getByLabel('Email').fill('alex@movesaferelocation.com');
  await staff.getByLabel('Password').fill('walkthrough-demo');
  await staff.getByRole('button', { name: 'Sign in' }).click();
  await staff.getByLabel('Text code').waitFor();
  await staff.getByLabel('Text code').fill(latestSmsCode(smsFile));
  await staff.getByRole('button', { name: 'Verify code' }).click();
  await staff.getByRole('heading', { name: 'Video surveys' }).waitFor();
  console.log('step create room');

  await staff.getByLabel('Customer name').fill('Jordan Lee');
  await staff.getByLabel('Moving from').fill('Austin, TX');
  await staff.getByLabel('Moving to').fill('Denver, CO');
  await staff.getByLabel('Office notes').fill('Piano on the second floor. Gate code stays off the customer screen.');
  await staff.getByRole('button', { name: 'Create video survey' }).click();
  const invite = staff.locator('textarea[name="invite"]');
  await invite.waitFor();
  const link = (await invite.inputValue()).match(/https?:\/\/\S+/)?.[0];
  if (!link) throw new Error('Invite did not include a link');
  console.log('step guest lobby', link);

  await guest.goto(link);
  const join = guest.getByRole('button', { name: 'Join walkthrough' });
  await join.waitFor();
  if (await join.isEnabled()) throw new Error('Join should wait for consent and a camera');
  await guest.getByRole('button', { name: 'Enable camera and mic' }).click();
  await guest.waitForFunction(() => (document.querySelector('#preview-video')?.videoWidth || 0) > 0);
  if (await join.isEnabled()) throw new Error('Join should still require consent');
  await guest.getByRole('checkbox', { name: /may be recorded/i }).check();
  if (!(await join.isEnabled())) throw new Error('Join stayed disabled after consent');

  console.log('step staff lobby');
  await staff.getByRole('link', { name: 'Join call' }).click();
  await staff.getByText('Piano on the second floor').waitFor();
  if (await staff.getByText('Gate code stays off the customer screen').count() !== 1) {
    throw new Error('Staff notes missing');
  }
  await guest.getByText('Piano on the second floor').count().then((count) => {
    if (count !== 0) throw new Error('Office notes leaked to the customer');
  });

  await staff.getByRole('button', { name: 'Enable camera and mic' }).click();
  await staff.waitForFunction(() => (document.querySelector('#preview-video')?.videoWidth || 0) > 0);
  console.log('step enter call');
  await Promise.all([
    staff.getByRole('button', { name: 'Enter survey' }).click(),
    join.click(),
  ]);

  await staff.locator('.tile-state.ok', { hasText: 'Live' }).waitFor({ timeout: 25000 });
  await guest.locator('.tile-state.ok', { hasText: 'Live' }).waitFor({ timeout: 25000 });
  await staff.getByText('Jordan Lee', { exact: true }).first().waitFor();
  await guest.locator('[data-name-for]').filter({ hasText: 'Alex Rivera' }).waitFor();

  await guest.getByRole('button', { name: 'Rear cam' }).click();
  await guest.getByRole('button', { name: 'Front cam' }).waitFor({ timeout: 10000 });

  console.log('step record');
  await staff.getByRole('button', { name: 'Record' }).click();
  await staff.locator('#rec-banner').waitFor({ state: 'visible', timeout: 10000 });
  await guest.locator('#rec-banner').waitFor({ state: 'visible', timeout: 10000 });
  const banner = await guest.locator('#rec-live').innerText();
  if (!banner.includes('This call is being recorded')) {
    throw new Error(`Unexpected banner: ${banner}`);
  }
  await staff.waitForTimeout(3500);
  const frames = await staff.evaluate(() => ({
    remotes: document.querySelectorAll('.remote-tile video').length,
    remoteWidth: document.querySelector('.remote-tile video')?.videoWidth || 0,
    localWidth: document.querySelector('#local-video')?.videoWidth || 0,
  }));
  if (frames.remotes < 1 || frames.remoteWidth < 2 || frames.localWidth < 2) {
    throw new Error(`Video frames missing ${JSON.stringify(frames)}`);
  }
  await staff.screenshot({ path: path.join(shotDir, 'call_recording_staff.png') });
  await guest.screenshot({ path: path.join(shotDir, 'call_recording_guest.png') });
  console.log('Captured call screenshots', frames);

  await staff.getByRole('button', { name: 'Stop' }).click();
  await staff.locator('#rec-banner').waitFor({ state: 'hidden', timeout: 40000 });
  await staff.getByRole('link', { name: 'Library' }).click();
  await staff.getByRole('heading', { name: 'Jordan Lee' }).waitFor({ timeout: 15000 });
  await staff.getByText('Austin, TX → Denver, CO').waitFor();
  await staff.screenshot({ path: path.join(shotDir, 'recordings_list.png') });

  const listed = await staff.request.get('/api/recordings');
  const payload = await listed.json();
  const rec = payload.recordings.find((item) => item.customerName === 'Jordan Lee' && item.status === 'ready');
  if (!rec) throw new Error(`No ready recording: ${JSON.stringify(payload.recordings)}`);
  const file = await staff.request.get(`/api/recordings/${rec.id}/file`);
  const bytes = await file.body();
  const type = file.headers()['content-type'] || '';
  if (!file.ok() || !type.startsWith('video/') || bytes.length < 2000) {
    throw new Error(`Bad recording file status=${file.status()} type=${type} bytes=${bytes.length}`);
  }
  console.log('Saved recording', rec.id, type, bytes.length, 'duration', rec.durationSec);
  const guestFile = await guest.request.get(`/api/recordings/${rec.id}/file`);
  if (guestFile.status() !== 401) throw new Error(`Customer could download a recording (${guestFile.status()})`);

  await staff.getByRole('button', { name: 'Play recording for Jordan Lee' }).click();
  await staff.locator('#player').waitFor();
  const playback = await staff.evaluate(async () => {
    const video = document.querySelector('#player');
    try {
      await video.play();
    } catch (err) {
      return { error: err.message };
    }
    await new Promise((resolve) => setTimeout(resolve, 1200));
    return {
      currentTime: video.currentTime,
      duration: video.duration,
      videoBytes: video.webkitVideoDecodedByteCount || 0,
      audioBytes: video.webkitAudioDecodedByteCount || 0,
      mediaError: video.error && video.error.message,
      readyState: video.readyState,
    };
  });
  console.log('Playback', playback);
  if (playback.mediaError || playback.error) throw new Error(`Playback failed ${JSON.stringify(playback)}`);
  if (!(playback.currentTime > 0.2) && !(playback.videoBytes > 0)) {
    throw new Error(`Recording did not play ${JSON.stringify(playback)}`);
  }
  if (!(playback.audioBytes > 0)) {
    throw new Error(`Recording has no decoded audio ${JSON.stringify(playback)}`);
  }
  await staff.screenshot({ path: path.join(shotDir, 'recordings_playback.png') });
  await staff.getByRole('button', { name: 'Close' }).click();

  await staff.getByRole('button', { name: 'Delete recording for Jordan Lee' }).click();
  await staff.getByLabel('Text code').waitFor();
  await staff.getByLabel('Text code').fill(latestSmsCode(smsFile));
  await staff.getByRole('button', { name: 'Confirm delete' }).click();
  await staff.getByText('No recordings yet').waitFor();

  console.log('Verify passed');
  console.log('Screenshots in', shotDir);
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  stopServer();
  await Promise.race([
    new Promise((resolve) => server.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 2000)),
  ]);
}
