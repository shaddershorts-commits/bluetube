// api/blue-embeddings.js — Pipeline de embeddings pra feed personalizado
//
// Actions:
//   GET ?action=gerar-batch          — cron: gera embeddings dos videos sem (batch)
//   GET ?action=atualizar-perfis     — cron: recalcula user profile embeddings
//   GET ?action=similar&video_id=X   — top 10 videos similares
//   GET ?action=feed-personalizado&token=X — feed ordenado por similarity do user
//   GET ?action=status               — quantos videos ja tem embedding

const { gerarEmbedding } = require('./_helpers/embeddings.js');

const CONFIG = {
  BATCH_GERAR: 30,        // videos por invocacao (gera embedding de 30 videos)
  MINI_BATCH: 5,          // quantos em paralelo (OpenAI rate limit)
  DELAY_MS: 500,
  TIMEOUT_PREVENTIVO_MS: 50000,
};

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const SU = process.env.SUPABASE_URL;
  const SK = process.env.SUPABASE_SERVICE_KEY;
  const AK = process.env.SUPABASE_ANON_KEY || SK;
  if (!SU || !SK) return res.status(500).json({ error: 'Config missing' });
  const h = { apikey: SK, Authorization: `Bearer ${SK}`, 'Content-Type': 'application/json' };
  const action = req.query.action;
  const ctx = { SU, SK, AK, h };

  try {
    if (action === 'gerar-batch')           return res.status(200).json(await gerarBatch(ctx, req));
    if (action === 'atualizar-perfis')      return res.status(200).json(await atualizarPerfis(ctx, req));
    if (action === 'similar')               return res.status(200).json(await similar(ctx, req));
    if (action === 'feed-personalizado')    return res.status(200).json(await feedPersonalizado(ctx, req));
    if (action === 'status')                return res.status(200).json(await status(ctx));
    return res.status(400).json({ error: 'action invalida' });
  } catch (e) {
    console.error(`[blue-embeddings ${action}]`, e.message);
    return res.status(500).json({ error: e.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GERAR BATCH — cron que processa videos sem embedding
// ─────────────────────────────────────────────────────────────────────────────
async function gerarBatch(ctx, req) {
  const inicio = Date.now();
  const limit = Math.min(parseInt(req.query.limit || CONFIG.BATCH_GERAR), 100);

  // Busca videos sem embedding
  const r = await fetch(
    `${ctx.SU}/rest/v1/blue_videos?embedding=is.null&status=eq.active&order=created_at.desc&limit=${limit}&select=id,title,description`,
    { headers: ctx.h, signal: AbortSignal.timeout(8000) }
  );
  if (!r.ok) return { ok: false, erro: `read ${r.status}` };
  const videos = await r.json();
  if (!videos.length) return { ok: true, processados: 0, motivo: 'todos_ja_processados' };

  let processados = 0, falhas = 0;
  // Mini-batches paralelos com delay
  for (let i = 0; i < videos.length; i += CONFIG.MINI_BATCH) {
    if (Date.now() - inicio > CONFIG.TIMEOUT_PREVENTIVO_MS) break;
    const batch = videos.slice(i, i + CONFIG.MINI_BATCH);
    const resultados = await Promise.allSettled(batch.map(async v => {
      const texto = `${v.title || ''}. ${v.description || ''}`.slice(0, 2000);
      if (!texto.trim() || texto.trim().length < 3) return null;
      const emb = await gerarEmbedding(ctx, texto);
      if (!emb?.embedding) return null;
      // Atualiza o video — PostgREST aceita arrays como vector
      await fetch(`${ctx.SU}/rest/v1/blue_videos?id=eq.${v.id}`, {
        method: 'PATCH', headers: { ...ctx.h, Prefer: 'return=minimal' },
        body: JSON.stringify({
          embedding: emb.embedding,
          embedding_generated_at: new Date().toISOString(),
        }),
      });
      return true;
    }));
    processados += resultados.filter(r => r.status === 'fulfilled' && r.value).length;
    falhas += resultados.filter(r => r.status !== 'fulfilled' || !r.value).length;
    if (i + CONFIG.MINI_BATCH < videos.length) await new Promise(rs => setTimeout(rs, CONFIG.DELAY_MS));
  }

  return {
    ok: true, action: 'gerar-batch',
    processados, falhas, total_tentados: videos.length,
    duracao_ms: Date.now() - inicio,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// ATUALIZAR PERFIS — media ponderada dos embeddings dos videos que o user
// interagiu. Roda semanal ou quando user tiver muita interacao nova.
// ─────────────────────────────────────────────────────────────────────────────
async function atualizarPerfis(ctx, req) {
  const inicio = Date.now();
  const limit = Math.min(parseInt(req.query.limit || 20), 50);

  // Busca users ativos com historico nos ultimos 30 dias
  const desde = new Date(Date.now() - 30 * 86400000).toISOString();
  const hR = await fetch(
    `${ctx.SU}/rest/v1/blue_feed_historico?created_at=gte.${desde}&select=user_id&limit=2000`,
    { headers: ctx.h, signal: AbortSignal.timeout(8000) }
  );
  const historico = hR.ok ? await hR.json() : [];
  const users = [...new Set(historico.map(x => x.user_id))].slice(0, limit);

  let atualizados = 0;
  for (const userId of users) {
    if (Date.now() - inicio > CONFIG.TIMEOUT_PREVENTIVO_MS) break;
    try {
      // Busca embeddings dos videos que esse user curtiu/salvou/assistiu ate o fim
      const iR = await fetch(
        `${ctx.SU}/rest/v1/blue_feed_historico?user_id=eq.${userId}&or=(liked.eq.true,saved.eq.true,completion_rate.gt.80)&select=video_id&limit=100`,
        { headers: ctx.h }
      );
      const ints = iR.ok ? await iR.json() : [];
      if (ints.length < 3) continue; // precisa de amostra
      const videoIds = ints.map(i => i.video_id);
      const vR = await fetch(
        `${ctx.SU}/rest/v1/blue_videos?id=in.(${videoIds.join(',')})&embedding=not.is.null&select=embedding`,
        { headers: ctx.h }
      );
      const videos = vR.ok ? await vR.json() : [];
      if (videos.length < 3) continue;

      // Media dos embeddings (normalizada)
      const dim = 1536;
      const avg = new Array(dim).fill(0);
      for (const v of videos) {
        const emb = typeof v.embedding === 'string' ? JSON.parse(v.embedding) : v.embedding;
        if (!Array.isArray(emb)) continue;
        for (let i = 0; i < dim; i++) avg[i] += emb[i] || 0;
      }
      const mag = Math.sqrt(avg.reduce((s, x) => s + x * x, 0)) || 1;
      const normalized = avg.map(x => x / mag);

      await fetch(`${ctx.SU}/rest/v1/blue_user_profile_embeddings`, {
        method: 'POST',
        headers: { ...ctx.h, Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({
          user_id: userId,
          embedding: normalized,
          baseado_em: videos.length,
          ultima_atualizacao: new Date().toISOString(),
        }),
      });
      atualizados++;
    } catch (e) { /* pula user com erro */ }
  }

  return { ok: true, action: 'atualizar-perfis', users_processados: users.length, atualizados };
}

// ─────────────────────────────────────────────────────────────────────────────
// SIMILAR — top N videos similares via pgvector cosine
// ─────────────────────────────────────────────────────────────────────────────
async function similar(ctx, req) {
  const videoId = req.query.video_id;
  const limit = Math.min(parseInt(req.query.limit || 10), 30);
  if (!videoId) return { ok: false, error: 'video_id obrigatorio' };

  // Pega embedding do video
  const vR = await fetch(`${ctx.SU}/rest/v1/blue_videos?id=eq.${videoId}&select=embedding&limit=1`, { headers: ctx.h });
  const [v] = vR.ok ? await vR.json() : [];
  if (!v?.embedding) return { ok: false, error: 'video_sem_embedding' };

  // Usa RPC pra similarity search — precisa de uma funcao SQL criada (ver sql)
  // Como fallback sem RPC, filtro simples por is not null e retorno amostra
  // Nota: PostgREST nao expõe ops de vector diretamente — precisa RPC.
  try {
    const rpcR = await fetch(`${ctx.SU}/rest/v1/rpc/blue_videos_similares`, {
      method: 'POST', headers: ctx.h,
      body: JSON.stringify({ query_embedding: v.embedding, match_limit: limit, exclude_id: videoId }),
    });
    if (rpcR.ok) {
      const rows = await rpcR.json();
      return { ok: true, video_base: videoId, similares: rows };
    }
  } catch (e) {}

  // Fallback sem RPC — retorna videos ativos recentes (nao eh real similarity mas evita 500)
  const fR = await fetch(`${ctx.SU}/rest/v1/blue_videos?status=eq.active&id=neq.${videoId}&embedding=not.is.null&order=score.desc&limit=${limit}&select=id,title,thumbnail_url,views,likes,user_id`, { headers: ctx.h });
  const rows = fR.ok ? await fR.json() : [];
  return { ok: true, video_base: videoId, similares: rows, fonte: 'fallback_sem_rpc' };
}

// ─────────────────────────────────────────────────────────────────────────────
// FEED PERSONALIZADO — usa user profile embedding pra ordenar
// ─────────────────────────────────────────────────────────────────────────────
async function feedPersonalizado(ctx, req) {
  const token = req.query.token;
  if (!token) return { ok: false, error: 'token obrigatorio' };
  const limit = Math.min(parseInt(req.query.limit || 20), 50);

  // Valida token
  const uR = await fetch(`${ctx.SU}/auth/v1/user`, { headers: { apikey: ctx.AK, Authorization: `Bearer ${token}` } });
  if (!uR.ok) return { ok: false, error: 'token_invalido' };
  const user = await uR.json();

  // Pega embedding do perfil
  const pR = await fetch(`${ctx.SU}/rest/v1/blue_user_profile_embeddings?user_id=eq.${user.id}&select=embedding,baseado_em&limit=1`, { headers: ctx.h });
  const [profile] = pR.ok ? await pR.json() : [];
  if (!profile?.embedding) {
    return { ok: false, error: 'perfil_sem_embedding', hint: 'interaja com mais videos pra criar perfil' };
  }

  // RPC similarity search
  try {
    const rpcR = await fetch(`${ctx.SU}/rest/v1/rpc/blue_feed_personalizado`, {
      method: 'POST', headers: ctx.h,
      body: JSON.stringify({
        query_embedding: profile.embedding,
        match_limit: limit,
        exclude_user: user.id,
      }),
    });
    if (rpcR.ok) {
      const rows = await rpcR.json();
      return { ok: true, baseado_em: profile.baseado_em, videos: rows };
    }
  } catch (e) {}

  return { ok: false, error: 'rpc_indisponivel' };
}

// ─────────────────────────────────────────────────────────────────────────────
// STATUS — quantos videos ja tem embedding
// ─────────────────────────────────────────────────────────────────────────────
async function status(ctx) {
  const tR = await fetch(`${ctx.SU}/rest/v1/blue_videos?status=eq.active&select=id`, { headers: { ...ctx.h, Prefer: 'count=exact' } });
  const total = parseInt(tR.headers.get('content-range')?.split('/')[1] || 0);

  const eR = await fetch(`${ctx.SU}/rest/v1/blue_videos?status=eq.active&embedding=not.is.null&select=id`, { headers: { ...ctx.h, Prefer: 'count=exact' } });
  const comEmb = parseInt(eR.headers.get('content-range')?.split('/')[1] || 0);

  const pR = await fetch(`${ctx.SU}/rest/v1/blue_user_profile_embeddings?select=user_id`, { headers: { ...ctx.h, Prefer: 'count=exact' } });
  const perfis = parseInt(pR.headers.get('content-range')?.split('/')[1] || 0);

  return {
    ok: true,
    total_videos: total,
    videos_com_embedding: comEmb,
    cobertura_pct: total > 0 ? Math.round((comEmb / total) * 100) : 0,
    perfis_usuario: perfis,
  };
}
