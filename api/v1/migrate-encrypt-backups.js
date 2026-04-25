// api/v1/migrate-encrypt-backups.js — HOTFIX migration pra Fix 7 (Gap 2)
//
// 2 actions disponiveis (auth: 3 camadas igual Fix 5 migrate-encrypt-affiliate):
//
//   action=consolidate  -> Le todos os backups legacy plaintext do bucket
//                          publico 'blue-videos', gunzip+merge em 1 JSON unico,
//                          encripta com chave 'backups', salva no bucket privado
//                          'blue-backups'. Mantem 1 snapshot de recovery.
//
//   action=purge-legacy -> Deleta TODOS os arquivos com path 'backups/...' do
//                          bucket publico 'blue-videos' + zera blue_backups_log
//                          de entradas com extensao .json.gz (legacy). MANTEM
//                          entradas com .bin (novos encrypted no bucket privado).
//
// Auth (3 camadas):
//   1. Bearer ADMIN_SECRET
//   2. Header X-Confirm-Migration: yes-i-understand-irreversibility
//   3. Query ?confirm_token=<HMAC-TS gerado <5min>
//
// Uso recomendado:
//   1. POST ?action=consolidate (cria 1 snapshot encrypted no bucket privado)
//   2. Felipe verifica via /api/blue-backup?action=listar
//   3. POST ?action=purge-legacy (so depois de verificar consolidate)

const crypto = require('node:crypto');
const zlib = require('zlib');
const { encryptBuffer } = require('../_helpers/crypto');

const TOKEN_WINDOW_SEC = 300;
const CONFIRM_HEADER = 'yes-i-understand-irreversibility';
const LEGACY_BUCKET = 'blue-videos';
const NEW_BUCKET = 'blue-backups';

