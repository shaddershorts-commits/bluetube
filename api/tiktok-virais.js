// api/tiktok-virais.js — TikTok Virais engine (2026-06-24)
// =====================================================================
// Actions:
//   coletar (cron 3x/dia 6/14/22 UTC) — busca top por país via TikAPI
//   listar (frontend GET) — retorna vídeos filtrados por período/país
//   limpar (cron diário 4h UTC) — DELETE vídeos > 30 dias
//
// TikAPI endpoint: GET /public/explore?country=XX&count=30
// Filtro local: stats.diggCount >= 1_000_000
// Países: us, br, mx, es, jp, kr, id, fr (8 países, conforme decisão)

// 2026-06-29: expandido pra 22 países × 12 coletas/dia × 50 vídeos/req.
// Alvo: 264 reqs/dia = 88% da quota Starter (300), margem 12% pra retries.
// Cobertura geográfica: Américas + Europa + Ásia + Oceania + África.
// CN: TikTok não opera oficialmente (lá é Douyin). Mantemos — TikAPI tenta.
const COUNTRIES = [
  // Originais (17)
  'us', 'br', 'mx', 'es', 'jp', 'kr', 'id', 'fr',
  // 'gb' (não 'uk') — ISO 3166-1 alpha-2 oficial. uk dá HTTP 400 no TikAPI.
  'gb', 'de', 'it', 'ph', 'th', 'vn', 'tr', 'ca', 'cn',
  // Novos 2026-06-29 (5): cobertura geográfica expandida
  'ar', // Argentina (LATAM)
  'au', // Austrália (Oceania)
  'nl', // Holanda (Norte Europa)
  'za', // África do Sul (África)
  'se', // Suécia (Norte Europa)
];
// 2026-06-29: Chunk de 5 saturava rate-limit per-second do TikAPI Starter.
// Comportamento observado: 2 primeiros reqs do chunk passam, 3 últimos retornam
// HTTP 403 com response vazio. TikAPI parece permitir ~2 reqs simultâneos.
// Solução: chunks de 2 + delay maior. Total: 22 países / 2 = 11 chunks ×
// (1.5s delay + ~2s TikAPI) ≈ 35-45s, cabe nos 60s timeout Vercel.
const PARALLEL_CHUNK_SIZE = 2;
const PARALLEL_CHUNK_DELAY_MS = 1500;
const MIN_LIKES = 800_000;

