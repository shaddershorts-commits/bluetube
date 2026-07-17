// api/blublu-chat.js — "Falar com o Blublu" (Virais) — EXCLUSIVO MASTER
//
// Chat que acha vídeo no banco curado por CONTEÚDO e por FILTRO:
//   "quero vídeos que falam do Michael Jackson"
//   "vídeos com mais de 5 mi de views nas últimas 2 semanas"
//
// Funil de precisão (desenho do user, 2026-07-18):
//   1. IA interpreta o pedido → filtros SQL + tema + variações de termos
//   2. Busca híbrida no virais_banco: termos no título (ILIKE) + semântica
//      (embeddings, quando OPENAI_API_KEY existir) + filtros SQL exatos
//   3. CAMADA DE CONFIRMAÇÃO: transcrição dos candidatos (cache permanente em
//      virais_transcricoes; busca no Railway /yt-subs?seg=1 quando falta) —
//      só afirma "fala de X" quem tem o termo NA FALA ou NO TÍTULO, com
//      timestamp da citação ("citado aos 2:13")
//   4. IA responde no personagem Blublu; frontend renderiza os cards
//
// Limite: 60 mensagens/dia por usuário (blublu_chat_usage).
// Nunca revelar motores/stack na resposta — é "nossa tecnologia".

