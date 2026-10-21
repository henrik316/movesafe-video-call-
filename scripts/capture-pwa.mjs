import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { chromium, devices } from 'playwright';

const execFileAsync = promisify(execFile);
const port = Number(process.env.PORT || 4198);
const origin = `http://127.0.0.1:${port}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'movesafe-pwa-shot-'));
const shotDir = process.env.SHOT_DIR || path.join(os.tmpdir(), 'movesafe-pwa-shots');
fs.mkdirSync(shotDir, { recursive: true });

const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PORT: String(port),
    HOST: '127.0.0.1',
    DATA_DIR: dataDir,
    SESSION_SECRET: 'pwa-shot-session-secret',
    STAFF_EMAIL: 'alex@movesaferelocation.com',
    STAFF_PASSWORD: 'walkthrough-demo',
    STAFF_NAME: 'Alex Rivera',
    NODE_ENV: 'test',
    SHOW_DEMO_BANNER: 'true',
    STORAGE: 'local',
    DISPLAY: process.env.DISPLAY || ':1',
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

async function screenSize() {
  try {
    const { stdout } = await execFileAsync('xdpyinfo', [], { env: process.env });
    const match = stdout.match(/dimensions:\s+(\d+)x(\d+)/);
    if (match) return { width: Number(match[1]), height: Number(match[2]) };
  } catch {
    /* fall through */
  }
  return { width: 1920, height: 1200 };
}

async function grab(name) {
  const { width, height } = await screenSize();
  const file = path.join(shotDir, name);
  await execFileAsync('ffmpeg', [
    '-y',
    '-f', 'x11grab',
    '-video_size', `${width}x${height}`,
    '-i', process.env.DISPLAY || ':1',
    '-frames:v', '1',
    file,
  ]);
  console.log('Saved', file);
  return file;
}

let browser;
let chrome;
let standalone;
try {
  await waitForHealth();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'movesafe-install-'));
  chrome = spawn('/usr/bin/google-chrome', [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--disable-features=Translate,ChromeWhatsNewUI',
    '--bypass-app-banner-engagement-checks',
    '--remote-debugging-port=9224',
    `--user-data-dir=${profile}`,
    '--window-size=1280,900',
    '--window-position=70,36',
    `${origin}/login`,
  ], {
    env: { ...process.env, DISPLAY: process.env.DISPLAY || ':1' },
    stdio: 'ignore',
  });
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      browser = await chromium.connectOverCDP('http://127.0.0.1:9224');
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  if (!browser) throw new Error('Chrome remote debugging did not open');
  const page = browser.contexts()[0].pages().at(-1);
  page.on('pageerror', (err) => console.error('[install]', err));
  await page.getByRole('button', { name: 'Install app' }).waitFor({ timeout: 20000 });
  const ready = await page.evaluate(() => Boolean(window.__movesafeInstall?.prompt));
  console.log('beforeinstallprompt', ready);
  if (!ready) throw new Error('Install app is visible without a deferred prompt');
  await page.waitForTimeout(600);
  await grab('pwa_install_button.png');
  await page.getByRole('button', { name: 'Install app' }).click();
  await page.waitForTimeout(1500);
  await grab('pwa_install_prompt.png');
  await page.keyboard.press('Escape').catch(() => {});
  await browser.close();
  browser = null;
  if (!chrome.killed) chrome.kill('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 800));

  const iphone = await chromium.launch({ channel: 'chrome', headless: true });
  const iphoneContext = await iphone.newContext({
    ...devices['iPhone 13'],
    baseURL: origin,
  });
  const iphonePage = await iphoneContext.newPage();
  await iphonePage.goto('/login', { waitUntil: 'networkidle' });
  await iphonePage.getByText('Add to your Home Screen').waitFor();
  await iphonePage.screenshot({ path: path.join(shotDir, 'pwa_ios_instructions.png'), fullPage: false });
  console.log('Saved iPhone instructions');
  await iphone.close();

  const appProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'movesafe-app-'));
  standalone = spawn('/usr/bin/google-chrome', [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate',
    `--user-data-dir=${appProfile}`,
    `--app=${origin}/login`,
    '--window-size=1100,820',
    '--window-position=160,70',
  ], {
    env: { ...process.env, DISPLAY: process.env.DISPLAY || ':1' },
    stdio: 'ignore',
  });
  await new Promise((resolve) => setTimeout(resolve, 3500));
  await grab('pwa_standalone.png');
  console.log('CAPTURE_DONE', shotDir);
} finally {
  await browser?.close();
  if (chrome && !chrome.killed) chrome.kill('SIGTERM');
  if (standalone && !standalone.killed) standalone.kill('SIGTERM');
  stopServer();
  await Promise.race([
    new Promise((resolve) => server.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 2000)),
  ]);
}
