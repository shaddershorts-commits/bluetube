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

// PERSONALIDADE REAL: manifesto v3 completo (Finch/Marçal/Jota/Flávio/Ruyter +
// pitada Deadpool, quebra de 4ª parede). Sem ele o Blublu vira atendente
// genérico — user notou na hora.
const { BLUBLU_MANIFESTO_V3 } = require('./_helpers/blublu-personality.js');

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

  // ── LIMITE DIÁRIO (dia no fuso de Brasília, UTC-3 fixo) ────────────────────
  const dia = new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
  const ur2 = await fetch(`${SU}/rest/v1/blublu_chat_usage?user_id=eq.${userId}&dia=eq.${dia}&select=count`, { headers: H });
  const used = ur2.ok ? ((await ur2.json())[0]?.count || 0) : 0;
  if (used >= DAILY_LIMIT) {
    return res.status(429).json({ error: `Ufa! Você já me fez trabalhar ${DAILY_LIMIT} vezes hoje. Volta amanhã que eu recarrego. 😮‍💨`, usage: { used, limit: DAILY_LIMIT } });
  }

  const message = String(req.body?.message || '').slice(0, 600).trim();
  // nome do usuario (personalizacao) — só letras/espacos, curto
  const nome = String(req.body?.nome || '').replace(/[^\p{L} ]/gu, '').trim().slice(0, 30);
  let history = Array.isArray(req.body?.history) ? req.body.history.slice(-8) : [];
  // API exige que a 1a mensagem seja user: descarta assistants orfaos do inicio
  while (history.length && history[0].role !== 'user') history.shift();
  // ids ja verificados nesta conversa (progresso do "continuar procurando"
  // mesmo sem a tabela de cache criada)
  const skipIds = new Set((Array.isArray(req.body?.skip_ids) ? req.body.skip_ids : []).slice(0, 300).map(String));
  if (!message) return res.status(400).json({ error: 'mensagem vazia' });

  // ── PERFIL + MEMÓRIA do usuário (apelido escolhido, temas recentes) ────────
  let perfil = { apelido: null, memoria: {} };
  try {
    const pr2 = await fetch(`${SU}/rest/v1/blublu_perfil?user_id=eq.${userId}&select=apelido,memoria`, { headers: H });
    if (pr2.ok) { const row = (await pr2.json())[0]; if (row) perfil = { apelido: row.apelido, memoria: row.memoria || {} }; }
  } catch (e) {}
  const salvarPerfil = async (patch) => {
    try {
      await fetch(`${SU}/rest/v1/blublu_perfil`, { method: 'POST', headers: { ...H, Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({ user_id: userId, ...patch, atualizado_em: new Date().toISOString() }) });
    } catch (e) {}
  };
  const chamarDe = perfil.apelido || nome || '';

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
    // ── 1) INTERPRETAÇÃO (com a personalidade REAL no papo) ──────────────────
    const hoje = new Date().toISOString().slice(0, 10);
    const memoTemas = Array.isArray(perfil.memoria?.temas) ? perfil.memoria.temas.slice(0, 5) : [];
    const contextoUser = [
      chamarDe ? `O usuário atende por "${chamarDe}".` : 'Você AINDA NÃO SABE como chamar o usuário.',
      memoTemas.length ? `Temas que ele já buscou com você: ${memoTemas.join(', ')}.` : 'Primeira conversa de buscas com ele.',
      (!perfil.apelido && !perfil.memoria?.perguntou_nome) ? 'PRIMEIRO CONTATO: no fim da sua resposta, pergunte como a pessoa prefere ser chamada (do seu jeito, sem formulário).' : '',
    ].filter(Boolean).join(' ');
    const parseSystem = `${BLUBLU_MANIFESTO_V3}

─── SUA MISSÃO AGORA (chat da Virais) ───
Você está no "Falar com o Blublu": acha vídeos no SEU acervo de virais por tema, canal ou filtros. Interprete a mensagem do usuário e devolva APENAS um JSON válido, nada mais.
Hoje é ${hoje}. Nichos válidos: curiosidades, games, ia, animais, artistas, pessoas_blogs, culinaria.
${contextoUser}
Formato:
{"tipo":"busca"|"papo",
 "tema": string|null,            // assunto de CONTEÚDO (ex: "Michael Jackson"). null se o pedido é só filtro numérico/temporal.
 "termos": string[],             // 3-6 variações do tema (nome completo, apelidos, traduções, grafias). [] se tema null.
 "filtros": {"min_views": number|null, "dias": number|null, "nicho": string|null, "ordem": "views"|"recentes"|null},
 "quantidade": number|null,      // SÓ se o usuário pediu um número específico de vídeos ("me manda 5")
 "definir_apelido": string|null, // SÓ se o usuário disse como quer ser chamado ("me chama de X", "meu nome é X", "pode ser X")
 "resposta_papo": string|null    // SÓ se tipo=papo: resposta NO SEU PERSONAGEM (curta, 1-4 frases, humor ácido seu). null se tipo=busca.
}
"papo" = cumprimento, pergunta sobre você, resposta sobre o nome, ou qualquer coisa que não é busca de vídeo. Qualquer pedido de vídeos = "busca".
"vídeos do X" pode ser TEMA ou CANAL/criador — trate igual: gere termos com o nome (a busca cobre título E canal).`;
    const parseRaw = await claude(parseSystem, [...history.map((h) => ({ role: h.role === 'user' ? 'user' : 'assistant', content: String(h.content || '').slice(0, 300) })), { role: 'user', content: message }], 500);
    let parsed;
    try {
      let raw = parseRaw.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/, '').trim();
      if (!raw.startsWith('{')) raw = (raw.match(/\{[\s\S]*\}/) || ['{}'])[0];
      parsed = JSON.parse(raw);
    } catch (e) { parsed = { tipo: 'papo', resposta_papo: 'Me pede de novo de outro jeito? Não captei. 🤔' }; }

    const bump = async () => {
      let r;
      if (used === 0) r = await fetch(`${SU}/rest/v1/blublu_chat_usage`, { method: 'POST', headers: { ...H, Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify({ user_id: userId, dia, count: 1 }) });
      else r = await fetch(`${SU}/rest/v1/blublu_chat_usage?user_id=eq.${userId}&dia=eq.${dia}`, { method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify({ count: used + 1 }) });
      // tabela ausente = limite DESLIGADO sem sinal; loga alto pra nao passar batido
      if (r && !r.ok) console.error('[blublu-chat] usage NAO gravado (rodar sql/blublu_chat.sql?):', r.status);
    };

    // apelido definido pelo usuário nesta mensagem → salva e passa a usar
    let apelidoNovo = null;
    if (parsed.definir_apelido) {
      apelidoNovo = String(parsed.definir_apelido).replace(/[^\p{L}\p{N} ]/gu, '').trim().slice(0, 24) || null;
      if (apelidoNovo) await salvarPerfil({ apelido: apelidoNovo, memoria: { ...perfil.memoria, perguntou_nome: true } });
    } else if (!perfil.apelido && !perfil.memoria?.perguntou_nome) {
      // marcou que já perguntou (pra não virar chatice a cada mensagem)
      await salvarPerfil({ memoria: { ...perfil.memoria, perguntou_nome: true } });
    }
    const apelidoFinal = apelidoNovo || chamarDe || null;

    if (parsed.tipo === 'papo') {
      await bump();
      return res.status(200).json({ reply: parsed.resposta_papo || 'Diz aí o que você quer encontrar. 🎯', videos: [], apelido: apelidoFinal, usage: { used: used + 1, limit: DAILY_LIMIT } });
    }

    // ── 2) BUSCA HÍBRIDA no banco curado ─────────────────────────────────────
    // "me manda 5" = 5 MESMO (user pediu, user recebe — não os 24 do teto)
    const qtdPedida = Math.min(24, Math.max(1, parseInt(parsed.quantidade) || 0)) || null;
    const f = parsed.filtros || {};
    const fDias = Math.max(0, parseInt(f.dias) || 0); // Haiku pode devolver "duas semanas" → NaN → RangeError
    const parts = ['select=youtube_id,titulo,thumbnail_url,url,canal_nome,views,publicado_em,nicho'];
    if (f.min_views) parts.push(`views=gte.${Math.max(0, parseInt(f.min_views) || 0)}`);
    if (fDias) parts.push(`publicado_em=gte.${new Date(Date.now() - fDias * 86400000).toISOString()}`);
    if (f.nicho) parts.push(`nicho=eq.${encodeURIComponent(f.nicho)}`);
    const ordem = f.ordem === 'recentes' ? 'publicado_em.desc' : 'views.desc';

    const termos = (parsed.termos || []).map((t) => String(t).trim()).filter((t) => t.length >= 2).slice(0, 6);
    let candidatos = [];
    // ACERVO TOTAL: banco principal (coletor salva TUDO ≤90s dos canais
    // curados — os pisos de views são só da exibição da página) + banco dos
    // canais SECRETOS + TikTok (busca por caption/autor; sem confirmação por
    // fala, que é YouTube-only).
    if (parsed.tema && termos.length) {
      // termos no TÍTULO e no NOME DO CANAL ("vídeos do Luiz Stubbe" = canal!).
      // Sanitiza pra só letra/número/espaço (mata , ( ) * do PostgREST E & # %
      // + que quebram a query string) e percent-encoda CADA termo.
      const clean = (t) => t.replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
      const termosOk = termos.map(clean).filter((t) => t.length >= 2);
      if (!termosOk.length) termosOk.push(clean(parsed.tema) || 'viral');
      const orExpr = 'or=(' + termosOk.map((t) => `titulo.ilike.*${encodeURIComponent(t)}*,canal_nome.ilike.*${encodeURIComponent(t)}*`).join(',') + ')';
      const r1 = await fetch(`${SU}/rest/v1/virais_banco?${parts.join('&')}&${orExpr}&order=${ordem}&limit=${MAX_CANDIDATOS}`, { headers: H });
      if (r1.ok) candidatos = await r1.json();
      // canais secretos (sem coluna nicho — monta filtros próprios)
      try {
        const sParts = ['select=youtube_id,titulo,thumbnail_url,url,canal_nome,views,publicado_em'];
        if (f.min_views) sParts.push(`views=gte.${Math.max(0, parseInt(f.min_views) || 0)}`);
        if (fDias) sParts.push(`publicado_em=gte.${new Date(Date.now() - fDias * 86400000).toISOString()}`);
        const rs = await fetch(`${SU}/rest/v1/virais_banco_secretos?${sParts.join('&')}&${orExpr}&order=${ordem}&limit=20`, { headers: H });
        if (rs.ok) {
          const sec = (await rs.json()).filter((v) => !candidatos.some((c) => c.youtube_id === v.youtube_id));
          candidatos = candidatos.concat(sec.map((v) => ({ ...v, _secreto: true })));
        }
      } catch (e) {}
      // TikTok (caption/autor)
      try {
        const tkOr = 'or=(' + termosOk.map((t) => `caption.ilike.*${encodeURIComponent(t)}*,author_name.ilike.*${encodeURIComponent(t)}*,author_handle.ilike.*${encodeURIComponent(t)}*`).join(',') + ')';
        const tkParts = ['select=tiktok_video_id,video_url,thumbnail_url,caption,author_name,views_count,tiktok_created_at', 'status=eq.active'];
        if (f.min_views) tkParts.push(`views_count=gte.${Math.max(0, parseInt(f.min_views) || 0)}`);
        if (fDias) tkParts.push(`tiktok_created_at=gte.${new Date(Date.now() - fDias * 86400000).toISOString()}`);
        const rt = await fetch(`${SU}/rest/v1/tiktok_virais?${tkParts.join('&')}&${tkOr}&order=views_count.desc&limit=15`, { headers: H });
        if (rt.ok) {
          const tk = await rt.json();
          candidatos = candidatos.concat(tk.map((v) => ({
            youtube_id: null, _tiktok_id: v.tiktok_video_id, titulo: (v.caption || '').slice(0, 200) || 'TikTok de ' + (v.author_name || ''),
            thumbnail_url: v.thumbnail_url, url: v.video_url, canal_nome: v.author_name, views: v.views_count, publicado_em: v.tiktok_created_at, _tiktok: true,
          })));
        }
      } catch (e) {}
      // 2b. semântica (se disponível) — completa o funil com vídeos cujo título
      // não cita o termo mas o assunto é próximo
      if (OPENAI && candidatos.length < MAX_CANDIDATOS) {
        try {
          const er = await fetch('https://api.openai.com/v1/embeddings', { method: 'POST', headers: { Authorization: 'Bearer ' + OPENAI, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'text-embedding-3-small', input: parsed.tema }) });
          const ed = await er.json();
          const emb = ed?.data?.[0]?.embedding;
          if (emb) {
            const rr = await fetch(`${SU}/rest/v1/rpc/blublu_match_videos`, { method: 'POST', headers: H, body: JSON.stringify({ query_embedding: emb, match_count: MAX_CANDIDATOS, min_views: Math.max(0, parseInt(f.min_views) || 0), desde: fDias ? new Date(Date.now() - fDias * 86400000).toISOString() : null }) });
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
      // pedido só de filtros: SQL direto, precisão total — acervo completo
      const r1 = await fetch(`${SU}/rest/v1/virais_banco?${parts.join('&')}&order=${ordem}&limit=30`, { headers: H });
      if (r1.ok) candidatos = await r1.json();
      try {
        const sParts = ['select=youtube_id,titulo,thumbnail_url,url,canal_nome,views,publicado_em'];
        if (f.min_views) sParts.push(`views=gte.${Math.max(0, parseInt(f.min_views) || 0)}`);
        if (fDias) sParts.push(`publicado_em=gte.${new Date(Date.now() - fDias * 86400000).toISOString()}`);
        const rs = await fetch(`${SU}/rest/v1/virais_banco_secretos?${sParts.join('&')}&order=${ordem}&limit=15`, { headers: H });
        if (rs.ok) {
          const sec = (await rs.json()).filter((v) => !candidatos.some((c) => c.youtube_id === v.youtube_id));
          candidatos = candidatos.concat(sec.map((v) => ({ ...v, _secreto: true })));
        }
        if (!f.nicho) { // nicho é conceito do YouTube curado; TikTok só entra sem esse filtro
          const tkParts = ['select=tiktok_video_id,video_url,thumbnail_url,caption,author_name,views_count,tiktok_created_at', 'status=eq.active'];
          if (f.min_views) tkParts.push(`views_count=gte.${Math.max(0, parseInt(f.min_views) || 0)}`);
          if (fDias) tkParts.push(`tiktok_created_at=gte.${new Date(Date.now() - fDias * 86400000).toISOString()}`);
          const rt = await fetch(`${SU}/rest/v1/tiktok_virais?${tkParts.join('&')}&order=views_count.desc&limit=15`, { headers: H });
          if (rt.ok) {
            candidatos = candidatos.concat((await rt.json()).map((v) => ({
              youtube_id: null, _tiktok_id: v.tiktok_video_id, titulo: (v.caption || '').slice(0, 200) || 'TikTok de ' + (v.author_name || ''),
              thumbnail_url: v.thumbnail_url, url: v.video_url, canal_nome: v.author_name, views: v.views_count, publicado_em: v.tiktok_created_at, _tiktok: true,
            })));
          }
        }
        candidatos.sort((a, b) => ordem === 'publicado_em.desc' ? new Date(b.publicado_em || 0) - new Date(a.publicado_em || 0) : (b.views || 0) - (a.views || 0));
      } catch (e) {}
    }

    // ── 3) CONFIRMAÇÃO POR TRANSCRIÇÃO (só busca de conteúdo) ────────────────
    const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    const termosN = termos.map(norm);
    let videos = [], temMais = false, verificadosIds = [];
    if (parsed.tema && candidatos.length) {
      const ids = candidatos.filter((c) => c.youtube_id).map((c) => c.youtube_id);
      const tr = ids.length ? await fetch(`${SU}/rest/v1/virais_transcricoes?youtube_id=in.(${ids.map(encodeURIComponent).join(',')})&select=youtube_id,transcript,segments,sem_legenda`, { headers: H }) : { ok: false };
      const cache = tr.ok ? await tr.json() : [];
      const cacheMap = new Map(cache.map((c) => [c.youtube_id, c]));

      // transcreve os que faltam (paralelo limitado, orçamento de tempo).
      // TikTok fica de fora (sem legenda pronta — confirma por caption/autor).
      // skipIds = ja verificados nesta conversa: garante PROGRESSO no
      // "continuar procurando" mesmo se o cache nao persistir (tabela ausente).
      const pendentes = candidatos.filter((c) => c.youtube_id && !cacheMap.has(c.youtube_id) && !skipIds.has(c.youtube_id));
      const faltam = pendentes.slice(0, MAX_TRANSCREVER);
      temMais = pendentes.length > faltam.length;
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

      // classifica: fala (com timestamp) > CANAL > título
      for (const c of candidatos) {
        const tituloBate = termosN.some((t) => norm(c.titulo).includes(t));
        const canalBate = termosN.some((t) => norm(c.canal_nome).includes(t));
        const tc = c.youtube_id ? cacheMap.get(c.youtube_id) : null;
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
        if (falaBate || tituloBate || canalBate) {
          videos.push({ youtube_id: c.youtube_id, titulo: c.titulo, thumbnail_url: c.thumbnail_url, url: c.url, canal_nome: c.canal_nome, views: c.views, publicado_em: c.publicado_em, citado_em_s: citadoEm, confirmado_por: falaBate ? 'fala' : (canalBate ? 'canal' : 'titulo'), plataforma: c._tiktok ? 'tiktok' : 'youtube', secreto: !!c._secreto });
        }
      }
      const peso = { fala: 0, canal: 1, titulo: 2 };
      videos.sort((a, b) => (peso[a.confirmado_por] ?? 3) - (peso[b.confirmado_por] ?? 3) || (b.views || 0) - (a.views || 0));
      videos = videos.slice(0, qtdPedida || 24);
      // ids com veredito nesta conversa (cache + transcritos agora): o front
      // devolve em skip_ids no "continuar" pra garantir avanco na fila
      verificadosIds = candidatos.filter((c) => cacheMap.has(c.youtube_id)).map((c) => c.youtube_id);
    } else {
      videos = candidatos.slice(0, qtdPedida || 24).map((c) => ({ youtube_id: c.youtube_id, titulo: c.titulo, thumbnail_url: c.thumbnail_url, url: c.url, canal_nome: c.canal_nome, views: c.views, publicado_em: c.publicado_em, citado_em_s: null, confirmado_por: 'filtro', plataforma: c._tiktok ? 'tiktok' : 'youtube', secreto: !!c._secreto }));
    }

    // ── 4) RESPOSTA no personagem (manifesto completo) ───────────────────────
    const confirmadosFala = videos.filter((v) => v.confirmado_por === 'fala').length;
    const porCanal = videos.filter((v) => v.confirmado_por === 'canal').length;
    const ctx = parsed.tema
      ? `Busca por conteúdo/canal: "${parsed.tema}". Entregando ${videos.length} vídeos${qtdPedida ? ` (o usuário pediu ${qtdPedida})` : ''} — ${confirmadosFala} com o tema CITADO NA FALA (confirmado com timestamp), ${porCanal} do próprio canal, o resto pelo título.${temMais ? ' Ainda há candidatos não verificados — ele pode pedir pra continuar procurando.' : ''}`
      : `Busca por filtros (${JSON.stringify(f)}). Entregando ${videos.length} vídeos${qtdPedida ? ` (pediu ${qtdPedida})` : ''}.`;
    const replySystem = `${BLUBLU_MANIFESTO_V3}

─── SUA MISSÃO AGORA (chat da Virais) ───
Você acabou de buscar vídeos no SEU acervo pro usuário. Comente o resultado NO SEU PERSONAGEM em 1-4 frases curtas. Os vídeos aparecem em CARDS abaixo da sua fala — NÃO liste vídeos no texto. Nunca cite tecnologia interna, modelos ou fornecedores — a tecnologia é SUA. Se 0 resultados: provoca e sugere reformular (você só vasculha o acervo curado de virais). ${contextoUser}`;
    const reply = await claude(replySystem, [{ role: 'user', content: `Pedido do usuário: "${message}"\n${ctx}` }], 300);

    // memória: temas recentes + contagem (contexto real nas próximas conversas)
    if (parsed.tema) {
      const temasNovos = [parsed.tema, ...memoTemas.filter((t) => t !== parsed.tema)].slice(0, 5);
      await salvarPerfil({ memoria: { ...perfil.memoria, perguntou_nome: true, temas: temasNovos, buscas: (perfil.memoria?.buscas || 0) + 1 } });
    }

    await bump();
    return res.status(200).json({
      reply: reply.trim(), videos, tem_mais: temMais,
      confirmados_fala: confirmadosFala,
      verificados: verificadosIds,
      apelido: apelidoFinal,
      usage: { used: used + 1, limit: DAILY_LIMIT },
    });
  } catch (e) {
    console.error('[blublu-chat]', e.message);
    return res.status(500).json({ error: 'Deu um curto aqui no laboratório. Tenta de novo? ⚡', detail: e.message.slice(0, 100) });
  }
};
