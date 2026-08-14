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

// Categorias com conteúdo dark de verdade. `search.list` aceita filtro sem
// termo de busca, e a categoria é o que espalha a descoberta em vez de deixar
// tudo cair no mesmo nicho.
const CATEGORIAS = {
  27: 'Educação',
  28: 'Ciência e Tecnologia',
  24: 'Entretenimento',
  22: 'Pessoas e Blogs',
  26: 'Como fazer / Estilo',
  25: 'Notícias e Política',
  20: 'Games',
  1: 'Filme e Animação',
};

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

  try {
    const candidatos = new Map();   // videoId -> categoria de origem

    // ── 1) BUSCA. É o passo caro; tudo abaixo é barato. ───────────────────
    for (let i = 0; i < buscas; i++) {
      const cat = cats[i % cats.length];
      // `long` (+20min) pega a metade de cima da faixa pedida; `medium`
      // (4-20min) pega a de baixo. Alterna entre as duas.
      const balde = i % 2 === 0 ? 'long' : 'medium';
      try {
        const r = await youtubeRequest('search', {
          part: 'snippet',
          type: 'video',
          videoDuration: balde,
          order: 'viewCount',
          videoCategoryId: cat,
          maxResults: 50,
        });
        relatorio.custo.buscas_gastas++;
        const itens = (r && r.items) || [];
        relatorio.por_categoria[`${CATEGORIAS[cat] || cat} (${balde})`] = itens.length;
        for (const it of itens) {
          const id = it.id && it.id.videoId;
          if (id) candidatos.set(id, CATEGORIAS[cat] || cat);
        }
      } catch (e) {
        relatorio.erros.push(`busca cat=${cat} ${balde}: ${String(e.message || e).slice(0, 140)}`);
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
