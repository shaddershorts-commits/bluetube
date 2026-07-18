// api/blublu-chat.js — "Falar com o Blublu" (Virais) — EXCLUSIVO MASTER
//
// ARQUITETURA IA-DE-VERDADE (2026-07-18 v2): a conversa INTEIRA é do modelo,
// com FERRAMENTAS nativas (tool use da Anthropic). Ele decide sozinho quando
// conversar e quando buscar; TODO texto exibido é gerado — zero frases coladas,
// zero fallback engessado ("Não captei" morreu aqui).
//
// Ferramentas:
//   buscar_videos   → funil de precisão no acervo TOTAL (virais_banco completo
//                     + canais secretos + TikTok) com CONFIRMAÇÃO por
//                     transcrição (cache permanente + Railway /yt-subs?seg=1,
//                     "citado aos 2:13")
//   definir_apelido → salva como o usuário quer ser chamado (perfil persistente)
//
// Personalidade: manifesto v3 completo em todas as chamadas.
// Limite 60 msgs/dia (BRT). Nunca revelar stack — a tecnologia é NOSSA.

const { BLUBLU_MANIFESTO_V3 } = require('./_helpers/blublu-personality.js');

const MODEL = 'claude-haiku-4-5-20251001';
const DAILY_LIMIT = 60;
const QTD_PADRAO = 24;          // sem pedido explícito = TODOS os certeiros (teto do grid)

