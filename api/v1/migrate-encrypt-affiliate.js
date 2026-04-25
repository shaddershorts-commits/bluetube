// api/v1/migrate-encrypt-affiliate.js — Migration endpoint pra criptografar
// affiliates.chave_pix + affiliate_saques.chave_pix in-place (Fix 5 - Gap 3).
//
// CRITICAL: NUNCA dispara automaticamente. Sempre chamada manual via curl.
// Felipe precisa estar acordado, com backup confirmado, pra reagir se algo falhar.
//
// Auth (3 camadas):
//   1. Bearer ADMIN_SECRET (env)
//   2. Header X-Confirm-Migration: yes-i-understand-irreversibility
//   3. Query ?confirm_token=<HMAC-SHA256(timestamp+ADMIN_SECRET) gerado <5min antes>
//
// Acoes:
//   POST /api/v1/migrate-encrypt-affiliate                      → migrate (encrypt)
//   POST /api/v1/migrate-encrypt-affiliate?action=rollback      → decrypt back
//   GET  /api/v1/migrate-encrypt-affiliate?action=gen-token     → gera confirm_token
//   GET  /api/v1/migrate-encrypt-affiliate?action=status        → conta encrypted/legacy
//
// Idempotente: rows ja encrypted nao sao re-encriptadas.

const crypto = require('node:crypto');
const { encryptValue, decryptValue, isEncrypted } = require('../_helpers/crypto');

const TOKEN_WINDOW_SEC = 300; // 5 minutos
const CONFIRM_HEADER = 'yes-i-understand-irreversibility';

function genConfirmToken(adminSecret) {
  // Token = HMAC(minute-bucket, ADMIN_SECRET). Valido na janela do minuto + proximos 5.
  const ts = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', adminSecret).update(String(ts)).digest('hex').slice(0, 32);
  return `${ts}.${sig}`;
}

