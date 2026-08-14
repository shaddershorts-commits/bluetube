// api/longos-test.js — SONDA da futura página /longos (Virais de vídeo longo)
// ===========================================================================
// Isto NÃO é a feature. É a sonda que decide se a feature vale ser construída,
// e é isolada de propósito: não escreve no banco, não mexe em nenhuma rota da
// Virais de Shorts, e pode ser apagada sem deixar rastro.
//
// ── A PERGUNTA QUE ELA RESPONDE ────────────────────────────────────────────
// "Descoberta por VIEWS, sem canal pré-selecionado, rende criador dark de
// verdade — ou vem podcast e canal grande?" Nenhum plano de página vale nada
// antes desse número.
//
// ── O CRITÉRIO PEDIDO, E POR QUE ELE MUDOU ─────────────────────────────────
// O pedido foi "excluir canal com selo de verificado". A API do YouTube NÃO
// expõe verificação — conferido no recurso `channels`: existem título, país,
// inscritos, banner, e nenhum campo de selo.
// O substituto é o número que GERA o selo: ele é liberado a partir de 100 mil
// inscritos, e `subscriberCount` está na API. O dono apertou pra 70 mil.
// De quebra o substituto é melhor que o original: o YouTube também verifica
// proativamente canais menores famosos FORA do YouTube — justamente os que o
// dono quer excluir. Filtrar por inscritos pega esses; o selo não pegaria.
//
// ── CUSTO, QUE É O RISCO REAL ──────────────────────────────────────────────
// `search.list` é o item mais caro da API: ~100 chamadas por DIA por chave.
// Este arquivo faz no máximo `buscas` chamadas (padrão 2) por execução, e diz
// no relatório quantas gastou. Depois da busca tudo é barato: `videos.list` e
// `channels.list` custam 1 unidade a cada 50 itens.
// Este projeto já perdeu 28 chaves numa suspensão do Google — sonda que gasta
// cota escondida é sonda que vira problema.

const { youtubeRequest } = require('./_helpers/youtube');

// A faixa que o dono pediu: 15 a 50 minutos.
// ⚠️ Ela CRUZA as duas faixas da API (`medium` = 4-20min, `long` = +20min), e
// por isso a busca pede as duas e o corte fino é feito aqui, com a duração
// exata que vem do videos.list. Confiar só no balde da API deixaria de fora
// tudo entre 20 e 50 minutos, ou traria coisa de 4 minutos.
const DUR_MIN_S = 15 * 60;
const DUR_MAX_S = 50 * 60;
const MAX_INSCRITOS = 70_000;
const PISOS = [30_000, 100_000, 300_000];

// ⚠️ MEDIDO em 13/08/2026 com ?diag=1: `videoCategoryId` devolve ZERO na busca
// de vídeo — testado com e sem `order`, três variações, todas com
// `totalResults: 0`. Com TERMO de busca a mesma chamada devolve 10 itens e
// 1 milhão de resultados estimados.
//
// Consequência de desenho: a descoberta precisa de VOCABULÁRIO, não de
// categoria. É o mesmo padrão da rotação de hashtags do coletor de TikTok —
// uma lista grande, e cada rodada usa uma fatia, pra duas rodadas seguidas não
// vasculharem o mesmo canto.
//
// Os termos abaixo miram conteúdo SEM ROSTO, que é o que o dono chamou de
// "criador dark": narração sobre imagem, compilação, história contada. Termo
// com nome de gente ou de marca traria justamente o canal famoso que a regra
// dos 70 mil inscritos existe pra excluir.
const TERMOS = [
  'documentary', 'documentário', 'true story', 'história real',
  'mystery explained', 'mistério explicado', 'unsolved case',
  'deep dive', 'explicado em detalhes', 'full analysis',
  'compilation', 'compilado', 'top 10 facts', 'curiosidades',
  'sleep story', 'história para dormir', 'relaxing narration',
  'scary stories', 'histórias de terror', 'creepy',
  'ancient history', 'história antiga', 'space documentary',
  'crime documentary', 'caso real', 'investigação',
];

function fatiaDeTermos(quantos, semente) {
  const passo = Math.floor(semente / (3 * 3600 * 1000));
  const inicio = (passo * quantos) % TERMOS.length;
  const saida = [];
  for (let i = 0; i < quantos; i++) saida.push(TERMOS[(inicio + i) % TERMOS.length]);
  return saida;
}