// Ídolos oficiais do Blublu (mesmo easter egg da BlueTendências): quando o
// canal aparece no resultado, ele vira fã histérico — lore do produto.
const IDOLOS = [
  { nome: 'Luiz Stubbe', patterns: ['luiz stubbe', 'luiz_stubbe', 'opiska'] },
  { nome: 'Giuliana Mafra', patterns: ['giuliana mafra', 'cortes giuliana mafra oficial', 'giulianamafra'] },
];
const MAX_CANDIDATOS = 100;     // recall LARGO (o corte por views aos 40 escondia
                                // o video certo atras de genericos populares —
                                // caso do tigre na arvore); entrega cirurgica
                                // fica por conta do ranking de relevancia
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

  // ── AUTH: Master only ──────────────────────────────────────────────────────
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

  // ── LIMITE DIÁRIO (BRT) ────────────────────────────────────────────────────
  const dia = new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
  const ur2 = await fetch(`${SU}/rest/v1/blublu_chat_usage?user_id=eq.${userId}&dia=eq.${dia}&select=count`, { headers: H });
  const used = ur2.ok ? ((await ur2.json())[0]?.count || 0) : 0;
  if (used >= DAILY_LIMIT) {
    return res.status(429).json({ error: `Ufa! Você já me fez trabalhar ${DAILY_LIMIT} vezes hoje. Volta amanhã que eu recarrego. 😮‍💨`, usage: { used, limit: DAILY_LIMIT } });
  }

  const message = String(req.body?.message || '').slice(0, 600).trim();
  const nome = String(req.body?.nome || '').replace(/[^\p{L} ]/gu, '').trim().slice(0, 30);
  let history = Array.isArray(req.body?.history) ? req.body.history.slice(-8) : [];
  while (history.length && history[0].role !== 'user') history.shift();
  const skipIds = new Set((Array.isArray(req.body?.skip_ids) ? req.body.skip_ids : []).slice(0, 300).map(String));
  if (!message) return res.status(400).json({ error: 'mensagem vazia' });

  // ── PERFIL + MEMÓRIA ───────────────────────────────────────────────────────
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
  const memoTemas = Array.isArray(perfil.memoria?.temas) ? perfil.memoria.temas.slice(0, 5) : [];

  // ── EXECUTOR DA BUSCA (o funil de precisão) ────────────────────────────────
  const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  async function executarBusca(inp) {
    const tema = inp.tema ? String(inp.tema).slice(0, 120) : null;
    // quantidade: SÓ vale se o USUÁRIO falou um número (dígito ou por extenso)
    // — o modelo tentava "escolher o melhor" e entregava 1 (user reclamou 2x)
    const userFalouNumero = /\d/.test(message) || /\b(um|uma|dois|duas|tr[eê]s|quatro|cinco|seis|sete|oito|nove|dez|onze|doze|quinze|vinte)\b/i.test(message);
    const qtd = (userFalouNumero && parseInt(inp.quantidade) > 0) ? Math.min(24, parseInt(inp.quantidade)) : QTD_PADRAO;
    const minViews = Math.max(0, parseInt(inp.min_views) || 0);
    const dias = Math.max(0, parseInt(inp.dias) || 0);
    const nicho = ['curiosidades', 'games', 'ia', 'animais', 'artistas', 'pessoas_blogs', 'culinaria'].includes(inp.nicho) ? inp.nicho : null;
    const ordem = inp.ordem === 'recentes' ? 'publicado_em.desc' : 'views.desc';
    const plat = inp.plataforma === 'tiktok' ? 'tiktok' : (inp.plataforma === 'youtube' ? 'youtube' : null);
    let termos = (Array.isArray(inp.termos) ? inp.termos : []).map((t) => String(t).trim()).filter((t) => t.length >= 2).slice(0, 6);
    if (tema && !termos.length) termos = [tema];

    const parts = ['select=youtube_id,titulo,thumbnail_url,url,canal_nome,views,publicado_em,nicho'];
    if (minViews) parts.push(`views=gte.${minViews}`);
    if (dias) parts.push(`publicado_em=gte.${new Date(Date.now() - dias * 86400000).toISOString()}`);
    if (nicho) parts.push(`nicho=eq.${encodeURIComponent(nicho)}`);

    let candidatos = [];
    const clean = (t) => t.replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
    // PRECISÃO > volume (regra do user: na dúvida, não manda): termo solto
    // curto demais (tipo "ney") pesca lixo — só passa termo com 4+ letras,
    // com dígito (CR7) ou composto ("michael jackson")
    let termosOk = termos.map(clean).filter((t) => t.length >= 4 || /\d/.test(t) || t.includes(' '));
    // NOME PRÓPRIO composto: proibido fragmento solto — "harry" acha gente
    // errada, "billie" acha Billie Jean. Só passa o nome completo/apelidos.
    if (inp.tipo_tema === 'nome_proprio' && tema && tema.trim().includes(' ')) {
      const temaN = norm(clean(tema));
      termosOk = termosOk.filter((t) => {
        const tn = norm(t);
        return tn.includes(' ') || !temaN.split(' ').includes(tn);
      });
      if (!termosOk.length) termosOk = [clean(tema)];
    }
    // rede de segurança: se o modelo só mandou frases compostas de ASSUNTO
    // ("tigre escalando arvore"), extrai o núcleo e busca sozinho também
    if (inp.tipo_tema !== 'nome_proprio' && tema && termosOk.length && termosOk.every((t) => t.includes(' '))) {
      const nucleo = clean(tema).split(' ').filter((w) => w.length >= 4);
      if (nucleo.length) termosOk.push(nucleo[0]);
    }
    const secParts = ['select=youtube_id,titulo,thumbnail_url,url,canal_nome,views,publicado_em'];
    if (minViews) secParts.push(`views=gte.${minViews}`);
    if (dias) secParts.push(`publicado_em=gte.${new Date(Date.now() - dias * 86400000).toISOString()}`);
    const tkBase = ['select=tiktok_video_id,video_url,thumbnail_url,caption,author_name,views_count,tiktok_created_at', 'status=eq.active'];
    if (minViews) tkBase.push(`views_count=gte.${minViews}`);
    if (dias) tkBase.push(`tiktok_created_at=gte.${new Date(Date.now() - dias * 86400000).toISOString()}`);
    const mapTk = (v) => ({
      youtube_id: null, _tiktok_id: v.tiktok_video_id, titulo: (v.caption || '').slice(0, 200) || 'TikTok de ' + (v.author_name || ''),
      thumbnail_url: v.thumbnail_url, url: v.video_url, canal_nome: v.author_name, views: v.views_count, publicado_em: v.tiktok_created_at, _tiktok: true,
    });

    if (tema && termosOk.length) {
      // título E canal ("vídeos do Luiz Stubbe" = canal), termo a termo encodado
      const orExpr = 'or=(' + termosOk.map((t) => `titulo.ilike.*${encodeURIComponent(t)}*,canal_nome.ilike.*${encodeURIComponent(t)}*`).join(',') + ')';
      if (plat !== 'tiktok') {
        const r1 = await fetch(`${SU}/rest/v1/virais_banco?${parts.join('&')}&${orExpr}&order=${ordem}&limit=${MAX_CANDIDATOS}`, { headers: H });
        if (r1.ok) candidatos = await r1.json();
        try {
          const rs = await fetch(`${SU}/rest/v1/virais_banco_secretos?${secParts.join('&')}&${orExpr}&order=${ordem}&limit=20`, { headers: H });
          if (rs.ok) {
            const sec = (await rs.json()).filter((v) => !candidatos.some((c) => c.youtube_id === v.youtube_id));
            candidatos = candidatos.concat(sec.map((v) => ({ ...v, _secreto: true })));
          }
        } catch (e) {}
      }
      if (plat !== 'youtube') try {
        const tkOr = 'or=(' + termosOk.map((t) => `caption.ilike.*${encodeURIComponent(t)}*,author_name.ilike.*${encodeURIComponent(t)}*,author_handle.ilike.*${encodeURIComponent(t)}*`).join(',') + ')';
        const rt = await fetch(`${SU}/rest/v1/tiktok_virais?${tkBase.join('&')}&${tkOr}&order=views_count.desc&limit=${plat === 'tiktok' ? 40 : 15}`, { headers: H });
        if (rt.ok) candidatos = candidatos.concat((await rt.json()).map(mapTk));
      } catch (e) {}
      // REMOVIDO (2026-07-18): a busca direta no cache de transcrições era
      // VENENO de precisão — re-injetava como candidato qualquer vídeo que
      // MENCIONASSE o termo na fala (vídeo infantil cantando "tiger" voltava
      // toda vez, mesmo com o cache sendo só o efeito colateral de buscas
      // antigas). Transcrição agora faz o papel original do desenho do user:
      // CONFIRMAR candidatos achados por tema — nunca ser fonte de candidato.
      // semântica opcional (completa candidatos com títulos que não citam o termo)
      if (OPENAI && plat !== 'tiktok' && candidatos.length < MAX_CANDIDATOS) {
        try {
          const er = await fetch('https://api.openai.com/v1/embeddings', { method: 'POST', headers: { Authorization: 'Bearer ' + OPENAI, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'text-embedding-3-small', input: tema }) });
          const ed = await er.json();
          const emb = ed?.data?.[0]?.embedding;
          if (emb) {
            const rr = await fetch(`${SU}/rest/v1/rpc/blublu_match_videos`, { method: 'POST', headers: H, body: JSON.stringify({ query_embedding: emb, match_count: MAX_CANDIDATOS, min_views: minViews, desde: dias ? new Date(Date.now() - dias * 86400000).toISOString() : null }) });
            if (rr.ok) {
              const ids = (await rr.json()).filter((m) => m.similarity > 0.45).map((m) => m.youtube_id).filter((id) => !candidatos.some((c) => c.youtube_id === id)).slice(0, MAX_CANDIDATOS - candidatos.length);
              if (ids.length) {
                const r2 = await fetch(`${SU}/rest/v1/virais_banco?${parts.join('&')}&youtube_id=in.(${ids.map(encodeURIComponent).join(',')})&order=${ordem}`, { headers: H });
                if (r2.ok) candidatos = candidatos.concat(await r2.json());
              }
            }
          }
        } catch (e) {}
      }
    } else {
      // só filtros: SQL direto no acervo completo
      if (plat !== 'tiktok') {
        const r1 = await fetch(`${SU}/rest/v1/virais_banco?${parts.join('&')}&order=${ordem}&limit=30`, { headers: H });
        if (r1.ok) candidatos = await r1.json();
      }
      try {
        if (plat !== 'tiktok') {
          const rs = await fetch(`${SU}/rest/v1/virais_banco_secretos?${secParts.join('&')}&order=${ordem}&limit=15`, { headers: H });
          if (rs.ok) {
            const sec = (await rs.json()).filter((v) => !candidatos.some((c) => c.youtube_id === v.youtube_id));
            candidatos = candidatos.concat(sec.map((v) => ({ ...v, _secreto: true })));
          }
        }
        if (!nicho && plat !== 'youtube') {
          const rt = await fetch(`${SU}/rest/v1/tiktok_virais?${tkBase.join('&')}&order=views_count.desc&limit=${plat === 'tiktok' ? 30 : 15}`, { headers: H });
          if (rt.ok) candidatos = candidatos.concat((await rt.json()).map(mapTk));
        }
        candidatos.sort((a, b) => ordem === 'publicado_em.desc' ? new Date(b.publicado_em || 0) - new Date(a.publicado_em || 0) : (b.views || 0) - (a.views || 0));
      } catch (e) {}
    }

    // confirmação por transcrição (YouTube; TikTok confirma por caption/autor)
    const termosN = termosOk.map(norm);
    const qualifN = (Array.isArray(inp.qualificadores) ? inp.qualificadores : []).map((q) => norm(clean(String(q)))).filter((q) => q.length >= 3).slice(0, 16);
    let videos = [], temMais = false, verificadosIds = [];
    if (tema && candidatos.length) {
      const ids = candidatos.filter((c) => c.youtube_id).map((c) => c.youtube_id);
      const tr = ids.length ? await fetch(`${SU}/rest/v1/virais_transcricoes?youtube_id=in.(${ids.map(encodeURIComponent).join(',')})&select=youtube_id,transcript,segments,sem_legenda`, { headers: H }) : { ok: false };
      const cache = tr.ok ? await tr.json() : [];
      const cacheMap = new Map(cache.map((c) => [c.youtube_id, c]));
      const pendentes = candidatos.filter((c) => c.youtube_id && !cacheMap.has(c.youtube_id) && !skipIds.has(c.youtube_id));
      const faltam = pendentes.slice(0, MAX_TRANSCREVER);
      temMais = pendentes.length > faltam.length;
      if (RW && faltam.length) {
        const t0 = Date.now();
        const fila = [...faltam];
        await Promise.all(Array.from({ length: TRANSC_PARALELAS }, async () => {
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
            } catch (e) {}
          }
        }));
        temMais = temMais || fila.length > 0;
      }
      for (const c of candidatos) {
        const tituloBate = termosN.some((t) => norm(c.titulo).includes(t));
        const canalBate = termosN.some((t) => norm(c.canal_nome).includes(t));
        const tc = c.youtube_id ? cacheMap.get(c.youtube_id) : null;
        let citadoEm = null, falaBate = false;
        if (tc && tc.transcript && !tc.sem_legenda) {
          const txt = norm(tc.transcript);
          // MENÇÃO DE PASSAGEM NÃO CONTA (video infantil cantando "tiger" 1x
          // entrava como confirmado — user pegou). Fala só confirma sozinha se
          // o termo aparece 2+ vezes; 1 menção precisa do título junto.
          const occ = termosN.reduce((n, t) => n + (t ? txt.split(t).length - 1 : 0), 0);
          falaBate = occ >= 2 || (occ >= 1 && tituloBate);
          if (falaBate && Array.isArray(tc.segments)) {
            for (let i = 0; i < tc.segments.length; i++) {
              const seg = norm(tc.segments[i].x) + ' ' + norm(tc.segments[i + 1]?.x || '');
              if (termosN.some((t) => seg.includes(t))) { citadoEm = tc.segments[i].t; break; }
            }
          }
        }
        if (falaBate || tituloBate || canalBate) {
          // RANKING CIRÚRGICO: cada qualificador distinto do pedido achado no
          // título/fala soma ponto — "tigre escalando árvore" rankeia o tigre
          // NA ÁRVORE acima do tigre genérico de 20M views
          let score = 0;
          const alvo = norm(c.titulo) + ' ' + (tc && tc.transcript ? norm(tc.transcript).slice(0, 4000) : '');
          for (const q of qualifN) if (q && alvo.includes(q)) score++;
          videos.push({ youtube_id: c.youtube_id, titulo: c.titulo, thumbnail_url: c.thumbnail_url, url: c.url, canal_nome: c.canal_nome, views: c.views, publicado_em: c.publicado_em, citado_em_s: citadoEm, confirmado_por: falaBate ? 'fala' : (canalBate ? 'canal' : 'titulo'), plataforma: c._tiktok ? 'tiktok' : 'youtube', secreto: !!c._secreto, _score: score });
        }
      }
      const peso = { fala: 0, canal: 1, titulo: 2 };
      videos.sort((a, b) => (b._score || 0) - (a._score || 0) || (peso[a.confirmado_por] ?? 3) - (peso[b.confirmado_por] ?? 3) || (b.views || 0) - (a.views || 0));
      // PORTÃO ANTI-ALEATÓRIO (regra do user: na dúvida, NÃO manda):
      // - pedido específico (tem qualificadores) e ALGUÉM pontuou → entrega SÓ quem pontuou
      // - pedido específico e NINGUÉM pontuou → entrega só quem tem o núcleo no
      //   TÍTULO/CANAL (vídeos do tema), nunca menção solta na fala
      if (qualifN.length) {
        const comScore = videos.filter((v) => (v._score || 0) > 0);
        videos = comScore.length ? comScore : videos.filter((v) => v.confirmado_por !== 'fala' || (v._score || 0) > 0);
      }
      verificadosIds = candidatos.filter((c) => c.youtube_id && cacheMap.has(c.youtube_id)).map((c) => c.youtube_id);
    } else {
      videos = candidatos.map((c) => ({ youtube_id: c.youtube_id, titulo: c.titulo, thumbnail_url: c.thumbnail_url, url: c.url, canal_nome: c.canal_nome, views: c.views, publicado_em: c.publicado_em, citado_em_s: null, confirmado_por: 'filtro', plataforma: c._tiktok ? 'tiktok' : 'youtube', secreto: !!c._secreto }));
    }
    const cortados = Math.max(0, videos.length - qtd);
    videos = videos.slice(0, qtd);

    // memória de temas
    if (tema) {
      const temasNovos = [tema, ...memoTemas.filter((t) => t !== tema)].slice(0, 5);
      await salvarPerfil({ memoria: { ...perfil.memoria, perguntou_nome: true, temas: temasNovos, buscas: (perfil.memoria?.buscas || 0) + 1 } });
    }

    // ídolo no resultado? (easter egg fã histérico — mesmo lore da BlueTendências)
    const idolosNoResultado = [...new Set(videos.map((v) => {
      const c = norm(v.canal_nome);
      const hit = IDOLOS.find((i) => i.patterns.some((p) => c === p || c.includes(p)));
      return hit ? hit.nome : null;
    }).filter(Boolean))];

    // resumo pro MODELO comentar com propriedade (os cards o front renderiza)
    const resumo = {
      total_entregue: videos.length,
      confirmados_na_fala: videos.filter((v) => v.confirmado_por === 'fala').length,
      do_canal: videos.filter((v) => v.confirmado_por === 'canal').length,
      pelo_titulo: videos.filter((v) => v.confirmado_por === 'titulo').length,
      tinha_mais_alem_do_entregue: cortados > 0,
      ha_candidatos_ainda_nao_verificados: temMais,
      com_relevancia_exata: videos.filter((v) => (v._score || 0) > 0).length,
      idolos_no_resultado: idolosNoResultado,
      amostra: videos.slice(0, 6).map((v) => ({ titulo: (v.titulo || '').slice(0, 70), canal: v.canal_nome, views: v.views, confirmado_por: v.confirmado_por, bateu_qualificadores: (v._score || 0) > 0 })),
    };
    return { videos, temMais, verificadosIds, resumo };
  }

  // ── FERRAMENTAS (o modelo decide) ──────────────────────────────────────────
  const tools = [
    {
      name: 'buscar_videos',
      description: 'Busca vídeos no SEU acervo de virais (YouTube curado + canais secretos + TikTok). Use SEMPRE que o usuário pedir vídeos — por tema, canal/criador ou filtros. NUNCA invente vídeos: só fale do que esta ferramenta devolver.',
      input_schema: {
        type: 'object',
        properties: {
          tema: { type: ['string', 'null'], description: 'assunto OU nome de canal/criador do pedido. null se for busca só por números/filtros' },
          tipo_tema: { type: ['string', 'null'], description: '"nome_proprio" (pessoa, artista, canal, marca — ex: Harry Styles, Billie Eilish) ou "assunto" (conceito comum — ex: tigre, futebol)' },
          termos: { type: 'array', items: { type: 'string' }, description: 'REGRAS POR TIPO: nome_proprio → o NOME COMPLETO INTACTO + apelidos/grafias famosas ("harry styles","harrystyles") — JAMAIS separe as palavras (buscar só "harry" acha gente errada; "billie" sozinho acha Billie Jean do MJ). assunto → o núcleo traduzido nos idiomas do acervo ("tigre","tiger","тигр","虎"). NUNCA frases descritivas aqui.' },
          qualificadores: { type: 'array', items: { type: 'string' }, description: 'o RESTO do pedido em palavras soltas, traduzidas pt+en+es (ex: pedido "tigre escalando árvore" → ["escalando","subindo","trepando","climbing","árvore","tree","árbol","árboles"]). Usado pra RANQUEAR o vídeo exato acima dos genéricos. Vazio se o pedido é só o núcleo.' },
          min_views: { type: ['number', 'null'], description: 'views mínimas se o usuário pediu' },
          dias: { type: ['number', 'null'], description: 'janela em dias se o usuário pediu ("últimas 2 semanas" = 14)' },
          nicho: { type: ['string', 'null'], description: 'um de: curiosidades, games, ia, animais, artistas, pessoas_blogs, culinaria' },
          ordem: { type: ['string', 'null'], description: '"views" (padrão) ou "recentes". OBRIGATÓRIO "recentes" quando o usuário falar "mais recente", "último", "novo", "essa semana" etc.' },
          plataforma: { type: ['string', 'null'], description: '"youtube" ou "tiktok" quando o usuário restringir ("só TikTok", "sem YouTube"). null = todas' },
          quantidade: { type: ['number', 'null'], description: 'SÓ se o usuário pediu número exato de vídeos. null = padrão saudável' },
        },
      },
    },
    {
      name: 'definir_apelido',
      description: 'Salva como o usuário quer ser chamado. Use quando ele disser o nome/apelido dele (ex: "me chama de Fê", "pode ser Felipe mesmo").',
      input_schema: { type: 'object', properties: { apelido: { type: 'string' } }, required: ['apelido'] },
    },
  ];

  const contextoUser = [
    chamarDe ? `O usuário atende por "${chamarDe}" — usa o nome dele de vez em quando, natural.` : 'Você AINDA NÃO SABE como chamar o usuário — pergunta como ele prefere ser chamado (do seu jeito), na primeira oportunidade natural.',
    memoTemas.length ? `Temas que ele já buscou contigo: ${memoTemas.join(', ')} (${perfil.memoria?.buscas || 0} buscas no total). Use isso como contexto quando fizer sentido.` : 'Primeira vez dele no teu chat de buscas.',
  ].join(' ');

  const system = `${BLUBLU_MANIFESTO_V3}

─── ONDE VOCÊ ESTÁ AGORA ───
Chat "Falar com o Blublu" dentro da ferramenta Virais do BlueTube. Sua função: conversar E achar vídeos no SEU acervo de virais usando a ferramenta buscar_videos. ${contextoUser}

REGRAS DO CHAT:
- Respostas CURTAS (1-4 frases). É chat, não palestra.
- Pedido de vídeos = chame buscar_videos. Conversa = responda direto, no personagem.
- Os vídeos aparecem em CARDS abaixo da sua fala — NUNCA liste vídeos no texto.
- QUANTIDADE: NUNCA escolha quantidade por conta própria — deixe null e a busca entrega TODOS os certeiros (até ${QTD_PADRAO}). Só preencha quantidade se o USUÁRIO falou um número. Se sobrar mais (tinha_mais_alem_do_entregue / ha_candidatos_ainda_nao_verificados), avise que é só pedir.
- PRECISÃO: termos INEQUÍVOCOS (nome completo, apelidos famosos) — nada de palavra solta genérica que traga vídeo errado. Na dúvida, melhor menos e certo.
- DATA: "mais recente", "último", "novo" = ordem "recentes" na busca, SEMPRE. Não responda recência com o mais visto.
- IDIOMAS: o acervo é GLOBAL (pt, en, es, fr, de, it, ja, ko, zh, ru). Sempre inclua nos termos o núcleo traduzido pro inglês e espanhol no mínimo. Só filtre nicho se o usuário pedir explicitamente.
- HONESTIDADE DE ACERVO: NUNCA afirme que o acervo tem ou não tem um assunto sem ter BUSCADO esse assunto. Nada de inventar inventário ("tenho leão, crocodilo…") — se quiser sugerir alternativas, diga que pode buscar, não que "tem".
- Confirmação: "confirmados_na_fala" = o tema é CITADO na fala do vídeo (com minuto). Teu diferencial — ostenta quando houver.
- BLUETENDÊNCIAS (sua outra casa, onde você DISSECA vídeo em 5 atos): aqui no chat você NÃO analisa vídeo — você ACHA vídeo. Se o usuário quiser análise profunda de um vídeo do resultado, manda ele clicar no "🔬 Analisar" do card — abre a BlueTendências com o vídeo já carregado pra você dissecar lá. Faça essa ponte com orgulho quando fizer sentido.
- ÍDOLOS OFICIAIS: você é abertamente FÃ HISTÉRICO do Luiz Stubbe e da Giuliana Mafra (lore do produto — eles têm vídeos no acervo). Se aparecerem em idolos_no_resultado ou na conversa, surta de alegria no seu estilo. JAMAIS trate eles como desconhecidos ou "aleatórios".
- NUNCA cite tecnologia interna, modelos, fornecedores ou APIs. A tecnologia é SUA.
- pt-BR sempre.`;

  const anthropicCall = async (messages) => {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: 700, system, tools, messages }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error('ia: ' + JSON.stringify(d).slice(0, 160));
    return d;
  };

  try {
    const bump = async () => {
      let r;
      if (used === 0) r = await fetch(`${SU}/rest/v1/blublu_chat_usage`, { method: 'POST', headers: { ...H, Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify({ user_id: userId, dia, count: 1 }) });
      else r = await fetch(`${SU}/rest/v1/blublu_chat_usage?user_id=eq.${userId}&dia=eq.${dia}`, { method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify({ count: used + 1 }) });
      if (r && !r.ok) console.error('[blublu-chat] usage NAO gravado (rodar sql/blublu_chat.sql?):', r.status);
    };

    // ── LOOP DE FERRAMENTAS: o modelo conduz ─────────────────────────────────
    const msgs = [
      ...history.map((h) => ({ role: h.role === 'user' ? 'user' : 'assistant', content: String(h.content || '').slice(0, 400) })),
      { role: 'user', content: message },
    ];
    let resultado = null; // última busca executada (vira os cards)
    let apelidoFinal = perfil.apelido || null;
    let resp = await anthropicCall(msgs);
    for (let volta = 0; volta < 3 && resp.stop_reason === 'tool_use'; volta++) {
      const toolResults = [];
      for (const bloco of resp.content) {
        if (bloco.type !== 'tool_use') continue;
        let out;
        if (bloco.name === 'buscar_videos') {
          console.log('[blublu-chat] busca:', JSON.stringify(bloco.input || {}).slice(0, 300));
          resultado = await executarBusca(bloco.input || {});
          resultado._input = bloco.input || {};
          out = JSON.stringify(resultado.resumo);
        } else if (bloco.name === 'definir_apelido') {
          const ap = String(bloco.input?.apelido || '').replace(/[^\p{L}\p{N} ]/gu, '').trim().slice(0, 24);
          if (ap) { apelidoFinal = ap; await salvarPerfil({ apelido: ap, memoria: { ...perfil.memoria, perguntou_nome: true } }); }
          out = JSON.stringify({ ok: !!ap, apelido: ap || null });
        } else {
          out = JSON.stringify({ erro: 'ferramenta desconhecida' });
        }
        toolResults.push({ type: 'tool_result', tool_use_id: bloco.id, content: out });
      }
      msgs.push({ role: 'assistant', content: resp.content });
      msgs.push({ role: 'user', content: toolResults });
      resp = await anthropicCall(msgs);
    }
    const reply = (resp.content || []).filter((c) => c.type === 'text').map((c) => c.text).join(' ').trim()
      || 'Fala de novo aí — me distraí contando views. 👀';

    // primeira conversa sem apelido: marca que a pergunta já foi feita
    if (!perfil.apelido && !apelidoFinal && !perfil.memoria?.perguntou_nome) {
      await salvarPerfil({ memoria: { ...perfil.memoria, perguntou_nome: true } });
    }

    // log de uso (análise de produto — o que pediram, o que entendemos, o que saiu)
    fetch(`${SU}/rest/v1/blublu_chat_logs`, { method: 'POST', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify({
      user_id: userId, mensagem: message.slice(0, 300),
      tema: resultado?._input?.tema || null,
      termos: resultado?._input?.termos || null,
      qualificadores: resultado?._input?.qualificadores || null,
      filtros: resultado ? { min_views: resultado._input?.min_views, dias: resultado._input?.dias, nicho: resultado._input?.nicho, ordem: resultado._input?.ordem, plataforma: resultado._input?.plataforma, quantidade: resultado._input?.quantidade } : null,
      entregues: resultado ? resultado.videos.length : null,
      confirmados_fala: resultado ? resultado.videos.filter((v) => v.confirmado_por === 'fala').length : null,
      com_relevancia: resultado ? resultado.videos.filter((v) => (v._score || 0) > 0).length : null,
      usou_busca: !!resultado,
    }) }).catch(() => {});

    await bump();
    return res.status(200).json({
      reply,
      videos: resultado ? resultado.videos : [],
      tem_mais: resultado ? resultado.temMais : false,
      verificados: resultado ? resultado.verificadosIds : [],
      apelido: apelidoFinal,
      usage: { used: used + 1, limit: DAILY_LIMIT },
    });
  } catch (e) {
    console.error('[blublu-chat]', e.message);
    return res.status(500).json({ error: 'Deu um curto aqui no laboratório. Tenta de novo? ⚡', detail: e.message.slice(0, 100) });
  }
};
