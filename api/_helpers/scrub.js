// api/_helpers/scrub.js — PII scrub helper (Fix 2 PII auditoria 2026-04-24)
// CommonJS, usado pelo backend Vercel.
//
// IMPORTANTE: existe um helper IDENTICO em bluetube-app/src/utils/scrub.js
// (versao ES modules). Manter os dois sincronizados ao adicionar/mudar
// patterns ou ALWAYS_REDACT_KEYS. Diferencas devem ser justificadas.

// Regex de strings com PII embedded (busca dentro de qualquer string).
const PII_PATTERNS = [
  [/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g,                                            '[EMAIL_REDACTED]'],
  [/\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/g,                                           '[CPF_REDACTED]'],
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,                   '[JWT_REDACTED]'],
  [/Bearer\s+[A-Za-z0-9._-]+/g,                                                'Bearer [REDACTED]'],
  [/token=[^&\s"']+/gi,                                                        'token=[REDACTED]'],
  [/password=[^&\s"']+/gi,                                                     'password=[REDACTED]'],
];

// Chaves que SEMPRE viram [REDACTED] independente do valor — pega casos
// onde o conteudo nao bate regex (ex: password "abc123" sem prefixo,
// card_cvc "789", etc). Comparada lowercase.
const ALWAYS_REDACT_KEYS = [
  'password', 'senha', 'token', 'access_token',
  'refresh_token', 'authorization', 'cookie',
  'session', 'secret', 'api_key',
  'cpf', 'rg', 'cnpj', 'pix_key', 'chave_pix',
  'card_number', 'cvv', 'card_cvc',
];

function scrubString(s) {
  if (typeof s !== 'string') return s;
  let out = s;
  for (const [pat, rep] of PII_PATTERNS) out = out.replace(pat, rep);
  return out;
}

function scrubDeep(obj, depth) {
  if (depth === undefined) depth = 0;
  if (depth > 6) return obj; // profundidade max — evita recursao infinita em objetos circulares
  if (obj == null) return obj;
  if (typeof obj === 'string') return scrubString(obj);
  if (Array.isArray(obj)) return obj.map(function (v) { return scrubDeep(v, depth + 1); });
  if (typeof obj === 'object') {
    const out = {};
    for (const k of Object.keys(obj)) {
      if (ALWAYS_REDACT_KEYS.indexOf(k.toLowerCase()) !== -1) {
        out[k] = '[REDACTED]';
      } else {
        out[k] = scrubDeep(obj[k], depth + 1);
      }
    }
    return out;
  }
  return obj;
}

// Scrub completo de event Sentry: aplica em exception values, message, extra,
// contexts, breadcrumbs, request.url. Tags sao whitelist (definidas em codigo,
// nao sao scrubbed). User vai filtrado em outro ponto (so passa id).
function scrubEvent(event) {
  if (!event) return event;
  if (event.exception && Array.isArray(event.exception.values)) {
    event.exception.values = event.exception.values.map(function (v) {
      return Object.assign({}, v, { value: scrubString(v.value) });
    });
  }
  if (event.message) {
    if (typeof event.message === 'string') event.message = scrubString(event.message);
    else event.message = scrubDeep(event.message);
  }
  if (event.extra) event.extra = scrubDeep(event.extra);
  if (event.contexts) event.contexts = scrubDeep(event.contexts);
  if (Array.isArray(event.breadcrumbs)) {
    event.breadcrumbs = event.breadcrumbs.map(function (b) {
      return Object.assign({}, b, {
        data: scrubDeep(b.data),
        message: scrubString(b.message),
      });
    });
  }
  if (event.request && event.request.url) event.request.url = scrubString(event.request.url);
  return event;
}

module.exports = { scrubString, scrubDeep, scrubEvent, PII_PATTERNS, ALWAYS_REDACT_KEYS };
