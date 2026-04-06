// Blue Service Worker — Cache first for assets, network first for API
const CACHE_NAME = 'blue-v1';
const STATIC_ASSETS = ['/blue.html', '/manifest.json'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(STATIC_ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // API calls: network first
  if (url.pathname.startsWith('/api/')) {
    e.respondWith(fetch(e.request).catch(() => new Response(JSON.stringify({ error: 'Offline' }), { headers: { 'Content-Type': 'application/json' } })));
    return;
  }
  // Videos: network only (too large to cache)
  if (url.pathname.includes('storage') || url.pathname.includes('video')) {
    e.respondWith(fetch(e.request));
    return;
  }
  // Static assets: cache first
  e.respondWith(caches.match(e.request).then(cached => cached || fetch(e.request).then(r => {
    if (r.ok) { const clone = r.clone(); caches.open(CACHE_NAME).then(c => c.put(e.request, clone)); }
    return r;
  })));
});
