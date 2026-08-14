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

// O vocabulário É a curadoria desta página: ele define o que ela encontra.
// Mira conteúdo SEM ROSTO — narração sobre imagem, história contada,
// compilação. Termo com nome de gente ou de marca traria justamente o canal
// famoso que o teto de inscritos existe pra excluir.
const TERMOS = [
  'documentary', 'documentário', 'true story', 'história real',
  'mystery explained', 'mistério explicado', 'unsolved case', 'caso não resolvido',
  'deep dive', 'explicado em detalhes', 'full analysis', 'análise completa',
  'compilation', 'compilado', 'top 10 facts', 'curiosidades incríveis',
  'sleep story', 'história para dormir', 'relaxing narration',
  'scary stories', 'histórias de terror', 'creepy',
  'ancient history', 'história antiga', 'space documentary', 'universo explicado',
  'crime documentary', 'caso real', 'investigação',
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
    try {
      const r = await youtubeRequest('search', {
        part: 'snippet', type: 'video', q: termos[i],
        videoDuration: balde, order: 'relevance', maxResults: 50,
      });
      stat.buscas++;
      const itens = (r && r.items) || [];
      stat.por_termo[termos[i]] = itens.length;
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
      part: 'snippet,statistics', id: canaisIds.slice(i, i + 50).join(','), maxResults: 50,
    });
    for (const c of (r && r.items) || []) {
      info[c.id] = {
        subs: Number((c.statistics && c.statistics.subscriberCount) || 0),
        oculto: !!(c.statistics && c.statistics.hiddenSubscriberCount),
        nome: (c.snippet && c.snippet.title) || '',
        thumb: (c.snippet && c.snippet.thumbnails && ((c.snippet.thumbnails.medium || {}).url || (c.snippet.thumbnails.default || {}).url)) || null,
        pais: (c.snippet && c.snippet.country) || null,
      };
    }
  }
  stat.canais_consultados = canaisIds.length;

  const linhas = [];
  const porCanal = new Map();
  for (const { v, d } of naFaixa) {
    const c = info[v.snippet.channelId];
    // Canal que ESCONDE a contagem não passa: sem o número não dá pra afirmar
    // que é pequeno, e na dúvida fica de fora.
    if (!c || c.oculto || c.subs > MAX_INSCRITOS) continue;
    const views = Number((v.statistics && v.statistics.viewCount) || 0);
    if (views < PISOS[0]) continue;      // abaixo do menor piso não interessa a ninguém
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

module.exports.__interno = { TERMOS, PISOS, DUR_MIN_S, DUR_MAX_S, MAX_INSCRITOS, fatiaDeTermos, textoSeguro, seg };
