// api/helpers/fetch-safe.js — Timeout + friendly errors for external API calls

const TIMEOUT_MS = 30000;

const FRIENDLY_ERRORS = {
  abort: 'A requisição demorou muito. Tente novamente.',
  quota: 'Serviço temporariamente indisponível. Tente em 1 minuto.',
  generic: 'Algo deu errado. Já fomos notificados e estamos corrigindo.',
  no_caption: 'Este vídeo não tem legenda disponível. Tente outro Short.',
  invalid_link: 'Link inválido. Use um link de YouTube Shorts.',
  private_video: 'Este vídeo é privado ou foi removido.',
  overloaded: 'Nossos servidores estão sobrecarregados. Tente novamente em 1 minuto.',
};

/**
 * fetch with timeout via AbortController.
 * @param {string} url
 * @param {object} opts - standard fetch options
 * @param {number} [timeoutMs=30000]
 * @returns {Promise<Response>}
 */
async function fetchWithTimeout(url, opts = {}, timeoutMs = TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Try multiple AI providers in order. Returns the first successful result.
 * @param {Array<{name:string, fn:()=>Promise<any>}>} providers
 * @returns {Promise<{result:any, provider:string}>}
 */
async function tryProviders(providers) {
  let lastErr = null;
  for (const { name, fn } of providers) {
    try {
      const result = await fn();
      return { result, provider: name };
    } catch (e) {
      console.warn(`[fallback] ${name} failed:`, e.message);
      lastErr = e;
    }
  }
  throw lastErr || new Error('All providers failed');
}

/**
 * Classify an error into a user-friendly message.
 */
function friendlyError(err, context) {
  const msg = (err?.message || err || '').toString().toLowerCase();
  if (msg.includes('abort') || msg.includes('timeout')) return FRIENDLY_ERRORS.abort;
  if (msg.includes('quota') || msg.includes('rate') || msg.includes('429') || msg.includes('limit')) return FRIENDLY_ERRORS.quota;
  if (msg.includes('caption') || msg.includes('subtitle') || msg.includes('no transcript')) return FRIENDLY_ERRORS.no_caption;
  if (msg.includes('private') || msg.includes('unavailable') || msg.includes('not found')) return FRIENDLY_ERRORS.private_video;
  if (context === 'overloaded') return FRIENDLY_ERRORS.overloaded;
  return FRIENDLY_ERRORS.generic;
}

module.exports = { fetchWithTimeout, tryProviders, friendlyError, FRIENDLY_ERRORS };
