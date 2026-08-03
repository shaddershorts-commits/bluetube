// api/blue-interact.js — Registra interações e atualiza score do vídeo
// POST { type, video_id, user_id?, session_id, watch_duration?, completion_pct? }

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const SU = process.env.SUPABASE_URL;
  const SK = process.env.SUPABASE_SERVICE_KEY;
  if (!SU || !SK) return res.status(500).json({ error: 'Config missing' });

  const h = { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' };

  // Rate limiting: 30 req/min per IP for interactions
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  try {
    const janela = new Date(Date.now() - 60000).toISOString();
    const rlR = await fetch(`${SU}/rest/v1/blue_rate_limits?identificador=eq.${encodeURIComponent(ip)}&endpoint=eq.interact&select=requests,janela_inicio`, { headers: h });
    const rlRows = rlR.ok ? await rlR.json() : [];
    const rl = rlRows[0];
    if (rl && new Date(rl.janela_inicio) >= new Date(janela) && rl.requests >= 30) {
      return res.status(429).json({ error: 'Rate limit exceeded' });
    }
    const newCount = (rl && new Date(rl.janela_inicio) >= new Date(janela)) ? (rl.requests || 0) + 1 : 1;
    const newJanela = (rl && new Date(rl.janela_inicio) >= new Date(janela)) ? rl.janela_inicio : new Date().toISOString();
    fetch(`${SU}/rest/v1/blue_rate_limits`, { method: 'POST', headers: { ...h, 'Prefer': 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ identificador: ip, endpoint: 'interact', requests: newCount, janela_inicio: newJanela }) }).catch(() => {});
  } catch(e) {} // fail open

  try {
    const body = req.body || {};
    const { type, action: interactAction, video_id, user_id, session_id, token, watch_duration = 0, video_duration = 0, completion_pct = 0 } = body;

    // ── Anti-fraude: ações LOGADAS (curtir/descurtir/compartilhar) tiram a
    //    identidade do TOKEN validado, não do user_id do corpo (que era
    //    spoofável → dava pra inflar curtida de qualquer um). View NÃO passa
    //    por aqui: visitante conta sem login (validação de view é por
    //    dedup+watch, mais abaixo).
    // like/unlike: exigem token (ação logada; kill do spoof de curtida).
    // share/view: visitante conta — best-effort (dedup + rate limit por IP).
    let actorId = user_id || null;
    if (['like', 'unlike'].includes(type)) {
      if (!token) return res.status(401).json({ error: 'Login necessário' });
      const AK = process.env.SUPABASE_ANON_KEY || SK;
      const uR = await fetch(`${SU}/auth/v1/user`, { headers: { apikey: AK, Authorization: 'Bearer ' + token } });
      if (!uR.ok) return res.status(401).json({ error: 'Token inválido' });
      actorId = (await uR.json()).id;
    } else if (type === 'share' && token) {
      // Se veio token no share, usa a identidade validada (senão fica null = guest)
      const AK = process.env.SUPABASE_ANON_KEY || SK;
      const uR = await fetch(`${SU}/auth/v1/user`, { headers: { apikey: AK, Authorization: 'Bearer ' + token } }).catch(() => null);
      if (uR && uR.ok) actorId = (await uR.json()).id;
    }

    // ── SALVAR / DESALVAR VÍDEO ────────────────────────────────────────────
    if (interactAction === 'salvar') {
      const { token, video_id: vid } = body;
      if (!token || !vid) return res.status(400).json({ error: 'token e video_id obrigatórios' });
      const AK = process.env.SUPABASE_ANON_KEY || SK;
      const uR = await fetch(`${SU}/auth/v1/user`, { headers: { apikey: AK, Authorization: 'Bearer ' + token } });
      if (!uR.ok) return res.status(401).json({ error: 'Token inválido' });
      const uid = (await uR.json()).id;
      // Check if already saved
      const eR = await fetch(`${SU}/rest/v1/blue_salvos?user_id=eq.${uid}&video_id=eq.${vid}&select=id`, { headers: h });
      const existing = eR.ok ? await eR.json() : [];
      if (existing.length) {
        await fetch(`${SU}/rest/v1/blue_salvos?id=eq.${existing[0].id}`, { method: 'DELETE', headers: h });
        return res.status(200).json({ ok: true, saved: false });
      }
      await fetch(`${SU}/rest/v1/blue_salvos`, { method: 'POST', headers: { ...h, 'Prefer': 'return=minimal' },
        body: JSON.stringify({ user_id: uid, video_id: vid, colecao: body.colecao || 'Salvos' }) });
      return res.status(200).json({ ok: true, saved: true });
    }

    // ── MEUS SALVOS ────────────────────────────────────────────────────────
    if (interactAction === 'meus-salvos') {
      const { token } = body;
      if (!token) return res.status(401).json({ error: 'token obrigatório' });
      const AK = process.env.SUPABASE_ANON_KEY || SK;
      const uR = await fetch(`${SU}/auth/v1/user`, { headers: { apikey: AK, Authorization: 'Bearer ' + token } });
      if (!uR.ok) return res.status(401).json({ error: 'Token inválido' });
      const uid = (await uR.json()).id;
      const sR = await fetch(`${SU}/rest/v1/blue_salvos?user_id=eq.${uid}&order=created_at.desc&limit=50&select=video_id,colecao,created_at`, { headers: h });
      const salvos = sR.ok ? await sR.json() : [];
      if (!salvos.length) return res.status(200).json({ salvos: [] });
      const vIds = salvos.map(s => s.video_id);
      const vR = await fetch(`${SU}/rest/v1/blue_videos?id=in.(${vIds.join(',')})&status=eq.active&select=id,title,thumbnail_url,video_url,views,likes,user_id`, { headers: h });
      const vids = vR.ok ? await vR.json() : [];
      const vidMap = {}; vids.forEach(v => { vidMap[v.id] = v; });
      return res.status(200).json({ salvos: salvos.map(s => ({ ...s, video: vidMap[s.video_id] || null })).filter(s => s.video) });
    }

    // ── NOTIFICAÇÕES ───────────────────────────────────────────────────────
    if (interactAction === 'notificacoes') {
      const { token } = body;
      if (!token) return res.status(401).json({ error: 'token obrigatório' });
      const AK = process.env.SUPABASE_ANON_KEY || SK;
      const uR = await fetch(`${SU}/auth/v1/user`, { headers: { apikey: AK, Authorization: 'Bearer ' + token } });
      if (!uR.ok) return res.status(401).json({ error: 'Token inválido' });
      const uid = (await uR.json()).id;
      const nR = await fetch(`${SU}/rest/v1/blue_notificacoes?user_id=eq.${uid}&order=created_at.desc&limit=30&select=*`, { headers: h });
      const notifs = nR.ok ? await nR.json() : [];
      const unread = notifs.filter(n => !n.lida).length;
      return res.status(200).json({ notificacoes: notifs, unread });
    }

    // ── MARCAR NOTIFICAÇÕES COMO LIDAS ─────────────────────────────────────
    if (interactAction === 'marcar-lidas') {
      const { token } = body;
      if (!token) return res.status(401).json({ error: 'token obrigatório' });
      const AK = process.env.SUPABASE_ANON_KEY || SK;
      const uR = await fetch(`${SU}/auth/v1/user`, { headers: { apikey: AK, Authorization: 'Bearer ' + token } });
      if (!uR.ok) return res.status(401).json({ error: 'Token inválido' });
      const uid = (await uR.json()).id;
      await fetch(`${SU}/rest/v1/blue_notificacoes?user_id=eq.${uid}&lida=eq.false`, {
        method: 'PATCH', headers: { ...h, 'Prefer': 'return=minimal' }, body: JSON.stringify({ lida: true })
      });
      return res.status(200).json({ ok: true });
    }

    // ── ANALYTICS (registra watch data) ────────────────────────────────────
    if (interactAction === 'analytics') {
      const { video_id: aVid, user_id: aUid, percentual_assistido, origem } = body;
      if (aVid) {
        fetch(`${SU}/rest/v1/blue_video_analytics`, { method: 'POST', headers: { ...h, 'Prefer': 'return=minimal' },
          body: JSON.stringify({ video_id: aVid, user_id: aUid || null, percentual_assistido: percentual_assistido || 0, origem: origem || 'feed' })
        }).catch(() => {});
      }
      return res.status(200).json({ ok: true });
    }

    if (!type || !video_id) return res.status(400).json({ error: 'type e video_id obrigatórios' });

    const completed = completion_pct >= 80;
    const skipped   = completion_pct < 20 && watch_duration > 0;

    // Registra interação
    await fetch(`${SU}/rest/v1/blue_interactions`, {
      method: 'POST',
      headers: { ...h, Prefer: 'return=minimal' },
      body: JSON.stringify({ type, video_id, user_id: user_id || null, session_id: session_id || null, watch_duration, video_duration, completion_pct, completed, skipped })
    });

    // ── Validação de VIEW (régua "Equilibrada", escolha do user 2026-07-17) ──
    // Visitante conta, mas o contador só sobe se: (1) o vídeo REALMENTE tocou
    // (≥1s OU ≥25%) e (2) essa identidade não contou esse vídeo nas últimas 24h.
    // Identidade: user_id (logado) senão session_id do app (visitante) — a
    // relaunch do guest gera nova sessão, mas o teto de 30/min por IP no topo
    // barra inflação via API direto.
    let viewCounts = false;
    if (type === 'view') {
      const played = watch_duration >= 1 || completion_pct >= 25;
      let alreadyCounted = false;
      const dedupCol = user_id ? 'user_id' : (session_id ? 'session_id' : null);
      const dedupVal = user_id || session_id;
      if (played && dedupCol) {
        const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
        const dR = await fetch(
          `${SU}/rest/v1/blue_feed_seen?video_id=eq.${encodeURIComponent(video_id)}&${dedupCol}=eq.${encodeURIComponent(dedupVal)}&seen_at=gt.${since}&select=video_id&limit=1`,
          { headers: h }
        ).catch(() => null);
        alreadyCounted = dR && dR.ok && (await dR.json().catch(() => [])).length > 0;
      }
      // sem identidade (dedupCol null): não dá pra deduplicar → conta 1x só se tocou
      viewCounts = played && !alreadyCounted;
    }

    // Marca como visto no feed (mantém a lógica do feed + refresca a janela de dedup)
    if ((user_id || session_id) && type === 'view') {
      await fetch(`${SU}/rest/v1/blue_feed_seen`, {
        method: 'POST',
        headers: { ...h, Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({ video_id, user_id: user_id || null, session_id: session_id || null, seen_at: new Date().toISOString() })
      }).catch(() => {});
    }

    // Busca métricas atuais do vídeo
    const vR = await fetch(`${SU}/rest/v1/blue_videos?id=eq.${video_id}&select=*`, { headers: h });
    if (!vR.ok) return res.status(200).json({ ok: true });
    const vArr = await vR.json();
    const v = vArr[0];
    if (!v) return res.status(200).json({ ok: true });

    // Atualiza contadores e recalcula score
    const patch = {};

    if (type === 'view') {
      // Só conta se passou na validação (tocou + não-duplicado em 24h).
      // View repetida/phantom: não mexe em nenhum contador nem no score.
      if (!viewCounts) return res.status(200).json({ ok: true, counted: false });
      patch.views = (v.views || 0) + 1;
      patch.test_views = (v.test_views || 0) + 1;
      patch.total_watch_time = (v.total_watch_time || 0) + watch_duration;
      const totalViews = patch.views;
      patch.completion_rate = totalViews > 0
        ? ((v.completion_rate || 0) * (totalViews - 1) + (completed ? 100 : completion_pct)) / totalViews
        : completion_pct;
      patch.skip_rate = totalViews > 0
        ? ((v.skip_rate || 0) * (totalViews - 1) + (skipped ? 100 : 0)) / totalViews
        : 0;
    } else if (type === 'like') {
      // IDEMPOTENCIA via UNIQUE(user_id, video_id) em blue_likes.
      // Tenta INSERT — se ja existir, ignore-duplicates retorna corpo vazio.
      // Apenas incrementa o contador + notifica se foi 1a curtida desse user.
      // actorId vem do token validado (não do corpo) — anti-spoof
      const insR = await fetch(`${SU}/rest/v1/blue_likes`, {
        method: 'POST',
        headers: { ...h, Prefer: 'return=representation,resolution=ignore-duplicates' },
        body: JSON.stringify({ user_id: actorId, video_id }),
      });
      const insBody = await insR.json().catch(() => []);
      const insertedNew = Array.isArray(insBody) && insBody.length > 0;
      if (!insertedNew) {
        // Usuario ja tinha curtido — nao incrementa, retorna idempotente
        return res.status(200).json({ ok: true, skipped: 'already_liked' });
      }
      patch.likes = Math.max(0, (v.likes || 0) + 1);
      await _notifyOwner(SU, h, actorId, v.user_id, video_id, {
        tipo: 'like', titulo: 'Nova curtida',
        msgFn: (uname) => `@${uname} curtiu seu vídeo`,
      });
    } else if (type === 'unlike') {
      // Espelho: deleta de blue_likes; so decrementa se realmente removeu uma row
      const delR = await fetch(
        `${SU}/rest/v1/blue_likes?user_id=eq.${encodeURIComponent(actorId)}&video_id=eq.${encodeURIComponent(video_id)}`,
        { method: 'DELETE', headers: { ...h, Prefer: 'return=representation' } }
      );
      const delBody = await delR.json().catch(() => []);
      const wasDeleted = Array.isArray(delBody) && delBody.length > 0;
      if (!wasDeleted) return res.status(200).json({ ok: true, skipped: 'not_liked_yet' });
      patch.likes = Math.max(0, (v.likes || 0) - 1);
    } else if (type === 'save') {
      patch.saves = Math.max(0, (v.saves || 0) + 1);
      await _notifyOwner(SU, h, actorId, v.user_id, video_id, {
        tipo: 'save', titulo: 'Vídeo salvo',
        msgFn: (uname) => `@${uname} salvou seu vídeo`,
      });
    } else if (type === 'unsave') { patch.saves = Math.max(0, (v.saves || 0) - 1);
    } else if (type === 'share') {
      // Conta no insight do criador (coluna shares — sql/status_bluechat_v1.sql)
      patch.shares = (v.shares || 0) + 1;
      await _notifyOwner(SU, h, actorId, v.user_id, video_id, {
        tipo: 'share', titulo: 'Vídeo compartilhado',
        msgFn: (uname) => `@${uname} compartilhou seu vídeo`,
      });
    }

    // Recalcula score (0-100)
    const newLikes    = patch.likes !== undefined ? patch.likes : (v.likes || 0);
    const newSaves    = patch.saves !== undefined ? patch.saves : (v.saves || 0);
    const newViews    = patch.views !== undefined ? patch.views : (v.views || 0);
    const compRate    = patch.completion_rate !== undefined ? patch.completion_rate : (v.completion_rate || 0);
    const skipRate    = patch.skip_rate !== undefined ? patch.skip_rate : (v.skip_rate || 0);
    const engRate     = newViews > 0 ? ((newLikes * 3 + newSaves * 5) / newViews) * 100 : 0;
    const retScore    = compRate * 0.4 + (100 - skipRate) * 0.2;
    const engScore    = Math.min(100, engRate * 2);
    const bruto       = Math.min(100, Math.max(0, retScore * 0.6 + engScore * 0.4));

    // ── SUAVIZAÇÃO POR AMOSTRA (fix 03/08/2026) ────────────────────────────
    // Sem isto, UMA única view decidia o destino do vídeo. Caso real observado
    // em produção hoje, minutos depois da medição voltar a funcionar: alguém
    // assistiu 3s de um vídeo de 21s (15%), o backend marcou como "skip"
    // (completion < 20%), o skip_rate virou 100 porque a amostra era n=1, e o
    // score caiu de 50 pra 3,6. Um espectador desatento condenava o vídeo.
    // A distribuição confirmava o estrago: 53% dos vídeos a menos de 1 ponto
    // da mediana — score bimodal (50 = intocado, ~12 = tocado), sem poder de
    // ordenar nada.
    // Agora o score observado é misturado a um prior neutro com peso PRIOR_N:
    // com 1 view o score quase não se move; com 30+ views o dado real domina.
    // É o mesmo princípio de "média bayesiana" que o IMDb usa pra nota de
    // filme com poucos votos.
    // ── QUEM É O DONO DO SCORE (decisão 03/08/2026) ────────────────────────
    // O `score` passou a ser calculado pelo cron `update-metrics` (roda de 15
    // em 15 min), que enxerga 30 DIAS e as duas fontes de retenção. Aqui a
    // amostra é sempre minúscula — no limite, UMA view — e por isso este
    // ponto só sabia produzir score instável (chegou a derrubar um vídeo de
    // 50 pra 3,6 com um único espectador desatento).
    // Dois donos escrevendo no mesmo campo seria pior que nenhum: um
    // sobrescreveria o outro a cada interação. Então aqui NÃO se mexe mais no
    // score — só nos contadores. A suavização bayesiana vive no cron.
    // `bruto` segue calculado acima só pra telemetria/depuração futura.
    void bruto;

    // Sai da fase de teste após 30 views
    if ((v.test_views || 0) >= 30) patch.test_phase = false;

    patch.updated_at = new Date().toISOString();

    let pR = await fetch(`${SU}/rest/v1/blue_videos?id=eq.${video_id}`, {
      method: 'PATCH', headers: { ...h, Prefer: 'return=minimal' }, body: JSON.stringify(patch)
    });
    // Retrocompat: coluna shares ainda não criada → repete sem ela
    if (!pR.ok && patch.shares !== undefined) {
      delete patch.shares;
      await fetch(`${SU}/rest/v1/blue_videos?id=eq.${video_id}`, {
        method: 'PATCH', headers: { ...h, Prefer: 'return=minimal' }, body: JSON.stringify(patch)
      });
    }

    // ── MARCOS "seu vídeo tá indo bem" (estilo Instagram, user 2026-07-24) ──
    // Dispara UMA vez quando o contador CRUZA o degrau (old < T <= new) —
    // como o incremento é +1 por evento, cada degrau notifica só uma vez.
    // AWAITED (fire-and-forget morre no serverless) e raro (só no cruzamento).
    try {
      const fmtN = (n) => n >= 1000000 ? (n / 1000000).toFixed(n % 1000000 ? 1 : 0) + ' mi' : n >= 1000 ? (n / 1000).toFixed(n % 1000 ? 1 : 0) + ' mil' : String(n);
      const marcos = [];
      if (patch.views !== undefined) {
        for (const T of [100, 1000, 10000, 50000, 100000, 500000, 1000000]) {
          if ((v.views || 0) < T && patch.views >= T) marcos.push({ metric: 'views', T, titulo: '🚀 Seu vídeo tá voando!', msg: `Passou de ${fmtN(T)} visualizações` });
        }
      }
      if (patch.likes !== undefined && type === 'like') {
        for (const T of [10, 50, 100, 500, 1000, 5000, 10000]) {
          if ((v.likes || 0) < T && patch.likes >= T) marcos.push({ metric: 'likes', T, titulo: '❤️ Seu vídeo tá bombando!', msg: `Bateu ${fmtN(T)} curtidas` });
        }
      }
      for (const m of marcos) {
        if (!v.user_id) break;
        await fetch(`${SU}/rest/v1/blue_notificacoes`, {
          method: 'POST', headers: { ...h, Prefer: 'return=minimal' },
          body: JSON.stringify({
            user_id: v.user_id, tipo: 'milestone', titulo: m.titulo, mensagem: m.msg,
            dados: { video_id, metric: m.metric, valor: m.T },
          }),
        }).catch(() => null);
        try {
          const { sendPushToUser } = require('./_helpers/push.js');
          await sendPushToUser(v.user_id, {
            title: m.titulo, body: m.msg,
            data: { tipo: 'milestone', video_id, url: '/blue' },
          }).catch(() => null);
        } catch (e) {}
      }
    } catch (e) { /* fail-soft: marco nunca quebra a interação */ }

    return res.status(200).json({ ok: true, score: patch.score });
  } catch(err) {
    console.error('blue-interact error:', err.message);
    return res.status(200).json({ ok: false });
  }
};

