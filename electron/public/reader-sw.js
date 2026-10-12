/* Reader app-shell service worker (web build, secure origins only).
 *
 * Keeps the UI loadable without the PC: navigations are network-first with the
 * cached index.html as fallback, hashed build assets are cache-first. API
 * requests (documents, audio, auth) are never intercepted; offline audio lives
 * in IndexedDB, which also works on plain-HTTP LAN origins. */
const CACHE = 'reader-shell-v1';
const SHELL = [
  '/',
  '/manifest.webmanifest',
  '/early-error-capture.js',
  '/favicon.svg',
  '/reader-icon.svg',
  '/reader-icon-192.png',
  '/reader-icon-512.png',
  '/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => Promise.allSettled(SHELL.map((url) => cache.add(url))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) await cache.put('/', response.clone());
    return response;
  } catch (error) {
    const cached = (await cache.match('/')) || (await cache.match('/index.html'));
    if (cached) return cached;
    throw error;
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) await cache.put(request, response.clone());
  return response;
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  const refresh = fetch(request).then((response) => {
    if (response.ok) void cache.put(request, response.clone());
    return response;
  });
  if (!cached) return refresh;
  refresh.catch(() => {});
  return cached;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.mode === 'navigate' && (url.pathname === '/' || url.pathname === '/index.html')) {
    event.respondWith(networkFirst(request));
    return;
  }
  if (url.pathname.startsWith('/assets/')) event.respondWith(cacheFirst(request));
  else if (SHELL.includes(url.pathname)) event.respondWith(staleWhileRevalidate(request));
});
