// api/unsubscribe.js — Proxy retrocompat pro endpoint versionado v1.
//
// MIGRATED 2026-04-25 (Fix 4 - Gap 6): logica real movida pra api/v1/unsubscribe.js.
// Mantido pra cobrir links antigos em emails ja enviados (inboxes dos users).
// REMOVER apos 30 dias do deploy (2026-05-25). Ver docs/blue-pendencias.md.

const v1Handler = require('./v1/unsubscribe');

module.exports = async function handler(req, res) {
  const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0];
  console.log(`[unsubscribe] legacy_path ip=${ip}`);
  return v1Handler(req, res);
};
