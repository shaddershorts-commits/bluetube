// api/longos.js — BlueTube LONGOS: virais longos de criadores dark
// ===========================================================================
// Página /longos. Duas abas: Virais (vídeos) e Canais (quem os fez).
//
// ── O QUE ISTO NÃO FAZ ─────────────────────────────────────────────────────
// Não toca em virais_banco, não usa os 484 canais curados do painel, não
// compartilha uma linha de código com a Virais de Shorts. São produtos
// diferentes com fontes diferentes — misturar os dois foi descartado depois de
// medir que os canais curados publicam 96% Shorts.
//
// ── AS REGRAS, TODAS MEDIDAS EM 13-14/08/2026 ──────────────────────────────
// · Duração 15-50 min (pedido do dono). Cruza as duas faixas da API, então a
//   busca pede `long` E `medium` e o corte fino é aqui, com a duração exata.
// · Até 70 mil inscritos. O pedido era "sem selo de verificado", e o selo NÃO
//   EXISTE na API. O substituto é o número que gera o selo (liberado a partir
//   de 100 mil); o dono apertou pra 70 mil. É melhor que o original: o YouTube
//   verifica proativamente canais menores famosos FORA do YouTube — justo os
//   que ele quer excluir.
// · Descoberta por TERMO. `videoCategoryId` devolve ZERO na busca de vídeo
//   (medido, 3 variações, todas com totalResults 0).
// · order=relevance. Medido, 4 buscas cada: viewCount deu 1 canal pequeno de
//   24; date deu 50 canais pequenos mas só 2 acima de 30k views; relevance deu
//   6 acima de 30k e 2 acima de 300k.
//
// ── CUSTO, QUE É O RISCO ───────────────────────────────────────────────────
// `search.list` é ~100 chamadas por DIA por chave — o item mais caro da API.
// Cada rodada gasta BUSCAS_POR_RODADA (8). Com o cron de 3 em 3h dá 64/dia,
// dentro de UMA chave, sem encostar na cota que a Virais de Shorts já usa.
// Este projeto já perdeu 28 chaves numa suspensão do Google; a resposta da
// coleta sempre informa quantas buscas gastou.

const { youtubeRequest } = require('./_helpers/youtube');

const DUR_MIN_S = 15 * 60;
const DUR_MAX_S = 50 * 60;
const MAX_INSCRITOS = 70_000;
const PISOS = [30_000, 100_000, 300_000];
const BUSCAS_POR_RODADA = 8;
const RETENCAO_DIAS = 90;
// Canal precisa ter postado nos últimos N dias pra entrar. Pedido do dono em
// 14/08, depois de ver o acervo enchendo de canal que estourou uma vez e
// parou: viral de canal abandonado não serve pra estudar formato.
const DIAS_CANAL_VIVO = 2;
// Só canal destes países (pedido do dono em 14/08). Entram em DOIS lugares:
//  · no `regionCode` da busca, pra a descoberta já mirar esses mercados;
//  · no filtro final, conferindo o país DECLARADO do canal.
// ⚠️ `snippet.country` é OPCIONAL no YouTube — canal que não declara fica sem
// o campo. A regra é literal ("apenas desses países"), então canal sem país
// declarado NÃO entra. O relatório da coleta conta quantos caem por isso, pra
// a decisão de afrouxar (ou não) ser tomada com número.
const PAISES = ['US', 'ES', 'BR', 'DE'];
// Idioma que combina com cada mercado, pra a busca não devolver conteúdo em
// inglês quando está mirando a Alemanha.
const IDIOMA_DO_PAIS = { US: 'en', ES: 'es', BR: 'pt', DE: 'de' };