function verifyConfirmToken(token, adminSecret) {
  if (!token || typeof token !== 'string') return false;
  const [tsStr, sig] = token.split('.');
  const ts = parseInt(tsStr, 10);
  if (!ts || !sig) return false;
  const now = Math.floor(Date.now() / 1000);
  if (now - ts > TOKEN_WINDOW_SEC || ts > now + 60) return false; // futuro ate 60s tolera clock skew
  const expected = crypto.createHmac('sha256', adminSecret).update(String(ts)).digest('hex').slice(0, 32);
  if (expected.length !== sig.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const SU = process.env.SUPABASE_URL;
  const SK = process.env.SUPABASE_SERVICE_KEY;
  const ADMIN = process.env.ADMIN_SECRET;
  if (!SU || !SK || !ADMIN) return res.status(500).json({ error: 'Config missing' });

  // Auth camada 1: Bearer ADMIN_SECRET
  const auth = req.headers['authorization'] || '';
  if (auth !== `Bearer ${ADMIN}`) return res.status(401).json({ error: 'Unauthorized' });

  const action = String(req.query?.action || '').toLowerCase();

  // GET helper: gerar confirm_token (sem precisar do header X-Confirm-Migration)
  if (req.method === 'GET' && action === 'gen-token') {
    return res.status(200).json({
      confirm_token: genConfirmToken(ADMIN),
      expires_in_seconds: TOKEN_WINDOW_SEC,
      usage: 'Pass como ?confirm_token=... na proxima chamada POST de migration/rollback (validade 5min).',
    });
  }

  const h = { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' };

  // GET status: conta quantos rows estao encrypted vs legacy. Sem auth extra.
  if (req.method === 'GET' && action === 'status') {
    try {
      const [aR, sR] = await Promise.all([
        fetch(`${SU}/rest/v1/affiliates?select=id,chave_pix&chave_pix=not.is.null`, { headers: h }),
        fetch(`${SU}/rest/v1/affiliate_saques?select=id,chave_pix&chave_pix=not.is.null`, { headers: h }),
      ]);
      const affs = aR.ok ? await aR.json() : [];
      const saqs = sR.ok ? await sR.json() : [];
      const aEnc = affs.filter(r => isEncrypted(r.chave_pix)).length;
      const sEnc = saqs.filter(r => isEncrypted(r.chave_pix)).length;
      return res.status(200).json({
        affiliates: { total: affs.length, encrypted: aEnc, legacy: affs.length - aEnc },
        affiliate_saques: { total: saqs.length, encrypted: sEnc, legacy: saqs.length - sEnc },
      });
    } catch (e) {
      return res.status(500).json({ error: 'status_failed', message: e.message });
    }
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Auth camada 2: header de confirmacao explicita
  if (req.headers['x-confirm-migration'] !== CONFIRM_HEADER) {
    return res.status(403).json({
      error: 'missing_confirmation',
      hint: `Pass header X-Confirm-Migration: ${CONFIRM_HEADER}`,
    });
  }

  // Auth camada 3: confirm_token HMAC (gerado <5min atras)
  const confirmToken = req.query?.confirm_token;
  if (!verifyConfirmToken(confirmToken, ADMIN)) {
    return res.status(403).json({
      error: 'invalid_or_expired_confirm_token',
      hint: 'GET ?action=gen-token primeiro pra obter token valido por 5min',
    });
  }

  const isRollback = action === 'rollback';
  const transform = isRollback ? decryptValue : encryptValue;
  const transformName = isRollback ? 'decrypt' : 'encrypt';
  const startedAt = Date.now();

  // Tenta config check (joga se ENCRYPTION_KEY_AFFILIATES nao setado)
  try { transform('test-config-check'); }
  catch (e) {
    return res.status(500).json({ error: 'config_check_failed', message: e.message });
  }

  const result = {
    action: transformName,
    affiliates: { processed: 0, transformed: 0, skipped: 0, errors: [] },
    affiliate_saques: { processed: 0, transformed: 0, skipped: 0, errors: [] },
  };

  // ── AFFILIATES ──────────────────────────────────────────────────────────
  try {
    const aR = await fetch(`${SU}/rest/v1/affiliates?select=id,chave_pix&chave_pix=not.is.null`, { headers: h });
    if (!aR.ok) throw new Error(`affiliates select ${aR.status}`);
    const affs = await aR.json();
    for (const row of affs) {
      result.affiliates.processed++;
      const current = row.chave_pix;
      const alreadyDone = isRollback ? !isEncrypted(current) : isEncrypted(current);
      if (alreadyDone) { result.affiliates.skipped++; continue; }
      try {
        const next = transform(current);
        if (next === current) { result.affiliates.skipped++; continue; }
        const pR = await fetch(`${SU}/rest/v1/affiliates?id=eq.${encodeURIComponent(row.id)}`, {
          method: 'PATCH',
          headers: { ...h, Prefer: 'return=minimal' },
          body: JSON.stringify({ chave_pix: next }),
        });
        if (!pR.ok) throw new Error(`patch ${pR.status}`);
        result.affiliates.transformed++;
      } catch (e) {
        result.affiliates.errors.push({ id: row.id, error: e.message });
      }
    }
  } catch (e) {
    return res.status(500).json({ error: 'affiliates_iter_failed', message: e.message, partial: result });
  }

  // ── AFFILIATE_SAQUES ────────────────────────────────────────────────────
  try {
    const sR = await fetch(`${SU}/rest/v1/affiliate_saques?select=id,chave_pix&chave_pix=not.is.null`, { headers: h });
    if (!sR.ok) throw new Error(`saques select ${sR.status}`);
    const saqs = await sR.json();
    for (const row of saqs) {
      result.affiliate_saques.processed++;
      const current = row.chave_pix;
      const alreadyDone = isRollback ? !isEncrypted(current) : isEncrypted(current);
      if (alreadyDone) { result.affiliate_saques.skipped++; continue; }
      try {
        const next = transform(current);
        if (next === current) { result.affiliate_saques.skipped++; continue; }
        const pR = await fetch(`${SU}/rest/v1/affiliate_saques?id=eq.${encodeURIComponent(row.id)}`, {
          method: 'PATCH',
          headers: { ...h, Prefer: 'return=minimal' },
          body: JSON.stringify({ chave_pix: next }),
        });
        if (!pR.ok) throw new Error(`patch ${pR.status}`);
        result.affiliate_saques.transformed++;
      } catch (e) {
        result.affiliate_saques.errors.push({ id: row.id, error: e.message });
      }
    }
  } catch (e) {
    return res.status(500).json({ error: 'saques_iter_failed', message: e.message, partial: result });
  }

  result.ms = Date.now() - startedAt;
  console.log(`[migrate-encrypt-affiliate] ${transformName} done: ${JSON.stringify(result)}`);
  return res.status(200).json(result);
};
