// api/_helpers/blublu-busca.js
//
// O FUNIL DE BUSCA do Blublu — extraído VERBATIM do api/blublu-chat.js em
// 2026-08-13 pra ser compartilhado com o "Criar com IA" (o user comparou os
// dois chats: "o blubluchat do virais funciona MUITO melhor" — a resposta
// certa é UM motor, não duas buscas divergindo).
//
// O corpo de executarBusca é o MESMO que rodava inline no blublu-chat (todas
// as decisões forenses de 2026-07-18 preservadas: núcleos vs qualificadores,
// sobrenome distintivo, menção de passagem não confirma, volume fill,
// cobertura fina, prioridade YouTube). Só mudou a fiação:
//   - closures viram ctx: { SU, H, OPENAI, RW, message, skipIds, onTema }
//   - a memória de temas (perfil do chat da Virais) virou o hook onTema —
//     quem tem perfil passa o callback; quem não tem, omite.
//
// MUDOU LÁ, MUDA AQUI: este arquivo é a fonte única dos dois chats.

const QTD_PADRAO = 30;          // VOLUME: sem pedido explícito = tudo do tema (teto do grid)
const MAX_CANDIDATOS = 100;     // recall LARGO (o corte por views aos 40 escondia
                                // o video certo atras de genericos populares —
                                // caso do tigre na arvore); entrega cirurgica
                                // fica por conta do ranking de relevancia
const MAX_TRANSCREVER = 10;     // novas transcrições por mensagem (latência)
const TRANSC_PARALELAS = 4;     // concorrência no Railway
const BUDGET_TRANSC_MS = 20000; // orçamento de tempo da confirmação

// Ídolos oficiais do Blublu (easter egg — lore do produto)
const IDOLOS = [
  { nome: 'Luiz Stubbe', patterns: ['luiz stubbe', 'luiz_stubbe', 'opiska'] },
  { nome: 'Giuliana Mafra', patterns: ['giuliana mafra', 'cortes giuliana mafra oficial', 'giulianamafra'] },
];

// Sobrenomes que TAMBÉM são palavra comum (pt/en): NÃO podem virar termo solto
// (buscar "styles" traz "hairstyles", "grande" traz "grande"=big). Distintivos
// (Haaland, Yamal, Eilish) ficam de fora e podem buscar sozinhos — é o que
// destrava o volume de nome próprio sem quebrar a precisão.
const SOBRENOME_COMUM = new Set(['styles', 'grande', 'brown', 'white', 'black', 'green', 'west', 'king', 'young', 'hall', 'park', 'wood', 'stone', 'snow', 'love', 'price', 'banks', 'fields', 'winter', 'summer', 'cook', 'baker', 'smith', 'jones', 'gray', 'grey', 'bell', 'hill', 'lake', 'moon', 'star', 'rose', 'silva', 'santos', 'costa', 'souza', 'sousa', 'lima', 'rocha', 'dias', 'ramos', 'campos', 'gomes', 'neves', 'pinto', 'cruz', 'reis', 'melo', 'lopes', 'martins', 'day', 'best', 'long', 'rich', 'wise', 'ford']);

const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

