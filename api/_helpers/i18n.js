// api/_helpers/i18n.js — Helper minimalista de i18n pra mensagens user-facing.
//
// Suporta PT (default) e EN. Adicionar idioma novo = adicionar bloco em STRINGS.
// Adicionar chave nova = adicionar pelo menos em pt + en (fallback PT garantido).
//
// Uso (em endpoint ESM):
//   const i18nMod = await import('./_helpers/i18n.js');
//   const { t } = i18nMod.default || i18nMod;
//   res.status(400).json({ error: t('invalid_plan', lang) });
//
// Convencao de chaves: snake_case, prefixo opcional por dominio (checkout_, auth_).

const STRINGS = {
  pt: {
    invalid_plan: 'Plano invalido',
    invalid_currency: 'Moeda invalida',
    invalid_plan_currency: 'Combinacao de plano e moeda nao disponivel',
    stripe_unavailable: 'Stripe nao configurado',
    stripe_error: 'Erro no Stripe',
    checkout_failed: 'Falha ao criar sessao de pagamento',
  },
  en: {
    invalid_plan: 'Invalid plan',
    invalid_currency: 'Invalid currency',
    invalid_plan_currency: 'Plan and currency combination not available',
    stripe_unavailable: 'Payment system unavailable',
    stripe_error: 'Stripe error',
    checkout_failed: 'Failed to create payment session',
  },
};

const SUPPORTED_LANGS = ['pt', 'en'];

function normalizeLang(raw) {
  if (!raw) return 'pt';
  // Aceita 'pt-BR', 'en-US', 'en_GB' etc — pega so o codigo primario
  const lower = String(raw).toLowerCase().split(/[-_]/)[0];
  return SUPPORTED_LANGS.includes(lower) ? lower : 'pt';
}

function t(key, lang) {
  const l = normalizeLang(lang);
  return (STRINGS[l] && STRINGS[l][key]) || STRINGS.pt[key] || key;
}

module.exports = { t, normalizeLang, SUPPORTED_LANGS };
