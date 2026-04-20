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
    // ───── PORTUGUÊS (fallback base) ──────────────────────────────────────
    pt: {
      _i18n_ok: 'sistema de traducao ativo (pt)',
      // Navegação (topbar + bottom-nav + sidebar desktop)
      nav_chat: 'Chat',
      nav_for_you: 'Para você',
      nav_following: 'Seguindo',
      nav_explore: 'Explorar',
      nav_discover: 'Descobrir',
      nav_upload: 'Carregar',
      nav_create: 'Criar',
      nav_notifications: 'Notificações',
      nav_notifications_short: 'Notif',
      nav_search: 'Buscar',
      nav_home: 'Início',
      nav_profile: 'Perfil',
      // Menu do perfil (profMenu)
      menu_share_profile: 'Compartilhar perfil',
      menu_share_profile_sub: 'Copia o link do seu perfil',
      menu_analytics: 'Analytics',
      menu_analytics_sub: 'Views, curtidas e retenção',
      menu_tendencias: 'BlueTendências',
      menu_tendencias_sub: 'Descubra tendências antes de todo mundo',
      menu_monetizacao: 'Monetização',
      menu_monetizacao_sub: 'Saldo e pagamentos',
      menu_pioneiros: 'Programa Pioneiros',
      menu_pioneiros_sub: 'R$ 1.000 por indicações',
      menu_settings: 'Configurações da conta',
      menu_settings_sub: 'Planos, assinatura e privacidade',
      menu_logout: 'Sair da conta',
      menu_logout_sub: 'Desconectar deste dispositivo',
      menu_cancel: 'Cancelar',
      // Seletor de idioma
      menu_language: 'Idioma',
      menu_language_sub: 'Escolha o idioma da interface',
      lang_title: 'Escolha o idioma',
      lang_saved: 'Idioma salvo. Recarregando...',
      lang_upsell_full: 'Idioma disponível no plano Full. Quer ver os benefícios?',
      lang_upsell_master: 'Idioma disponível no plano Master. Quer ver os benefícios?',
      lang_upsell_btn: 'Ver planos',
    },
    // ───── ENGLISH ────────────────────────────────────────────────────────
    en: {
      _i18n_ok: 'translation system active (en)',
      nav_chat: 'Chat',
      nav_for_you: 'For you',
      nav_following: 'Following',
      nav_explore: 'Explore',
      nav_discover: 'Discover',
      nav_upload: 'Upload',
      nav_create: 'Create',
      nav_notifications: 'Notifications',
      nav_notifications_short: 'Inbox',
      nav_search: 'Search',
      nav_home: 'Home',
      nav_profile: 'Profile',
      menu_share_profile: 'Share profile',
      menu_share_profile_sub: 'Copy your profile link',
      menu_analytics: 'Analytics',
      menu_analytics_sub: 'Views, likes and retention',
      menu_tendencias: 'BlueTendências',
      menu_tendencias_sub: 'Discover trends before everyone else',
      menu_monetizacao: 'Monetization',
      menu_monetizacao_sub: 'Balance and payouts',
      menu_pioneiros: 'Pioneers Program',
      menu_pioneiros_sub: 'R$ 1,000 for referrals',
      menu_settings: 'Account settings',
      menu_settings_sub: 'Plans, subscription and privacy',
      menu_logout: 'Log out',
      menu_logout_sub: 'Sign out from this device',
      menu_cancel: 'Cancel',
      menu_language: 'Language',
      menu_language_sub: 'Choose your interface language',
      lang_title: 'Choose language',
      lang_saved: 'Language saved. Reloading...',
      lang_upsell_full: 'This language is available on the Full plan. Want to see the benefits?',
      lang_upsell_master: 'This language is available on the Master plan. Want to see the benefits?',
      lang_upsell_btn: 'See plans',
    },
    // ───── ESPAÑOL ────────────────────────────────────────────────────────
    es: {
      _i18n_ok: 'sistema de traducción activo (es)',
      nav_chat: 'Chat',
      nav_for_you: 'Para ti',
      nav_following: 'Siguiendo',
      nav_explore: 'Explorar',
      nav_discover: 'Descubrir',
      nav_upload: 'Subir',
      nav_create: 'Crear',
      nav_notifications: 'Notificaciones',
      nav_notifications_short: 'Avisos',
      nav_search: 'Buscar',
      nav_home: 'Inicio',
      nav_profile: 'Perfil',
      menu_share_profile: 'Compartir perfil',
      menu_share_profile_sub: 'Copia el enlace de tu perfil',
      menu_analytics: 'Analytics',
      menu_analytics_sub: 'Vistas, me gusta y retención',
      menu_tendencias: 'BlueTendências',
      menu_tendencias_sub: 'Descubre tendencias antes que nadie',
      menu_monetizacao: 'Monetización',
      menu_monetizacao_sub: 'Saldo y pagos',
      menu_pioneiros: 'Programa Pioneros',
      menu_pioneiros_sub: 'R$ 1.000 por referidos',
      menu_settings: 'Ajustes de cuenta',
      menu_settings_sub: 'Planes, suscripción y privacidad',
      menu_logout: 'Cerrar sesión',
      menu_logout_sub: 'Desconectar este dispositivo',
      menu_cancel: 'Cancelar',
      menu_language: 'Idioma',
      menu_language_sub: 'Elige el idioma de la interfaz',
      lang_title: 'Elige el idioma',
      lang_saved: 'Idioma guardado. Recargando...',
      lang_upsell_full: 'Este idioma está disponible en el plan Full. ¿Quieres ver los beneficios?',
      lang_upsell_master: 'Este idioma está disponible en el plan Master. ¿Quieres ver los beneficios?',
      lang_upsell_btn: 'Ver planes',
    },
    // ───── FRANÇAIS ───────────────────────────────────────────────────────
    fr: {
      _i18n_ok: 'système de traduction actif (fr)',
      nav_chat: 'Chat',
      nav_for_you: 'Pour toi',
      nav_following: 'Abonnements',
      nav_explore: 'Explorer',
      nav_discover: 'Découvrir',
      nav_upload: 'Publier',
      nav_create: 'Créer',
      nav_notifications: 'Notifications',
      nav_notifications_short: 'Alertes',
      nav_search: 'Rechercher',
      nav_home: 'Accueil',
      nav_profile: 'Profil',
      menu_share_profile: 'Partager le profil',
      menu_share_profile_sub: 'Copier le lien de ton profil',
      menu_analytics: 'Analytique',
      menu_analytics_sub: "Vues, j'aime et rétention",
      menu_tendencias: 'BlueTendências',
      menu_tendencias_sub: 'Découvrir les tendances avant tout le monde',
      menu_monetizacao: 'Monétisation',
      menu_monetizacao_sub: 'Solde et paiements',
      menu_pioneiros: 'Programme Pionniers',
      menu_pioneiros_sub: 'R$ 1 000 pour les parrainages',
      menu_settings: 'Paramètres du compte',
      menu_settings_sub: 'Plans, abonnement et confidentialité',
      menu_logout: 'Déconnexion',
      menu_logout_sub: 'Se déconnecter de cet appareil',
      menu_cancel: 'Annuler',
      menu_language: 'Langue',
      menu_language_sub: "Choisir la langue de l'interface",
      lang_title: 'Choisir la langue',
      lang_saved: 'Langue enregistrée. Rechargement...',
      lang_upsell_full: "Cette langue est disponible sur le plan Full. Voir les avantages ?",
      lang_upsell_master: "Cette langue est disponible sur le plan Master. Voir les avantages ?",
      lang_upsell_btn: 'Voir les plans',
    },
    // ───── DEUTSCH ────────────────────────────────────────────────────────
    de: {
      _i18n_ok: 'Übersetzungssystem aktiv (de)',
      nav_chat: 'Chat',
      nav_for_you: 'Für dich',
      nav_following: 'Folge ich',
      nav_explore: 'Entdecken',
      nav_discover: 'Entdecken',
      nav_upload: 'Hochladen',
      nav_create: 'Erstellen',
      nav_notifications: 'Benachrichtigungen',
      nav_notifications_short: 'Benachr.',
      nav_search: 'Suchen',
      nav_home: 'Start',
      nav_profile: 'Profil',
      menu_share_profile: 'Profil teilen',
      menu_share_profile_sub: 'Link zum Profil kopieren',
      menu_analytics: 'Analytics',
      menu_analytics_sub: 'Aufrufe, Likes und Wiedergabedauer',
      menu_tendencias: 'BlueTendências',
      menu_tendencias_sub: 'Trends vor allen anderen entdecken',
      menu_monetizacao: 'Monetarisierung',
      menu_monetizacao_sub: 'Guthaben und Auszahlungen',
      menu_pioneiros: 'Pioniere-Programm',
      menu_pioneiros_sub: 'R$ 1.000 für Empfehlungen',
      menu_settings: 'Kontoeinstellungen',
      menu_settings_sub: 'Tarife, Abo und Datenschutz',
      menu_logout: 'Abmelden',
      menu_logout_sub: 'Von diesem Gerät abmelden',
      menu_cancel: 'Abbrechen',
      menu_language: 'Sprache',
      menu_language_sub: 'Sprache der Oberfläche wählen',
      lang_title: 'Sprache wählen',
      lang_saved: 'Sprache gespeichert. Wird neu geladen...',
      lang_upsell_full: 'Diese Sprache ist im Full-Tarif verfügbar. Vorteile ansehen?',
      lang_upsell_master: 'Diese Sprache ist im Master-Tarif verfügbar. Vorteile ansehen?',
      lang_upsell_btn: 'Tarife ansehen',
    },
    // ───── ITALIANO ───────────────────────────────────────────────────────
    it: {
      _i18n_ok: 'sistema di traduzione attivo (it)',
      nav_chat: 'Chat',
      nav_for_you: 'Per te',
      nav_following: 'Seguiti',
      nav_explore: 'Esplora',
      nav_discover: 'Scopri',
      nav_upload: 'Carica',
      nav_create: 'Crea',
      nav_notifications: 'Notifiche',
      nav_notifications_short: 'Avvisi',
      nav_search: 'Cerca',
      nav_home: 'Home',
      nav_profile: 'Profilo',
      menu_share_profile: 'Condividi profilo',
      menu_share_profile_sub: 'Copia il link del tuo profilo',
      menu_analytics: 'Analytics',
      menu_analytics_sub: 'Visualizzazioni, like e ritenzione',
      menu_tendencias: 'BlueTendências',
      menu_tendencias_sub: 'Scopri le tendenze prima di tutti',
      menu_monetizacao: 'Monetizzazione',
      menu_monetizacao_sub: 'Saldo e pagamenti',
      menu_pioneiros: 'Programma Pionieri',
      menu_pioneiros_sub: 'R$ 1.000 per le segnalazioni',
      menu_settings: 'Impostazioni account',
      menu_settings_sub: 'Piani, abbonamento e privacy',
      menu_logout: 'Esci',
      menu_logout_sub: 'Disconnetti da questo dispositivo',
      menu_cancel: 'Annulla',
      menu_language: 'Lingua',
      menu_language_sub: "Scegli la lingua dell'interfaccia",
      lang_title: 'Scegli la lingua',
      lang_saved: 'Lingua salvata. Ricaricando...',
      lang_upsell_full: 'Questa lingua è disponibile nel piano Full. Vedi i vantaggi?',
      lang_upsell_master: 'Questa lingua è disponibile nel piano Master. Vedi i vantaggi?',
      lang_upsell_btn: 'Vedi piani',
    },
    // ───── 日本語 ─────────────────────────────────────────────────────────
    ja: {
      _i18n_ok: '翻訳システムが有効 (ja)',
      nav_chat: 'チャット',
      nav_for_you: 'おすすめ',
      nav_following: 'フォロー中',
      nav_explore: '探索',
      nav_discover: '発見',
      nav_upload: 'アップロード',
      nav_create: '作成',
      nav_notifications: '通知',
      nav_notifications_short: '通知',
      nav_search: '検索',
      nav_home: 'ホーム',
      nav_profile: 'プロフィール',
      menu_share_profile: 'プロフィールを共有',
      menu_share_profile_sub: 'プロフィールのリンクをコピー',
      menu_analytics: 'アナリティクス',
      menu_analytics_sub: '再生数、いいね、維持率',
      menu_tendencias: 'BlueTendências',
      menu_tendencias_sub: '誰よりも早くトレンドを発見',
      menu_monetizacao: '収益化',
      menu_monetizacao_sub: '残高と支払い',
      menu_pioneiros: 'パイオニアプログラム',
      menu_pioneiros_sub: '紹介で R$ 1,000',
      menu_settings: 'アカウント設定',
      menu_settings_sub: 'プラン、購読、プライバシー',
      menu_logout: 'ログアウト',
      menu_logout_sub: 'このデバイスからサインアウト',
      menu_cancel: 'キャンセル',
      menu_language: '言語',
      menu_language_sub: 'インターフェースの言語を選択',
      lang_title: '言語を選択',
      lang_saved: '言語が保存されました。再読み込み中...',
      lang_upsell_full: 'この言語はFullプランで利用できます。特典を見ますか？',
      lang_upsell_master: 'この言語はMasterプランで利用できます。特典を見ますか？',
      lang_upsell_btn: 'プランを見る',
    },
    // ───── IDIOMAS SEM TRADUÇÃO REAL (caem no fallback PT via i18n.js) ────
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
