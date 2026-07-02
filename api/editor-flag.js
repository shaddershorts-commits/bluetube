// api/editor-flag.js — Feature flag publica do BlueEditor V0
// =====================================================================
// Endpoint GET que retorna { enabled, reason, phase }.
//
// Liga/desliga via env var EDITOR_V0_ENABLED no Vercel:
//   - 'true' / '1' = ligado
//   - qualquer outro = desligado (estado padrao em prod ate Fase 11)
//
// Em preview deploys (vercel.app), liga automatico independente da env
// pra facilitar teste sem ter que setar env em cada branch.
//
// Cache-Control: no-store — flag e leve, queremos ler sempre o estado atual.

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });

  const envVal = String(process.env.EDITOR_V0_ENABLED || '').toLowerCase().trim();
  const envEnabled = envVal === 'true' || envVal === '1';

  // Detecta preview deploy: VERCEL_ENV vem 'preview' em deploys de branches.
  // Em preview, libera automatico pra teste — produ continua respeitando env.
  const isPreview = process.env.VERCEL_ENV === 'preview';
  const isLocal = !process.env.VERCEL_ENV;

  const enabled = envEnabled || isPreview || isLocal;

  return res.status(200).json({
    enabled,
    reason: enabled
      ? (isPreview ? 'preview_auto_enabled' : isLocal ? 'local_auto_enabled' : 'env_enabled')
      : 'env_disabled',
    phase: '0/11 — setup',
    env: process.env.VERCEL_ENV || 'local',
  });
};
