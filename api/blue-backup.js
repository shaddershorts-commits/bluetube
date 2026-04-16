// api/blue-backup.js — Backup automático diário
// CommonJS

const zlib = require('zlib');

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

  // ── EXECUTAR BACKUP (cron) ──────────────────────────────────────────────
  if (action === 'executar') {
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
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const path = `backups/${new Date().toISOString().split('T')[0]}/blue_backup_${timestamp}.json.gz`;

      // Upload to Storage
      const upR = await fetch(`${SU}/storage/v1/object/blue-videos/${path}`, {
        method: 'POST',
        headers: { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/gzip', 'x-upsert': 'true' },
        body: gzipped
      });

      const storagePath = upR.ok ? path : null;

      // Log
      const logR = await fetch(`${SU}/rest/v1/blue_backups_log`, {
        method: 'POST', headers: { ...h, 'Prefer': 'return=minimal' },
        body: JSON.stringify({
          tipo: 'automatico',
          tabelas: TABELAS,
          tamanho_bytes: gzipped.length,
          storage_path: storagePath,
          status: upR.ok ? 'ok' : 'erro'
        })
      });

      // Keep only last 30 backups
      try {
        const oldR = await fetch(`${SU}/rest/v1/blue_backups_log?order=created_at.desc&limit=100&select=id,storage_path`, { headers: h });
        const backups = oldR.ok ? await oldR.json() : [];
        if (backups.length > 30) {
          const toDelete = backups.slice(30);
          for (const b of toDelete) {
            if (b.storage_path) {
              await fetch(`${SU}/storage/v1/object/blue-videos/${b.storage_path}`, { method: 'DELETE', headers: { apikey: SK, Authorization: 'Bearer ' + SK } }).catch(() => {});
            }
            await fetch(`${SU}/rest/v1/blue_backups_log?id=eq.${b.id}`, { method: 'DELETE', headers: h }).catch(() => {});
          }
        }
      } catch(e) {}

      // Email summary
      const RESEND = process.env.RESEND_API_KEY;
      if (RESEND && upR.ok) {
        fetch('https://api.resend.com/emails', { method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + RESEND },
          body: JSON.stringify({
            from: 'Blue Backup <noreply@bluetubeviral.com>',
            to: ['cannongames01@gmail.com'],
            subject: '✅ Backup Blue concluído - ' + new Date().toLocaleDateString('pt-BR'),
            html: `<div style="font-family:sans-serif;background:#0a1628;color:#e8f4ff;padding:24px;border-radius:12px">
              <h2 style="color:#3b82f6">💾 Backup diário concluído</h2>
              <p>Tamanho: <strong>${(gzipped.length/1024).toFixed(1)}KB</strong></p>
              <p>Tabelas: ${TABELAS.length}</p>
              ${Object.entries(dados).map(([t,d])=>`<p>• ${t}: ${d.length} rows</p>`).join('')}
              <p style="color:#999;font-size:11px;margin-top:20px">Path: ${storagePath || 'erro'}</p>
            </div>`
          })
        }).catch(() => {});
      }

      return res.status(200).json({ ok: true, path: storagePath, size: gzipped.length, tabelas: Object.fromEntries(Object.entries(dados).map(([k,v])=>[k,v.length])) });
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
      return res.status(200).json({
        backups: backups.map(b => ({
          ...b,
          download_url: b.storage_path ? `${SU}/storage/v1/object/public/blue-videos/${b.storage_path}` : null,
          tamanho_display: b.tamanho_bytes ? (b.tamanho_bytes / 1024).toFixed(1) + 'KB' : '—',
        }))
      });
    } catch(e) { return res.status(200).json({ backups: [] }); }
  }

  // ── RESTAURAR (admin - apenas retorna dados) ────────────────────────────
  if (req.method === 'POST' && action === 'restaurar') {
    if (!isAdmin(req)) return res.status(401).json({ error: 'Admin only' });
    const { backup_path } = req.body;
    if (!backup_path) return res.status(400).json({ error: 'backup_path obrigatório' });
    try {
      const dR = await fetch(`${SU}/storage/v1/object/public/blue-videos/${backup_path}`);
      if (!dR.ok) return res.status(404).json({ error: 'Backup não encontrado' });
      const buffer = Buffer.from(await dR.arrayBuffer());
      const unzipped = zlib.gunzipSync(buffer).toString();
      const dados = JSON.parse(unzipped);
      return res.status(200).json({ ok: true, dados });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  return res.status(404).json({ error: 'Action não encontrada' });
};
