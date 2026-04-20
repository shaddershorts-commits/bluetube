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
      // Toasts — login obrigatório (bloco 2)
      toast_login_required_like: 'Faça login pra interagir',
      toast_login_required_comment: 'Entre para comentar',
      toast_login_required_dm: 'Entre para enviar mensagens',
      toast_login_required_follow: 'Entre para seguir',
      toast_login_required_group: 'Entre para participar de grupos',
      toast_login_required_subscribe: 'Entre para assinar',
      toast_login_required_following: 'Faça login pra ver quem você segue',
      // Toasts — ações genéricas
      toast_saved: '💾 Salvo!',
      toast_removed: 'Removido',
      toast_link_copied: '🔗 Link copiado!',
      toast_link_copied_prefix: 'Link copiado: ',
      toast_error: 'Erro',
      toast_error_prefix: 'Erro: ',
      toast_error_save: 'Erro ao salvar',
      toast_error_delete: 'Erro ao excluir',
      toast_deleted: '🗑️ Excluído',
      toast_updated: '✅ Atualizado',
      toast_profile_updated: '✅ Perfil atualizado',
      toast_profile_configured: '✅ Perfil configurado!',
      toast_loading_profile: 'Carregando perfil…',
      // Toasts — sessão/conexão
      toast_session_expired: 'Sessão expirada',
      toast_session_ended_other_tab: 'Sessão encerrada em outra aba',
      toast_session_restored: '✅ Sessão restaurada',
      toast_login_detected: '✅ Login detectado',
      toast_connection_restored: '✅ Conexão restaurada',
      toast_chat_reconnected: '🟢 Chat reconectado',
      toast_notifications_read: '✅ Notificações lidas',
      // Toasts — upload
      toast_upload_too_large: '❌ Vídeo muito grande. Máximo 500MB.',
      toast_upload_wrong_format: '❌ Formato não suportado. Use MP4, MOV ou WebM.',
      toast_upload_too_long: '❌ Vídeo muito longo. Máximo 3 minutos para o feed.',
      toast_upload_invalid: '❌ Vídeo inválido.',
      toast_upload_invalid_file: '❌ Arquivo não é um vídeo válido.',
      toast_upload_missing_title: 'Adicione um título',
      toast_upload_in_progress: 'Upload em andamento...',
      toast_upload_published: '🎬 Publicado!',
      toast_video_unavailable: 'Vídeo indisponível',
      toast_no_videos: 'Sem vídeos disponíveis',
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
      // Toasts — login obrigatório
      toast_login_required_like: 'Log in to interact',
      toast_login_required_comment: 'Log in to comment',
      toast_login_required_dm: 'Log in to send messages',
      toast_login_required_follow: 'Log in to follow',
      toast_login_required_group: 'Log in to join groups',
      toast_login_required_subscribe: 'Log in to subscribe',
      toast_login_required_following: 'Log in to see who you follow',
      // Toasts — ações genéricas
      toast_saved: '💾 Saved!',
      toast_removed: 'Removed',
      toast_link_copied: '🔗 Link copied!',
      toast_link_copied_prefix: 'Link copied: ',
      toast_error: 'Error',
      toast_error_prefix: 'Error: ',
      toast_error_save: 'Error saving',
      toast_error_delete: 'Error deleting',
      toast_deleted: '🗑️ Deleted',
      toast_updated: '✅ Updated',
      toast_profile_updated: '✅ Profile updated',
      toast_profile_configured: '✅ Profile set up!',
      toast_loading_profile: 'Loading profile…',
      // Toasts — sessão/conexão
      toast_session_expired: 'Session expired',
      toast_session_ended_other_tab: 'Session ended in another tab',
      toast_session_restored: '✅ Session restored',
      toast_login_detected: '✅ Login detected',
      toast_connection_restored: '✅ Connection restored',
      toast_chat_reconnected: '🟢 Chat reconnected',
      toast_notifications_read: '✅ Notifications marked read',
      // Toasts — upload
      toast_upload_too_large: '❌ Video too large. Maximum 500MB.',
      toast_upload_wrong_format: '❌ Unsupported format. Use MP4, MOV or WebM.',
      toast_upload_too_long: '❌ Video too long. Maximum 3 minutes for the feed.',
      toast_upload_invalid: '❌ Invalid video.',
      toast_upload_invalid_file: '❌ File is not a valid video.',
      toast_upload_missing_title: 'Add a title',
      toast_upload_in_progress: 'Upload in progress...',
      toast_upload_published: '🎬 Published!',
      toast_video_unavailable: 'Video unavailable',
      toast_no_videos: 'No videos available',
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
      toast_login_required_like: 'Inicia sesión para interactuar',
      toast_login_required_comment: 'Inicia sesión para comentar',
      toast_login_required_dm: 'Inicia sesión para enviar mensajes',
      toast_login_required_follow: 'Inicia sesión para seguir',
      toast_login_required_group: 'Inicia sesión para unirte a grupos',
      toast_login_required_subscribe: 'Inicia sesión para suscribirte',
      toast_login_required_following: 'Inicia sesión para ver a quién sigues',
      toast_saved: '💾 ¡Guardado!',
      toast_removed: 'Eliminado',
      toast_link_copied: '🔗 ¡Enlace copiado!',
      toast_link_copied_prefix: 'Enlace copiado: ',
      toast_error: 'Error',
      toast_error_prefix: 'Error: ',
      toast_error_save: 'Error al guardar',
      toast_error_delete: 'Error al eliminar',
      toast_deleted: '🗑️ Eliminado',
      toast_updated: '✅ Actualizado',
      toast_profile_updated: '✅ Perfil actualizado',
      toast_profile_configured: '✅ ¡Perfil configurado!',
      toast_loading_profile: 'Cargando perfil…',
      toast_session_expired: 'Sesión expirada',
      toast_session_ended_other_tab: 'Sesión finalizada en otra pestaña',
      toast_session_restored: '✅ Sesión restaurada',
      toast_login_detected: '✅ Inicio de sesión detectado',
      toast_connection_restored: '✅ Conexión restaurada',
      toast_chat_reconnected: '🟢 Chat reconectado',
      toast_notifications_read: '✅ Notificaciones marcadas',
      toast_upload_too_large: '❌ Vídeo demasiado grande. Máximo 500MB.',
      toast_upload_wrong_format: '❌ Formato no admitido. Usa MP4, MOV o WebM.',
      toast_upload_too_long: '❌ Vídeo demasiado largo. Máximo 3 minutos para el feed.',
      toast_upload_invalid: '❌ Vídeo no válido.',
      toast_upload_invalid_file: '❌ El archivo no es un vídeo válido.',
      toast_upload_missing_title: 'Añade un título',
      toast_upload_in_progress: 'Subida en curso...',
      toast_upload_published: '🎬 ¡Publicado!',
      toast_video_unavailable: 'Vídeo no disponible',
      toast_no_videos: 'Sin vídeos disponibles',
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
      toast_login_required_like: 'Connecte-toi pour interagir',
      toast_login_required_comment: 'Connecte-toi pour commenter',
      toast_login_required_dm: 'Connecte-toi pour envoyer des messages',
      toast_login_required_follow: 'Connecte-toi pour suivre',
      toast_login_required_group: 'Connecte-toi pour rejoindre des groupes',
      toast_login_required_subscribe: 'Connecte-toi pour t\'abonner',
      toast_login_required_following: 'Connecte-toi pour voir tes abonnements',
      toast_saved: '💾 Enregistré !',
      toast_removed: 'Supprimé',
      toast_link_copied: '🔗 Lien copié !',
      toast_link_copied_prefix: 'Lien copié : ',
      toast_error: 'Erreur',
      toast_error_prefix: 'Erreur : ',
      toast_error_save: 'Erreur lors de la sauvegarde',
      toast_error_delete: 'Erreur lors de la suppression',
      toast_deleted: '🗑️ Supprimé',
      toast_updated: '✅ Mis à jour',
      toast_profile_updated: '✅ Profil mis à jour',
      toast_profile_configured: '✅ Profil configuré !',
      toast_loading_profile: 'Chargement du profil…',
      toast_session_expired: 'Session expirée',
      toast_session_ended_other_tab: 'Session terminée dans un autre onglet',
      toast_session_restored: '✅ Session restaurée',
      toast_login_detected: '✅ Connexion détectée',
      toast_connection_restored: '✅ Connexion rétablie',
      toast_chat_reconnected: '🟢 Chat reconnecté',
      toast_notifications_read: '✅ Notifications marquées comme lues',
      toast_upload_too_large: '❌ Vidéo trop volumineuse. Maximum 500 Mo.',
      toast_upload_wrong_format: '❌ Format non pris en charge. Utilise MP4, MOV ou WebM.',
      toast_upload_too_long: '❌ Vidéo trop longue. Maximum 3 minutes pour le feed.',
      toast_upload_invalid: '❌ Vidéo invalide.',
      toast_upload_invalid_file: '❌ Le fichier n\'est pas une vidéo valide.',
      toast_upload_missing_title: 'Ajoute un titre',
      toast_upload_in_progress: 'Envoi en cours...',
      toast_upload_published: '🎬 Publié !',
      toast_video_unavailable: 'Vidéo indisponible',
      toast_no_videos: 'Aucune vidéo disponible',
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
      toast_login_required_like: 'Anmelden, um zu interagieren',
      toast_login_required_comment: 'Anmelden, um zu kommentieren',
      toast_login_required_dm: 'Anmelden, um Nachrichten zu senden',
      toast_login_required_follow: 'Anmelden, um zu folgen',
      toast_login_required_group: 'Anmelden, um Gruppen beizutreten',
      toast_login_required_subscribe: 'Anmelden, um zu abonnieren',
      toast_login_required_following: 'Anmelden, um deine Abos zu sehen',
      toast_saved: '💾 Gespeichert!',
      toast_removed: 'Entfernt',
      toast_link_copied: '🔗 Link kopiert!',
      toast_link_copied_prefix: 'Link kopiert: ',
      toast_error: 'Fehler',
      toast_error_prefix: 'Fehler: ',
      toast_error_save: 'Fehler beim Speichern',
      toast_error_delete: 'Fehler beim Löschen',
      toast_deleted: '🗑️ Gelöscht',
      toast_updated: '✅ Aktualisiert',
      toast_profile_updated: '✅ Profil aktualisiert',
      toast_profile_configured: '✅ Profil eingerichtet!',
      toast_loading_profile: 'Profil wird geladen…',
      toast_session_expired: 'Sitzung abgelaufen',
      toast_session_ended_other_tab: 'Sitzung in einem anderen Tab beendet',
      toast_session_restored: '✅ Sitzung wiederhergestellt',
      toast_login_detected: '✅ Anmeldung erkannt',
      toast_connection_restored: '✅ Verbindung wiederhergestellt',
      toast_chat_reconnected: '🟢 Chat wieder verbunden',
      toast_notifications_read: '✅ Benachrichtigungen gelesen',
      toast_upload_too_large: '❌ Video zu groß. Maximal 500 MB.',
      toast_upload_wrong_format: '❌ Format nicht unterstützt. Nutze MP4, MOV oder WebM.',
      toast_upload_too_long: '❌ Video zu lang. Maximal 3 Minuten für den Feed.',
      toast_upload_invalid: '❌ Ungültiges Video.',
      toast_upload_invalid_file: '❌ Datei ist kein gültiges Video.',
      toast_upload_missing_title: 'Titel hinzufügen',
      toast_upload_in_progress: 'Upload läuft...',
      toast_upload_published: '🎬 Veröffentlicht!',
      toast_video_unavailable: 'Video nicht verfügbar',
      toast_no_videos: 'Keine Videos verfügbar',
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
      toast_login_required_like: 'Accedi per interagire',
      toast_login_required_comment: 'Accedi per commentare',
      toast_login_required_dm: 'Accedi per inviare messaggi',
      toast_login_required_follow: 'Accedi per seguire',
      toast_login_required_group: 'Accedi per unirti ai gruppi',
      toast_login_required_subscribe: 'Accedi per abbonarti',
      toast_login_required_following: 'Accedi per vedere chi segui',
      toast_saved: '💾 Salvato!',
      toast_removed: 'Rimosso',
      toast_link_copied: '🔗 Link copiato!',
      toast_link_copied_prefix: 'Link copiato: ',
      toast_error: 'Errore',
      toast_error_prefix: 'Errore: ',
      toast_error_save: 'Errore durante il salvataggio',
      toast_error_delete: 'Errore durante l\'eliminazione',
      toast_deleted: '🗑️ Eliminato',
      toast_updated: '✅ Aggiornato',
      toast_profile_updated: '✅ Profilo aggiornato',
      toast_profile_configured: '✅ Profilo configurato!',
      toast_loading_profile: 'Caricamento profilo…',
      toast_session_expired: 'Sessione scaduta',
      toast_session_ended_other_tab: 'Sessione terminata in un\'altra scheda',
      toast_session_restored: '✅ Sessione ripristinata',
      toast_login_detected: '✅ Accesso rilevato',
      toast_connection_restored: '✅ Connessione ripristinata',
      toast_chat_reconnected: '🟢 Chat riconnessa',
      toast_notifications_read: '✅ Notifiche lette',
      toast_upload_too_large: '❌ Video troppo grande. Massimo 500MB.',
      toast_upload_wrong_format: '❌ Formato non supportato. Usa MP4, MOV o WebM.',
      toast_upload_too_long: '❌ Video troppo lungo. Massimo 3 minuti per il feed.',
      toast_upload_invalid: '❌ Video non valido.',
      toast_upload_invalid_file: '❌ Il file non è un video valido.',
      toast_upload_missing_title: 'Aggiungi un titolo',
      toast_upload_in_progress: 'Caricamento in corso...',
      toast_upload_published: '🎬 Pubblicato!',
      toast_video_unavailable: 'Video non disponibile',
      toast_no_videos: 'Nessun video disponibile',
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
      toast_login_required_like: 'ログインして交流しましょう',
      toast_login_required_comment: 'コメントするにはログインが必要です',
      toast_login_required_dm: 'メッセージを送るにはログインが必要です',
      toast_login_required_follow: 'フォローするにはログインが必要です',
      toast_login_required_group: 'グループ参加にはログインが必要です',
      toast_login_required_subscribe: '登録にはログインが必要です',
      toast_login_required_following: 'フォロー中を見るにはログインが必要です',
      toast_saved: '💾 保存しました！',
      toast_removed: '削除しました',
      toast_link_copied: '🔗 リンクをコピーしました！',
      toast_link_copied_prefix: 'リンクをコピー: ',
      toast_error: 'エラー',
      toast_error_prefix: 'エラー: ',
      toast_error_save: '保存に失敗しました',
      toast_error_delete: '削除に失敗しました',
      toast_deleted: '🗑️ 削除済み',
      toast_updated: '✅ 更新しました',
      toast_profile_updated: '✅ プロフィールを更新しました',
      toast_profile_configured: '✅ プロフィール設定完了！',
      toast_loading_profile: 'プロフィール読み込み中…',
      toast_session_expired: 'セッションの有効期限が切れました',
      toast_session_ended_other_tab: '別のタブでセッションが終了しました',
      toast_session_restored: '✅ セッションを復元しました',
      toast_login_detected: '✅ ログインを検出',
      toast_connection_restored: '✅ 接続が回復しました',
      toast_chat_reconnected: '🟢 チャット再接続',
      toast_notifications_read: '✅ 通知を既読にしました',
      toast_upload_too_large: '❌ 動画が大きすぎます。最大500MB。',
      toast_upload_wrong_format: '❌ 非対応のフォーマット。MP4、MOV、WebMを使用してください。',
      toast_upload_too_long: '❌ 動画が長すぎます。フィード用は最大3分です。',
      toast_upload_invalid: '❌ 無効な動画です。',
      toast_upload_invalid_file: '❌ このファイルは有効な動画ではありません。',
      toast_upload_missing_title: 'タイトルを追加してください',
      toast_upload_in_progress: 'アップロード中...',
      toast_upload_published: '🎬 公開しました！',
      toast_video_unavailable: '動画が利用できません',
      toast_no_videos: '動画がありません',
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