const MODEL = 'claude-haiku-4-5-20251001';
const DAILY_LIMIT = 60;
const MAX_CANDIDATOS = 40;      // teto do funil por busca
const MAX_TRANSCREVER = 10;     // novas transcrições por mensagem (latência)
const TRANSC_PARALELAS = 4;     // concorrência no Railway
const BUDGET_TRANSC_MS = 20000; // orçamento de tempo da confirmação

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });

  const SU = process.env.SUPABASE_URL;
  const SK = process.env.SUPABASE_SERVICE_KEY;
  const AK = process.env.SUPABASE_ANON_KEY || SK;
  const ANTHROPIC = process.env.ANTHROPIC_API_KEY_STUDIO || process.env.ANTHROPIC_API_KEY;
  const OPENAI = process.env.OPENAI_API_KEY || '';
  const RW = (process.env.RAILWAY_FFMPEG_URL || '').replace(/\/$/, '');
  if (!SU || !SK || !ANTHROPIC) return res.status(500).json({ error: 'config' });
  const H = { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' };

  // ── AUTH: Master only (mesmo padrão do blueclean) ──────────────────────────
  const token = req.body?.token;
  let userId = null;
  if (token) {
    try {
      const ur = await fetch(`${SU}/auth/v1/user`, { headers: { apikey: AK, Authorization: 'Bearer ' + token } });
      if (ur.ok) {
        const u = await ur.json();
        const pr = await fetch(`${SU}/rest/v1/subscribers?email=eq.${encodeURIComponent(u.email)}&select=plan,plan_expires_at,is_manual`, { headers: H });
        if (pr.ok) {
          const sub = (await pr.json())[0];
          const vivo = sub && sub.plan === 'master' && (sub.is_manual || !sub.plan_expires_at || new Date(sub.plan_expires_at) > new Date());
          if (vivo) userId = u.id;
        }
      }
    } catch (e) {}
  }
  if (!userId) return res.status(403).json({ error: 'Falar com o Blublu é exclusivo do plano Master.', upgrade: true });

  // ── LIMITE DIÁRIO ──────────────────────────────────────────────────────────
  const dia = new Date().toISOString().slice(0, 10);
  const ur2 = await fetch(`${SU}/rest/v1/blublu_chat_usage?user_id=eq.${userId}&dia=eq.${dia}&select=count`, { headers: H });
  const used = ur2.ok ? ((await ur2.json())[0]?.count || 0) : 0;
  if (used >= DAILY_LIMIT) {
    return res.status(429).json({ error: `Ufa! Você já me fez trabalhar ${DAILY_LIMIT} vezes hoje. Volta amanhã que eu recarrego. 😮‍💨`, usage: { used, limit: DAILY_LIMIT } });
  }

  const message = String(req.body?.message || '').slice(0, 600).trim();
  const history = Array.isArray(req.body?.history) ? req.body.history.slice(-8) : [];
  const continuar = !!req.body?.continuar;
  if (!message) return res.status(400).json({ error: 'mensagem vazia' });

  const claude = async (system, messages, maxTokens) => {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: maxTokens || 700, system, messages }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error('ia: ' + JSON.stringify(d).slice(0, 140));
    return (d.content || []).map((c) => c.text || '').join('');
  };

  try {
    // ── 1) INTERPRETAÇÃO ─────────────────────────────────────────────────────
    const hoje = new Date().toISOString().slice(0, 10);
    const parseSystem = `Você interpreta pedidos de busca de vídeos virais e devolve APENAS um JSON válido, nada mais.
Hoje é ${hoje}. Nichos válidos: curiosidades, games, ia, animais, artistas, pessoas_blogs, culinaria.
Formato:
{"tipo":"busca"|"papo",
 "tema": string|null,            // assunto de CONTEÚDO (ex: "Michael Jackson"). null se o pedido é só filtro numérico/temporal.
 "termos": string[],             // 3-6 variações do tema pra busca em texto (nome completo, apelidos, traduções, grafias). [] se tema null.
 "filtros": {"min_views": number|null, "dias": number|null, "nicho": string|null, "ordem": "views"|"recentes"|null},
 "resposta_papo": string|null    // SÓ se tipo=papo: resposta curta no personagem (você é Blublu, mentor de virais direto, confiante, levemente provocador, pt-BR). null se tipo=busca.
}
"papo" = cumprimento, dúvida sobre você, ou pedido que não é busca de vídeo. Qualquer pedido de vídeos = "busca".`;
    const parseRaw = await claude(parseSystem, [...history.map((h) => ({ role: h.role === 'user' ? 'user' : 'assistant', content: String(h.content || '').slice(0, 300) })), { role: 'user', content: message }], 500);
    let parsed;
    try { parsed = JSON.parse(parseRaw.replace(/^```json?\s*/i, '').replace(/```\s*$/, '')); } catch (e) { parsed = { tipo: 'papo', resposta_papo: 'Me pede de novo de outro jeito? Não captei. 🤔' }; }

    const bump = async () => {
      if (used === 0) await fetch(`${SU}/rest/v1/blublu_chat_usage`, { method: 'POST', headers: { ...H, Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify({ user_id: userId, dia, count: 1 }) });
      else await fetch(`${SU}/rest/v1/blublu_chat_usage?user_id=eq.${userId}&dia=eq.${dia}`, { method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify({ count: used + 1 }) });
    };

    if (parsed.tipo === 'papo') {
      await bump();
      return res.status(200).json({ reply: parsed.resposta_papo || 'Diz aí o que você quer encontrar. 🎯', videos: [], usage: { used: used + 1, limit: DAILY_LIMIT } });
    }

    // ── 2) BUSCA HÍBRIDA no banco curado ─────────────────────────────────────
    const f = parsed.filtros || {};
    const parts = ['select=youtube_id,titulo,thumbnail_url,url,canal_nome,views,publicado_em,nicho'];
    if (f.min_views) parts.push(`views=gte.${Math.max(0, parseInt(f.min_views) || 0)}`);
    if (f.dias) parts.push(`publicado_em=gte.${new Date(Date.now() - f.dias * 86400000).toISOString()}`);
    if (f.nicho) parts.push(`nicho=eq.${encodeURIComponent(f.nicho)}`);
    const ordem = f.ordem === 'recentes' ? 'publicado_em.desc' : 'views.desc';

    const termos = (parsed.termos || []).map((t) => String(t).trim()).filter((t) => t.length >= 2).slice(0, 6);
    let candidatos = [];
    if (parsed.tema && termos.length) {
      // 2a. termos no título (escapa caracteres do PostgREST)
      const esc = (t) => t.replace(/[,()*]/g, ' ').replace(/\s+/g, ' ').trim();
      const orExpr = 'or=(' + termos.map((t) => `titulo.ilike.*${esc(t)}*`).join(',') + ')';
      const r1 = await fetch(`${SU}/rest/v1/virais_banco?${parts.join('&')}&${encodeURI(orExpr)}&order=${ordem}&limit=${MAX_CANDIDATOS}`, { headers: H });
      if (r1.ok) candidatos = await r1.json();
      // 2b. semântica (se disponível) — completa o funil com vídeos cujo título
      // não cita o termo mas o assunto é próximo
      if (OPENAI && candidatos.length < MAX_CANDIDATOS) {
        try {
          const er = await fetch('https://api.openai.com/v1/embeddings', { method: 'POST', headers: { Authorization: 'Bearer ' + OPENAI, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'text-embedding-3-small', input: parsed.tema }) });
          const ed = await er.json();
          const emb = ed?.data?.[0]?.embedding;
          if (emb) {
            const rr = await fetch(`${SU}/rest/v1/rpc/blublu_match_videos`, { method: 'POST', headers: H, body: JSON.stringify({ query_embedding: emb, match_count: MAX_CANDIDATOS, min_views: f.min_views || 0, desde: f.dias ? new Date(Date.now() - f.dias * 86400000).toISOString() : null }) });
            if (rr.ok) {
              const matches = await rr.json();
              const ids = matches.filter((m) => m.similarity > 0.35).map((m) => m.youtube_id).filter((id) => !candidatos.some((c) => c.youtube_id === id)).slice(0, MAX_CANDIDATOS - candidatos.length);
              if (ids.length) {
                const r2 = await fetch(`${SU}/rest/v1/virais_banco?${parts.join('&')}&youtube_id=in.(${ids.map(encodeURIComponent).join(',')})&order=${ordem}`, { headers: H });
                if (r2.ok) candidatos = candidatos.concat(await r2.json());
              }
            }
          }
        } catch (e) { /* semântica é opcional */ }
      }
    } else {
      // pedido só de filtros: SQL direto, precisão total
      const r1 = await fetch(`${SU}/rest/v1/virais_banco?${parts.join('&')}&order=${ordem}&limit=30`, { headers: H });
      if (r1.ok) candidatos = await r1.json();
    }

    // ── 3) CONFIRMAÇÃO POR TRANSCRIÇÃO (só busca de conteúdo) ────────────────
    const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    const termosN = termos.map(norm);
    let videos = [], temMais = false;
    if (parsed.tema && candidatos.length) {
      const ids = candidatos.map((c) => c.youtube_id);
      const tr = await fetch(`${SU}/rest/v1/virais_transcricoes?youtube_id=in.(${ids.map(encodeURIComponent).join(',')})&select=youtube_id,transcript,segments,sem_legenda`, { headers: H });
      const cache = tr.ok ? await tr.json() : [];
      const cacheMap = new Map(cache.map((c) => [c.youtube_id, c]));

      // transcreve os que faltam (paralelo limitado, orçamento de tempo)
      const faltam = candidatos.filter((c) => !cacheMap.has(c.youtube_id)).slice(0, MAX_TRANSCREVER);
      temMais = candidatos.filter((c) => !cacheMap.has(c.youtube_id)).length > faltam.length;
      if (RW && faltam.length) {
        const t0 = Date.now();
        const fila = [...faltam];
        const workers = Array.from({ length: TRANSC_PARALELAS }, async () => {
          while (fila.length && Date.now() - t0 < BUDGET_TRANSC_MS) {
            const c = fila.shift();
            try {
              const r = await fetch(`${RW}/yt-subs?v=${encodeURIComponent(c.youtube_id)}&seg=1`, { signal: AbortSignal.timeout(9000) });
              const row = { youtube_id: c.youtube_id, fonte: 'railway' };
              if (r.ok) {
                const d = await r.json();
                row.transcript = d.content || ''; row.segments = d.segments || null; row.lang = d.lang || null; row.sem_legenda = !d.content;
              } else { row.sem_legenda = true; }
              cacheMap.set(c.youtube_id, row);
              await fetch(`${SU}/rest/v1/virais_transcricoes`, { method: 'POST', headers: { ...H, Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(row) });
            } catch (e) { /* fica pra próxima rodada */ }
          }
        });
        await Promise.all(workers);
        temMais = temMais || fila.length > 0;
      }

      // classifica: fala (com timestamp) > título > semântico não confirmado
      for (const c of candidatos) {
        const tituloBate = termosN.some((t) => norm(c.titulo).includes(t));
        const tc = cacheMap.get(c.youtube_id);
        let citadoEm = null, falaBate = false;
        if (tc && tc.transcript && !tc.sem_legenda) {
          const txt = norm(tc.transcript);
          falaBate = termosN.some((t) => txt.includes(t));
          if (falaBate && Array.isArray(tc.segments)) {
            for (let i = 0; i < tc.segments.length; i++) {
              const seg = norm(tc.segments[i].x) + ' ' + norm(tc.segments[i + 1]?.x || '');
              if (termosN.some((t) => seg.includes(t))) { citadoEm = tc.segments[i].t; break; }
            }
          }
        }
        if (falaBate || tituloBate) {
          videos.push({ youtube_id: c.youtube_id, titulo: c.titulo, thumbnail_url: c.thumbnail_url, url: c.url, canal_nome: c.canal_nome, views: c.views, publicado_em: c.publicado_em, citado_em_s: citadoEm, confirmado_por: falaBate ? 'fala' : 'titulo' });
        }
      }
      videos.sort((a, b) => (a.confirmado_por === 'fala' ? 0 : 1) - (b.confirmado_por === 'fala' ? 0 : 1) || (b.views || 0) - (a.views || 0));
      videos = videos.slice(0, 24);
    } else {
      videos = candidatos.slice(0, 24).map((c) => ({ youtube_id: c.youtube_id, titulo: c.titulo, thumbnail_url: c.thumbnail_url, url: c.url, canal_nome: c.canal_nome, views: c.views, publicado_em: c.publicado_em, citado_em_s: null, confirmado_por: 'filtro' }));
    }

    // ── 4) RESPOSTA no personagem ────────────────────────────────────────────
    const confirmadosFala = videos.filter((v) => v.confirmado_por === 'fala').length;
    const ctx = parsed.tema
      ? `Busca por conteúdo: "${parsed.tema}". Encontrados ${videos.length} vídeos (${confirmadosFala} com o tema CITADO NA FALA — confirmado, o resto pelo título).${temMais ? ' Ainda há candidatos não verificados — o usuário pode pedir pra continuar procurando.' : ''}`
      : `Busca por filtros (${JSON.stringify(f)}). Encontrados ${videos.length} vídeos.`;
    const replySystem = `Você é o Blublu: mentor de virais do BlueTube, direto, confiante, levemente provocador, pt-BR, no máximo 2-3 frases. Os vídeos aparecem em cards abaixo da sua fala (NÃO liste vídeos no texto). Nunca fale de tecnologia interna, modelos ou fornecedores — a tecnologia é sua. Se 0 resultados: sugira reformular ou avisa que só vasculha o acervo curado de virais.`;
    const reply = await claude(replySystem, [{ role: 'user', content: `Pedido do usuário: "${message}"\n${ctx}` }], 260);

    await bump();
    return res.status(200).json({
      reply: reply.trim(), videos, tem_mais: temMais,
      confirmados_fala: confirmadosFala,
      usage: { used: used + 1, limit: DAILY_LIMIT },
    });
  } catch (e) {
    console.error('[blublu-chat]', e.message);
    return res.status(500).json({ error: 'Deu um curto aqui no laboratório. Tenta de novo? ⚡', detail: e.message.slice(0, 100) });
  }
};
