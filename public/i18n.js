// public/i18n.js — Sistema de traducao compartilhado (Fase 1)
//
// USO BASICO:
//   <script src="/i18n.js" defer></script>
//   <script>
//     await initI18n();                    // busca idioma + traducoes
//     el.textContent = t('welcome', 'Bem-vindo');  // fallback explicito
//   </script>
//
// ORDEM DE PRIORIDADE DO IDIOMA:
//   1. Preferencia manual do user (localStorage 'bt_user_lang') — persistente
//   2. Cache da detecao por IP (localStorage 'bt_lang_cache', TTL 1h)
//   3. Fetch /api/auth?action=lang (detecta pelo IP via ipapi.co)
//   4. Fallback: 'pt'
//
// COMO ADICIONAR CHAVES NOVAS:
//   Edite TRANSLATIONS_EXT abaixo. Cada idioma deve ter a chave (se faltar,
//   o sistema cai no 'pt'). Para nao quebrar o sistema incremental, SEMPRE
//   passe o fallback no t(): t('minha_key', 'Texto em PT').
//
// INTEGRACAO COM api/auth.js (INTOCAVEL):
//   Este arquivo NAO modifica TRANSLATIONS de auth.js. Ele MERGEIA o que
//   o backend devolve com TRANSLATIONS_EXT. Se houver colisao de chave,
//   TRANSLATIONS_EXT vence (util pra override).