// O vocabulário É a curadoria desta página: ele define o que ela encontra.
// Mira conteúdo SEM ROSTO — narração sobre imagem, história contada,
// compilação. Termo com nome de gente ou de marca traria justamente o canal
// famoso que o teto de inscritos existe pra excluir.
//
// ⚠️ O TAMANHO DESTA LISTA É O TETO DA PÁGINA, não a cota da API.
// Medido em 14/08: a busca do YouTube é ESTÁVEL — repetir o mesmo termo devolve
// praticamente os mesmos 50 vídeos. Então rodar a coleta mais vezes com o mesmo
// vocabulário não enche o acervo; só gasta cota. Quem quiser mais conteúdo
// acrescenta TERMO aqui, e é o único lugar que precisa mexer.
// Rendimento medido: ~50 candidatos por termo → ~5% viram vídeo gravado.
const TERMOS = [
  // narrativa e investigação
  'documentary', 'documentário', 'true story', 'história real',
  'mystery explained', 'mistério explicado', 'unsolved case', 'caso não resolvido',
  'crime documentary', 'caso real', 'investigação', 'true crime',
  'cold case', 'caso arquivado', 'desaparecimento misterioso',
  // explicação e análise
  'deep dive', 'explicado em detalhes', 'full analysis', 'análise completa',
  'explicação completa', 'entenda de uma vez', 'como funciona',
  // listas e compilações
  'compilation', 'compilado', 'top 10 facts', 'curiosidades incríveis',
  'fatos surpreendentes', 'coisas que você não sabia', 'top 10 mysteries',
  // sono e relaxamento (nicho gigante de canal sem rosto)
  'sleep story', 'história para dormir', 'relaxing narration',
  'bedtime stories', 'contos de fadas', 'histórias infantis',
  'audiolivro completo', 'audiobook full',
  // terror
  'scary stories', 'histórias de terror', 'creepy', 'horror stories',
  'relatos de terror', 'lendas urbanas', 'creepypasta',
  // história e ciência
  'ancient history', 'história antiga', 'space documentary', 'universo explicado',
  'segunda guerra', 'civilizações perdidas', 'documentário histórico',
  'astronomia explicada', 'buraco negro', 'evolução humana',
  // natureza e animais
  'wildlife documentary', 'documentário natureza', 'animais selvagens',
  'oceano profundo', 'predadores',
  // pessoas e sociedade
  'biografia completa', 'a história de', 'ascensão e queda',
  'psicologia explicada', 'comportamento humano',
  // dinheiro e trabalho
  'como enriqueceu', 'história de sucesso', 'colapso da empresa',
  'documentário economia',
  // cultura pop sem rosto
  'anime explained', 'lore explicada', 'teoria do filme', 'game lore',
  'reddit stories', 'histórias do reddit',
  // religião e mitologia
  'mitologia grega', 'curiosidades da bíblia', 'histórias bíblicas',
  'mitologia nórdica',
];

const seg = (iso) => {
  const m = String(iso || '').match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  return m ? (parseInt(m[1] || 0, 10) * 3600) + (parseInt(m[2] || 0, 10) * 60) + parseInt(m[3] || 0, 10) : 0;
};

// Rotação: duas rodadas seguidas não vasculham os mesmos termos. Sem isto o
// cron de 3 em 3h traria em boa parte os mesmos vídeos, e o volume DIÁRIO de
// vídeos únicos seria muito menor que o volume por rodada sugere. Mesmo
// desenho da rotação de hashtags do coletor de TikTok.
function fatiaDeTermos(quantos, agora) {
  const passo = Math.floor(agora / (3 * 3600 * 1000));
  const inicio = (passo * quantos) % TERMOS.length;
  const saida = [];
  for (let i = 0; i < quantos; i++) saida.push(TERMOS[(inicio + i) % TERMOS.length]);
  return saida;
}