function genConfirmToken(adminSecret) {
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
  if (now - ts > TOKEN_WINDOW_SEC || ts > now + 60) return false;
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
  if (req.headers['authorization'] !== `Bearer ${ADMIN}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const action = String(req.query?.action || '').toLowerCase();

  // GET: gerar confirm_token (sem precisar X-Confirm-Migration header)
  if (req.method === 'GET' && action === 'gen-token') {
    return res.status(200).json({
      confirm_token: genConfirmToken(ADMIN),
      expires_in_seconds: TOKEN_WINDOW_SEC,
    });
  }

  // GET status: lista backups por bucket (informativo, sem 3-camada)
  const h = { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' };
  if (req.method === 'GET' && action === 'status') {
    try {
      const logR = await fetch(`${SU}/rest/v1/blue_backups_log?select=id,storage_path,tamanho_bytes,created_at&order=created_at.desc&limit=200`, { headers: h });
      const rows = logR.ok ? await logR.json() : [];
      const legacy = rows.filter(r => r.storage_path && !r.storage_path.endsWith('.bin'));
      const encrypted = rows.filter(r => r.storage_path && r.storage_path.endsWith('.bin'));
      return res.status(200).json({
        legacy_plaintext: { count: legacy.length, oldest: legacy[legacy.length - 1]?.created_at, newest: legacy[0]?.created_at },
        encrypted: { count: encrypted.length, newest: encrypted[0]?.created_at },
        total: rows.length,
      });
    } catch (e) {
      return res.status(500).json({ error: 'status_failed', message: e.message });
    }
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Auth camada 2: header X-Confirm-Migration
  if (req.headers['x-confirm-migration'] !== CONFIRM_HEADER) {
    return res.status(403).json({ error: 'missing_confirmation', hint: `Pass header X-Confirm-Migration: ${CONFIRM_HEADER}` });
  }

  // Auth camada 3: confirm_token HMAC
  if (!verifyConfirmToken(req.query?.confirm_token, ADMIN)) {
    return res.status(403).json({ error: 'invalid_or_expired_confirm_token', hint: 'GET ?action=gen-token primeiro' });
  }

  const startedAt = Date.now();

  // ── CONSOLIDATE: download+merge legacy backups, encrypt, upload pro bucket privado
  if (action === 'consolidate') {
    try {
      const logR = await fetch(`${SU}/rest/v1/blue_backups_log?storage_path=not.is.null&order=created_at.desc&limit=200&select=id,storage_path,created_at`, { headers: h });
      const rows = logR.ok ? await logR.json() : [];
      const legacy = rows.filter(r => r.storage_path && !r.storage_path.endsWith('.bin'));

      if (legacy.length === 0) {
        return res.status(200).json({ ok: true, message: 'Nenhum backup legacy encontrado', consolidated: 0 });
      }

      // Download + gunzip cada um, agregar
      const consolidated = { consolidated_at: new Date().toISOString(), source_count: legacy.length, snapshots: [] };
      let downloadErrors = 0;
      for (const row of legacy) {
        try {
          const dR = await fetch(`${SU}/storage/v1/object/${LEGACY_BUCKET}/${row.storage_path}`, {
            headers: { apikey: SK, Authorization: 'Bearer ' + SK }
          });
          if (!dR.ok) { downloadErrors++; continue; }
          const buf = Buffer.from(await dR.arrayBuffer());
          const text = zlib.gunzipSync(buf).toString();
          const parsed = JSON.parse(text);
          consolidated.snapshots.push({ original_path: row.storage_path, created_at: row.created_at, data: parsed });
        } catch (e) { downloadErrors++; }
      }

      if (consolidated.snapshots.length === 0) {
        return res.status(500).json({ error: 'all_downloads_failed', download_errors: downloadErrors });
      }

      // Gzip + encrypt + upload pro bucket privado
      const json = JSON.stringify(consolidated);
      const gzipped = zlib.gzipSync(Buffer.from(json));
      const encrypted = encryptBuffer(gzipped, 'backups');
      const today = new Date().toISOString().split('T')[0];
      const randId = crypto.randomBytes(16).toString('hex');
      const path = `backups/${today}/${randId}.bin`;

      const upR = await fetch(`${SU}/storage/v1/object/${NEW_BUCKET}/${path}`, {
        method: 'POST',
        headers: { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/octet-stream', 'x-upsert': 'true' },
        body: encrypted
      });
      if (!upR.ok) {
        const upT = await upR.text();
        return res.status(502).json({ error: 'upload_failed', status: upR.status, body: upT.slice(0, 200) });
      }

      // Log consolidado
      await fetch(`${SU}/rest/v1/blue_backups_log`, {
        method: 'POST', headers: { ...h, 'Prefer': 'return=minimal' },
        body: JSON.stringify({
          tipo: 'consolidado_fix7',
          tabelas: [`consolidado_de_${legacy.length}_legacy`],
          tamanho_bytes: encrypted.length,
          storage_path: path,
          status: 'ok'
        })
      });

      return res.status(200).json({
        ok: true,
        action: 'consolidate',
        consolidated: consolidated.snapshots.length,
        download_errors: downloadErrors,
        new_bucket: NEW_BUCKET,
        new_path: path,
        size_bytes: encrypted.length,
        ms: Date.now() - startedAt,
      });
    } catch (e) {
      return res.status(500).json({ error: 'consolidate_failed', message: e.message });
    }
  }

  // ── PURGE LEGACY: deleta plaintext do bucket publico + zera log entries legacy
  if (action === 'purge-legacy') {
    try {
      const logR = await fetch(`${SU}/rest/v1/blue_backups_log?storage_path=not.is.null&select=id,storage_path&limit=500`, { headers: h });
      const rows = logR.ok ? await logR.json() : [];
      const legacy = rows.filter(r => r.storage_path && !r.storage_path.endsWith('.bin'));

      const result = { storage_deleted: 0, storage_errors: 0, log_deleted: 0 };
      for (const row of legacy) {
        try {
          const dR = await fetch(`${SU}/storage/v1/object/${LEGACY_BUCKET}/${row.storage_path}`, {
            method: 'DELETE',
            headers: { apikey: SK, Authorization: 'Bearer ' + SK }
          });
          if (dR.ok || dR.status === 404) result.storage_deleted++;
          else result.storage_errors++;
        } catch (e) { result.storage_errors++; }
        try {
          await fetch(`${SU}/rest/v1/blue_backups_log?id=eq.${encodeURIComponent(row.id)}`, {
            method: 'DELETE',
            headers: h
          });
          result.log_deleted++;
        } catch (e) {}
      }

      return res.status(200).json({
        ok: true,
        action: 'purge-legacy',
        ...result,
        ms: Date.now() - startedAt,
      });
    } catch (e) {
      return res.status(500).json({ error: 'purge_failed', message: e.message });
    }
  }

  return res.status(400).json({ error: 'invalid_action', hint: 'use action=consolidate or action=purge-legacy or action=status' });
};
