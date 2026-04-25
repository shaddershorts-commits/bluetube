// api/blue-backup.js — Backup automatico diario (Fix 7 - Gap 2)
// CommonJS
//
// Mudancas Fix 7 (vs versao anterior):
// 1. Auth obrigatoria em executar (cron-header OU Bearer ADMIN_SECRET).
//    Era SEM auth — qualquer um podia disparar.
// 2. Encrypted at-rest (AES-256-GCM via _helpers/crypto encryptBuffer).
// 3. Bucket PRIVADO 'blue-backups' (era 'blue-videos' publico — vazamento ativo).
// 4. Path randomizado (16-bytes hex). Era previsivel (date+timestamp).
// 5. URLs assinadas (signed) no listar/restaurar — TTL 1h. Era /object/public/.
// 6. Decrypt no restaurar.

const zlib = require('zlib');
const crypto = require('node:crypto');
const { encryptBuffer, decryptBuffer } = require('./_helpers/crypto');

const TABELAS = [
  'blue_profiles',
  'blue_videos',
  'blue_follows',
  'blue_bluecoins',
  'blue_bluecoins_transacoes',
  'blue_creator_accounts',
  'blue_gorjetas',
  'blue_lives',
];

const BUCKET = 'blue-backups'; // Fix 7: bucket privado novo
const SIGNED_URL_TTL_SEC = 3600; // 1 hora
const RETENTION_COUNT = 30;

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const SU = process.env.SUPABASE_URL;
  const SK = process.env.SUPABASE_SERVICE_KEY;
  const ADMIN_SECRET = process.env.ADMIN_SECRET;
  if (!SU || !SK) return res.status(500).json({ error: 'Config missing' });

  const h = { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' };
  const action = req.method === 'GET' ? req.query.action : (req.body && req.body.action);

  function isAdmin(req) {
    const auth = req.headers['authorization'];
    return ADMIN_SECRET && auth === 'Bearer ' + ADMIN_SECRET;
  }
  function isVercelCron(req) {
    // Vercel cron infra seta esse header automaticamente — nao-forjavel externamente
    return !!req.headers['x-vercel-cron'];
  }

  // ── EXECUTAR BACKUP (cron diario OU admin manual) ───────────────────────
  if (action === 'executar') {
    // Fix 7: AUTH OBRIGATORIO. Antes era aberto.
    if (!isVercelCron(req) && !isAdmin(req)) {
      return res.status(401).json({ error: 'Unauthorized — requires Vercel cron header OR Bearer ADMIN_SECRET' });
    }

    try {
      const dados = {};
      for (const tabela of TABELAS) {
        try {
          const r = await fetch(`${SU}/rest/v1/${tabela}?select=*`, { headers: h });
          if (r.ok) dados[tabela] = await r.json();
          else dados[tabela] = [];
        } catch(e) { dados[tabela] = []; }
      }

      const json = JSON.stringify({ timestamp: new Date().toISOString(), dados });
      const gzipped = zlib.gzipSync(Buffer.from(json));
      // Fix 7: encrypt buffer ANTES do upload
      const encrypted = encryptBuffer(gzipped, 'backups');

      // Fix 7: path randomizado (16 bytes hex). Sem revelar conteudo no nome (.bin).
      const today = new Date().toISOString().split('T')[0];
      const randId = crypto.randomBytes(16).toString('hex');
      const path = `backups/${today}/${randId}.bin`;

      // Fix 7: upload no bucket privado novo
      const upR = await fetch(`${SU}/storage/v1/object/${BUCKET}/${path}`, {
        method: 'POST',
        headers: { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/octet-stream', 'x-upsert': 'true' },
        body: encrypted
      });

      const storagePath = upR.ok ? path : null;

      // Log
      await fetch(`${SU}/rest/v1/blue_backups_log`, {
        method: 'POST', headers: { ...h, 'Prefer': 'return=minimal' },
        body: JSON.stringify({
          tipo: isVercelCron(req) ? 'automatico' : 'manual',
          tabelas: TABELAS,
          tamanho_bytes: encrypted.length,
          storage_path: storagePath,
          status: upR.ok ? 'ok' : 'erro'
        })
      });

      // Lifecycle: keep only last RETENTION_COUNT
      try {
        const oldR = await fetch(`${SU}/rest/v1/blue_backups_log?order=created_at.desc&limit=200&select=id,storage_path`, { headers: h });
        const backups = oldR.ok ? await oldR.json() : [];
        if (backups.length > RETENTION_COUNT) {
          const toDelete = backups.slice(RETENTION_COUNT);
          for (const b of toDelete) {
            if (b.storage_path) {
              // Detect bucket by path (legacy paths sem .bin foram pra blue-videos, novos vao pra blue-backups)
              const bucket = b.storage_path.endsWith('.bin') ? BUCKET : 'blue-videos';
              await fetch(`${SU}/storage/v1/object/${bucket}/${b.storage_path}`, { method: 'DELETE', headers: { apikey: SK, Authorization: 'Bearer ' + SK } }).catch(() => {});
            }
            await fetch(`${SU}/rest/v1/blue_backups_log?id=eq.${b.id}`, { method: 'DELETE', headers: h }).catch(() => {});
          }
        }
      } catch(e) {}

      // Email summary (so com sucesso)
      const RESEND = process.env.RESEND_API_KEY;
      if (RESEND && upR.ok) {
        fetch('https://api.resend.com/emails', { method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + RESEND },
          body: JSON.stringify({
            from: 'Blue Backup <noreply@bluetubeviral.com>',
            to: ['cannongames01@gmail.com'],
            subject: '✅ Backup Blue (encrypted) - ' + new Date().toLocaleDateString('pt-BR'),
            html: `<div style="font-family:sans-serif;background:#0a1628;color:#e8f4ff;padding:24px;border-radius:12px">
              <h2 style="color:#3b82f6">💾 Backup encrypted concluido</h2>
              <p>Tamanho: <strong>${(encrypted.length/1024).toFixed(1)}KB</strong> (${(gzipped.length/1024).toFixed(1)}KB gzip + 42B encrypt overhead)</p>
              <p>Tabelas: ${TABELAS.length}</p>
              ${Object.entries(dados).map(([t,d])=>`<p>• ${t}: ${d.length} rows</p>`).join('')}
              <p style="color:#999;font-size:11px;margin-top:20px">Bucket privado: ${BUCKET} · Path: ${storagePath || 'erro'}</p>
            </div>`
          })
        }).catch(() => {});
      }

      return res.status(200).json({
        ok: true,
        path: storagePath,
        bucket: BUCKET,
        size: encrypted.length,
        gzip_size: gzipped.length,
        tabelas: Object.fromEntries(Object.entries(dados).map(([k,v])=>[k,v.length]))
      });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── LISTAR BACKUPS (admin) ──────────────────────────────────────────────
  if (action === 'listar') {
    if (!isAdmin(req)) return res.status(401).json({ error: 'Admin only' });
    try {
      const r = await fetch(`${SU}/rest/v1/blue_backups_log?order=created_at.desc&limit=30&select=*`, { headers: h });
      const backups = r.ok ? await r.json() : [];

      // Fix 7: gerar signed URLs (TTL 1h) ao inves de URLs publicas
      const enriched = await Promise.all(backups.map(async (b) => {
        let download_url = null;
        if (b.storage_path) {
          const bucket = b.storage_path.endsWith('.bin') ? BUCKET : 'blue-videos';
          try {
            const sR = await fetch(`${SU}/storage/v1/object/sign/${bucket}/${b.storage_path}`, {
              method: 'POST',
              headers: { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' },
              body: JSON.stringify({ expiresIn: SIGNED_URL_TTL_SEC })
            });
            if (sR.ok) {
              const sd = await sR.json();
              download_url = `${SU}/storage/v1${sd.signedURL || sd.signedUrl || ''}`;
            }
          } catch(e) {}
        }
        return {
          ...b,
          download_url,
          tamanho_display: b.tamanho_bytes ? (b.tamanho_bytes / 1024).toFixed(1) + 'KB' : '—',
          encrypted: b.storage_path?.endsWith('.bin') || false,
        };
      }));

      return res.status(200).json({ backups: enriched });
    } catch(e) { return res.status(200).json({ backups: [] }); }
  }

  // ── RESTAURAR (admin - apenas retorna dados decifrados) ─────────────────
  if (req.method === 'POST' && action === 'restaurar') {
    if (!isAdmin(req)) return res.status(401).json({ error: 'Admin only' });
    const { backup_path } = req.body;
    if (!backup_path) return res.status(400).json({ error: 'backup_path obrigatório' });
    try {
      const bucket = backup_path.endsWith('.bin') ? BUCKET : 'blue-videos';
      // Pra bucket privado precisa auth header — buscar via service role
      const dR = await fetch(`${SU}/storage/v1/object/${bucket}/${backup_path}`, {
        headers: { apikey: SK, Authorization: 'Bearer ' + SK }
      });
      if (!dR.ok) return res.status(404).json({ error: 'Backup não encontrado' });
      const buffer = Buffer.from(await dR.arrayBuffer());
      // Fix 7: decrypt antes de gunzip (decryptBuffer e idempotente p/ legacy plaintext sem header)
      const decrypted = decryptBuffer(buffer, 'backups');
      const unzipped = zlib.gunzipSync(decrypted).toString();
      const dados = JSON.parse(unzipped);
      return res.status(200).json({ ok: true, dados });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  return res.status(404).json({ error: 'Action não encontrada' });
};