// Corta em `max` sem partir emoji e sem deixar NUL. Mesma lição do coletor de
// TikTok: um emoji partido ao meio faz o PostgREST recusar o LOTE INTEIRO com
// "Empty or invalid json" — 132 vídeos bons perdidos por causa de 1.
function textoSeguro(s, max) {
  return String(s == null ? '' : s)
    .replace(new RegExp(String.fromCharCode(0), 'g'), '')
    .slice(0, max)
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '')
    .replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const SU = process.env.SUPABASE_URL;
  const SK = process.env.SUPABASE_SERVICE_KEY;
  if (!SU || !SK) return res.status(500).json({ error: 'config_missing' });
  const h = { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' };
  const action = req.query.action || (req.body && req.body.action) || 'listar';

  try {
    if (action === 'coletar') return await coletar(req, res, { SU, h });
    if (action === 'listar') return await listar(req, res, { SU, h });
    if (action === 'canais') return await canais(req, res, { SU, h });
    if (action === 'limpar') return await limpar(req, res, { SU, h });
    return res.status(400).json({ error: 'action_invalida', actions: ['listar', 'canais', 'coletar', 'limpar'] });
  } catch (e) {
    console.error('[longos]', action, e && e.message);
    return res.status(500).json({ error: String((e && e.message) || e).slice(0, 200) });
  }
};