function segundosDeISO(iso) {
  const m = String(iso || '').match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  return (parseInt(m[1] || 0, 10) * 3600) + (parseInt(m[2] || 0, 10) * 60) + parseInt(m[3] || 0, 10);
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.query.admin_secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  // Tudo parametrizável pra sondar sem redeploy — a sonda existe pra ser
  // rodada várias vezes com regras diferentes.
  const buscas = Math.min(4, Math.max(1, parseInt(req.query.buscas || '2', 10)));
  const maxInscritos = parseInt(req.query.subs || String(MAX_INSCRITOS), 10);
  const durMin = parseInt(req.query.dmin || String(DUR_MIN_S), 10);
  const durMax = parseInt(req.query.dmax || String(DUR_MAX_S), 10);
  const cats = String(req.query.cats || '27,28').split(',').map((c) => c.trim()).filter(Boolean);

  const relatorio = {
    regra: { duracao: `${durMin / 60}-${durMax / 60} min`, max_inscritos: maxInscritos, pisos: PISOS },
    custo: { buscas_gastas: 0, videos_list: 0, channels_list: 0 },
    funil: {},
    por_categoria: {},
    exemplos: [],
    descartados: { fora_da_duracao: 0, canal_grande: 0, abaixo_do_piso: 0 },
    erros: [],
  };

  // ── MODO DIAGNÓSTICO ────────────────────────────────────────────────────
  // A primeira rodada da sonda voltou ZERO candidatos, sem erro nenhum: a
  // documentação diz que `q` não é obrigatório, mas na prática
  // `videoCategoryId + videoDuration + order=viewCount` sem termo devolveu
  // lista vazia. Em vez de chutar qual parâmetro é o culpado, este modo testa
  // as combinações numa rodada só e diz qual delas traz item.
  if (req.query.diag === '1') {
    const variantes = [
      { nome: 'categoria + long + viewCount (o que falhou)', p: { videoCategoryId: '27', videoDuration: 'long', order: 'viewCount' } },
      { nome: 'categoria + long, SEM order', p: { videoCategoryId: '27', videoDuration: 'long' } },
      { nome: 'categoria + long + order=date', p: { videoCategoryId: '27', videoDuration: 'long', order: 'date' } },
      { nome: 'q generico + long + viewCount', p: { q: 'documentario', videoDuration: 'long', order: 'viewCount' } },
      { nome: 'q generico + long + viewCount + 30d', p: { q: 'documentario', videoDuration: 'long', order: 'viewCount', publishedAfter: new Date(Date.now() - 30 * 864e5).toISOString() } },
      { nome: 'so q generico, sem duracao', p: { q: 'documentario', order: 'viewCount' } },
    ];
    const saida = [];
    for (const v of variantes) {
      try {
        const r = await youtubeRequest('search', Object.assign({ part: 'snippet', type: 'video', maxResults: 10 }, v.p));
        const itens = (r && r.items) || [];
        saida.push({
          variante: v.nome, itens: itens.length,
          total_estimado: (r && r.pageInfo && r.pageInfo.totalResults) != null ? r.pageInfo.totalResults : null,
          exemplo: itens[0] ? (itens[0].snippet && itens[0].snippet.title || '').slice(0, 55) : null,
        });
      } catch (e) {
        saida.push({ variante: v.nome, erro: String(e.message || e).slice(0, 180) });
      }
    }
    return res.status(200).json({ ok: true, diagnostico: saida, buscas_gastas: variantes.length });
  }

  try {
    const candidatos = new Map();   // videoId -> categoria de origem

    // ── 1) BUSCA. É o passo caro; tudo abaixo é barato. ───────────────────
    const termos = req.query.termos
      ? String(req.query.termos).split(',').map((t) => t.trim()).filter(Boolean).slice(0, 8)
      : fatiaDeTermos(buscas, Date.now());
    for (let i = 0; i < termos.length && i < buscas; i++) {
      const termo = termos[i];
      // `long` (+20min) cobre a metade de cima da faixa pedida (15-50min);
      // `medium` (4-20min) cobre a de baixo. Alterna entre as duas.
      const balde = i % 2 === 0 ? 'long' : 'medium';
      // ⚠️ `order=viewCount` devolve os MAIS VISTOS DE TODOS OS TEMPOS pro
      // termo — ou seja, justamente os canais famosos que a regra dos 70 mil
      // inscritos existe pra excluir. MEDIDO: 4 buscas assim renderam 1 vídeo,
      // com 23 dos 24 canais grandes demais.
      // `order=date` + janela recente inverte isso: traz o que é NOVO, e quem
      // decide se é viral passa a ser o piso de views. Canal de 20 mil
      // inscritos com 300 mil views em 30 dias é a assinatura do dark.
      // `relevance` é o terceiro caminho e o mais promissor: é a mistura do
      // próprio YouTube, que não devolve nem o gigante de sempre (viewCount)
      // nem o recém-publicado sem audiência (date).
      const ORDENS = ['date', 'viewCount', 'relevance', 'rating'];
      const ordem = ORDENS.includes(req.query.order) ? req.query.order : 'date';
      const dias = Math.max(0, parseInt(req.query.dias || '90', 10));
      try {
        const params = {
          part: 'snippet',
          type: 'video',
          q: termo,
          videoDuration: balde,
          order: ordem,
          maxResults: 50,
        };
        if (ordem === 'date' && dias) params.publishedAfter = new Date(Date.now() - dias * 864e5).toISOString();
        const r = await youtubeRequest('search', params);
        relatorio.custo.buscas_gastas++;
        const itens = (r && r.items) || [];
        relatorio.por_categoria[`${termo} (${balde})`] = itens.length;
        for (const it of itens) {
          const id = it.id && it.id.videoId;
          if (id) candidatos.set(id, termo);
        }
      } catch (e) {
        relatorio.erros.push(`busca "${termo}" ${balde}: ${String(e.message || e).slice(0, 140)}`);
      }
    }
    relatorio.funil.candidatos_da_busca = candidatos.size;
    if (!candidatos.size) {
      return res.status(200).json({ ok: false, motivo: 'a busca não devolveu nada', ...relatorio });
    }

    // ── 2) DETALHES (1 unidade por lote de 50) ────────────────────────────
    const ids = [...candidatos.keys()];
    const videos = [];
    for (let i = 0; i < ids.length; i += 50) {
      const r = await youtubeRequest('videos', {
        part: 'snippet,contentDetails,statistics',
        id: ids.slice(i, i + 50).join(','),
        maxResults: 50,
      });
      relatorio.custo.videos_list++;
      for (const v of (r && r.items) || []) videos.push(v);
    }
    relatorio.funil.com_detalhes = videos.length;

    // ── 3) CORTE FINO DE DURAÇÃO (aqui, não no balde da API) ──────────────
    const naFaixa = videos.filter((v) => {
      const d = segundosDeISO(v.contentDetails && v.contentDetails.duration);
      if (d >= durMin && d <= durMax) return true;
      relatorio.descartados.fora_da_duracao++;
      return false;
    });
    relatorio.funil.na_faixa_de_duracao = naFaixa.length;

    // ── 4) INSCRITOS DO CANAL — o substituto do selo ──────────────────────
    const canais = [...new Set(naFaixa.map((v) => v.snippet && v.snippet.channelId).filter(Boolean))];
    const inscritos = {};
    for (let i = 0; i < canais.length; i += 50) {
      const r = await youtubeRequest('channels', {
        part: 'statistics,snippet',
        id: canais.slice(i, i + 50).join(','),
        maxResults: 50,
      });
      relatorio.custo.channels_list++;
      for (const c of (r && r.items) || []) {
        inscritos[c.id] = {
          subs: Number((c.statistics && c.statistics.subscriberCount) || 0),
          oculto: !!(c.statistics && c.statistics.hiddenSubscriberCount),
          nome: (c.snippet && c.snippet.title) || '',
        };
      }
    }
    relatorio.funil.canais_distintos = canais.length;

    const dark = naFaixa.filter((v) => {
      const c = inscritos[v.snippet && v.snippet.channelId];
      // Canal que ESCONDE a contagem não pode passar por engano: sem o número,
      // não dá pra afirmar que é pequeno. Na dúvida, fica de fora.
      if (!c || c.oculto || c.subs > maxInscritos) { relatorio.descartados.canal_grande++; return false; }
      return true;
    });
    relatorio.funil.de_canal_pequeno = dark.length;

    // ── 5) OS TRÊS PISOS DE VIEWS ─────────────────────────────────────────
    relatorio.funil.por_piso = {};
    for (const piso of PISOS) {
      relatorio.funil.por_piso[piso.toLocaleString('pt-BR') + ' views'] = dark.filter((v) => Number((v.statistics && v.statistics.viewCount) || 0) >= piso).length;
    }
    relatorio.descartados.abaixo_do_piso = dark.filter((v) => Number((v.statistics && v.statistics.viewCount) || 0) < PISOS[0]).length;

    // ── 6) A AMOSTRA, que é o que dá pra JULGAR ───────────────────────────
    // Número no funil não diz se o conteúdo presta. A lista abaixo diz.
    relatorio.exemplos = dark
      .filter((v) => Number((v.statistics && v.statistics.viewCount) || 0) >= PISOS[0])
      .sort((a, b) => Number(b.statistics.viewCount) - Number(a.statistics.viewCount))
      .slice(0, 15)
      .map((v) => {
        const c = inscritos[v.snippet.channelId] || {};
        const views = Number(v.statistics.viewCount || 0);
        const d = segundosDeISO(v.contentDetails.duration);
        return {
          titulo: (v.snippet.title || '').slice(0, 70),
          canal: c.nome,
          inscritos: c.subs,
          views,
          // A assinatura do dark: o vídeo estourou muito acima do tamanho do
          // canal. Canal de 20k com vídeo de 300k = 15x.
          views_por_inscrito: c.subs ? +(views / c.subs).toFixed(1) : null,
          duracao: Math.floor(d / 60) + 'min',
          categoria: candidatos.get(v.id) || '',
          url: 'https://youtube.com/watch?v=' + v.id,
        };
      });

    return res.status(200).json({ ok: true, ...relatorio });
  } catch (e) {
    return res.status(500).json({ ok: false, erro: String((e && e.message) || e).slice(0, 300), ...relatorio });
  }
};
