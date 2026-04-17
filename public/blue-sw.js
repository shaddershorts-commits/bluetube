// Blue Service Worker — Network first, cache only as offline fallback
// v4: bump pra forçar reg.update() detectar mudança e disparar reload
//     automático via updatefound handler no cliente. Continua com a mesma
//     estrategia de v3 (no-store em HTML, no-cache em JS/CSS).

const CACHE_NAME = 'blue-v4';

self.addEventListener('install', e => {
  self.skipWaiting(); // Activate immediately
});

self.addEventListener('activate', e => {
  e.waitUntil(
    // Delete ALL old caches (v1, v2, etc)
    caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k))))
  );
  self.clients.claim(); // Take control immediately
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // NEVER intercept API calls
  if (url.pathname.startsWith('/api/')) return;

  // HTML: always network fresh, bypass HTTP memory/disk cache do browser.
  // `cache: 'no-store'` força ir até o servidor, ignora qualquer cache local.
  if (e.request.mode === 'navigate' || url.pathname.endsWith('.html') || e.request.destination === 'document') {
    e.respondWith(
      fetch(e.request, { cache: 'no-store' })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // Videos/storage: network only (too large)
  if (url.pathname.includes('storage') || e.request.destination === 'video') return;

  // JS/CSS/images: network-first com revalidate (no-cache força If-None-Match
  // pra pegar updates mesmo se browser acha que cache tá fresh)
  e.respondWith(
    fetch(e.request, { cache: 'no-cache' }).then(r => {
      if (r.ok && r.status === 200) {
        const clone = r.clone();
        caches.open(CACHE_NAME).then(c => c.put(e.request, clone)).catch(() => {});
      }
      return r;
    }).catch(() => caches.match(e.request))
  );
});

// Push notifications
self.addEventListener('push', event => {
  if (!event.data) return;
  let data = {};
  try { data = event.data.json(); } catch(e) { data = { titulo: 'Blue', mensagem: event.data.text() }; }
  event.waitUntil(
    self.registration.showNotification(data.titulo || 'Blue', {
      body: data.mensagem || '',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: { url: data.url || '/blue' },
      tag: data.tipo || 'blue',
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = event.notification.data?.url || '/blue';
  event.waitUntil(clients.openWindow(url));
});
