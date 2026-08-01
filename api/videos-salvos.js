// api/videos-salvos.js — Vídeos salvos da Virais (2026-07-28)
// =============================================================================
// O usuário marca o vídeo pelo ícone dourado no card (YouTube / TikTok /
// Instagram) e consulta depois em Perfil → "Vídeos Salvos".
//
// Guardamos um RETRATO do vídeo (título, thumb, autor, views, url) — assim a
// lista não depende de re-buscar item por item e continua funcionando mesmo
// se o vídeo sair do acervo de virais.
//
// Actions (POST, token Supabase):
//   salvar   — marca (idempotente)
//   remover  — desmarca
//   listar   — todos os salvos do usuário (mais recentes primeiro)
//   ids      — só os ids, pra pintar os ícones da grade rapidamente

const PLATAFORMAS = ['youtube', 'tiktok', 'instagram'];

async function usuario(token, { SU, ANON }) {
  if (!token) return null;
  try {
    const r = await fetch(`${SU}/auth/v1/user`, { headers: { apikey: ANON, Authorization: 'Bearer ' + token } });
    if (!r.ok) return null;
    const u = await r.json();
    return u && u.id ? u.id : null;
  } catch (e) { return null; }
}


// Salvar é exclusivo Master — validado no SERVIDOR (esconder botão não
// impede alguém de chamar a API direto).
async function ehMaster(userId, { SU, h }) {
  try {
    const ur = await fetch(`${SU}/auth/v1/admin/users/${userId}`, { headers: h });
    if (!ur.ok) return false;
    const email = String((await ur.json()).email || "").toLowerCase();
    if (!email) return false;
    const sr = await fetch(`${SU}/rest/v1/subscribers?email=eq.${encodeURIComponent(email)}&select=plan,plan_expires_at,is_manual`, { headers: h });
    if (!sr.ok) return false;
    const s = (await sr.json())[0];
    // 2026-08-02: Full ganhou os recursos que eram Master na Virais
    if (!s || (s.plan !== "master" && s.plan !== "full")) return false;
    // is_manual = assinante eterno (data antiga não expira ele) — mesma regra
    // dos outros gates da Virais
    if (s.is_manual !== true && s.plan_expires_at && new Date(s.plan_expires_at) < new Date()) return false;
    return true;
  } catch (e) { return false; }
}
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const SU = process.env.SUPABASE_URL;
  const SK = process.env.SUPABASE_SERVICE_KEY;
  const ANON = process.env.SUPABASE_ANON_KEY || SK;
  if (!SU || !SK) return res.status(500).json({ error: 'config_missing' });
  const h = { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' };

  const body = req.body || {};
  const action = body.action || req.query.action;
  const userId = await usuario(body.token || req.query.token, { SU, ANON });
  if (!userId) return res.status(401).json({ error: 'Entre na sua conta para salvar vídeos.' });
  const uid = encodeURIComponent(userId);

  try {
    if (action === 'listar') {
      const r = await fetch(`${SU}/rest/v1/videos_salvos?user_id=eq.${uid}&order=salvo_em.desc&limit=300&select=*`, { headers: h });
      const itens = r.ok ? await r.json() : [];
      return res.status(200).json({ ok: true, total: itens.length, itens });
    }

    if (action === 'ids') {
      const r = await fetch(`${SU}/rest/v1/videos_salvos?user_id=eq.${uid}&select=video_id,plataforma&limit=500`, { headers: h });
      const itens = r.ok ? await r.json() : [];
      return res.status(200).json({ ok: true, ids: itens.map((x) => `${x.plataforma}:${x.video_id}`) });
    }

    if (action === 'salvar') {
      if (!(await ehMaster(userId, { SU, h }))) {
        return res.status(403).json({ error: 'Salvar vídeos é exclusivo pra assinantes (Full ou Master).', upgrade: true });
      }
      const { video_id, plataforma, titulo, thumbnail, canal, url, views } = body;
      if (!video_id || !PLATAFORMAS.includes(plataforma)) {
        return res.status(400).json({ error: 'video_id e plataforma válidos são obrigatórios' });
      }
      const r = await fetch(`${SU}/rest/v1/videos_salvos?on_conflict=user_id,plataforma,video_id`, {
        method: 'POST',
        headers: { ...h, Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify([{
          user_id: userId, video_id: String(video_id), plataforma,
          titulo: (titulo || '').slice(0, 300) || null,
          thumbnail: thumbnail || null, canal: (canal || '').slice(0, 120) || null,
          url: url || null, views: Number.isFinite(+views) ? Math.round(+views) : null,
        }]),
      });
      if (!r.ok) {
        const t = await r.text().catch(() => '');
        return res.status(500).json({ error: 'Falha ao salvar', detalhe: t.slice(0, 160) });
      }
      return res.status(200).json({ ok: true, salvo: true });
    }

    if (action === 'remover') {
      const { video_id, plataforma } = body;
      if (!video_id || !plataforma) return res.status(400).json({ error: 'video_id e plataforma obrigatórios' });
      const r = await fetch(
        `${SU}/rest/v1/videos_salvos?user_id=eq.${uid}&plataforma=eq.${encodeURIComponent(plataforma)}&video_id=eq.${encodeURIComponent(video_id)}`,
        { method: 'DELETE', headers: h }
      );
      return res.status(r.ok ? 200 : 500).json({ ok: r.ok, removido: r.ok });
    }

    return res.status(400).json({ error: 'action_invalida' });
  } catch (e) {
    console.error('[videos-salvos]', e && e.message);
    return res.status(500).json({ error: e && e.message });
  }
};
