// Blue Service Worker — Network first, cache only as offline fallback
// NEVER caches HTML or API responses

const CACHE_NAME = 'blue-v2';

self.addEventListener('install', e => {
  self.skipWaiting(); // Activate immediately
});

self.addEventListener('activate', e => {
  e.waitUntil(
    // Delete ALL old caches
    caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k))))
  );
  self.clients.claim(); // Take control immediately
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // NEVER intercept API calls
  if (url.pathname.startsWith('/api/')) return;

  // NEVER cache HTML files — always go to network
  if (e.request.mode === 'navigate' || url.pathname.endsWith('.html') || e.request.destination === 'document') {
    e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
    return;
  }

  // Videos/storage: network only (too large)
  if (url.pathname.includes('storage') || e.request.destination === 'video') return;

  // JS/CSS/images: network first, cache as fallback
  e.respondWith(
    fetch(e.request).then(r => {
      if (r.ok && r.status === 200) {
        const clone = r.clone();
        caches.open(CACHE_NAME).then(c => c.put(e.request, clone)).catch(() => {});
      }
      return r;
    }).catch(() => caches.match(e.request))
  );
});