// ═══════════════════════════════════════════════════════════════════════════
// FONTE GRÁTIS (2026-08-12) — TikWM
// ═══════════════════════════════════════════════════════════════════════════
// POR QUE MUDOU: o TikAPI ficou caro E parou de entregar. Medido em 12/08: a
// última inserção real foi 05/08 22:19; desde então ~40 rodadas devolveram
// `inseridos: 0 | falhas país: 6` — e TODAS apareceram VERDES no GitHub, porque
// o workflow só considera erro quando o HTTP não é 200. Com a limpeza de 30
// dias, a aba TikTok esvaziaria sozinha por volta de 04/09.
//
// A FONTE: www.tikwm.com — o MESMO espelho grátis que o BaixaBlue já usa em
// produção pro download de TikTok desde 27/07 (api/_helpers/tiktok-download.js).
// Não é fornecedor novo: é fornecedor conhecido, num endpoint que ainda não
// usávamos. Sem chave, sem conta, sem cookie.
//
// MEDIDO em 12/08 contra o serviço real:
//   · challenge/search?keywords=X  → data.challenge_list[0].id
//   · challenge/posts?challenge_id=N&count=&cursor=  → data.videos (16/página),
//     data.hasMore, data.cursor. Paginação limpa: 25 páginas seguidas, 389
//     únicos, ZERO duplicata.
//   · 45 requisições em 106s → 0 falhas → 626 únicos → 75 acima de 800k likes,
//     e os 75 eram INÉDITOS no banco. Mediana 1,83M likes / 19,2M views (o
//     acervo atual é 1,9M / 18,6M — mesma qualidade).
//
// ⚠️ AS TRÊS ARMADILHAS MEDIDAS, e como cada uma está tratada aqui:
//  1) O limite de vazão volta como **HTTP 200 com code:-1**. É EXATAMENTE o
//     modo de falha que matou esta coleta (7 dias) e a do Instagram (5 dias) em
//     silêncio. Por isso `tikwmGet` trata `code !== 0` como FALHA, e a rodada
//     que não grava nada responde 503 — pro cron ficar VERMELHO.
//  2) `feed/list` (o análogo do explore por país) é instável e seu modo de
//     falha é um HTTP 531 que demora 34-38s. Por isso a coleta vai por
//     HASHTAG, que mediu 45/45 de sucesso — e todo fetch tem timeout curto.
//  3) A Cloudflare já está comendo o TikWM por dentro: feed/search, user/posts
//     e music/posts já respondem 403. Nada garante que challenge/posts não seja
//     o próximo — daí o TikAPI CONTINUAR como reserva, nunca removido.
//
// O QUE PIORA, dito na cara: por hashtag o acervo fica mais VELHO (mediana de
// 274 dias na coleta, contra 60 do TikAPI). O feed do TikAPI já era evergreen
// (77% chegava com +30 dias), então é diferença de grau — mas é 4,5x.
const TIKWM_BASE = 'https://www.tikwm.com/api';
// 1,2s entre chamadas: o anunciado é 1 req/s e a 1,2s foram 45 requisições sem
// um único bloqueio. Não é lugar de economizar 200ms.
const TIKWM_PAUSA_MS = 1200;
// Curto DE PROPÓSITO: o modo de falha lento do TikWM devolve 531 em 34-38s.
// Quatro desses numa rodada estouram o --max-time do workflow.
const TIKWM_TIMEOUT_MS = 12000;
// Teto de TEMPO, não de requisições: quando o TikWM está lento a rodada colhe
// menos em vez de estourar o relógio do cron (--max-time 180 no workflow).
const TIKWM_TETO_MS = 120000;
const TIKWM_PAGINAS_POR_TAG = 8;
const TIKWM_TAGS_POR_RODADA = 6;
// Onde procurar. Isto NÃO é o filtro do que entra — quem decide é o piso de
// MIN_LIKES, que continua o mesmo. A lista é grande e a rodada usa uma fatia
// rotativa, pra duas rodadas seguidas não vasculharem o mesmo lugar e trazerem
// os mesmos vídeos.
const TIKWM_HASHTAGS = [
  'viral', 'fyp', 'foryou', 'trending', 'funny', 'comedy',
  'dance', 'satisfying', 'football', 'futebol', 'cat', 'dog',
  'prank', 'edit', 'anime', 'gym', 'cooking', 'magic',
  'art', 'baby', 'humor', 'skills',
];
// 2026-06-29: tentei 30 → 50 mas TikAPI Starter retornou 0.00kb (provavelmente
// rejeita count > 30 mas conta o req como usado). Voltado pra 30, valor seguro.
const FETCH_COUNT_PER_COUNTRY = 30;
const RETENTION_DAYS = 30;
// Robustez 2026-06-29:
const MAX_RETRIES = 1;              // 1 retry em 429/5xx (backoff 2s)
const RETRY_BACKOFF_MS = 2000;
const CIRCUIT_BREAKER_FAIL_RATIO = 0.5;  // se >50% países falham, aborta resto

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const SU = process.env.SUPABASE_URL;
  const SK = process.env.SUPABASE_SERVICE_KEY;
  const TIKAPI_KEY = process.env.TIKAPI_KEY;
  if (!SU || !SK) return res.status(500).json({ error: 'config_missing' });

  const h = { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' };
  const action = req.query.action || (req.body && req.body.action);

  try {
    if (action === 'coletar') return await coletar(req, res, { SU, h, TIKAPI_KEY });
    if (action === 'listar')  return await listar(req, res, { SU, h });
    if (action === 'limpar')  return await limpar(req, res, { SU, h });
    if (action === 'cache-thumbs') return await cacheThumbs(req, res, { SU, SK, h });
    if (action === 'health') return await health(req, res, { SU, h });
    return res.status(400).json({ error: 'action_invalida', actions: ['coletar', 'listar', 'limpar', 'cache-thumbs', 'health'] });
  } catch (e) {
    console.error('[tiktok-virais fatal]', e?.message);
    return res.status(500).json({ error: e?.message });
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// FONTE GRÁTIS: TikWM
// ═══════════════════════════════════════════════════════════════════════════

// ⚠️ A FUNÇÃO MAIS IMPORTANTE DESTE ARQUIVO.
// O TikWM responde HTTP 200 com `code:-1` quando barra por vazão. Quem olhar só
// o status HTTP vê 200, insere zero e reporta verde — que é literalmente como
// esta coleta morreu por 7 dias sem ninguém notar. Aqui `code !== 0` é FALHA,
// e a falha SOBE (não vira lista vazia silenciosa).
async function tikwmGet(caminho, params) {
  const qs = new URLSearchParams(params).toString();
  const r = await fetch(`${TIKWM_BASE}/${caminho}?${qs}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36',
      accept: 'application/json',
    },
    signal: AbortSignal.timeout(TIKWM_TIMEOUT_MS),
  });
  if (!r.ok) return { ok: false, erro: 'http_' + r.status };
  const d = await r.json().catch(() => null);
  if (!d) return { ok: false, erro: 'corpo_ilegivel' };
  // AQUI. `code:-1` com HTTP 200 é o disfarce.
  if (d.code !== 0) return { ok: false, erro: String(d.msg || 'code_' + d.code).slice(0, 80) };
  return { ok: true, data: d.data };
}

const pausa = (ms) => new Promise((r) => setTimeout(r, ms));

// ⚠️ UM EMOJI PARTIDO AO MEIO DERRUBA O LOTE INTEIRO. Medido em 12/08/2026:
// uma rodada com 133 vídeos qualificados gravou ZERO, e o Postgres devolveu
// `PGRST102 "Empty or invalid json"`. A causa era UM vídeo — legenda cortada em
// 500 caracteres bem no meio de um emoji ("...Foil 👹👹👹🧚🏼✨ #asmrfa"), deixando
// metade de um par substituto solto. Meio emoji não é UTF-8 válido, e o
// PostgREST recusa o CORPO todo, não a linha ruim.
//
// Como o corte é NOSSO, o defeito é nosso — e ele existe desde sempre também no
// caminho do TikAPI, que corta a legenda do mesmo jeito. Por isso esta função é
// usada nos dois.
function textoSeguro(s, max) {
  return String(s == null ? '' : s)
    // Postgres não aceita NUL em coluna de texto, em hipótese nenhuma.
    .replace(/\u0000/g, '')
    .slice(0, max)
    // Sobras do corte: metade de cima sem a de baixo, e vice-versa.
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '')
    .replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
}

// Grava em blocos. A higienização acima mata a causa CONHECIDA; isto limita o
// estrago da próxima, que ainda não conhecemos: uma linha ruim custa o bloco
// dela, não a rodada inteira. Foi assim que 133 vídeos viraram zero.
const UPSERT_BLOCO = 50;

async function gravarEmBlocos(rows, { SU, h }) {
  const saida = { gravados: 0, blocos_ok: 0, blocos_falha: 0, erros: [] };
  for (let i = 0; i < rows.length; i += UPSERT_BLOCO) {
    const bloco = rows.slice(i, i + UPSERT_BLOCO);
    try {
      const up = await fetch(`${SU}/rest/v1/tiktok_virais?on_conflict=tiktok_video_id`, {
        method: 'POST',
        headers: { ...h, Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(bloco),
      });
      if (up.ok) { saida.gravados += bloco.length; saida.blocos_ok++; continue; }
      saida.blocos_falha++;
      saida.erros.push((await up.text()).slice(0, 160));
    } catch (e) {
      saida.blocos_falha++;
      saida.erros.push(String((e && e.message) || e).slice(0, 160));
    }
  }
  return saida;
}

// A hashtag é buscada por NOME e o TikWM devolve um id numérico; challenge/posts
// só aceita o id. Resolvido uma vez por rodada e reaproveitado entre páginas.
async function resolverHashtag(nome) {
  const r = await tikwmGet('challenge/search', { keywords: nome, count: 5 });
  if (!r.ok) return { ok: false, erro: r.erro };
  const lista = (r.data && r.data.challenge_list) || [];
  // A busca devolve variações ("fypシ"); a primeira é a de maior alcance.
  const id = lista[0] && lista[0].id;
  return id ? { ok: true, id: String(id) } : { ok: false, erro: 'hashtag_sem_id' };
}

// Rotação: duas rodadas seguidas não vasculham as mesmas hashtags. Sem isto, o
// cron de 3 em 3 horas traria em boa parte os mesmos vídeos, e o volume DIÁRIO
// de vídeos únicos seria muito menor que o volume por rodada sugere.
function fatiaDeHashtags(agora) {
  const passo = Math.floor(agora / (3 * 3600 * 1000));   // muda a cada 3h, como o cron
  const inicio = (passo * TIKWM_TAGS_POR_RODADA) % TIKWM_HASHTAGS.length;
  const fatia = [];
  for (let i = 0; i < TIKWM_TAGS_POR_RODADA; i++) {
    fatia.push(TIKWM_HASHTAGS[(inicio + i) % TIKWM_HASHTAGS.length]);
  }
  return fatia;
}

// Um item cru do TikWM vira uma linha do banco. As 17 colunas continuam as
// mesmas — o front, o Blublu e a limpeza não sabem que a fonte mudou.
function linhaDeTikwm(v, agoraIso, thumb) {
  const handle = (v.author && v.author.unique_id) || null;
  const id = String(v.video_id || v.id || '');
  return {
    tiktok_video_id: id,
    video_url: `https://www.tiktok.com/@${handle || 'tiktok'}/video/${id}`,
    thumbnail_url: thumb || v.cover || v.origin_cover || v.ai_dynamic_cover || null,
    // textoSeguro, não slice: legenda e nome de criador são campos cheios de
    // emoji, e é o corte no meio de um deles que derruba o lote inteiro.
    caption: textoSeguro(v.title, 500),
    author_handle: handle,
    author_name: textoSeguro((v.author && v.author.nickname) || '', 100) || null,
    author_avatar: (v.author && v.author.avatar) || null,
    likes_count: v.digg_count || 0,
    views_count: v.play_count || 0,
    comments_count: v.comment_count || 0,
    shares_count: v.share_count || 0,
    // O TikWM diz de que país é CADA vídeo (o TikAPI dizia de que país era a
    // BUSCA). É um dado melhor: minúsculo pra casar com o filtro do front.
    country: String(v.region || '').toLowerCase() || null,
    duration_sec: v.duration || 0,
    // Obrigatório mesmo o grid não usando: o Blublu filtra o acervo por esta
    // coluna quando alguém pede janela de tempo (api/blublu-chat.js). Nula, o
    // vídeo some das respostas dele.
    tiktok_created_at: v.create_time ? new Date(v.create_time * 1000).toISOString() : null,
    collected_at: agoraIso,
    last_seen_at: agoraIso,
    status: 'active',
  };
}

// `tagsPedidas` só vem do disparo MANUAL do admin (?tags=cat,dog). O cron nunca
// passa nada e continua usando a fatia rotativa do relógio.
//
// Por que isso existe: a rotação é calculada pela HORA, então disparar a coleta
// quatro vezes seguidas dentro da mesma janela de 3h vasculharia as MESMAS seis
// hashtags e traria quase os mesmos vídeos. Pra encher o acervo de uma vez —
// depois de uma parada longa, por exemplo — é preciso poder dizer onde procurar.
async function coletarViaTikWM({ SU, SK, h }, tagsPedidas) {
  const inicio = Date.now();
  const stat = { fonte: 'tikwm', requisicoes: 0, brutos: 0, unicos: 0, qualificados: 0, inseridos: 0, tags_ok: 0, tags_falhas: {}, parou_por: null };
  const vistos = new Set();
  const qualificados = [];

  const tags = (tagsPedidas && tagsPedidas.length) ? tagsPedidas : fatiaDeHashtags(Date.now());
  stat.tags = tags;
  for (const tag of tags) {
    if (Date.now() - inicio > TIKWM_TETO_MS) { stat.parou_por = 'teto_de_tempo'; break; }
    stat.requisicoes++;
    const alvo = await resolverHashtag(tag);
    await pausa(TIKWM_PAUSA_MS);
    if (!alvo.ok) { stat.tags_falhas[tag] = alvo.erro; continue; }

    let cursor = 0;
    let paginasOk = 0;
    for (let p = 0; p < TIKWM_PAGINAS_POR_TAG; p++) {
      if (Date.now() - inicio > TIKWM_TETO_MS) { stat.parou_por = 'teto_de_tempo'; break; }
      stat.requisicoes++;
      const r = await tikwmGet('challenge/posts', { challenge_id: alvo.id, count: 30, cursor });
      await pausa(TIKWM_PAUSA_MS);
      if (!r.ok) { stat.tags_falhas[tag] = r.erro; break; }
      const videos = (r.data && r.data.videos) || [];
      stat.brutos += videos.length;
      for (const v of videos) {
        const id = String(v.video_id || v.id || '');
        if (!id || vistos.has(id)) continue;
        vistos.add(id);
        if ((v.digg_count || 0) >= MIN_LIKES) qualificados.push(v);
      }
      paginasOk++;
      if (!r.data || !r.data.hasMore) break;
      cursor = r.data.cursor || cursor + videos.length;
    }
    if (paginasOk) stat.tags_ok++;
  }

  stat.unicos = vistos.size;
  stat.qualificados = qualificados.length;
  if (!qualificados.length) return stat;

  // Mesma cache de thumbnail do caminho antigo: a URL do TikTok expira em 3-5
  // dias e vira 403 na tela. Reuso, não reescrita.
  const agoraIso = new Date().toISOString();
  const thumbs = await Promise.all(qualificados.map(async (v) => {
    const original = v.cover || v.origin_cover || v.ai_dynamic_cover || null;
    if (!original) return null;
    try { return await cacheThumbnail(original, String(v.video_id || v.id), { SU, SK }); } catch (e) { return null; }
  }));

  const rows = qualificados.map((v, i) => linhaDeTikwm(v, agoraIso, thumbs[i]));
  const g = await gravarEmBlocos(rows, { SU, h });
  stat.inseridos = g.gravados;
  stat.blocos_ok = g.blocos_ok;
  if (g.blocos_falha) {
    stat.blocos_falha = g.blocos_falha;
    stat.erro_upsert = g.erros[0];
    console.error('[tiktok-virais:tikwm] blocos com falha:', g.blocos_falha, g.erros[0]);
  }
  return stat;
}

// ── COLETAR (cron a cada 3h) ─────────────────────────────────────────────────
// Cadeia de fontes, no mesmo desenho da cadeia de download do BaixaBlue:
//   1º TikWM (grátis)  ·  2º TikAPI (pago, RESERVA — nunca removido)
// A reserva só é acionada quando a primeira não trouxe NADA. Se o TikAPI não
// estiver configurado, isso não é erro: é a operação normal depois que a
// assinatura for cancelada.
async function coletar(req, res, { SU, h, TIKAPI_KEY }) {
  const SK = process.env.SUPABASE_SERVICE_KEY;
  // Auth: cron Vercel ou admin
  const isCron = !!req.headers['x-vercel-cron'];
  const isAdmin = req.query.admin_secret === process.env.ADMIN_SECRET;
  if (!isCron && !isAdmin) return res.status(401).json({ error: 'unauthorized' });

  // Hashtags escolhidas à mão (só no disparo manual do admin). Higienizadas: o
  // valor vira query string numa chamada a terceiro, então só letra e número
  // passam. Teto de 12 pra uma rodada manual não estourar o relógio.
  const tagsPedidas = String(req.query.tags || '')
    .split(',')
    .map((t) => t.trim().toLowerCase().replace(/[^a-z0-9]/g, ''))
    .filter(Boolean)
    .slice(0, 12);

  const fontes = [];
  let tikwm = null;
  if (process.env.TIKTOK_FONTE_TIKWM !== 'off') {
    try {
      tikwm = await coletarViaTikWM({ SU, SK, h }, tagsPedidas);
    } catch (e) {
      console.error('[tiktok-virais:tikwm]', e && e.message);
      tikwm = { fonte: 'tikwm', inseridos: 0, erro: String((e && e.message) || e).slice(0, 120) };
    }
    fontes.push(tikwm);
  }

  // Reserva. Só roda se a fonte grátis não trouxe nada — e só se houver chave.
  if ((!tikwm || !tikwm.inseridos) && TIKAPI_KEY) {
    const antigo = await coletarViaTikAPI(req, { SU, h, SK, TIKAPI_KEY });
    fontes.push(antigo);
    return responderColeta(res, fontes, antigo.by_country);
  }
  if ((!tikwm || !tikwm.inseridos) && !TIKAPI_KEY) {
    fontes.push({ fonte: 'tikapi', pulado: 'sem_chave' });
  }
  return responderColeta(res, fontes, {});
}

// ⚠️ O CONSERTO DO ALARME, e ele é o motivo de esta função existir.
// Rodada que não grava NADA responde 503. O workflow do GitHub só marca erro
// quando o HTTP não é 200 — então, antes disso, ~40 rodadas vazias seguidas
// apareceram verdes e a coleta ficou 7 dias morta sem ninguém saber.
// Trocar de fornecedor sem trocar isto só mudaria a data do próximo enterro.
function responderColeta(res, fontes, byCountry) {
  const total = fontes.reduce((n, f) => n + (f.inseridos || f.total_inserted || 0), 0);
  const corpo = {
    ok: total > 0,
    total_inserted: total,
    fontes,
    by_country: byCountry,
    timestamp: new Date().toISOString(),
  };
  if (total > 0) return res.status(200).json(corpo);
  corpo.error = 'coleta_vazia';
  corpo.detalhe = 'Nenhuma fonte gravou vídeo nesta rodada — isto é falha, não silêncio.';
  return res.status(503).json(corpo);
}

// ── FONTE RESERVA: TikAPI (o caminho original, intacto) ──────────────────────
async function coletarViaTikAPI(req, { SU, h, SK, TIKAPI_KEY }) {
  const results = { fonte: 'tikapi', ok: true, by_country: {}, total_inserted: 0, total_skipped: 0, total_failed: 0 };

  // 2026-06-24: chunked parallelization.
  // Primeira tentativa: 17 fetches simultâneos saturava rate per-second do
  // TikAPI (5 países falhavam aleatoriamente). Solução: chunks de 5 paralelos
  // com 800ms entre cada chunk. Tempo total: ~15-20s (cabe nos 120s).
  // Retry com backoff: 1 retry em 429/5xx (problema transitório).
  // Em 4xx (exceto 429): não retry — erro nosso (key inválida, etc).
  async function fetchTikAPIWithRetry(country) {
    const url = `https://api.tikapi.io/public/explore?country=${country}&count=${FETCH_COUNT_PER_COUNTRY}`;
    let lastError = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const r = await fetch(url, {
          headers: { 'X-API-KEY': TIKAPI_KEY, 'accept': 'application/json' },
          signal: AbortSignal.timeout(25000),
        });
        // Sucesso ou erro permanente (4xx exceto 429) — retorna
        if (r.ok) return { ok: true, status: r.status, response: r, attempts: attempt + 1 };
        const isRetryable = r.status === 429 || r.status >= 500;
        if (!isRetryable || attempt === MAX_RETRIES) {
          return { ok: false, status: r.status, response: r, attempts: attempt + 1 };
        }
        // Retry: aguarda backoff
        console.warn(`[tiktok-virais:${country}] HTTP ${r.status} attempt ${attempt+1}, retry em ${RETRY_BACKOFF_MS}ms`);
        await new Promise(rs => setTimeout(rs, RETRY_BACKOFF_MS * (attempt + 1)));
      } catch (e) {
        lastError = e;
        if (attempt === MAX_RETRIES) break;
        console.warn(`[tiktok-virais:${country}] ${e.message} attempt ${attempt+1}, retry em ${RETRY_BACKOFF_MS}ms`);
        await new Promise(rs => setTimeout(rs, RETRY_BACKOFF_MS * (attempt + 1)));
      }
    }
    return { ok: false, error: lastError?.message || 'unknown', attempts: MAX_RETRIES + 1 };
  }

  async function coletarPais(country) {
    const stat = { fetched: 0, qualified: 0, inserted: 0, errors: 0, attempts: 0 };
    try {
      const result = await fetchTikAPIWithRetry(country);
      stat.attempts = result.attempts;
      if (!result.ok) {
        stat.errors++;
        return { country, stat: { ...stat, http_status: result.status, error: result.error }, failed: true };
      }
      const r = result.response;
      const data = await r.json();
      const items = Array.isArray(data?.itemList) ? data.itemList : [];
      stat.fetched = items.length;

      const qualified = items.filter(v => (v?.stats?.diggCount || 0) >= MIN_LIKES);
      stat.qualified = qualified.length;

      const now = new Date().toISOString();
      // Faz cache da thumbnail no Supabase Storage ANTES de salvar
      // (TikTok URLs expiram em ~3-5d → 403). Cache permanente + CDN Cloudflare.
      // Se cache falhar, mantém URL original (frontend ainda renderiza enquanto fresh).
      const cached = await Promise.all(qualified.map(async v => {
        const original = v.video?.cover || v.video?.dynamicCover || null;
        if (!original) return null;
        return await cacheThumbnail(original, v.id, { SU, SK });
      }));
      const rows = qualified.map((v, i) => ({
        tiktok_video_id: v.id,
        video_url: `https://www.tiktok.com/@${v.author?.uniqueId || 'tiktok'}/video/${v.id}`,
        thumbnail_url: cached[i] || v.video?.cover || v.video?.dynamicCover || null,
        // Mesmo defeito de sempre, mesmo conserto: cortar em 500 pode partir um
        // emoji e derrubar o lote INTEIRO com PGRST102. Vale aqui também.
        caption: textoSeguro(v.desc, 500),
        author_handle: v.author?.uniqueId || null,
        author_name: textoSeguro(v.author?.nickname || '', 100) || null,
        author_avatar: v.author?.avatarLarger || v.author?.avatarMedium || null,
        likes_count: v.stats?.diggCount || 0,
        views_count: v.stats?.playCount || 0,
        comments_count: v.stats?.commentCount || 0,
        shares_count: v.stats?.shareCount || 0,
        country,
        duration_sec: v.video?.duration || 0,
        tiktok_created_at: v.createTime ? new Date(v.createTime * 1000).toISOString() : null,
        collected_at: now,
        last_seen_at: now,
        status: 'active',
      }));

      if (rows.length) {
        const upR = await fetch(`${SU}/rest/v1/tiktok_virais?on_conflict=tiktok_video_id`, {
          method: 'POST',
          headers: { ...h, Prefer: 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify(rows),
        });
        if (upR.ok) {
          stat.inserted = rows.length;
        } else {
          const errText = await upR.text();
          console.error(`[tiktok-virais:coletar:${country}] upsert ${upR.status}:`, errText.slice(0, 200));
          stat.errors++;
          return { country, stat, failed: true };
        }
      }
      return { country, stat, skipped: rows.length === 0 };
    } catch (e) {
      console.error(`[tiktok-virais:coletar:${country}]`, e?.message);
      stat.errors++;
      return { country, stat, failed: true };
    }
  }

  // Quebra em chunks de PARALLEL_CHUNK_SIZE com pausa entre cada.
  // Circuit breaker: avalia taxa de falha ACUMULADA após processar pelo menos
  // 6 países (3 chunks). Em chunks pequenos (2), uma única falha isolada não
  // dispara mais (evita falsos positivos). Só aborta se >50% do total processado
  // até agora falhou — sinal de outage real do TikAPI.
  const allResults = [];
  let circuitBroken = false;
  const MIN_COUNTRIES_BEFORE_BREAKER = 6;
  let totalProcessed = 0;
  let totalFailed = 0;
  for (let i = 0; i < COUNTRIES.length; i += PARALLEL_CHUNK_SIZE) {
    if (circuitBroken) break;
    const chunk = COUNTRIES.slice(i, i + PARALLEL_CHUNK_SIZE);
    const chunkResults = await Promise.allSettled(chunk.map(coletarPais));
    allResults.push(...chunkResults);
    // Acumula stats
    totalProcessed += chunk.length;
    totalFailed += chunkResults.filter(r => r.status === 'rejected' || (r.value && r.value.failed)).length;
    // Circuit breaker: só dispara após mínimo de países E se >50% total falhou
    if (totalProcessed >= MIN_COUNTRIES_BEFORE_BREAKER) {
      const cumFailRatio = totalFailed / totalProcessed;
      if (cumFailRatio > CIRCUIT_BREAKER_FAIL_RATIO) {
        console.error(`[tiktok-virais] CIRCUIT BREAKER: ${totalFailed}/${totalProcessed} países (${Math.round(cumFailRatio*100)}%) falharam até agora. Abortando próximos pra preservar quota.`);
        results.circuit_broken = true;
        results.circuit_broken_at_chunk = i;
        circuitBroken = true;
      }
    }
    // Pausa entre chunks (exceto após o último ou se quebrou)
    if (!circuitBroken && i + PARALLEL_CHUNK_SIZE < COUNTRIES.length) {
      await new Promise(rs => setTimeout(rs, PARALLEL_CHUNK_DELAY_MS));
    }
  }

  // Consolida resultados de cada país
  for (const s of allResults) {
    if (s.status === 'fulfilled' && s.value) {
      const { country, stat, failed, skipped } = s.value;
      results.by_country[country] = stat;
      if (failed) results.total_failed++;
      else if (skipped) results.total_skipped++;
      else results.total_inserted += stat.inserted;
    } else {
      results.total_failed++;
    }
  }

  return results;
}

// ── LISTAR (frontend GET) ────────────────────────────────────────────────────
// Params: period=24h|7d|30d, country=all|us|br|..., sort=likes|views|recent, limit, offset
async function listar(req, res, { SU, h }) {
  const period = req.query.period || '24h';
  const country = req.query.country || 'all';
  const sortParam = req.query.sort || 'likes';
  // 2026-07-25: sort=recent (paridade com a view Instagram) — mais novos primeiro
  const sort = sortParam === 'views' ? 'views_count' : sortParam === 'recent' ? 'collected_at' : 'likes_count';
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  const offset = Math.max(0, parseInt(req.query.offset) || 0);

  const PERIOD_MS = {
    '24h': 24 * 3600 * 1000,
    '7d':  7 * 24 * 3600 * 1000,
    '30d': 30 * 24 * 3600 * 1000,
  };
  const since = new Date(Date.now() - (PERIOD_MS[period] || PERIOD_MS['24h'])).toISOString();

  let url = `${SU}/rest/v1/tiktok_virais?status=eq.active&collected_at=gte.${since}`;
  if (country !== 'all' && COUNTRIES.includes(country)) {
    url += `&country=eq.${country}`;
  }
  url += `&order=${sort}.desc&limit=${limit}&offset=${offset}`;
  url += `&select=tiktok_video_id,video_url,thumbnail_url,caption,author_handle,author_name,author_avatar,likes_count,views_count,comments_count,shares_count,country,duration_sec,tiktok_created_at,collected_at`;

  const r = await fetch(url, { headers: { ...h, Prefer: 'count=exact' } });
  const items = r.ok ? await r.json() : [];
  const total = parseInt((r.headers.get('content-range') || '').split('/')[1] || '0') || items.length;

  return res.status(200).json({
    ok: true,
    period, country, sort: sortParam, limit, offset, total,
    has_more: offset + items.length < total,
    items,
  });
}

// ── LIMPAR (cron diário) ─────────────────────────────────────────────────────
// DELETE vídeos com collected_at > 30 dias
async function limpar(req, res, { SU, h }) {
  const isCron = !!req.headers['x-vercel-cron'];
  const isAdmin = req.query.admin_secret === process.env.ADMIN_SECRET;
  if (!isCron && !isAdmin) return res.status(401).json({ error: 'unauthorized' });

  const cutoff = new Date(Date.now() - RETENTION_DAYS * 86400000).toISOString();
  const r = await fetch(`${SU}/rest/v1/tiktok_virais?collected_at=lt.${cutoff}`, {
    method: 'DELETE',
    headers: { ...h, Prefer: 'return=minimal' },
  });
  return res.status(200).json({
    ok: r.ok,
    cutoff,
    retention_days: RETENTION_DAYS,
    timestamp: new Date().toISOString(),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Cache de thumbnails no Supabase Storage
// TikTok URLs expiram em ~3-5 dias (403 depois). Baixamos a imagem e salvamos
// no bucket 'tiktok-thumbs/{video_id}.jpg' — URL pública estável + cache CDN
// Cloudflare (cdn.bluetubeviral.com configurado pra Supabase).
// ─────────────────────────────────────────────────────────────────────────────
const TIKTOK_THUMBS_BUCKET = 'tiktok-thumbs';

async function cacheThumbnail(tiktokUrl, videoId, { SU, SK }) {
  if (!tiktokUrl || !videoId) return null;
  // Já é URL do nosso Supabase? Skip
  if (tiktokUrl.includes(new URL(SU).hostname)) return tiktokUrl;
  try {
    // Baixa a imagem do TikTok CDN
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 8000);
    const r = await fetch(tiktokUrl, { signal: ctrl.signal });
    clearTimeout(tid);
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 1024 || buf.length > 5 * 1024 * 1024) return null; // 1KB-5MB sanity check
    const contentType = r.headers.get('content-type') || 'image/jpeg';
    const ext = contentType.includes('webp') ? 'webp' : contentType.includes('png') ? 'png' : 'jpg';
    const objectPath = `${videoId}.${ext}`;
    // Upload pro Supabase Storage (upsert)
    const upR = await fetch(`${SU}/storage/v1/object/${TIKTOK_THUMBS_BUCKET}/${objectPath}`, {
      method: 'POST',
      headers: {
        apikey: SK,
        Authorization: 'Bearer ' + SK,
        'Content-Type': contentType,
        'x-upsert': 'true',
        'cache-control': 'public, max-age=31536000, immutable',
      },
      body: buf,
    });
    if (!upR.ok) {
      const e = await upR.text();
      console.warn(`[tiktok-virais cache-thumb] upload ${videoId}: ${upR.status} ${e.slice(0,150)}`);
      return null;
    }
    return `${SU}/storage/v1/object/public/${TIKTOK_THUMBS_BUCKET}/${objectPath}`;
  } catch (e) {
    console.warn(`[tiktok-virais cache-thumb] ${videoId}:`, e.message);
    return null;
  }
}

// Job batch: re-cacheia thumbs dos vídeos no banco que ainda apontam pro TikTok CDN
// Útil pra migrar os 594 vídeos existentes pra Supabase, e como backup ongoing.
//
// Query: ?action=cache-thumbs[&limit=50][&force=1][&admin_secret=...]
//   limit (default 50, max 200) — quantos processar nessa execução
//   force=1 — re-cacheia mesmo URLs já no Supabase
async function cacheThumbs(req, res, { SU, SK, h }) {
  const isCron = !!req.headers['x-vercel-cron'];
  const isAdmin = req.query.admin_secret === process.env.ADMIN_SECRET;
  if (!isCron && !isAdmin) return res.status(401).json({ error: 'unauthorized' });

  const limit = Math.min(200, parseInt(req.query.limit || '50', 10));
  const force = req.query.force === '1';
  const myHost = new URL(SU).hostname;
  // Busca vídeos com thumbnail_url do TikTok CDN (não cacheada ainda)
  const filter = force
    ? `select=tiktok_video_id,thumbnail_url&limit=${limit}`
    : `thumbnail_url=not.is.null&thumbnail_url=not.ilike.*${encodeURIComponent(myHost)}*&select=tiktok_video_id,thumbnail_url&limit=${limit}`;
  const listR = await fetch(`${SU}/rest/v1/tiktok_virais?${filter}&order=collected_at.desc`, { headers: h });
  if (!listR.ok) return res.status(500).json({ error: 'list_failed' });
  const items = await listR.json();
  let cached = 0, failed = 0, skipped = 0;
  const updates = [];
  for (const item of items) {
    const cachedUrl = await cacheThumbnail(item.thumbnail_url, item.tiktok_video_id, { SU, SK });
    if (cachedUrl && cachedUrl !== item.thumbnail_url) {
      updates.push({ tiktok_video_id: item.tiktok_video_id, thumbnail_url: cachedUrl });
      cached++;
    } else if (cachedUrl === item.thumbnail_url) {
      skipped++;
    } else {
      failed++;
    }
    await new Promise(rs => setTimeout(rs, 100)); // rate limit
  }
  // Update em batch (upsert por on_conflict)
  if (updates.length) {
    await fetch(`${SU}/rest/v1/tiktok_virais?on_conflict=tiktok_video_id`, {
      method: 'POST',
      headers: { ...h, Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(updates),
    });
  }
  return res.status(200).json({
    ok: true, processed: items.length, cached, failed, skipped,
    remaining_estimate: items.length === limit ? 'mais a processar (rode de novo)' : 'completo',
    timestamp: new Date().toISOString(),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Health endpoint — monitora saúde do sistema de coleta
// ─────────────────────────────────────────────────────────────────────────────
// Retorna stats últimas 24h: total coletado, taxa de cache, distribuição por
// país, % uso da quota TikAPI estimado. Útil pra dashboard/alerta.
//
// Query: GET ?action=health
// Público (sem auth) — informações agregadas, sem PII.
async function health(req, res, { SU, h }) {
  const now = Date.now();
  const ONE_DAY = 24 * 60 * 60 * 1000;
  const oneDayAgo = new Date(now - ONE_DAY).toISOString();
  const supaHost = new URL(SU).hostname;

  // Busca vídeos coletados últimas 24h
  const r = await fetch(
    `${SU}/rest/v1/tiktok_virais?collected_at=gte.${oneDayAgo}&select=country,thumbnail_url,collected_at&order=collected_at.desc&limit=2000`,
    { headers: h }
  );
  if (!r.ok) return res.status(500).json({ error: 'query_failed' });
  const rows = await r.json();

  // Agrega stats
  const byCountry = {};
  const byHour = {};
  let cachedThumbs = 0, missingThumbs = 0;
  for (const row of rows) {
    byCountry[row.country] = (byCountry[row.country] || 0) + 1;
    const hour = row.collected_at.slice(0, 13);
    byHour[hour] = (byHour[hour] || 0) + 1;
    if (!row.thumbnail_url) missingThumbs++;
    else if (row.thumbnail_url.includes(supaHost)) cachedThumbs++;
  }
  const totalThumbs = rows.length - missingThumbs;
  const cacheRate = totalThumbs > 0 ? (cachedThumbs / totalThumbs) : 0;

  // Estimativa uso TikAPI (req por país × coletas hoje)
  const colHours = Object.keys(byHour).length;
  const estimatedReqs = colHours * COUNTRIES.length;
  const QUOTA_DAILY = 300;
  const quotaUsage = estimatedReqs / QUOTA_DAILY;

  // Total geral do banco
  const totalR = await fetch(`${SU}/rest/v1/tiktok_virais?select=tiktok_video_id&limit=1`, {
    headers: { ...h, Prefer: 'count=exact' },
  });
  const totalDb = parseInt(totalR.headers.get('content-range')?.split('/')[1] || '0', 10);

  return res.status(200).json({
    ok: true,
    timestamp: new Date().toISOString(),
    config: {
      countries: COUNTRIES.length,
      fetch_count_per_country: FETCH_COUNT_PER_COUNTRY,
      min_likes_threshold: MIN_LIKES,
      retention_days: RETENTION_DAYS,
      max_retries: MAX_RETRIES,
      circuit_breaker_threshold: CIRCUIT_BREAKER_FAIL_RATIO,
    },
    last_24h: {
      videos_inserted: rows.length,
      collection_runs: colHours,
      estimated_tikapi_reqs: estimatedReqs,
      tikapi_quota_usage_pct: Math.round(quotaUsage * 100),
      tikapi_quota_remaining: Math.max(0, QUOTA_DAILY - estimatedReqs),
      videos_by_country: byCountry,
      thumb_cache_rate_pct: Math.round(cacheRate * 100),
      thumbs_cached: cachedThumbs,
      thumbs_uncached: totalThumbs - cachedThumbs,
      thumbs_missing: missingThumbs,
    },
    database: {
      total_videos: totalDb,
    },
    status: estimatedReqs > QUOTA_DAILY * 0.95 ? 'WARNING_NEAR_QUOTA'
      : colHours < 4 ? 'WARNING_LOW_COLLECTIONS'
      : 'OK',
  });
}