// A ferramenta (tool use nativo) — compartilhada pelos dois chats pra o
// modelo receber EXATAMENTE as mesmas instruções de preenchimento.
const TOOL_BUSCAR_VIDEOS = {
  name: 'buscar_videos',
  description: 'Busca vídeos no SEU acervo de virais (YouTube curado + TikTok). Use SEMPRE que o usuário pedir vídeos — por tema, canal/criador ou filtros. NUNCA invente vídeos: só fale do que esta ferramenta devolver.',
  input_schema: {
    type: 'object',
    properties: {
      tema: { type: ['string', 'null'], description: 'OBRIGATÓRIO sempre que o pedido menciona QUALQUER assunto/pessoa/canal (ex: "chimpanzé", "Lebron James"). null APENAS em busca puramente numérica/temporal ("mais de 5mi em 2 semanas"). JAMAIS deixe null com nucleos preenchidos.' },
      tipo_tema: { type: ['string', 'null'], description: '"nome_proprio" (pessoa, artista, canal, marca — ex: Harry Styles, Billie Eilish) ou "assunto" (conceito comum — ex: tigre, futebol)' },
      nucleos: { type: 'array', items: { type: 'string' }, description: 'APENAS o substantivo-núcleo e suas traduções/apelidos. nome_proprio → nome COMPLETO intacto + grafias ("harry styles","harrystyles"), JAMAIS separar palavras. assunto → traduções nos idiomas do acervo. PROIBIDO verbos, adjetivos ou o resto do pedido aqui — isso vai em qualificadores. EXEMPLO pedido "tigre subindo em árvore": nucleos=["tigre","tiger","тигр","虎"] (SÓ o bicho!), qualificadores=["subindo","escalando","climbing","árvore","tree","árbol"].' },
      qualificadores: { type: 'array', items: { type: 'string' }, description: 'SÓ características do CONTEÚDO além do núcleo (ação, objeto, contexto), pt+en+es — servem pra ORDENAR os melhores primeiro, nunca excluem ninguém. PROIBIDO palavra de formato/plataforma ("shorts","video","youtube","tiktok","viral") — isso NÃO é qualificador. Vazio na dúvida.' },
      min_views: { type: ['number', 'null'], description: 'views mínimas se o usuário pediu' },
      dias: { type: ['number', 'null'], description: 'janela em dias se o usuário pediu ("últimas 2 semanas" = 14)' },
      nicho: { type: ['string', 'null'], description: 'um de: curiosidades, games, ia, animais, artistas, pessoas_blogs, culinaria' },
      ordem: { type: ['string', 'null'], description: '"views" (padrão) ou "recentes". OBRIGATÓRIO "recentes" quando o usuário falar "mais recente", "último", "novo", "essa semana" etc.' },
      plataforma: { type: ['string', 'null'], description: '"youtube" ou "tiktok" quando o usuário restringir ("só TikTok", "sem YouTube"). null = todas' },
      quantidade: { type: ['number', 'null'], description: 'SÓ se o usuário pediu número exato de vídeos. null = padrão saudável' },
    },
  },
};

/** Fabrica a executarBusca com o contexto do chamador.
 *  ctx: { SU, H, OPENAI, RW, message, skipIds:Set, onTema?:async(tema) } */
