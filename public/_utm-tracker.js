// public/_utm-tracker.js
//
// Captura de UTM/fbclid/gclid pra atribuicao de marketing.
// Carregado em landing.html + index.html APOS o Meta Pixel — se este script
// quebrar, Pixel ja inicializou e continua disparando eventos normalmente.
//
// Modelo: LAST-TOUCH attribution (sobrescreve a cada visita com novos params).
// TTL: 60 dias.
// Storage: localStorage (chave 'bt_attribution') com fallback silencioso.
//
// Tudo dentro de IIFE com try/catch global. Falhas SAO SILENCIOSAS — nao
// quebram Pixel, nao quebram pagina, nao logam ruido no console em prod.

(function () {
  try {
    var STORAGE_KEY = 'bt_attribution';
    var EXPIRES_KEY = 'bt_attribution_expires';
    var TTL_MS = 60 * 24 * 60 * 60 * 1000; // 60 dias

    // Param names a capturar
    var TRACKING_PARAMS = [
      'utm_source', 'utm_medium', 'utm_campaign',
      'utm_content', 'utm_term',
      'fbclid', 'gclid'
    ];

    // Helpers de storage com fallback (some browsers blockeiam localStorage)
    function readStorage(key) {
      try { return window.localStorage.getItem(key); } catch (e) { return null; }
    }
    function writeStorage(key, value) {
      try { window.localStorage.setItem(key, value); return true; } catch (e) { return false; }
    }
    function removeStorage(key) {
      try { window.localStorage.removeItem(key); } catch (e) {}
    }

    // 1. Limpa atribuicao expirada (se houver)
    var expiresRaw = readStorage(EXPIRES_KEY);
    if (expiresRaw) {
      var expiresAt = parseInt(expiresRaw, 10);
      if (!isNaN(expiresAt) && Date.now() > expiresAt) {
        removeStorage(STORAGE_KEY);
        removeStorage(EXPIRES_KEY);
      }
    }

    // 2. Le params da URL atual
    var params = new URLSearchParams(window.location.search || '');
    var hasNewTracking = false;
    for (var i = 0; i < TRACKING_PARAMS.length; i++) {
      if (params.has(TRACKING_PARAMS[i])) { hasNewTracking = true; break; }
    }

    // 3. LAST-TOUCH: se URL tem novo tracking, sobrescreve sempre
    if (hasNewTracking) {
      // Preserva first_visit_at se ja existia (nao apaga history de primeira visita)
      var existingFirstVisit = null;
      try {
        var existingRaw = readStorage(STORAGE_KEY);
        if (existingRaw) {
          var existing = JSON.parse(existingRaw);
          if (existing && existing.first_visit_at) existingFirstVisit = existing.first_visit_at;
        }
      } catch (e) { /* corrupted JSON, ignora */ }

      var nowIso = new Date().toISOString();
      var attribution = {
        utm_source:   params.get('utm_source')   || null,
        utm_medium:   params.get('utm_medium')   || null,
        utm_campaign: params.get('utm_campaign') || null,
        utm_content:  params.get('utm_content')  || null,
        utm_term:     params.get('utm_term')     || null,
        fbclid:       params.get('fbclid')       || null,
        gclid:        params.get('gclid')        || null,
        referrer:     (document.referrer || '').slice(0, 500) || null,
        landing_page: (window.location.pathname || '/').slice(0, 500),
        first_visit_at:    existingFirstVisit || nowIso,
        attribution_set_at: nowIso
      };

      writeStorage(STORAGE_KEY, JSON.stringify(attribution));
      writeStorage(EXPIRES_KEY, String(Date.now() + TTL_MS));
    }

    // 4. Helper global pra outros scripts lerem (ex: handleEmailSignup)
    // Retorna null se nao houver atribuicao (signup organico, sem ad).
    window.getMarketingAttribution = function () {
      try {
        var raw = readStorage(STORAGE_KEY);
        if (!raw) return null;
        var data = JSON.parse(raw);
        return (data && typeof data === 'object') ? data : null;
      } catch (e) { return null; }
    };
  } catch (globalErr) {
    // Falha silenciosa — Pixel ja rodou antes deste script.
    // Em dev pode descomentar pra debugar:
    // console.warn('[utm-tracker] erro silencioso:', globalErr);
  }
})();
