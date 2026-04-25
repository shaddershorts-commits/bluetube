// public/translations-en-overrides.js
// EN-overrides — vencem em colisao com TRANSLATIONS.en de api/auth.js (linha 48).
// Carregado em index.html ANTES do detectAndTranslate(). Quando siteLang === 'en',
// applyTranslations() le siteTranslations ja merged com EN_OVERRIDES. Chaves nao
// listadas aqui caem no TRANSLATIONS.en original (que continua sendo a base).
//
// Diretrizes Sprint 2 (EN nativa, nao traducao literal):
// - Verbos imperativos, frases curtas, hooks fortes
// - "you"/"your" frequente, nao "users"/"customers"
// - Tom de criador (informal, confiante), nao corporativo
// - Sem excesso de emojis (BR > EN naturalmente)
// - Sem regionalismos BR
//
// Pra revisar: abrir https://bluetubeviral.com/?lang=en e validar visualmente.

window.EN_OVERRIDES = {
  // ── HERO ────────────────────────────────────────────────────────────────────
  hero_1: 'Your next million-view Short',
  hero_2: 'starts here.',
  hero_3: 'Try it free.',
  hero_sub: 'Paste any YouTube Short. Get the transcript + 2 viral scripts ready to record. No signup needed.',
  btn_go: 'Get My Scripts ↗',

  // ── TABS / RESULTS ──────────────────────────────────────────────────────────
  tab_appeal: '🔥 Punchy',
  new_short: 'Try Another',
  generating: 'Cooking your next hit…',
  err_empty: 'Drop a YouTube Short link to begin.',
  err_invalid: "That's not a Short link. Use: youtube.com/shorts/...",

  // ── NAV / AUTH ──────────────────────────────────────────────────────────────
  nav_enter: 'Log In',
  nav_logout: 'Log Out',
  auth_title: 'Sign in or create your account',
  tab_login: 'Log In',
  tab_signup: 'Sign Up',
  pwd_min: 'Choose a password (6+ chars)',
  btn_login: 'Log In →',
  btn_signup: 'Sign Up →',
  forgot: 'Forgot password?',
  back_login: '← Back to log in',
  signing_in: 'Logging in…',
  welcome: "You're in! 🎉",
  creating: 'Setting up your account…',

  // ── UPGRADE MODAL ───────────────────────────────────────────────────────────
  up_live: 'creators making scripts right now',
  up_cta: 'Unlock now →',
  up_or: 'or sign up free',
  up_email_btn: 'Sign Up with Email',

  // ── PLANS ───────────────────────────────────────────────────────────────────
  plan_annual: 'Yearly',
  plan_annual_label: 'billed yearly',
  plan_full_btn: 'Get Full →',
  plan_master_btn: 'Get Master →',
  price_increase: 'Price goes up next month: +$10 Full / +$20 Master. Lock yours in.',

  // Full features
  f5: 'Creator community',
  f6: 'AI that gets your style',

  // Master features
  m3: 'AI chat tuned to you',
  m6: 'Trending Short finder',
  m7: 'Creator community',

  // ── COMMUNITY ───────────────────────────────────────────────────────────────
  comm_sub: 'Subscribers only',
  comm_joined: '✓ Joined',

  // ── PROFILE ─────────────────────────────────────────────────────────────────
  profile_days: 'Days on premium',
  profile_until: 'Premium until',
  profile_pwd: "🔑 Change password — we'll email a link",
  profile_master: '👑 Upgrade to Master →',
  profile_logout: '↪ Log out',
  profile_info: 'Account details',
  support_ph: "What's on your mind?",
  support_btn: 'Send →',

  // ── CANCEL FLOW ─────────────────────────────────────────────────────────────
  cancel_r1: "It's hard to use",
  cancel_r2: 'Too expensive right now',
  cancel_r3: "I don't need it anymore",
  cancel_confirm: 'Confirm cancel',
  cancel_offer_title: 'Wait — quick offer for you',
  cancel_offer_sub: 'Stay with us: $3 off your next bill.',
  cancel_accept: 'Take the offer 💙',
  cancel_bye_sub: 'Subscription cancelled. You keep premium until the end of your paid period.',

  // ── BLUBLU CHATBOT ──────────────────────────────────────────────────────────
  blublu_hello: "Hey! I'm <strong>BluBlu</strong> 🤖<br>How's it going so far?<br>Liking BlueTube?",
  blublu_ph: 'Tell me anything…',
  blublu_send: 'Send →',
  blublu_thanks: 'Sending this to the team. Thanks! 🚀',

  // ── FOMO BAR ────────────────────────────────────────────────────────────────
  fomo_censored: "Name hidden at creator's request",
  fomo_protected: 'Identity protected',
  fomo_anon: 'Creator chose to stay anonymous',

  // ── PLANS SECTION ───────────────────────────────────────────────────────────
  plans_eye: 'Pricing',
  plans_title: 'Pick your plan.',

  // ── FOOTER ──────────────────────────────────────────────────────────────────
  footer_copy: '© 2025 BlueTube · For creators',

  // ── RESET PASSWORD ──────────────────────────────────────────────────────────
  new_pwd: 'Set a new password',
  pwd_new_ph: 'New password (6+ chars)',
  save_pwd: 'Save password →',
};
