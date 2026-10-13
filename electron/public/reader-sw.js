/* Reader app-shell service worker (web build, secure origins only); also
 * receives the share target (see handleShare below).
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

/* Share target (manifest `share_target`): the installed app receives
 * Android's share sheet as a POST to /reader-share. Files are uploaded here
 * with this origin's cookie (images together, as one scan); links and text go
 * on to #/reader/share, where the page imports them. */
const SHARE_PATH = '/reader-share';
const IMAGE_NAME = /\.(?:jpe?g|png|webp|gif|bmp|tiff?|heic|heif|avif)$/i;

function isImage(file) {
  return (file.type || '').startsWith('image/') || IMAGE_NAME.test(file.name || '');
}

async function uploadShared(path, form) {
  const response = await fetch(path, {
    method: 'POST',
    body: form,
    credentials: 'include',
    // Cookie-authenticated writes need the CSRF marker (backend core/csrf.py).
    headers: { 'X-VoiceStudio-CSRF': '1' },
  });
  if (response.ok) return;
  let detail = `HTTP ${response.status}`;
  try {
    const body = await response.json();
    if (body && typeof body.detail === 'string') detail = body.detail;
  } catch {
    // Not JSON: keep the status.
  }
  throw new Error(detail);
}

function shareRedirect(params) {
  const target = new URL(`/#/reader/share?${params.toString()}`, self.location.origin);
  return Response.redirect(target.href, 303);
}

async function handleShare(request) {
  let data;
  try {
    data = await request.formData();
  } catch {
    return shareRedirect(new URLSearchParams({ failed: '1' }));
  }
  const files = data
    .getAll('files')
    .filter((file) => typeof file === 'object' && file !== null && file.size > 0);
  if (!files.length) {
    const params = new URLSearchParams();
    for (const key of ['title', 'text', 'url']) {
      const value = data.get(key);
      if (typeof value === 'string' && value.trim()) params.set(key, value);
    }
    return shareRedirect(params);
  }
  let started = 0;
  let failed = 0;
  let error = '';
  const attempt = async (path, form) => {
    try {
      await uploadShared(path, form);
      started += 1;
    } catch (reason) {
      failed += 1;
      error ||= String((reason && reason.message) || reason);
    }
  };
  for (const file of files.filter((item) => !isImage(item))) {
    const form = new FormData();
    form.append('file', file, file.name || 'shared');
    await attempt('/reader/documents/file', form);
  }
  const images = files.filter(isImage);
  if (images.length) {
    const form = new FormData();
    images.forEach((file, index) =>
      form.append('files', file, file.name || `page-${index + 1}.jpg`),
    );
    const title = data.get('title');
    if (typeof title === 'string' && title.trim()) form.append('title', title.trim().slice(0, 200));
    await attempt('/reader/documents/scan', form);
  }
  const params = new URLSearchParams({ files: String(started), failed: String(failed) });
  if (error) params.set('error', error.slice(0, 300));
  return shareRedirect(params);
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.method === 'POST' && url.pathname === SHARE_PATH) {
    event.respondWith(handleShare(request));
    return;
  }
  if (request.method !== 'GET') return;
  if (request.mode === 'navigate' && (url.pathname === '/' || url.pathname === '/index.html')) {
    event.respondWith(networkFirst(request));
    return;
  }
  if (url.pathname.startsWith('/assets/')) event.respondWith(cacheFirst(request));
  else if (SHELL.includes(url.pathname)) event.respondWith(staleWhileRevalidate(request));
});