// ── COLETAR (cron) ─────────────────────────────────────────────────────────
async function coletar(req, res, { SU, h }) {
  if (req.query.admin_secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const stat = {
    buscas: 0, candidatos: 0, na_faixa: 0, canais_consultados: 0,
    de_canal_pequeno: 0, gravados: 0, canais_gravados: 0,
    por_termo: {}, erros: [],
  };

  const termos = req.query.termos
    ? String(req.query.termos).split(',').map((t) => t.trim()).filter(Boolean).slice(0, 12)
    : fatiaDeTermos(BUSCAS_POR_RODADA, Date.now());

  // ── 1) BUSCA — o passo caro. Tudo abaixo custa 1 unidade por lote de 50.
  const candidatos = new Map();
  for (let i = 0; i < termos.length; i++) {
    // `long` (+20min) cobre 20-50min da faixa pedida; `medium` (4-20min) cobre
    // 15-20. Alternar aproveita as duas pontas.
    const balde = i % 2 === 0 ? 'long' : 'medium';
    // Rotaciona os 4 mercados pedidos entre as buscas da rodada: cada termo sai
    // olhando um país, e ao longo da rodada os quatro são cobertos.
    const pais = PAISES[i % PAISES.length];
    try {
      const r = await youtubeRequest('search', {
        part: 'snippet', type: 'video', q: termos[i],
        videoDuration: balde, order: 'relevance', maxResults: 50,
        regionCode: pais,
        relevanceLanguage: IDIOMA_DO_PAIS[pais] || 'en',
      });
      stat.buscas++;
      const itens = (r && r.items) || [];
      stat.por_termo[`${termos[i]} [${pais}]`] = itens.length;
      for (const it of itens) {
        const id = it.id && it.id.videoId;
        if (id && !candidatos.has(id)) candidatos.set(id, termos[i]);
      }
    } catch (e) {
      stat.erros.push(`busca "${termos[i]}": ${String(e.message || e).slice(0, 120)}`);
    }
  }
  stat.candidatos = candidatos.size;
  if (!candidatos.size) return responder(res, stat, 'a busca não devolveu nada');

  // ── 2) DETALHES + corte fino de duração
  const ids = [...candidatos.keys()];
  const naFaixa = [];
  for (let i = 0; i < ids.length; i += 50) {
    const r = await youtubeRequest('videos', {
      part: 'snippet,contentDetails,statistics', id: ids.slice(i, i + 50).join(','), maxResults: 50,
    });
    for (const v of (r && r.items) || []) {
      const d = seg(v.contentDetails && v.contentDetails.duration);
      if (d >= DUR_MIN_S && d <= DUR_MAX_S) naFaixa.push({ v, d });
    }
  }
  stat.na_faixa = naFaixa.length;
  if (!naFaixa.length) return responder(res, stat, 'nenhum vídeo na faixa de duração');

  // ── 3) INSCRITOS — o substituto do selo de verificado
  const canaisIds = [...new Set(naFaixa.map((x) => x.v.snippet && x.v.snippet.channelId).filter(Boolean))];
  const info = {};
  for (let i = 0; i < canaisIds.length; i += 50) {
    const r = await youtubeRequest('channels', {
      // `contentDetails` traz a playlist de uploads — é ela que diz quando o
      // canal postou pela última vez (ver o filtro de canal vivo abaixo).
      part: 'snippet,statistics,contentDetails', id: canaisIds.slice(i, i + 50).join(','), maxResults: 50,
    });
    for (const c of (r && r.items) || []) {
      info[c.id] = {
        subs: Number((c.statistics && c.statistics.subscriberCount) || 0),
        oculto: !!(c.statistics && c.statistics.hiddenSubscriberCount),
        nome: (c.snippet && c.snippet.title) || '',
        thumb: (c.snippet && c.snippet.thumbnails && ((c.snippet.thumbnails.medium || {}).url || (c.snippet.thumbnails.default || {}).url)) || null,
        pais: (c.snippet && c.snippet.country) || null,
        uploads: (c.contentDetails && c.contentDetails.relatedPlaylists && c.contentDetails.relatedPlaylists.uploads) || null,
      };
    }
  }
  stat.canais_consultados = canaisIds.length;

  // ── 3.5) CANAL VIVO ───────────────────────────────────────────────────────
  // ⚠️ O acervo estava enchendo de CANAL MORTO: o vídeo estourou um dia e o
  // canal parou de postar. Um viral de canal abandonado não serve pra estudar
  // formato — o que interessa é quem está acertando AGORA.
  //
  // O sinal é a última publicação, e ela sai da playlist de uploads do canal:
  // `playlistItems` com maxResults=1 custa **1 unidade**, não 100 como a busca.
  // E só é consultada pros canais que JÁ passaram no teto de inscritos e no
  // piso de views — um punhado por rodada, não os 85 candidatos.
  const diasVivo = Math.max(1, parseInt(req.query.dias_vivo || String(DIAS_CANAL_VIVO), 10));
  const corteVivo = Date.now() - diasVivo * 864e5;
  const ultimaPub = {};
  const precisamChecar = [...new Set(naFaixa
    .filter(({ v }) => {
      const c = info[v.snippet.channelId];
      const views = Number((v.statistics && v.statistics.viewCount) || 0);
      return c && !c.oculto && c.subs <= MAX_INSCRITOS && views >= PISOS[0] && c.uploads;
    })
    .map(({ v }) => v.snippet.channelId))];
  for (const id of precisamChecar) {
    try {
      const r = await youtubeRequest('playlistItems', {
        part: 'contentDetails', playlistId: info[id].uploads, maxResults: 1,
      });
      const it = (r && r.items && r.items[0]) || null;
      const q = it && it.contentDetails && it.contentDetails.videoPublishedAt;
      ultimaPub[id] = q ? new Date(q).getTime() : 0;
    } catch (e) {
      // Não deu pra checar não é o mesmo que canal morto. Sem o dado, deixa
      // passar: barrar por falha de rede esvaziaria a página em silêncio.
      ultimaPub[id] = Date.now();
    }
  }
  stat.canais_checados_vivos = precisamChecar.length;
  stat.canais_mortos = precisamChecar.filter((id) => ultimaPub[id] < corteVivo).length;
  stat.dias_vivo = diasVivo;

  // Funil por filtro: com cinco regras empilhadas, saber QUANTO cada uma corta
  // é a diferença entre afrouxar a certa e chutar.
  const corte = { canal_grande: 0, abaixo_do_piso: 0, canal_morto: 0, pais_fora: 0, sem_pais: 0 };
  const paisesAceitos = String(req.query.paises || PAISES.join(',')).toUpperCase().split(',').map((p) => p.trim()).filter(Boolean);

  const linhas = [];
  const porCanal = new Map();
  for (const { v, d } of naFaixa) {
    const c = info[v.snippet.channelId];
    // Canal que ESCONDE a contagem não passa: sem o número não dá pra afirmar
    // que é pequeno, e na dúvida fica de fora.
    if (!c || c.oculto || c.subs > MAX_INSCRITOS) { corte.canal_grande++; continue; }
    const views = Number((v.statistics && v.statistics.viewCount) || 0);
    if (views < PISOS[0]) { corte.abaixo_do_piso++; continue; }
    // Canal parado não entra, por mais que o vídeo tenha estourado.
    if ((ultimaPub[v.snippet.channelId] || 0) < corteVivo) { corte.canal_morto++; continue; }
    // País do canal. `snippet.country` é opcional no YouTube: quem não declara
    // fica sem o campo, e a regra pedida é literal — só os quatro mercados.
    if (!c.pais) { corte.sem_pais++; continue; }
    if (paisesAceitos.indexOf(String(c.pais).toUpperCase()) < 0) { corte.pais_fora++; continue; }
    const agora = new Date().toISOString();
    linhas.push({
      youtube_id: v.id,
      titulo: textoSeguro(v.snippet.title, 300),
      thumbnail_url: (v.snippet.thumbnails && ((v.snippet.thumbnails.maxres || {}).url || (v.snippet.thumbnails.high || {}).url || (v.snippet.thumbnails.medium || {}).url)) || null,
      url: 'https://youtube.com/watch?v=' + v.id,
      canal_id: v.snippet.channelId,
      canal_nome: textoSeguro(c.nome, 120),
      canal_inscritos: c.subs,
      views,
      likes: Number((v.statistics && v.statistics.likeCount) || 0),
      comentarios: Number((v.statistics && v.statistics.commentCount) || 0),
      duracao_segundos: d,
      // A assinatura do dark: quanto o vídeo estourou acima do tamanho do canal.
      views_por_inscrito: c.subs ? +(views / c.subs).toFixed(2) : null,
      termo: candidatos.get(v.id) || null,
      publicado_em: v.snippet.publishedAt || null,
      collected_at: agora,
      last_seen_at: agora,
      ativo: true,
    });
    const ja = porCanal.get(v.snippet.channelId);
    if (!ja || views > ja.melhor_views) {
      porCanal.set(v.snippet.channelId, {
        channel_id: v.snippet.channelId, nome: textoSeguro(c.nome, 120),
        thumbnail_url: c.thumb, inscritos: c.subs, pais: c.pais,
        melhor_video_id: v.id, melhor_views: views, melhor_titulo: textoSeguro(v.snippet.title, 200),
        ultimo_visto: agora,
      });
    }
  }
  stat.de_canal_pequeno = linhas.length;
  stat.cortes = corte;
  stat.paises = paisesAceitos;
  if (!linhas.length) return responder(res, stat, 'nada passou no teto de inscritos + piso de views');

  // ── 4) GRAVA em blocos (uma linha ruim custa o bloco, não a rodada)
  stat.gravados = await gravar(`${SU}/rest/v1/longos_virais?on_conflict=youtube_id`, linhas, h, stat);
  stat.canais_gravados = await gravar(`${SU}/rest/v1/longos_canais?on_conflict=channel_id`, [...porCanal.values()], h, stat);

  return responder(res, stat, null);
}

async function gravar(url, linhas, h, stat) {
  let n = 0;
  for (let i = 0; i < linhas.length; i += 50) {
    const bloco = linhas.slice(i, i + 50);
    const r = await fetch(url, {
      method: 'POST',
      headers: { ...h, Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(bloco),
    });
    if (r.ok) n += bloco.length;
    else stat.erros.push('upsert ' + r.status + ': ' + (await r.text()).slice(0, 140));
  }
  return n;
}

// Rodada que não grava NADA responde 503, pro cron ficar VERMELHO. É a lição
// que custou 7 dias de coleta morta do TikTok com o painel todo verde: o
// workflow só quebra quando o HTTP não é 200.
function responder(res, stat, motivo) {
  const corpo = { ok: stat.gravados > 0, ...stat, timestamp: new Date().toISOString() };
  if (stat.gravados > 0) return res.status(200).json(corpo);
  corpo.error = 'coleta_vazia';
  corpo.detalhe = motivo || 'nenhum vídeo gravado — isto é falha, não silêncio.';
  return res.status(503).json(corpo);
}

// ── LISTAR (a aba Virais) ──────────────────────────────────────────────────
async function listar(req, res, { SU, h }) {
  const piso = PISOS.includes(parseInt(req.query.piso, 10)) ? parseInt(req.query.piso, 10) : PISOS[0];
  const ordem = req.query.ordem === 'ratio' ? 'views_por_inscrito' : req.query.ordem === 'recentes' ? 'collected_at' : 'views';
  const limit = Math.min(60, parseInt(req.query.limit, 10) || 24);
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);

  let url = `${SU}/rest/v1/longos_virais?ativo=eq.true&views=gte.${piso}`;
  // Filtro por canal: é o que faz a aba Canais levar de volta pros vídeos dele.
  if (req.query.canal) url += `&canal_id=eq.${encodeURIComponent(String(req.query.canal))}`;
  url += `&order=${ordem}.desc.nullslast&limit=${limit}&offset=${offset}`;
  url += '&select=youtube_id,titulo,thumbnail_url,url,canal_id,canal_nome,canal_inscritos,views,likes,duracao_segundos,views_por_inscrito,termo,publicado_em,collected_at';

  const r = await fetch(url, { headers: { ...h, Prefer: 'count=exact' } });
  if (!r.ok) return res.status(500).json({ error: 'query_failed' });
  const items = await r.json();
  const total = parseInt((r.headers.get('content-range') || '').split('/')[1], 10) || items.length;
  return res.status(200).json({ ok: true, total, piso, ordem, items });
}

// ── CANAIS (a segunda aba) ─────────────────────────────────────────────────
// Ela nasceu de graça: o coletor JÁ precisa consultar inscritos pra aplicar o
// teto de 70 mil. Guardar isso transforma um dado que seria descartado numa
// aba inteira — "quem são os criadores dark que estão acertando".
async function canais(req, res, { SU, h }) {
  const ordem = req.query.ordem === 'inscritos' ? 'inscritos' : req.query.ordem === 'novos' ? 'primeiro_visto' : 'melhor_views';
  const limit = Math.min(60, parseInt(req.query.limit, 10) || 24);
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);

  const url = `${SU}/rest/v1/longos_canais?order=${ordem}.desc.nullslast&limit=${limit}&offset=${offset}`
    + '&select=channel_id,nome,thumbnail_url,inscritos,pais,melhor_video_id,melhor_views,melhor_titulo,primeiro_visto,ultimo_visto';
  const r = await fetch(url, { headers: { ...h, Prefer: 'count=exact' } });
  if (!r.ok) return res.status(500).json({ error: 'query_failed' });
  const items = await r.json();
  const total = parseInt((r.headers.get('content-range') || '').split('/')[1], 10) || items.length;

  // Quantos vídeos de cada canal estão no acervo. Uma consulta pro lote todo,
  // não uma por canal.
  if (items.length) {
    try {
      const ids = items.map((c) => `"${c.channel_id}"`).join(',');
      const cr = await fetch(`${SU}/rest/v1/longos_virais?canal_id=in.(${ids})&ativo=eq.true&select=canal_id`, { headers: h });
      if (cr.ok) {
        const contagem = {};
        for (const v of await cr.json()) contagem[v.canal_id] = (contagem[v.canal_id] || 0) + 1;
        items.forEach((c) => { c.videos_no_acervo = contagem[c.channel_id] || 0; });
      }
    } catch (e) {}
  }
  return res.status(200).json({ ok: true, total, ordem, items });
}

// ── LIMPAR (cron diário) ───────────────────────────────────────────────────
async function limpar(req, res, { SU, h }) {
  if (req.query.admin_secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const corte = new Date(Date.now() - RETENCAO_DIAS * 864e5).toISOString();
  const r = await fetch(`${SU}/rest/v1/longos_virais?collected_at=lt.${encodeURIComponent(corte)}`, {
    method: 'DELETE', headers: { ...h, Prefer: 'return=representation' },
  });
  const apagados = r.ok ? (await r.json()).length : 0;
  return res.status(200).json({ ok: r.ok, apagados, retencao_dias: RETENCAO_DIAS });
}

module.exports.__interno = { TERMOS, PISOS, DUR_MIN_S, DUR_MAX_S, MAX_INSCRITOS, DIAS_CANAL_VIVO, PAISES, IDIOMA_DO_PAIS, fatiaDeTermos, textoSeguro, seg };
