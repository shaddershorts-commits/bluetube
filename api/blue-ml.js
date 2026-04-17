// api/blue-ml.js — coleta de dados para ML em background (CommonJS).
// O ML NAO atua no feed. So observa e aprende.

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const SU = process.env.SUPABASE_URL;
  const SK = process.env.SUPABASE_SERVICE_KEY;
  const AK = process.env.SUPABASE_ANON_KEY || SK;
  if (!SU || !SK) return res.status(500).json({ error: 'config_missing' });
  const h = { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' };

  const action = (req.method === 'GET' ? req.query.action : req.body?.action) || null;

  if (action === 'registrar')          return registrarObservacao(req, res, { SU, SK, AK, h });
  if (action === 'calcular-features')  return calcularFeatures(req, res, { SU, h });
  if (action === 'status')             return statusML(req, res, { SU, h });
  if (action === 'exportar-dataset')   return exportarDataset(req, res, { SU, h });

  return res.status(400).json({ error: 'action_invalida' });
};

// ── REGISTRAR OBSERVACAO ──────────────────────────────────────────────────
async function registrarObservacao(req, res, { SU, AK, h }) {
  const b = req.body || {};
  const token = b.token;
  if (!token || !b.video_id) return res.status(200).json({ ok: true }); // fail silencioso

  // Resolve user via Supabase auth
  let userId;
  try {
    const uR = await fetch(`${SU}/auth/v1/user`, { headers: { apikey: AK, Authorization: 'Bearer ' + token } });
    if (!uR.ok) return res.status(200).json({ ok: true });
    userId = (await uR.json()).id;
  } catch (e) { return res.status(200).json({ ok: true }); }

  // Busca video
  let video;
  try {
    const vR = await fetch(`${SU}/rest/v1/blue_videos?id=eq.${b.video_id}&select=user_id,nichos,hashtags,views,likes,created_at&limit=1`, { headers: h });
    video = vR.ok ? (await vR.json())[0] : null;
  } catch (e) {}
  if (!video) return res.status(200).json({ ok: true });

  const agora = new Date();
  const pct = Math.max(0, Math.min(100, parseInt(b.percentual_assistido) || 0));

  // Engagement score (label para ML supervisionado)
  let eng = (pct / 100) * 40;
  if (b.curtiu) eng += 15;
  if (b.salvou) eng += 20;
  if (b.comentou) eng += 15;
  if (b.compartilhou) eng += 25;
  if (b.replay) eng += 20;
  if (b.abriu_perfil) eng += 10;
  if (b.seguiu_criador) eng += 30;
  if (b.pulou) eng -= 30;
  eng = Math.max(0, Math.min(100, eng));

  // Upsert pela unique (user_id, video_id, sessao_id)
  const payload = {
    user_id: userId,
    sessao_id: b.sessao_id || ('sess_' + userId + '_' + Date.now()),
    posicao_no_feed: parseInt(b.posicao) || 0,
    video_id: b.video_id,
    criador_id: video.user_id,
    nichos: Array.isArray(video.nichos) ? video.nichos : [],
    hashtags: Array.isArray(video.hashtags) ? video.hashtags : [],
    duracao_video: b.duracao_video != null ? parseInt(b.duracao_video) : null,
    hora_publicacao_video: video.created_at,
    views_no_momento: video.views || 0,
    likes_no_momento: video.likes || 0,
    hora_do_dia: agora.getHours(),
    dia_da_semana: agora.getDay(),
    dispositivo: b.dispositivo || null,
    percentual_assistido: pct,
    tempo_assistido_segundos: parseInt(b.tempo_assistido_segundos) || 0,
    pulou: !!b.pulou,
    tempo_ate_pular_segundos: b.tempo_ate_pular_segundos != null ? parseFloat(b.tempo_ate_pular_segundos) : null,
    curtiu: !!b.curtiu,
    salvou: !!b.salvou,
    comentou: !!b.comentou,
    compartilhou: !!b.compartilhou,
    replay: !!b.replay,
    abriu_perfil_criador: !!b.abriu_perfil,
    seguiu_criador: !!b.seguiu_criador,
    score_regras: b.score_regras != null ? parseFloat(b.score_regras) : null,
    engagement_score: eng,
  };

  try {
    await fetch(`${SU}/rest/v1/blue_ml_dataset?on_conflict=user_id,video_id,sessao_id`, {
      method: 'POST',
      headers: { ...h, Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(payload),
    });
  } catch (e) { console.error('[ml registrar]', e.message); }

  return res.status(200).json({ ok: true });
}

// ── CALCULAR FEATURES (cron 6h) ────────────────────────────────────────────
async function calcularFeatures(req, res, { SU, h }) {
  try {
    const seteDiasAtras = new Date(Date.now() - 7 * 86400000).toISOString();
    const trintaDiasAtras = new Date(Date.now() - 30 * 86400000).toISOString();

    // 1. Usuarios ativos nos ultimos 7 dias (processa ate 100)
    const uR = await fetch(
      `${SU}/rest/v1/blue_ml_dataset?created_at=gte.${seteDiasAtras}&select=user_id`,
      { headers: h }
    );
    const userRows = uR.ok ? await uR.json() : [];
    const userIdsUnicos = [...new Set(userRows.map(r => r.user_id))].slice(0, 100);

    let uProcessados = 0;
    for (const userId of userIdsUnicos) {
      // Busca observacoes do usuario nos ultimos 30 dias
      const oR = await fetch(
        `${SU}/rest/v1/blue_ml_dataset?user_id=eq.${userId}&created_at=gte.${trintaDiasAtras}&select=*&limit=2000`,
        { headers: h }
      );
      const obs = oR.ok ? await oR.json() : [];
      if (obs.length < 5) continue;

      const total = obs.length;
      const avg = obs.reduce((a, o) => a + (o.percentual_assistido || 0), 0) / total;
      const taxas = {
        taxa_like: obs.filter(o => o.curtiu).length / total,
        taxa_skip: obs.filter(o => o.pulou).length / total,
        taxa_save: obs.filter(o => o.salvou).length / total,
        taxa_share: obs.filter(o => o.compartilhou).length / total,
        taxa_comment: obs.filter(o => o.comentou).length / total,
      };

      // Horario preferido: pico de atividade por hora
      const contagem = new Array(24).fill(0);
      obs.forEach(o => { if (o.hora_do_dia != null) contagem[o.hora_do_dia]++; });
      const horario_preferido = contagem.indexOf(Math.max(...contagem));

      // Vetor de nichos ponderado pelo engagement_score
      const vetor = {};
      obs.forEach(o => {
        (o.nichos || []).forEach(n => {
          if (!n) return;
          vetor[n] = (vetor[n] || 0) + (o.engagement_score || 0);
        });
      });
      const maxV = Math.max(...Object.values(vetor), 1);
      Object.keys(vetor).forEach(k => { vetor[k] = Math.round((vetor[k] / maxV) * 1000) / 1000; });

      // Sessoes/semana e videos/sessao
      const sessoes = new Set(obs.map(o => o.sessao_id)).size;
      const diasUnicos = new Set(obs.map(o => o.created_at.slice(0, 10))).size;
      const sessoesPorSemana = diasUnicos > 0 ? (sessoes / diasUnicos) * 7 : 0;
      const videosPorSessao = sessoes > 0 ? total / sessoes : 0;

      await fetch(`${SU}/rest/v1/blue_ml_user_features?on_conflict=user_id`, {
        method: 'POST',
        headers: { ...h, Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({
          user_id: userId,
          avg_watch_percent: Math.round(avg * 100) / 100,
          ...taxas,
          sessoes_por_semana: Math.round(sessoesPorSemana * 100) / 100,
          videos_por_sessao: Math.round(videosPorSessao * 100) / 100,
          horario_preferido,
          nichos_vetor: vetor,
          total_interacoes: total,
          updated_at: new Date().toISOString(),
        }),
      });
      uProcessados++;
    }

    // 2. Videos ativos nos ultimos 7 dias (processa ate 200)
    const vR = await fetch(
      `${SU}/rest/v1/blue_ml_dataset?created_at=gte.${seteDiasAtras}&select=video_id`,
      { headers: h }
    );
    const vidRows = vR.ok ? await vR.json() : [];
    const videoIdsUnicos = [...new Set(vidRows.map(r => r.video_id))].slice(0, 200);

    let vProcessados = 0;
    for (const videoId of videoIdsUnicos) {
      const oR = await fetch(
        `${SU}/rest/v1/blue_ml_dataset?video_id=eq.${videoId}&select=*&limit=500`,
        { headers: h }
      );
      const obs = oR.ok ? await oR.json() : [];
      if (obs.length < 3) continue;

      const total = obs.length;
      await fetch(`${SU}/rest/v1/blue_ml_video_features?on_conflict=video_id`, {
        method: 'POST',
        headers: { ...h, Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({
          video_id: videoId,
          avg_watch_percent: Math.round((obs.reduce((a, o) => a + (o.percentual_assistido || 0), 0) / total) * 100) / 100,
          taxa_like: obs.filter(o => o.curtiu).length / total,
          taxa_skip: obs.filter(o => o.pulou).length / total,
          taxa_save: obs.filter(o => o.salvou).length / total,
          taxa_share: obs.filter(o => o.compartilhou).length / total,
          taxa_comment: obs.filter(o => o.comentou).length / total,
          taxa_replay: obs.filter(o => o.replay).length / total,
          taxa_follow_criador: obs.filter(o => o.seguiu_criador).length / total,
          engagement_score: Math.round((obs.reduce((a, o) => a + (o.engagement_score || 0), 0) / total) * 100) / 100,
          total_impressoes: total,
          updated_at: new Date().toISOString(),
        }),
      });
      vProcessados++;
    }

    // 3. Check milestone notifications (10K, 100K observacoes)
    await checkMilestoneNotifications({ SU, h }).catch(e => console.error('[ml milestone]', e.message));

    return res.status(200).json({
      ok: true,
      usuarios_processados: uProcessados,
      videos_processados: vProcessados,
    });
  } catch (e) {
    console.error('[ml calcular-features]', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// ── STATUS ─────────────────────────────────────────────────────────────────
async function statusML(req, res, { SU, h }) {
  try {
    const [dsR, expR, ufR, vfR] = await Promise.all([
      fetch(`${SU}/rest/v1/blue_ml_dataset?select=id&limit=1`, { headers: { ...h, Prefer: 'count=exact' } }),
      fetch(`${SU}/rest/v1/blue_ml_experimentos?nome=eq.feed_ml_v1&select=*&limit=1`, { headers: h }),
      fetch(`${SU}/rest/v1/blue_ml_user_features?select=user_id&limit=1`, { headers: { ...h, Prefer: 'count=exact' } }),
      fetch(`${SU}/rest/v1/blue_ml_video_features?select=video_id&limit=1`, { headers: { ...h, Prefer: 'count=exact' } }),
    ]);

    const getCount = (r) => parseInt((r.headers.get('content-range') || '').split('/')[1] || '0') || 0;
    const total = getCount(dsR);
    const metaMinima = 100000;
    const progresso = Math.min(100, (total / metaMinima) * 100);
    const experimento = expR.ok ? (await expR.json())[0] : null;

    const proximaFase = total < 10000
      ? 'Coletando dados (fase 1/3)'
      : total < metaMinima
        ? 'Dados suficientes para teste A/B (fase 2/3)'
        : 'Pronto para ativar ML completo (fase 3/3)';

    return res.status(200).json({
      status: experimento?.status || 'coletando_dados',
      experimento: experimento || null,
      dataset: {
        total_observacoes: total,
        meta_minima: metaMinima,
        progresso_percentual: Math.round(progresso * 10) / 10,
        proxima_fase: proximaFase,
      },
      features: {
        usuarios_com_features: getCount(ufR),
        videos_com_features: getCount(vfR),
      },
      estimativa_ativacao: total < metaMinima
        ? `Faltam ${(metaMinima - total).toLocaleString('pt-BR')} observacoes`
        : 'Dataset pronto para treinar modelo',
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

// ── EXPORTAR DATASET (admin-only) ─────────────────────────────────────────
async function exportarDataset(req, res, { SU, h }) {
  const ADMIN_SECRET = process.env.ADMIN_SECRET;
  const authHeader = req.headers['authorization'] || '';
  if (!ADMIN_SECRET || authHeader !== 'Bearer ' + ADMIN_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  try {
    const trintaDiasAtras = new Date(Date.now() - 30 * 86400000).toISOString();
    const r = await fetch(
      `${SU}/rest/v1/blue_ml_dataset?created_at=gte.${trintaDiasAtras}&order=created_at.desc&limit=50000&select=*`,
      { headers: h }
    );
    const data = r.ok ? await r.json() : [];
    return res.status(200).json({ total: data.length, dataset: data });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

// ── MILESTONE NOTIFICATIONS (10K, 100K) ───────────────────────────────────
async function checkMilestoneNotifications({ SU, h }) {
  if (!process.env.RESEND_API_KEY || !process.env.ADMIN_EMAIL) return;

  const dsR = await fetch(`${SU}/rest/v1/blue_ml_dataset?select=id&limit=1`, { headers: { ...h, Prefer: 'count=exact' } });
  const total = parseInt((dsR.headers.get('content-range') || '').split('/')[1] || '0') || 0;

  const expR = await fetch(`${SU}/rest/v1/blue_ml_experimentos?nome=eq.feed_ml_v1&select=id,metricas&limit=1`, { headers: h });
  const [exp] = expR.ok ? await expR.json() : [];
  if (!exp) return;
  const m = exp.metricas || {};

  const milestones = [
    { threshold: 10000, key: 'notified_10k', subject: '🎯 Blue ML: 10.000 observacoes — pronto pra teste A/B', body: 'O dataset bateu 10 mil observacoes. Fase 2 (teste A/B com 5% dos usuarios) agora eh viavel.' },
    { threshold: 100000, key: 'notified_100k', subject: '🚀 Blue ML: 100.000 observacoes — pronto pra ML completo', body: 'O dataset bateu 100 mil observacoes. Hora de treinar o modelo e ativar em producao.' },
  ];

  for (const ms of milestones) {
    if (total >= ms.threshold && !m[ms.key]) {
      try {
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: 'monitor@bluetubeviral.com',
            to: process.env.ADMIN_EMAIL,
            subject: ms.subject,
            html: `<h2>${ms.subject}</h2><p>${ms.body}</p><p><a href="https://bluetubeviral.com/admin">Abrir painel admin →</a></p><p style="font-size:12px;color:#888">Observacoes acumuladas: <b>${total.toLocaleString('pt-BR')}</b></p>`,
          }),
        });
        m[ms.key] = new Date().toISOString();
      } catch (e) { console.error('[ml milestone email]', e.message); }
    }
  }

  await fetch(`${SU}/rest/v1/blue_ml_experimentos?id=eq.${exp.id}`, {
    method: 'PATCH',
    headers: { ...h, Prefer: 'return=minimal' },
    body: JSON.stringify({ metricas: m }),
  }).catch(() => {});
}
