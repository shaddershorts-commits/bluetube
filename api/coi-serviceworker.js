/* coi-serviceworker — Cross-Origin Isolation via Service Worker
 * Habilita SharedArrayBuffer (necessário para FFmpeg WASM)
 * Adiciona COOP + COEP headers em todas as respostas */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', e => {
  // Ignora requests only-if-cached que não são same-origin
  if (e.request.cache === 'only-if-cached' && e.request.mode !== 'same-origin') return;
  // Ignora extensões e outros esquemas
  if (!e.request.url.startsWith('http')) return;

  e.respondWith(
    fetch(e.request).then(response => {
      if (!response || response.status === 0 || response.type === 'opaque') return response;
      const newHeaders = new Headers(response.headers);
      newHeaders.set('Cross-Origin-Opener-Policy', 'same-origin');
      newHeaders.set('Cross-Origin-Embedder-Policy', 'credentialless');
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: newHeaders,
      });
    }).catch(e => { console.warn('[COI-SW]', e); })
  );
});
