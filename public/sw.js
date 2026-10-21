const CACHE = 'movesafe-shell-v2';

const SHELL = [
  '/',
  '/offline.html',
  '/styles.css',
  '/manifest.webmanifest',
  '/favicon.svg',
  '/js/main.js',
  '/js/api.js',
  '/js/call.js',
  '/js/dom.js',
  '/js/format.js',
  '/js/icons.js',
  '/js/install.js',
  '/js/recorder.js',
  '/fonts/fraunces-latin.woff2',
  '/fonts/fraunces-latin-ext.woff2',
  '/fonts/outfit-latin.woff2',
  '/fonts/outfit-latin-ext.woff2',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/maskable-192.png',
  '/icons/maskable-512.png',
  '/icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

function leaveToNetwork(url, request) {
  if (url.origin !== self.location.origin) return true;
  if (request.method !== 'GET') return true;
  if (url.pathname.startsWith('/api/') || url.pathname === '/api') return true;
  if (url.pathname.startsWith('/socket.io')) return true;
  return false;
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (leaveToNetwork(url, event.request)) return;

  if (event.request.mode === 'navigate') {
    event.respondWith(networkFirstPage(event.request));
    return;
  }

  event.respondWith(staleWhileRevalidate(event.request, url));
});

async function networkFirstPage(request) {
  const cache = await caches.open(CACHE);
  try {
    const fresh = await fetch(request);
    if (fresh.ok && (fresh.headers.get('content-type') || '').includes('text/html')) {
      await cache.put('/', fresh.clone());
    }
    return fresh;
  } catch {
    return (await cache.match('/offline.html'))
      || (await cache.match('/'))
      || new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } });
  }
}

async function staleWhileRevalidate(request, url) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  const update = fetch(request)
    .then((response) => {
      if (response.ok && response.status !== 206 && isShellAsset(url.pathname)) {
        cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => null);
  if (cached) {
    update.catch(() => {});
    return cached;
  }
  const fresh = await update;
  if (fresh) return fresh;
  return new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } });
}

function isShellAsset(pathname) {
  return pathname.startsWith('/js/')
    || pathname.startsWith('/fonts/')
    || pathname.startsWith('/icons/')
    || pathname === '/styles.css'
    || pathname === '/favicon.svg'
    || pathname === '/manifest.webmanifest'
    || pathname === '/offline.html';
}
