import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const port = Number(process.env.PORT || 4197);
const origin = `http://127.0.0.1:${port}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'movesafe-pwa-'));
const root = process.cwd();

function fail(message) {
  throw new Error(message);
}

function pngSize(file) {
  const buf = fs.readFileSync(file);
  if (buf.toString('ascii', 1, 4) !== 'PNG') fail(`${file} is not a PNG`);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function checkManifestFiles() {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'public/manifest.webmanifest'), 'utf8'));
  if (manifest.name !== 'MoveSafe Relocation') fail(`name is ${manifest.name}`);
  if (manifest.short_name !== 'MoveSafe') fail(`short_name is ${manifest.short_name}`);
  if (manifest.display !== 'standalone') fail(`display is ${manifest.display}`);
  if (manifest.start_url !== '/' || manifest.scope !== '/') fail('start_url or scope is not /');
  if (manifest.theme_color !== '#1f4d3a') fail(`theme_color is ${manifest.theme_color}`);
  if (manifest.background_color !== '#f7f3ec') fail(`background_color is ${manifest.background_color}`);
  const icons = manifest.icons || [];
  for (const needed of [
    ['192x192', 'any'],
    ['512x512', 'any'],
    ['192x192', 'maskable'],
    ['512x512', 'maskable'],
  ]) {
    const found = icons.some((icon) => icon.sizes === needed[0] && icon.purpose === needed[1]);
    if (!found) fail(`manifest is missing ${needed.join(' ')} icon`);
  }
  for (const icon of icons) {
    const file = path.join(root, 'public', icon.src);
    const size = pngSize(file);
    const [width, height] = icon.sizes.split('x').map(Number);
    if (size.width !== width || size.height !== height) {
      fail(`${icon.src} is ${size.width}x${size.height}, manifest says ${icon.sizes}`);
    }
  }
  const apple = pngSize(path.join(root, 'public/icons/apple-touch-icon.png'));
  if (apple.width !== 180 || apple.height !== 180) fail('apple touch icon is not 180x180');
  console.log('Manifest and icon files look installable.');
}

const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(port),
    HOST: '127.0.0.1',
    DATA_DIR: dataDir,
    SESSION_SECRET: 'pwa-check-session-secret',
    STAFF_EMAIL: 'alex@movesaferelocation.com',
    STAFF_PASSWORD: 'walkthrough-demo',
    STAFF_NAME: 'Alex Rivera',
    NODE_ENV: 'test',
    SHOW_DEMO_BANNER: 'true',
    STORAGE: 'local',
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
  fail('Server did not start');
}

let browser;
try {
  checkManifestFiles();
  await waitForHealth();

  const manifestResponse = await fetch(`${origin}/manifest.webmanifest`);
  const manifestType = manifestResponse.headers.get('content-type') || '';
  if (!manifestResponse.ok || !manifestType.includes('application/manifest+json')) {
    fail(`manifest content-type is ${manifestType || 'missing'}`);
  }
  const workerResponse = await fetch(`${origin}/sw.js`);
  const workerCache = workerResponse.headers.get('cache-control') || '';
  if (!workerResponse.ok || !workerCache.includes('no-cache')) {
    fail(`service worker cache-control is ${workerCache || 'missing'}`);
  }
  const pageHeaders = await fetch(`${origin}/`);
  const html = await pageHeaders.text();
  if (!html.includes('rel="manifest"') || !html.includes('apple-touch-icon') || !html.includes('beforeinstallprompt')) {
    fail('index.html is missing manifest, apple touch icon, or install listener');
  }
  console.log('Manifest and service worker headers are correct.');

  browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--disable-background-timer-throttling'],
  });
  const context = await browser.newContext({ baseURL: origin, viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  page.on('pageerror', (err) => console.error('[page]', err));
  await page.goto('/login', { waitUntil: 'networkidle' });
  await page.waitForFunction(async () => {
    const registration = await navigator.serviceWorker.ready;
    return Boolean(registration.active);
  });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => navigator.serviceWorker.controller);
  console.log('Service worker is controlling the page.');

  const onlineConfig = await page.evaluate(async () => {
    const response = await fetch('/api/config');
    return response.status;
  });
  if (onlineConfig !== 200) fail(`/api/config returned ${onlineConfig} while online`);

  await context.setOffline(true);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  const offlineTitle = await page.locator('h1').innerText();
  if (!/offline/i.test(offlineTitle)) fail(`offline navigation showed “${offlineTitle}”`);
  const offlineBody = await page.locator('body').innerText();
  if (!offlineBody.includes('video visit still needs a connection')) {
    fail('offline page does not explain that a call needs a connection');
  }
  const cachedApi = await page.evaluate(async () => {
    try {
      const response = await fetch('/api/config', { credentials: 'same-origin' });
      return { failed: false, status: response.status };
    } catch (err) {
      return { failed: true, error: String(err) };
    }
  });
  if (!cachedApi.failed) fail(`offline /api/config was served with status ${cachedApi.status}`);
  const cachedSocket = await page.evaluate(async () => {
    try {
      const response = await fetch('/socket.io/socket.io.js');
      return { failed: false, status: response.status };
    } catch {
      return { failed: true };
    }
  });
  if (!cachedSocket.failed) fail(`offline /socket.io/socket.io.js was served with status ${cachedSocket.status}`);
  console.log('Offline page is shown, and API plus signaling stay on the network.');

  await context.setOffline(false);
  await page.goto('/c/ABCDEFGH', { waitUntil: 'networkidle' });
  const pathName = new URL(page.url()).pathname;
  if (pathName !== '/c/ABCDEFGH') fail(`join link navigated to ${pathName}`);
  const heading = await page.locator('h1').innerText();
  if (heading !== 'This survey link is not valid') fail(`join link rendered “${heading}”`);
  if (!page.url().includes('/c/ABCDEFGH')) fail('installed navigation rewrote the customer link');
  console.log('Customer join link stays on /c/ABCDEFGH.');
  console.log('PWA check passed.');
} finally {
  await browser?.close();
  stopServer();
  await Promise.race([
    new Promise((resolve) => server.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 2000)),
  ]);
}