(function () {
  // ── Constantes de cache ─────────────────────────────────────────────────
  const LANG_CACHE_KEY  = 'bt_lang_cache';
  const LANG_CACHE_TIME = 'bt_lang_cache_time';
  const USER_LANG_KEY   = 'bt_user_lang';   // preferencia manual persistente
  const CACHE_TTL_MS    = 60 * 60 * 1000;   // 1 hora

  // ── Gate por plano (espelho do index.html) ──────────────────────────────
  const FREE_LANGS   = ['pt', 'en'];
  const FULL_LANGS   = ['pt', 'en', 'es', 'fr', 'de', 'it', 'ja', 'zh', 'ar'];
  const MASTER_LANGS = ['pt', 'en', 'es', 'fr', 'de', 'it', 'ja', 'zh', 'ar',
                        'tr', 'hi', 'ko', 'ru', 'id', 'th', 'tl'];

  // Nomes legiveis pra montar dropdown (valores sao nativos de cada idioma)
  const LANG_NAMES = {
    pt: 'Português',     en: 'English',          es: 'Español',
    fr: 'Français',      de: 'Deutsch',          it: 'Italiano',
    ja: '日本語',        zh: '中文',             ar: 'العربية',
    tr: 'Türkçe',        hi: 'हिन्दी',             ko: '한국어',
    ru: 'Русский',       id: 'Bahasa Indonesia', th: 'ไทย',
    tl: 'Tagalog',
  };

  // ═══════════════════════════════════════════════════════════════════════
  // TRANSLATIONS_EXT — chaves ALEM das que ja existem em api/auth.js
  // A Fase 2 vai popular este objeto conforme for traduzindo features.
  // Por enquanto, apenas uma chave de smoke test pra validar o pipeline.
  // ═══════════════════════════════════════════════════════════════════════
  const TRANSLATIONS_EXT = {
    pt: { _i18n_ok: 'sistema de traducao ativo (pt)' },
    en: { _i18n_ok: 'translation system active (en)' },
    es: { _i18n_ok: 'sistema de traducción activo (es)' },
    fr: { _i18n_ok: 'système de traduction actif (fr)' },
    de: { _i18n_ok: 'Übersetzungssystem aktiv (de)' },
    it: { _i18n_ok: 'sistema di traduzione attivo (it)' },
    ja: { _i18n_ok: '翻訳システムが有効 (ja)' },
    zh: { _i18n_ok: '翻译系统已激活 (zh)' },
    ar: { _i18n_ok: 'نظام الترجمة نشط (ar)' },
    tr: { _i18n_ok: 'çeviri sistemi aktif (tr)' },
    hi: { _i18n_ok: 'अनुवाद प्रणाली सक्रिय (hi)' },
    ko: { _i18n_ok: '번역 시스템 활성 (ko)' },
    ru: { _i18n_ok: 'система перевода активна (ru)' },
    id: { _i18n_ok: 'sistem terjemahan aktif (id)' },
    th: { _i18n_ok: 'ระบบแปลทำงานอยู่ (th)' },
    tl: { _i18n_ok: 'aktibo ang sistema ng pagsasalin (tl)' },
  };

  // ── Estado global exposto via window ────────────────────────────────────
  window.siteLang = 'pt';
  window.siteTranslations = {};
  window.siteCurrency = null;

  let _initPromise = null;  // garante que initI18n seja idempotente

  // ═══════════════════════════════════════════════════════════════════════
  // initI18n() — resolve o idioma e popula siteTranslations
  // Retorna { lang, translations, currency }
  // ═══════════════════════════════════════════════════════════════════════
  function initI18n() {
    if (_initPromise) return _initPromise;
    _initPromise = _doInit();
    return _initPromise;
  }

  async function _doInit() {
    const now = Date.now();
    let lang = null;
    let translations = null;
    let currency = null;
    let fonte = 'fallback';

    // 1. Preferencia manual do user (maior prioridade)
    try {
      const userLang = localStorage.getItem(USER_LANG_KEY);
      if (userLang && LANG_NAMES[userLang]) {
        lang = userLang;
        fonte = 'user-pref';
      }
    } catch (e) { /* localStorage pode estar bloqueado */ }

    // 2. Cache do fetch anterior (ainda que user-pref tenha sobrescrito lang,
    //    usamos o cache das translations se houver — sao as mesmas chaves)
    let cacheValido = false;
    try {
      const cachedTime = parseInt(localStorage.getItem(LANG_CACHE_TIME) || '0', 10);
      const cachedRaw  = localStorage.getItem(LANG_CACHE_KEY);
      if (cachedRaw && (now - cachedTime) < CACHE_TTL_MS) {
        const d = JSON.parse(cachedRaw);
        // Se ja temos lang da preferencia do user, so usa translations do cache
        // se baterem com esse lang. Senao, precisa refetch.
        if (!lang || lang === d.lang) {
          if (!lang) { lang = d.lang; fonte = 'cache-ip'; }
          translations = d.translations || {};
          currency = d.currency || null;
          cacheValido = true;
        }
      }
    } catch (e) { /* JSON parse ou storage */ }

    // 3. Fetch se precisar (cache invalido OU user-pref sem cache compativel)
    // Nota: /api/auth?action=lang detecta SEMPRE por IP (nao aceita lang param).
    // Se o user-pref difere do IP, as chaves do BACKEND virao no idioma do IP
    // — mas TRANSLATIONS_EXT sobrescreve no merge abaixo, garantindo que as
    // chaves novas (Blue/BlueEditor) apareçam no idioma escolhido pelo user.
    if (!cacheValido || !translations) {
      try {
        const r = await fetch('/api/auth?action=lang');
        if (r.ok) {
          const d = await r.json();
          translations = d.translations || {};
          currency = d.currency || null;
          if (!lang) { lang = d.lang || 'pt'; fonte = 'ip-detect'; }
          // Cacheia a resposta original do backend (nao o merge com EXT —
          // pra EXT poder evoluir sem precisar invalidar cache manualmente)
          try {
            localStorage.setItem(LANG_CACHE_KEY, JSON.stringify({
              lang: d.lang, translations: d.translations || {}, currency: d.currency || null,
            }));
            localStorage.setItem(LANG_CACHE_TIME, String(now));
          } catch (e) {}
        }
      } catch (e) {
        console.warn('[i18n] fetch falhou, usando fallback pt', e && e.message);
      }
    }

    // 4. Fallback final
    if (!lang) lang = 'pt';
    if (!translations) translations = {};

    // 5. Merge com TRANSLATIONS_EXT. Chaves de EXT tem prioridade sobre backend.
    const ext = TRANSLATIONS_EXT[lang] || {};
    translations = Object.assign({}, translations, ext);

    // 6. Fill-in do PT: qualquer chave em TRANSLATIONS_EXT.pt que nao tenha
    //    equivalente em translations vira fallback. Evita mostrar chave crua
    //    ao user quando a feature foi traduzida em pt mas nao no idioma atual.
    if (lang !== 'pt') {
      const ptExt = TRANSLATIONS_EXT.pt || {};
      for (const k of Object.keys(ptExt)) {
        if (!(k in translations)) translations[k] = ptExt[k];
      }
    }

    window.siteLang = lang;
    window.siteTranslations = translations;
    window.siteCurrency = currency;

    try { console.log('[i18n] pronto — lang:', lang, '| fonte:', fonte); } catch (e) {}
    return { lang, translations, currency, fonte };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // t(key, fallback) — helper de traducao
  // Se a chave nao existir, retorna o fallback (ou a propria chave se nao
  // tiver fallback). Sempre prefira PASSAR O FALLBACK em PT pra nao vazar
  // "nome_da_chave" pro user se algo der errado.
  // ═══════════════════════════════════════════════════════════════════════
  function t(key, fallback) {
    const tr = window.siteTranslations;
    if (tr && Object.prototype.hasOwnProperty.call(tr, key)) return tr[key];
    return (fallback != null) ? fallback : key;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Gate por plano
  // ═══════════════════════════════════════════════════════════════════════
  function langAllowedForPlan(lang, plano) {
    const p = String(plano || 'free').toLowerCase();
    if (p === 'master') return MASTER_LANGS.includes(lang);
    if (p === 'full')   return FULL_LANGS.includes(lang);
    return FREE_LANGS.includes(lang);
  }

  function allowedLangs(plano) {
    const p = String(plano || 'free').toLowerCase();
    if (p === 'master') return MASTER_LANGS.slice();
    if (p === 'full')   return FULL_LANGS.slice();
    return FREE_LANGS.slice();
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Preferencia manual do user (persistente)
  // setUserLang valida contra o plano antes de salvar. Se o plano nao
  // permitir, retorna false — o caller deve mostrar upsell.
  // ═══════════════════════════════════════════════════════════════════════
  function setUserLang(lang, plano) {
    if (!LANG_NAMES[lang]) return false;
    if (plano && !langAllowedForPlan(lang, plano)) return false;
    try { localStorage.setItem(USER_LANG_KEY, lang); } catch (e) { return false; }
    return true;
  }

  function clearUserLang() {
    try { localStorage.removeItem(USER_LANG_KEY); } catch (e) {}
  }

  function getUserLang() {
    try { return localStorage.getItem(USER_LANG_KEY) || null; } catch (e) { return null; }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Exports
  // ═══════════════════════════════════════════════════════════════════════
  window.initI18n          = initI18n;
  window.t                 = t;
  window.langAllowedForPlan = langAllowedForPlan;
  window.allowedLangs      = allowedLangs;
  window.setUserLang       = setUserLang;
  window.clearUserLang     = clearUserLang;
  window.getUserLang       = getUserLang;
  window.LANG_NAMES        = LANG_NAMES;
  // Expoe EXT pra debug/extensao em runtime (nao modificar em producao)
  window.TRANSLATIONS_EXT  = TRANSLATIONS_EXT;
})();