// Helper: cria notif no banco + dispara push pro celular do dono do video.
// Fail-soft em todas as etapas — nunca quebra o flow principal de interacao.
// IMPORTANTE: é `async` e os chamadores usam AWAIT.
// Antes era fire-and-forget com .then(): em função serverless da Vercel, a
// promise pendente é DESCARTADA quando o handler responde — o mesmo bug que já
// tinha derrubado as notificações de follow/comentário (fix 2026-05-17 em
// blue-follow.js). Aqui sobreviviam só as que davam sorte de completar antes
// do encerramento, o que explica o número de notificações não bater com os
// contadores dos vídeos.
//
// DEDUP (2026-07-29): compartilhar o mesmo vídeo várias vezes (um envio por
// conversa no share sheet, + stories, + status) gerava uma notificação por
// envio — a caixa do criador enchia com "@fulano compartilhou seu vídeo"
// repetido, às vezes o mesmo par pessoa+vídeo com 150 ms de diferença. Agora
// o mesmo (dono, tipo, quem, vídeo) só notifica 1x a cada 24h. Os CONTADORES
// do vídeo continuam somando cada compartilhamento — muda só o aviso.
const JANELA_DEDUP_MS = 24 * 60 * 60 * 1000;

async function _notifyOwner(SU, h, fromUserId, ownerId, videoId, opts) {
  if (!fromUserId || !ownerId || ownerId === fromUserId) return;
  const { tipo, titulo, msgFn } = opts || {};
  try {
    const desde = new Date(Date.now() - JANELA_DEDUP_MS).toISOString();
    const jaR = await fetch(
      `${SU}/rest/v1/blue_notificacoes?user_id=eq.${ownerId}&tipo=eq.${tipo}` +
      `&dados->>from_user_id=eq.${fromUserId}&dados->>video_id=eq.${videoId}` +
      `&created_at=gte.${desde}&select=id&limit=1`,
      { headers: h }
    );
    if (jaR.ok) {
      const ja = await jaR.json().catch(() => []);
      if (Array.isArray(ja) && ja.length) return; // já avisou nas últimas 24h
    }

    const pR = await fetch(`${SU}/rest/v1/blue_profiles?user_id=eq.${fromUserId}&select=username`, { headers: h });
    const p = pR.ok ? await pR.json().catch(() => []) : [];
    const uname = p?.[0]?.username || 'alguém';
    const mensagem = msgFn ? msgFn(uname) : `@${uname} interagiu com seu vídeo`;

    // 1) Notif persistente no banco (aparece na inbox)
    await fetch(`${SU}/rest/v1/blue_notificacoes`, {
      method: 'POST', headers: { ...h, Prefer: 'return=minimal' },
      body: JSON.stringify({
        user_id: ownerId, tipo, titulo, mensagem,
        dados: { from_user_id: fromUserId, video_id: videoId },
      }),
    }).catch(() => {});

    // 2) Push mobile via Expo (chega no celular)
    try {
      const { sendPushToUser } = require('./_helpers/push.js');
      await sendPushToUser(ownerId, {
        title: titulo, body: mensagem,
        data: { tipo, from_user_id: fromUserId, video_id: videoId, url: '/blue' },
      }).catch(() => null);
    } catch(e) {}
  } catch (e) { /* fail-soft: notificação nunca derruba a interação */ }
}