function criarBuscaBlublu(ctx) {
  const { SU, H, OPENAI, RW, message = '', onTema } = ctx;
  const skipIds = ctx.skipIds instanceof Set ? ctx.skipIds : new Set();

  return async function executarBusca(inp) {
    // BLINDAGEM (forense 2026-07-18): o modelo às vezes manda termos/nucleos
    // com tema=null — sem isso o fluxo caía no ramo "só filtros" e DESPEJAVA
    // o top do acervo por views (os mesmos 24 sempre, caso Kidshire).
    const nucleosIn = Array.isArray(inp.nucleos) && inp.nucleos.length ? inp.nucleos : (Array.isArray(inp.termos) ? inp.termos : []);
    let tema = inp.tema ? String(inp.tema).slice(0, 120) : null;
    if (!tema && nucleosIn.length) tema = String(nucleosIn[0]).slice(0, 120);
    // quantidade: SÓ vale se o USUÁRIO falou um número (dígito ou por extenso)
    // — o modelo tentava "escolher o melhor" e entregava 1 (user reclamou 2x)
    const userFalouNumero = /\d/.test(message) || /\b(um|uma|dois|duas|tr[eê]s|quatro|cinco|seis|sete|oito|nove|dez|onze|doze|quinze|vinte)\b/i.test(message);
    const qtd = (userFalouNumero && parseInt(inp.quantidade) > 0) ? Math.min(24, parseInt(inp.quantidade)) : QTD_PADRAO;
    // FILTRO INVENTADO MATA VOLUME (forense: "que mais explodiram" virou
    // min_views gigante → 1 vídeo). min_views só vale se o USUÁRIO falou
    // número/quantia; dias só com referência temporal explícita.
    const falouQuantia = /\d|\b(mil|milh[aã]o|milh[oõ]es|k\b|m\b)\b/i.test(message);
    const falouTempo = /\d|\b(dia|dias|semana|semanas|m[eê]s|meses|hoje|ontem|recente|últim)\w*/i.test(message);
    const minViews = falouQuantia ? Math.max(0, parseInt(inp.min_views) || 0) : 0;
    const dias = falouTempo ? Math.max(0, parseInt(inp.dias) || 0) : 0;
    const nicho = ['curiosidades', 'games', 'ia', 'animais', 'artistas', 'pessoas_blogs', 'culinaria'].includes(inp.nicho) ? inp.nicho : null;
    const ordem = inp.ordem === 'recentes' ? 'publicado_em.desc' : 'views.desc';
    const plat = inp.plataforma === 'tiktok' ? 'tiktok' : (inp.plataforma === 'youtube' ? 'youtube' : null);
    let termos = nucleosIn.map((t) => String(t).trim()).filter((t) => t.length >= 2).slice(0, 8);
    if (tema && !termos.length) termos = [tema];

    const parts = ['select=youtube_id,titulo,thumbnail_url,url,canal_nome,views,publicado_em,nicho,duracao_segundos'];
    if (minViews) parts.push(`views=gte.${minViews}`);
    if (dias) parts.push(`publicado_em=gte.${new Date(Date.now() - dias * 86400000).toISOString()}`);
    if (nicho) parts.push(`nicho=eq.${encodeURIComponent(nicho)}`);

    let candidatos = [];
    const clean = (t) => t.replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
    // PRECISÃO > volume (regra do user: na dúvida, não manda): termo solto
    // curto demais (tipo "ney") pesca lixo — só passa termo com 4+ letras,
    // com dígito (CR7) ou composto ("michael jackson")
    let termosOk = termos.map(clean).filter((t) => t.length >= 4 || /\d/.test(t) || t.includes(' '));
    // NOME PRÓPRIO composto: o PRIMEIRO nome é ambíguo ("harry" acha Harry
    // Potter, "billie" acha Billie Jean) — proibido solto. MAS o SOBRENOME
    // distintivo (Haaland, Yamal) é o identificador real e a forma que os
    // títulos MAIS usam: mantê-lo destrava o volume (forense 2026-07-18:
    // "Erling Haaland" sozinho achava 1 vídeo; +"Haaland" = 33). Sobrenome que
    // é palavra comum (Styles→hairstyles) fica de fora — precisão primeiro.
    if (inp.tipo_tema === 'nome_proprio' && tema && tema.trim().includes(' ')) {
      const temaN = norm(clean(tema));
      const partes = temaN.split(' ');
      const sobrenome = partes[partes.length - 1];
      const sobrenomeVale = sobrenome.length >= 5 && !SOBRENOME_COMUM.has(sobrenome);
      termosOk = termosOk.filter((t) => {
        const tn = norm(t);
        return tn.includes(' ') || !partes.includes(tn) || (sobrenomeVale && tn === sobrenome);
      });
      if (sobrenomeVale && !termosOk.some((t) => norm(t) === sobrenome)) termosOk.push(sobrenome);
      if (!termosOk.length) termosOk = [clean(tema)];
    }
    // rede de segurança: se o modelo só mandou frases compostas de ASSUNTO
    // ("tigre escalando arvore"), extrai o núcleo e busca sozinho também
    if (inp.tipo_tema !== 'nome_proprio' && tema && termosOk.length && termosOk.every((t) => t.includes(' '))) {
      const nucleo = clean(tema).split(' ').filter((w) => w.length >= 4);
      if (nucleo.length) termosOk.push(nucleo[0]);
    }
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
        // NICHO SECRETO FORA da busca do Blublu (ordem do user 2026-07-18):
        // acervo do chat = Virais (banco principal + TikTok), secretos só no filtro da página.
      }
      if (plat !== 'youtube') try {
        const tkOr = 'or=(' + termosOk.map((t) => `caption.ilike.*${encodeURIComponent(t)}*,author_name.ilike.*${encodeURIComponent(t)}*,author_handle.ilike.*${encodeURIComponent(t)}*`).join(',') + ')';
        const rt = await fetch(`${SU}/rest/v1/tiktok_virais?${tkBase.join('&')}&${tkOr}&order=views_count.desc&limit=${plat === 'tiktok' ? 40 : 15}`, { headers: H });
        if (rt.ok) candidatos = candidatos.concat((await rt.json()).map(mapTk));
      } catch (e) {}
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
      // só filtros: SQL direto no acervo completo — MAS só quando há filtro
      // REAL. Sem tema, sem termos E sem filtro = pedido sem critério: devolve
      // vazio pro modelo pedir esclarecimento (jamais despejar top views).
      const temFiltroReal = !!(minViews || dias || nicho || plat || inp.ordem);
      if (!temFiltroReal) {
        return { videos: [], temMais: false, verificadosIds: [], resumo: { erro: 'pedido_sem_criterio', instrucao: 'Nenhum tema nem filtro identificado. Pergunte ao usuário o que ele quer (tema, canal ou filtro) — NÃO invente resultados.' } };
      }
      if (plat !== 'tiktok') {
        const r1 = await fetch(`${SU}/rest/v1/virais_banco?${parts.join('&')}&order=${ordem}&limit=30`, { headers: H });
        if (r1.ok) candidatos = await r1.json();
      }
      try {
        // (nicho secreto fora — ordem do user)
        if (!nicho && plat !== 'youtube') {
          const rt = await fetch(`${SU}/rest/v1/tiktok_virais?${tkBase.join('&')}&order=views_count.desc&limit=${plat === 'tiktok' ? 30 : 15}`, { headers: H });
          if (rt.ok) candidatos = candidatos.concat((await rt.json()).map(mapTk));
        }
        const pTk = (v) => (plat !== 'tiktok' && v._tiktok) ? 1 : 0; // YouTube primeiro
        candidatos.sort((a, b) => pTk(a) - pTk(b) || (ordem === 'publicado_em.desc' ? new Date(b.publicado_em || 0) - new Date(a.publicado_em || 0) : (b.views || 0) - (a.views || 0)));
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
          videos.push({ youtube_id: c.youtube_id, titulo: c.titulo, thumbnail_url: c.thumbnail_url, url: c.url, canal_nome: c.canal_nome, views: c.views, publicado_em: c.publicado_em, duracao_segundos: c.duracao_segundos ?? null, citado_em_s: citadoEm, confirmado_por: falaBate ? 'fala' : (canalBate ? 'canal' : 'titulo'), plataforma: c._tiktok ? 'tiktok' : 'youtube', secreto: !!c._secreto, _score: score });
        }
      }
      const peso = { fala: 0, canal: 1, titulo: 2 };
      // PRIORIDADE YOUTUBE (user 2026-07-18): YouTube Shorts sempre na frente —
      // TikTok tem views absurdas e dominava o sort; só lidera se o usuário
      // pedir TikTok explicitamente (plat === 'tiktok').
      const pPlat = (v) => (plat !== 'tiktok' && v.plataforma === 'tiktok') ? 1 : 0;
      videos.sort((a, b) => pPlat(a) - pPlat(b) || (b._score || 0) - (a._score || 0) || (peso[a.confirmado_por] ?? 3) - (peso[b.confirmado_por] ?? 3) || (b.views || 0) - (a.views || 0));
      // VOLUME FILL: se ainda couber, completa com os demais candidatos do
      // tema (recall/semântica) marcados 'relacionado', por views.
      if (videos.length < qtd) {
        const jaTem = new Set(videos.map((v) => v.youtube_id || v.url));
        const resto = candidatos.filter((c) => !jaTem.has(c.youtube_id || c.url))
          .sort((a, b) => ((plat !== 'tiktok' && a._tiktok) ? 1 : 0) - ((plat !== 'tiktok' && b._tiktok) ? 1 : 0) || (b.views || 0) - (a.views || 0))
          .slice(0, qtd - videos.length)
          .map((c) => ({ youtube_id: c.youtube_id, titulo: c.titulo, thumbnail_url: c.thumbnail_url, url: c.url, canal_nome: c.canal_nome, views: c.views, publicado_em: c.publicado_em, duracao_segundos: c.duracao_segundos ?? null, citado_em_s: null, confirmado_por: 'relacionado', plataforma: c._tiktok ? 'tiktok' : 'youtube', secreto: false, _score: 0 }));
        videos = videos.concat(resto);
      }
      verificadosIds = candidatos.filter((c) => c.youtube_id && cacheMap.has(c.youtube_id)).map((c) => c.youtube_id);
    } else {
      videos = candidatos.map((c) => ({ youtube_id: c.youtube_id, titulo: c.titulo, thumbnail_url: c.thumbnail_url, url: c.url, canal_nome: c.canal_nome, views: c.views, publicado_em: c.publicado_em, duracao_segundos: c.duracao_segundos ?? null, citado_em_s: null, confirmado_por: 'filtro', plataforma: c._tiktok ? 'tiktok' : 'youtube', secreto: !!c._secreto }));
    }
    const cortados = Math.max(0, videos.length - qtd);
    videos = videos.slice(0, qtd);

    // memória de temas (hook do chamador — o chat da Virais grava no perfil)
    if (tema && onTema) { try { await onTema(tema); } catch (e) {} }

    // ídolo no resultado? (easter egg fã histérico — mesmo lore da BlueTendências)
    const idolosNoResultado = [...new Set(videos.map((v) => {
      const c = norm(v.canal_nome);
      const hit = IDOLOS.find((i) => i.patterns.some((p) => c === p || c.includes(p)));
      return hit ? hit.nome : null;
    }).filter(Boolean))];

    // DIRETOS = casaram no tema de verdade (fala/título/canal). O resto é
    // "relacionado" (volume fill) ou "filtro". Precisão-primeiro: se os diretos
    // são poucos, o modelo AVISA em vez de fingir fartura.
    const diretos = videos.filter((v) => ['fala', 'titulo', 'canal'].includes(v.confirmado_por)).length;
    const buscaTematica = !!(tema && termosOk.length);
    // resumo pro MODELO comentar com propriedade (os cards o front renderiza)
    const resumo = {
      total_entregue: videos.length,
      confirmados_na_fala: videos.filter((v) => v.confirmado_por === 'fala').length,
      do_canal: videos.filter((v) => v.confirmado_por === 'canal').length,
      pelo_titulo: videos.filter((v) => v.confirmado_por === 'titulo').length,
      diretos_do_tema: diretos,
      relacionados_complemento: videos.filter((v) => v.confirmado_por === 'relacionado').length,
      // COBERTURA FINA: busca de tema trouxe POUCOS diretos (<=4). O modelo deve
      // ser transparente (número real + oferecer ampliar), nunca fingir fartura.
      cobertura_fina: buscaTematica && diretos > 0 && diretos <= 4,
      tinha_mais_alem_do_entregue: cortados > 0,
      ha_candidatos_ainda_nao_verificados: temMais,
      com_relevancia_exata: videos.filter((v) => (v._score || 0) > 0).length,
      idolos_no_resultado: idolosNoResultado,
      amostra: videos.slice(0, 6).map((v) => ({ titulo: (v.titulo || '').slice(0, 70), canal: v.canal_nome, views: v.views, confirmado_por: v.confirmado_por, bateu_qualificadores: (v._score || 0) > 0 })),
    };
    return { videos, temMais, verificadosIds, resumo };
  };
}

module.exports = { criarBuscaBlublu, TOOL_BUSCAR_VIDEOS, QTD_PADRAO, IDOLOS, norm };
