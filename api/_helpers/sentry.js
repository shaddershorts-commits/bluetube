// api/_helpers/sentry.js — Envio direto de eventos pro Sentry sem SDK.
// Usa a store API via HTTP, evita adicionar dep. pesada ao bundle.
// Safe pra ser chamado de qualquer contexto — silencioso se DSN ausente ou falha.

let lastDsnParse = null;

function parseDsn(dsn) {
  if (!dsn) return null;
  if (lastDsnParse?.dsn === dsn) return lastDsnParse.parsed;
  // Formato: https://KEY@HOST/PROJECT_ID  (sometimes with port)
  const m = dsn.match(/^https:\/\/([^@]+)@([^/]+)\/(.+)$/);
  const parsed = m ? { key: m[1], host: m[2], projectId: m[3] } : null;
  lastDsnParse = { dsn, parsed };
  return parsed;
}

function toIso() { return new Date().toISOString(); }

/**
 * Envia um evento de erro pro Sentry. Fire-and-forget.
 * @param {Error|string} err
 * @param {object} context - { tags, extra, user, level }
 */
async function sentryCapture(err, context = {}) {
  const p = parseDsn(process.env.SENTRY_DSN);
  if (!p) return;
  const isErr = err && typeof err === 'object' && err.message;
  const message = isErr ? err.message : String(err);
  const name = isErr ? (err.name || 'Error') : 'Error';
  const stackStr = isErr && err.stack ? String(err.stack) : '';

  // Parseia stack pra frames simplificados (opcional mas ajuda no Sentry)
  const frames = stackStr.split('\n').slice(1, 8).map(line => {
    const m = line.match(/at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)/);
    return m ? { function: m[1] || '<anonymous>', filename: m[2], lineno: parseInt(m[3]), colno: parseInt(m[4]) } : null;
  }).filter(Boolean).reverse(); // Sentry espera ordem cronologica (caller primeiro)

  const body = {
    event_id: Math.random().toString(16).slice(2) + Math.random().toString(16).slice(2),
    timestamp: toIso(),
    level: context.level || 'error',
    platform: 'node',
    environment: process.env.VERCEL_ENV || 'production',
    release: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) || undefined,
    message: { formatted: message },
    exception: { values: [{ type: name, value: message, stacktrace: frames.length ? { frames } : undefined }] },
    tags: { feature: 'bluetendencias', ...(context.tags || {}) },
    extra: context.extra || {},
    user: context.user || undefined,
  };

  try {
    await fetch(`https://${p.host}/api/${p.projectId}/store/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Sentry-Auth': `Sentry sentry_version=7, sentry_key=${p.key}, sentry_client=bluetube-inline/1.0`,
      },
      body: JSON.stringify(body),
    }).catch(() => {});
  } catch (e) { /* silent — nunca quebra o fluxo principal */ }
}

module.exports = { sentryCapture };
