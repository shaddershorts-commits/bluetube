// api/instagram-virais.js — Instagram Virais engine (2026-07-25)
// =============================================================================
// Espelho do tiktok-virais.js, mas com coleta própria (conta descartável +
// API interna web via api/_helpers/instagram.js) em vez de TikAPI.
//
// Actions:
//   replicar           (admin POST) — cola URL + campos à mão → captura o que der
//                                     da página PÚBLICA (sem cookie), hospeda a
//                                     imagem no NOSSO storage e CONGELA o registro
//   adicionar          (admin POST) — cola URL de Reel → metadata completa → upsert
//   adicionar-perfil   (admin POST) — cola link de perfil → resolve id → 1ª coleta
//   coletar-perfis     (cron/admin) — Reels recentes de cada perfil ativo
//   atualizar-metricas (cron/admin) — refresh de views/likes dos mais antigos
//   listar             (público GET) — grid da Virais (padrão: TODOS, recentes)
//   remover            (admin POST) — remove um vídeo do acervo
//   toggle-perfil      (admin POST) — ativa/desativa perfil monitorado
//   listar-perfis      (admin GET)  — perfis monitorados
//   health             (público GET)— status agregado (sem PII)
//
// BLINDAGEM (pedido do user 2026-07-25): o banco é a fonte da verdade.
// Falha de coleta/refresh NUNCA deleta nem esconde vídeo já coletado — no
// pior caso as métricas ficam paradas (last_error registra o motivo) e o
// usuário final não nota nada.

const ig = require('./_helpers/instagram');

const IG_THUMBS_BUCKET = 'instagram-thumbs';
const REFRESH_BATCH = 20;          // vídeos por rodada de atualizar-metricas
const REFRESH_SPACING_MS = 1500;   // pausa entre chamadas ao IG (anti-flag)
const PERFIS_POR_RODADA = 3;       // perfis coletados por rodada do cron
const PERFIL_PAGE_SIZE = 12;       // Reels por perfil por rodada (1 página)
// Régua de qualidade da coleta AUTOMÁTICA (decisão do user 2026-07-25):
// só mega virais entram sozinhos — 3M+ views E 1M+ likes. Ajustável por env.
// Adição MANUAL (admin cola URL) ignora a régua: decisão explícita do admin.
const MIN_VIEWS_AUTO = parseInt(process.env.IG_MIN_VIEWS, 10) || 3_000_000;
const MIN_LIKES_AUTO = parseInt(process.env.IG_MIN_LIKES, 10) || 1_000_000;
const passaRegua = (m) => (m.views_count || 0) >= MIN_VIEWS_AUTO && (m.likes_count || 0) >= MIN_LIKES_AUTO;

// ── RÉPLICA (2026-08-10) ────────────────────────────────────────────────────
// Captura SEM login: a página pública pode falhar e isso é NORMAL — o dono
// digita o que faltar. Timeouts curtos porque essa chamada é opcional.
const PUBLICO_TIMEOUT_MS = 6000;   // fetch da página pública do Instagram
const IMG_TIMEOUT_MS = 10000;      // download da imagem (pode ser grande)
const IMG_MIN_BYTES = 1024;        // menos que isso = página de erro, não imagem
const IMG_MAX_BYTES = 5 * 1024 * 1024;
// UA de navegador comum. É o ÚNICO header de identidade que mandamos: nunca
// vai Cookie, nunca vai token da Meta, em requisição nenhuma deste arquivo.
const UA_PUBLICO = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
// CDN da frente do Supabase Storage (mesmo padrão do api/blue-feed.js).
// Sem a env, devolve a URL crua do Supabase — degrada, não quebra.
const CDN = process.env.SUPABASE_CDN_URL;

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const SU = process.env.SUPABASE_URL;
  const SK = process.env.SUPABASE_SERVICE_KEY;
  if (!SU || !SK) return res.status(500).json({ error: 'config_missing' });
  const h = { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' };

  const action = req.query.action || (req.body && req.body.action);
  const isCron = !!req.headers['x-vercel-cron'];
  const isAdmin = (req.query.admin_secret || (req.body && req.body.admin_secret)) === process.env.ADMIN_SECRET;

  try {
    if (action === 'listar') return await listar(req, res, { SU, h });
    if (action === 'health') return await health(req, res, { SU, h });

    // Crons (GH Actions com admin_secret; header x-vercel-cron aceito por
    // compatibilidade) — só ações de coleta, que nunca destroem nada
    if (action === 'coletar-perfis' || action === 'atualizar-metricas') {
      if (!isCron && !isAdmin) return res.status(401).json({ error: 'unauthorized' });
      if (action === 'coletar-perfis') return await coletarPerfis(req, res, { SU, SK, h });
      return await atualizarMetricas(req, res, { SU, h });
    }

    // Daqui pra baixo: SÓ admin explícito (header de cron NÃO basta — 'remover'
    // deleta acervo; blindagem exige que nada externo consiga apagar vídeo)
    if (!isAdmin) return res.status(401).json({ error: 'unauthorized' });

    if (action === 'adicionar') return await adicionar(req, res, { SU, SK, h });
    if (action === 'replicar') return await replicar(req, res, { SU, SK, h });
    if (action === 'adicionar-perfil') return await adicionarPerfil(req, res, { SU, SK, h });
    if (action === 'remover') return await remover(req, res, { SU, h });
    if (action === 'toggle-perfil') return await togglePerfil(req, res, { SU, h });
    if (action === 'listar-perfis') return await listarPerfis(req, res, { SU, h });
    if (action === 'salvar-cookies') return await salvarCookies(req, res, { SU, h });
    if (action === 'testar-conexao') return res.status(200).json(await ig.validarSessao());
    return res.status(400).json({ error: 'action_invalida' });
  } catch (e) {
    console.error('[instagram-virais fatal]', e && e.message);
    return res.status(500).json({ error: e && e.message });
  }
};

// ── Upload no NOSSO bucket (self-healing: cria o bucket se não existir) ─────
// Retorna { path } em caso de sucesso ou { erro } com o MOTIVO real — quem
// chama decide se loga, se avisa o admin ou se tenta a próxima fonte.
async function uploadThumb(buf, contentType, objectPath, { SU, SK }) {
  const upload = () => fetch(`${SU}/storage/v1/object/${IG_THUMBS_BUCKET}/${objectPath}`, {
    method: 'POST',
    headers: {
      apikey: SK, Authorization: 'Bearer ' + SK,
      'Content-Type': contentType, 'x-upsert': 'true',
      'cache-control': 'public, max-age=31536000, immutable',
    },
    body: buf,
  });
  let upR = await upload();
  if (!upR.ok) {
    const errText = await upR.text();
    if (/bucket/i.test(errText) && /not.*found/i.test(errText)) {
      // Bucket ainda não existe (SQL não rodado?) — cria e tenta de novo
      await fetch(`${SU}/storage/v1/bucket`, {
        method: 'POST',
        headers: { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: IG_THUMBS_BUCKET, name: IG_THUMBS_BUCKET, public: true }),
      }).catch(() => {});
      upR = await upload();
      if (upR.ok) return { path: objectPath };
      const err2 = await upR.text();
      return { erro: `o bucket "${IG_THUMBS_BUCKET}" não existia, tentei criar e o upload falhou de novo (HTTP ${upR.status}: ${err2.slice(0, 120)})` };
    }
    return { erro: `nosso storage recusou o arquivo (HTTP ${upR.status}: ${errText.slice(0, 140)})` };
  }
  return { path: objectPath };
}

// URL pública da nossa imagem. Guardamos SEMPRE a URL crua do Supabase no
// banco; a troca pelo CDN acontece na LEITURA (mesmo contrato do blue-feed.js),
// pra que ligar/desligar o CDN não exija reescrever o acervo.
function urlPublica(objectPath, { SU }, cacheBust) {
  const u = `${SU}/storage/v1/object/public/${IG_THUMBS_BUCKET}/${objectPath}`;
  return cacheBust ? `${u}?v=${cacheBust}` : u;
}

// Troca o host do Supabase pelo CDN na resposta (sem env, devolve igual)
function aplicarCDN(url) {
  if (!CDN || !url) return url;
  return url.replace(`${process.env.SUPABASE_URL}/storage/v1/object/public`, CDN);
}

// ── Thumbnail: cacheia no NOSSO storage (fbcdn expira em dias) ───────────────
// Usado pela coleta LOGADA antiga. Mantido com o comportamento original:
// falha silenciosa (retorna null) e quem chama cai na URL da Meta.
async function cacheThumbnail(origemUrl, shortcode, { SU, SK }) {
  if (!origemUrl || !shortcode) return null;
  if (origemUrl.includes(new URL(SU).hostname)) return origemUrl; // já é nossa
  try {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 8000);
    const r = await fetch(origemUrl, { signal: ctrl.signal });
    clearTimeout(tid);
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 1024 || buf.length > 5 * 1024 * 1024) return null;
    const contentType = r.headers.get('content-type') || 'image/jpeg';
    const ext = contentType.includes('webp') ? 'webp' : contentType.includes('png') ? 'png' : 'jpg';
    const up = await uploadThumb(buf, contentType, `${shortcode}.${ext}`, { SU, SK });
    if (up.erro) { console.warn(`[ig-virais thumb] ${shortcode}: ${up.erro}`); return null; }
    return urlPublica(up.path, { SU });
  } catch (e) {
    console.warn(`[ig-virais thumb] ${shortcode}:`, e.message);
    return null;
  }
}

// Metadata normalizada → row do banco (thumbnail já cacheada quando possível)
async function mediaParaRow(m, { SU, SK }, extras = {}) {
  const cached = await cacheThumbnail(m.thumbnail_origem, m.shortcode, { SU, SK });
  return {
    shortcode: m.shortcode,
    media_pk: m.media_pk,
    video_url: `https://www.instagram.com/reel/${m.shortcode}/`,
    thumbnail_url: cached || m.thumbnail_origem || null,
    caption: m.caption || null,
    author_handle: m.author_handle,
    author_name: m.author_name,
    author_pk: m.author_pk,
    duration_sec: m.duration_sec,
    ig_created_at: m.ig_created_at,
    // Métrica zerada NÃO entra no row: se o IG esconder play_count numa
    // resposta 200 (payload degenerado), o upsert preservaria o valor bom já
    // salvo em vez de zerar. No insert, o default 0 do banco cobre.
    ...(m.views_count > 0 ? { views_count: m.views_count } : {}),
    ...(m.likes_count > 0 ? { likes_count: m.likes_count } : {}),
    ...(m.comments_count > 0 ? { comments_count: m.comments_count } : {}),
    // status NUNCA vai no upsert: insert usa o default 'active' do banco, e
    // update PRESERVA o valor atual — Reel removido pelo admin (tombstone
    // status='removed') não ressuscita quando o coletor re-encontra ele.
    last_error: null,
    metrics_updated_at: new Date().toISOString(),
    last_seen_at: new Date().toISOString(),
    ...extras,
  };
}

async function upsertRows(rows, { SU, h }) {
  if (!rows.length) return true;
  // PostgREST exige chaves uniformes por lote; como métricas zeradas ficam de
  // fora do row (guarda anti-zeramento), agrupamos por assinatura de chaves.
  const grupos = new Map();
  for (const row of rows) {
    const sig = Object.keys(row).sort().join(',');
    if (!grupos.has(sig)) grupos.set(sig, []);
    grupos.get(sig).push(row);
  }
  let ok = true;
  for (const lote of grupos.values()) {
    const r = await fetch(`${SU}/rest/v1/instagram_virais?on_conflict=shortcode`, {
      method: 'POST',
      headers: { ...h, Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(lote),
    });
    if (!r.ok) { console.error('[ig-virais upsert]', r.status, (await r.text()).slice(0, 200)); ok = false; }
  }
  return ok;
}

// ── ADICIONAR (admin cola URL de Reel) ───────────────────────────────────────
async function adicionar(req, res, { SU, SK, h }) {
  const url = (req.body && req.body.url) || req.query.url;
  const shortcode = ig.parseShortcode(url);
  if (!shortcode) return res.status(400).json({ error: 'URL inválida — use instagram.com/reel/CODIGO/ ou /p/CODIGO/' });
  if (!(await ig.temCookies())) return res.status(500).json({ error: 'Cookies não configurados — salve no painel (campo Cookies da conta)' });

  let m;
  try {
    m = await ig.mediaInfo(shortcode);
  } catch (e) {
    const dica = e.status === 429 ? 'Instagram pediu calma (429) — espere alguns minutos.'
      : e.status === 404 ? 'Post não encontrado (deletado ou privado).'
      : 'Falha ao consultar o Instagram.';
    return res.status(502).json({ error: dica, detalhe: e.message });
  }
  if (!m.is_video) {
    const tipo = m.media_type === 8 ? 'um CARROSSEL' : 'uma FOTO';
    return res.status(400).json({ error: `Esse post é ${tipo} — a Virais só aceita vídeos/Reels.` });
  }

  // status:'active' explícito AQUI (e só aqui): admin colar a URL de novo é
  // intenção clara de reativar um Reel que estava com tombstone 'removed'
  const row = await mediaParaRow(m, { SU, SK }, { fonte: 'manual', status: 'active' });
  // collected_at só no INSERT (upsert não sobrescreve por não estar no body? PostgREST
  // merge-duplicates sobrescreve TODAS as colunas enviadas — então NÃO enviamos collected_at,
  // deixando o default do banco no insert e o valor antigo no update)
  const ok = await upsertRows([row], { SU, h });
  if (!ok) return res.status(500).json({ error: 'Falha ao salvar no banco' });
  // Manual entra mesmo abaixo da régua (decisão do admin), mas avisamos
  return res.status(200).json({ ok: true, video: row, abaixo_da_regua: !passaRegua(m) });
}

// ═══════════════════════════════════════════════════════════════════════════
// RÉPLICA — captura UMA vez, hospeda tudo, nunca mais volta ao Instagram
// ═══════════════════════════════════════════════════════════════════════════

// ── Validação estrita da URL ────────────────────────────────────────────────
// Não basta "contém instagram.com": conferimos o HOST de verdade, porque a URL
// digitada vira request de servidor logo em seguida.
function parseUrlInstagram(bruta) {
  let s = String(bruta || '').trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  let u;
  try { u = new URL(s); } catch (_) { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const host = u.hostname.toLowerCase();
  if (host !== 'instagram.com' && !host.endsWith('.instagram.com')) return null;
  // /reel/CODE/, /reels/CODE/, /p/CODE/, /tv/CODE/ — com ou sem @perfil na frente
  const m = u.pathname.match(/^\/(?:[A-Za-z0-9._]+\/)?(p|reel|reels|tv)\/([A-Za-z0-9_-]{5,20})\/?$/);
  if (!m) return null;
  const tipo = m[1] === 'reels' ? 'reel' : m[1];
  return { shortcode: m[2], tipo, url: `https://www.instagram.com/${tipo}/${m[2]}/` };
}

// ── Números escritos por humano ─────────────────────────────────────────────
// Aceita "12400000", "12.400.000", "12,4 mi", "12.4M", "1,2 bi", "340 mil".
// Devolve inteiro ou null (null = "não informado", que é diferente de zero).
function parseNumeroHumano(valor) {
  if (valor === null || valor === undefined) return null;
  if (typeof valor === 'number') return Number.isFinite(valor) && valor >= 0 ? Math.round(valor) : null;
  let s = String(valor).toLowerCase().trim();
  if (!s) return null;
  s = s.replace(/[\s\u00a0\u202f]/g, '')   // espaco comum, nbsp e narrow-nbsp
       .replace(/(visualizações|visualizacoes|views|curtidas|likes|comentários|comentarios|comments|plays)/g, '');
  if (!s) return null;
  let mult = 1;
  const sufixo = /(bi|mil|mi|b|m|k)$/.exec(s);
  if (sufixo) {
    const suf = sufixo[1];
    mult = (suf === 'bi' || suf === 'b') ? 1e9 : (suf === 'mil' || suf === 'k') ? 1e3 : 1e6;
    s = s.slice(0, -suf.length);
  }
  if (!s || !/^[\d.,]+$/.test(s)) return null;
  let n;
  if (!sufixo && /^\d{1,3}([.,]\d{3})+$/.test(s)) {
    n = parseFloat(s.replace(/[.,]/g, ''));   // 12.400.000 = separador de milhar
  } else {
    n = parseFloat(s.replace(/\.(?=\d{3}\b)/g, '').replace(',', '.'));
  }
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * mult);
}

function limpaTexto(v, max) {
  const s = String(v === null || v === undefined ? '' : v).replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : null;
}

// Data da medição: "2026-08-11" (input date) → meio-dia UTC, pra que o fuso
// do Brasil (UTC-3) não jogue a exibição pro dia anterior.
function parseDataMedicao(v) {
  const s = String(v || '').trim();
  if (!s) return new Date().toISOString();
  const so = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (so) return new Date(`${s}T12:00:00.000Z`).toISOString();
  const d = new Date(s);
  return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

function decodeEntidades(s) {
  return String(s || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

// Todas as <meta> da página → { property/name minúsculo: content }
// O regex precisa ser CIENTE DA ASPA que abriu o atributo: o og:description do
// Instagram vem entre aspas simples E contém aspas duplas (a legenda). Um
// [^"']* comum corta o valor na primeira aspa da legenda e perde a legenda
// inteira — foi exatamente isso que o smoke pegou.
function lerAtributo(tag, nomes) {
  const re = new RegExp('(?:' + nomes + ')\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s"\'>]+))', 'i');
  const m = re.exec(tag);
  if (!m) return null;
  return m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3];
}

function lerMetaTags(html) {
  const out = {};
  const re = /<meta\b[^>]*>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const tag = m[0];
    const p = lerAtributo(tag, 'property|name');
    const c = lerAtributo(tag, 'content');
    if (p && c !== null && !out[p.toLowerCase()]) out[p.toLowerCase()] = decodeEntidades(c);
  }
  return out;
}

// og:image de página de login/erro é logo do produto, não capa do post
function pareceCapaDePost(url) {
  if (!url || !/^https?:\/\//i.test(url)) return false;
  if (/\/rsrc\.php\//i.test(url) || /\/static\//i.test(url)) return false;
  return /cdninstagram\.com|fbcdn\.net/i.test(url);
}

// ── Fetch da página PÚBLICA — sem cookie, sem login, sem token ──────────────
// Os headers abaixo são a lista COMPLETA enviada. Nada da Meta sai daqui.
async function baixarPaginaPublica(url) {
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), PUBLICO_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent': UA_PUBLICO,
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
      },
      redirect: 'manual',   // redirect = parede de login; queremos SABER disso
      signal: ctrl.signal,
    });
    if (r.status >= 300 && r.status < 400) {
      return { erro: `o Instagram redirecionou (HTTP ${r.status}) — a página exigiu login` };
    }
    if (!r.ok) return { erro: `a página pública respondeu HTTP ${r.status}` };
    return { html: await r.text() };
  } catch (e) {
    return { erro: e && e.name === 'AbortError'
      ? `a página pública não respondeu em ${PUBLICO_TIMEOUT_MS / 1000}s`
      : `falha de rede (${(e && e.message) || 'desconhecida'})` };
  } finally {
    clearTimeout(tid);
  }
}

// ── PAREDE DE LOGIN — detecção por CONTEÚDO, nunca por status HTTP ──────────
// CENÁRIO EVITADO (o modo de falha MAIS PROVÁVEL de todos): o Instagram devolve
// a parede de login com HTTP **200**. Não é 3xx, então o redirect:'manual' não
// pega, e !r.ok é falso. O parser antigo tratava aquilo como post normal e
// extraía o og:description institucional da Meta como se fosse a LEGENDA do
// Reel — "Uma maneira simples, divertida e criativa de capturar, editar e
// compartilhar fotos, vídeos e mensagens com amigos e familiares." ia pro banco
// e era PUBLICADO na vitrine, sem aviso nenhum.
// O erro de desenho ficava evidente no contraste: falhar ALTO (302/401) deixava
// o título null e avisava o dono; só o modo de falha mais comum era mudo.
const FRASES_PAREDE = [
  // PT — copy institucional da parede de login
  /maneira simples,?\s*divertida e criativa de capturar/i,
  // EN — copy institucional nova da parede de login
  /share what you'?re into with the people who get you/i,
  // PT/EN — post removido / link quebrado
  /the link you followed may be broken/i,
  /o link que voc[eê] seguiu pode estar quebrado/i,
  /sorry,?\s*this page isn'?t available/i,
  /esta p[áa]gina n[ãa]o est[áa] dispon[íi]vel/i,
  // Variantes antigas do convite a logar
  /crie uma conta ou entre no instagram/i,
  /create an account or log ?in to instagram/i,
  /log ?in to instagram to see photos and videos/i,
  /entre no instagram para ver fotos e v[íi]deos/i,
];

// A copy muda de tempos em tempos; o formulário continua lá.
const MARCAS_LOGIN = [
  /<form[^>]+action\s*=\s*["'][^"']*\/accounts\/login/i,
  /name\s*=\s*["']password["']/i,
  /id\s*=\s*["']loginForm["']/i,
  /\/accounts\/login\/\?next=/i,
  /"LoginAndSignupPage"/,
];

// Prova de que o bloco do POST veio mesmo — qualquer uma basta.
const MARCAS_POST = [
  /edge_media_to_caption/i,
  /"shortcode"\s*:\s*"/i,
  /"video_view_count"\s*:/i,
  /"edge_media_preview_like"\s*:/i,
  /class\s*=\s*["'][^"']*\bCaption\b/i,
  /class\s*=\s*["'][^"']*EmbedVideo/i,
];

// Devolve o MOTIVO (string em português, pronta pra tela do admin) ou null.
// Regra da casa: na dúvida, "não consegui ler" — nunca publicar dado que o
// sistema não conseguiu ler de verdade.
function detectarParedeDeLogin(html, meta) {
  const src = String(html || '');
  const m = meta || lerMetaTags(src);
  const textoOg = (m['og:description'] || '') + ' \n ' + (m['og:title'] || '');
  // 1) og institucional = prova direta (é exatamente o caso reproduzido no smoke)
  if (FRASES_PAREDE.some((re) => re.test(textoOg))) {
    return 'a página devolveu a copy institucional da Meta no lugar do post (parede de login / post removido)';
  }
  // 2) o bloco do post existe? Se existe, é post de verdade e seguimos.
  if (MARCAS_POST.some((re) => re.test(src)) || pareceCapaDePost(m['og:image'])) return null;
  // 3) sem bloco de post, qualquer outro sinal fecha o caso
  if (FRASES_PAREDE.some((re) => re.test(src))) {
    return 'a página devolveu a copy institucional da Meta no lugar do post (parede de login / post removido)';
  }
  if (MARCAS_LOGIN.some((re) => re.test(src))) {
    return 'a página veio com formulário de login e sem o bloco do post (parede de login)';
  }
  return 'a página não trouxe o bloco do post — não dá pra afirmar que li o Reel';
}

// Texto que casa com a copy institucional NUNCA é legenda. Guarda extra pro dia
// em que a Meta trocar a moldura e a página escapar dos filtros acima.
function legendaSuspeita(s) {
  const t = String(s || '');
  return !t || FRASES_PAREDE.some((re) => re.test(t));
}

function decodeJsonString(s) {
  const bruto = String(s === null || s === undefined ? '' : s);
  try { return JSON.parse('"' + bruto.replace(/\r?\n/g, '\\n') + '"'); } catch (_) { /* cai no manual */ }
  return bruto
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hx) => String.fromCharCode(parseInt(hx, 16)))
    .replace(/\\n/g, ' ').replace(/\\t/g, ' ')
    .replace(/\\"/g, '"').replace(/\\\//g, '/').replace(/\\\\/g, '\\');
}

// A legenda REAL do /embed/captioned/ mora em edge_media_to_caption — e o
// código antigo NÃO parseava isso. Por isso dependia do og:description, que na
// parede de login é a copy da Meta. Esta função é a metade boa do defeito 2.
function legendaDoEmbed(html) {
  const src = String(html || '');
  const tentar = (s) => {
    const m = /"edge_media_to_caption"\s*:\s*\{\s*"edges"\s*:\s*\[\s*\{\s*"node"\s*:\s*\{\s*"text"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(s);
    return m ? decodeJsonString(m[1]) : null;
  };
  return tentar(src)
    || (src.indexOf('\\"edge_media_to_caption\\"') >= 0 ? tentar(src.replace(/\\"/g, '"')) : null);
}

// O /embed/captioned/ também renderiza a legenda em HTML: <div class="Caption">
// <a class="CaptionUsername">user</a> legenda… <div class="CaptionComments">
function legendaDoCaptionHtml(html) {
  const src = String(html || '');
  const abre = /class\s*=\s*["'][^"']*\bCaption\b[^"']*["']/i.exec(src);
  if (!abre) return null;
  const resto = src.slice(abre.index);
  const fim = resto.search(/class\s*=\s*["'][^"']*CaptionComments/i);
  const bloco = fim > 0 ? resto.slice(0, fim) : resto.slice(0, 8000);
  const txt = decodeEntidades(
    bloco
      .replace(/<a\b[^>]*class\s*=\s*["'][^"']*CaptionUsername[\s\S]*?<\/a>/i, ' ')
      .replace(/<[^>]*>/g, ' ')
  );
  return limpaTexto(txt, 2200);
}

// Extrai UMA página. NÃO decide nada sozinha: devolve cada campo com um nível
// de CONFIANÇA, pra que escolherEntreFontes pegue a melhor entre todas. Página
// que é parede de login devolve { parede } e vale ZERO — não vale "achou algo".
function extrairDePagina(html, nomeFonte) {
  const src = String(html || '');
  const meta = lerMetaTags(src);
  const parede = detectarParedeDeLogin(src, meta);
  if (parede) return { fonte: nomeFonte, parede, campos: {} };

  const desc = meta['og:description'] || '';
  const tituloOg = meta['og:title'] || '';
  const campos = {};
  const por = (campo, valor, confianca) => {
    if (valor === null || valor === undefined || valor === '') return;
    if (campo === 'titulo' && legendaSuspeita(valor)) return;   // copy da Meta nunca é legenda
    if (!campos[campo] || confianca > campos[campo].confianca) campos[campo] = { valor, confianca };
  };

  // ── Capa ──
  const jt = /"(?:thumbnail_src|display_url)"\s*:\s*"([^"]+)"/.exec(src);
  const capaJson = jt ? decodeEntidades(jt[1].replace(/\\\//g, '/').replace(/\\u0026/g, '&')) : null;
  if (pareceCapaDePost(capaJson)) por('thumb_origem', capaJson, 3);
  if (pareceCapaDePost(meta['og:image'])) por('thumb_origem', meta['og:image'], 2);

  // ── Legenda, da mais confiável pra menos ──
  //   4 = edge_media_to_caption (a legenda de verdade, do embed)
  //   3 = <div class="Caption"> do embed renderizado
  //   2 = og entre aspas ('N likes, M comments - @user on DATA: "legenda"')
  //   1 = sobra do og:description depois do ':' (chute)
  const entreAspas = (s) => {
    const m = /:\s*["“”](.+)["“”]\s*\.?\s*$/s.exec(s || '');
    return m ? m[1] : null;
  };
  const semAspas = (s) => String(s || '').replace(/^["“](.*)["”]$/s, '$1');
  por('titulo', limpaTexto(legendaDoEmbed(src), 2200), 4);
  por('titulo', limpaTexto(legendaDoCaptionHtml(src), 2200), 3);
  por('titulo', limpaTexto(entreAspas(desc), 2200), 2);
  por('titulo', limpaTexto(entreAspas(tituloOg), 2200), 2);
  por('titulo', limpaTexto(semAspas((desc.split(' - ').slice(1).join(' - ') || '').replace(/^[^:]*:\s*/, '')), 2200), 1);

  // ── Autor ──
  const aJson = /"owner"\s*:\s*\{[^}]*"username"\s*:\s*"([A-Za-z0-9._]{2,30})"/.exec(src);
  if (aJson) por('autor', aJson[1].toLowerCase(), 3);
  const aOg = /(?:^|-\s*)@?([A-Za-z0-9._]{2,30})\s+(?:on|em)\s/.exec(desc)
    || /^([A-Za-z0-9._]{2,30})\s+(?:on Instagram|no Instagram)/.exec(tituloOg);
  if (aOg) por('autor', aOg[1].toLowerCase(), 2);
  const nome = /^(.+?)\s+(?:on Instagram|no Instagram)/.exec(tituloOg);
  if (nome) por('autor_nome', limpaTexto(nome[1], 120), 2);

  // ── Métricas ── JSON > texto do og. Ausência continua sendo ausência.
  const vJson = /"(?:video_view_count|play_count)"\s*:\s*(\d+)/.exec(src);
  if (vJson) por('views', parseNumeroHumano(vJson[1]), 3);
  const vOg = /([\d.,]+\s*(?:mil|mi|bi|[kmb])?)\s*(?:views|visualizações|visualizacoes|plays|reproduções)/i.exec(desc);
  if (vOg) por('views', parseNumeroHumano(vOg[1]), 2);

  const lJson = /"edge_media_preview_like"\s*:\s*\{\s*"count"\s*:\s*(\d+)/.exec(src);
  if (lJson) por('likes', parseNumeroHumano(lJson[1]), 3);
  const lOg = /([\d.,]+\s*(?:mil|mi|bi|[kmb])?)\s*(?:likes|curtidas|gostos)/i.exec(desc);
  if (lOg) por('likes', parseNumeroHumano(lOg[1]), 2);

  const cJson = /"edge_media_to_(?:parent_)?comment"\s*:\s*\{\s*"count"\s*:\s*(\d+)/.exec(src);
  if (cJson) por('comments', parseNumeroHumano(cJson[1]), 3);
  const cOg = /([\d.,]+\s*(?:mil|mi|bi|[kmb])?)\s*(?:comments|comentários|comentarios)/i.exec(desc);
  if (cOg) por('comments', parseNumeroHumano(cOg[1]), 2);

  return { fonte: nomeFonte, parede: null, campos };
}

// Funde o resultado de VÁRIAS fontes: por campo, ganha a de maior confiança.
// Fonte que devolveu parede de login não entra na disputa — vale ZERO.
function escolherEntreFontes(resultados) {
  const achado = { avisos: [], fontes: [] };
  const melhor = {};
  let algumaLida = false;

  for (const p of resultados || []) {
    if (p.erro) {
      achado.avisos.push(`${p.fonte}: ${p.erro}`);
      achado.fontes.push({ fonte: p.fonte, estado: 'erro', motivo: p.erro });
      continue;
    }
    if (p.parede) {
      // DEFEITO 3: este aviso vale pra parede de HTTP 200 também, não só pro
      // 302/401. Sem ele o dono nunca fica sabendo que a leitura falhou.
      achado.avisos.push(`${p.fonte}: não consegui ler essa página (${p.parede})`);
      achado.fontes.push({ fonte: p.fonte, estado: 'parede', motivo: p.parede });
      continue;
    }
    algumaLida = true;
    achado.fontes.push({ fonte: p.fonte, estado: 'ok' });
    for (const campo of Object.keys(p.campos || {})) {
      const dado = p.campos[campo];
      if (!dado || dado.valor === null || dado.valor === undefined || dado.valor === '') continue;
      if (!melhor[campo] || dado.confianca > melhor[campo].confianca) {
        melhor[campo] = { valor: dado.valor, confianca: dado.confianca, fonte: p.fonte };
      }
    }
  }

  for (const campo of Object.keys(melhor)) achado[campo] = melhor[campo].valor;
  achado.confianca = melhor;
  achado.pagina_ilegivel = !algumaLida;
  if (!algumaLida) {
    achado.avisos.unshift('Não consegui ler essa página (parede de login do Instagram) em NENHUMA fonte pública. Nada foi capturado — no card só vai aparecer o que VOCÊ digitar.');
  }
  return achado;
}

// Extrai o que der de uma página. Duas fontes, ambas públicas:
//   1) a página do post   → meta tags og:*
//   2) o /embed/captioned → HTML do player público, tem thumbnail_src e caption
// QUALQUER falha aqui é aceitável: o dono preenche à mão. O que NÃO é aceitável
// é falhar em silêncio e apresentar a copy da Meta como legenda do Reel.
async function capturarPublico(alvo) {
  const fontes = [
    { nome: 'og', url: alvo.url },
    { nome: 'embed', url: `https://www.instagram.com/${alvo.tipo}/${alvo.shortcode}/embed/captioned/` },
  ];

  // DEFEITO 2: tentamos TODAS as fontes, sempre. O código antigo parava na
  // primeira que devolvesse "qualquer coisa" (if (!achado.titulo)) — e como a
  // fonte 1 é justamente a que cai na parede de login, o lixo dela TRANCAVA a
  // fonte 2 (/embed/captioned/), que é a única que funciona deslogado.
  // Uma requisição extra de 6s é barata perto de publicar legenda falsa.
  const resultados = [];
  for (const f of fontes) {
    const r = await baixarPaginaPublica(f.url);
    if (r.erro) { resultados.push({ fonte: f.nome, erro: r.erro }); continue; }
    resultados.push(extrairDePagina(r.html || '', f.nome));
  }
  return escolherEntreFontes(resultados);
}

// ── O que vai pro banco em matéria de métrica (puro, sem rede) ──────────────
// DEFEITO 4: o antigo `temMetrica = views || likes || comments` fazia UMA
// métrica calar o aviso das outras duas. O og de Reel traz likes e comments mas
// NÃO traz views: bastava likes pra ninguém ser avisado, views ia nula, virava
// o DEFAULT 0 da coluna e o card publicava "▶ 0 · medido em <hoje>" — afirmando
// que zero foi medido hoje. Métrica ausente tem que ficar AUSENTE.
function decidirMetricas({ dados, origem, medidoEmBruto, existente }) {
  const COLS = { views: 'views_count', likes: 'likes_count', comments: 'comments_count' };
  const NOMES = { views: 'views', likes: 'likes', comments: 'comentários' };
  const chaves = Object.keys(COLS);
  const tem = (c) => dados[c] !== null && dados[c] !== undefined;
  const medidas = chaves.filter(tem);
  const temMetrica = medidas.length > 0;
  const fonte = !temMetrica ? 'nenhuma'
    : medidas.some((c) => (origem || {})[c] === 'manual') ? 'manual'
    : 'og';
  // "medido em" só existe se ALGUMA coisa foi medida de verdade.
  const medidoEm = temMetrica ? parseDataMedicao(medidoEmBruto) : null;

  const ex = existente || { lido: false };
  const colunas = {};
  const avisos = [];
  for (const c of chaves) {
    const col = COLS[c];
    if (tem(c)) { colunas[col] = dados[c]; continue; }
    avisos.push(`Sem ${NOMES[c]} — o card NÃO vai mostrar esse número (não inventamos 0). Digite o valor se quiser que apareça.`);
    // Não consegui ler o que já está no banco: omito, pra não arriscar apagar
    // um valor bom (valor inválido não substitui um bom).
    if (!ex.lido) continue;
    // Já existe valor bom gravado: preservo (o upsert é merge-duplicates).
    if (ex.row && Number(ex.row[col]) > 0) continue;
    // Não há nada bom a preservar → grava NULL explícito, pra que o DEFAULT 0
    // da coluna não transforme "não medido" em "medi e deu zero".
    colunas[col] = null;
  }
  if (!temMetrica) {
    avisos.push('Nenhuma métrica medida — o card sai SEM número e sem "medido em". Isso é melhor do que publicar 0 como se tivesse sido medido.');
  }
  return { medidas, temMetrica, fonte, medidoEm, colunas, avisos };
}

// Campo de texto: valor bom vence; ausência NÃO apaga o que já está gravado.
// Se não consegui ler a linha (lido:false), omito — lado seguro.
function textoOuPreserva(coluna, valor, existente) {
  if (valor !== null && valor !== undefined && valor !== '') return { [coluna]: valor };
  const ex = existente || { lido: false };
  if (!ex.lido) return {};
  const jaTem = ex.row && String(ex.row[coluna] || '').trim();
  return jaTem ? {} : { [coluna]: null };
}

// Lê a linha já gravada pra decidir entre "omitir" (preservar o que é bom) e
// "gravar null" (marcar como ausente). Falha de leitura devolve lido:false →
// o chamador escolhe o lado seguro (omitir).
async function lerMetricasExistentes(shortcode, { SU, h }) {
  try {
    const r = await fetch(
      `${SU}/rest/v1/instagram_virais?shortcode=eq.${encodeURIComponent(shortcode)}&select=views_count,likes_count,comments_count,caption,author_handle,author_name&limit=1`,
      { headers: h }
    );
    if (!r.ok) return { lido: false };
    const j = await r.json();
    return { lido: true, row: (Array.isArray(j) && j[0]) || null };
  } catch (_) {
    return { lido: false };
  }
}

// ── Hospedar a imagem no NOSSO storage ──────────────────────────────────────
// Aceita URL http(s) OU data:image/...;base64 (arquivo enviado pelo painel).
// Em caso de falha devolve { erro } dizendo QUAL foi o problema — nunca "erro".
async function hospedarImagem(origem, shortcode, { SU, SK }) {
  const src = String(origem || '').trim();
  if (!src) return { erro: 'nenhuma imagem informada' };
  let buf = null;
  let contentType = null;

  if (/^data:/i.test(src)) {
    const m = /^data:(image\/[a-z0-9.+-]+);base64,([\s\S]+)$/i.exec(src);
    if (!m) return { erro: 'o arquivo enviado não chegou como imagem (esperado data:image/…;base64)' };
    try { buf = Buffer.from(m[2], 'base64'); } catch (_) { return { erro: 'não consegui decodificar o arquivo enviado' }; }
    contentType = m[1].toLowerCase();
  } else {
    let u;
    try { u = new URL(src); } catch (_) { return { erro: 'não é uma URL válida — cole o endereço completo da imagem' }; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return { erro: `protocolo "${u.protocol}" não é aceito — use http ou https` };
    // A URL é digitada e vira request DO NOSSO SERVIDOR: barra alvos internos.
    // Só pega o caso óbvio (a action já é admin-only), mas é barato e correto.
    if (enderecoInterno(u.hostname)) return { erro: `"${u.hostname}" é um endereço interno — só aceito imagem de host público` };
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), IMG_TIMEOUT_MS);
    let r;
    try {
      // Sem cookie, sem credencial: só baixar o arquivo
      r = await fetch(u.toString(), { headers: { 'User-Agent': UA_PUBLICO, Accept: 'image/*,*/*' }, signal: ctrl.signal });
    } catch (e) {
      clearTimeout(tid);
      return { erro: e && e.name === 'AbortError'
        ? `a imagem não respondeu em ${IMG_TIMEOUT_MS / 1000}s`
        : `falha de rede ao baixar a imagem (${(e && e.message) || 'desconhecida'})` };
    }
    clearTimeout(tid);
    if (!r.ok) {
      const extra = r.status === 403 ? ' — link expirado ou bloqueado (URL da Meta dura poucos dias)'
        : r.status === 404 ? ' — esse arquivo não existe mais'
        : r.status === 429 ? ' — o servidor da imagem pediu calma'
        : '';
      return { erro: `o servidor da imagem respondeu HTTP ${r.status}${extra}` };
    }
    const declarado = (r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (declarado && !declarado.startsWith('image/')) {
      return { erro: `esse link devolveu "${declarado}", não uma imagem — cole o link DIRETO do arquivo (termina em .jpg, .png ou .webp)` };
    }
    contentType = declarado || null;
    buf = Buffer.from(await r.arrayBuffer());
  }

  if (buf.length < IMG_MIN_BYTES) {
    return { erro: `o arquivo baixado tem só ${buf.length} bytes — isso é página de erro, não imagem` };
  }
  if (buf.length > IMG_MAX_BYTES) {
    return { erro: `a imagem tem ${(buf.length / 1048576).toFixed(1)} MB — o limite é ${IMG_MAX_BYTES / 1048576} MB` };
  }

  // Confere a assinatura de verdade: content-type mente, magic bytes não
  const real = detectarTipoImagem(buf);
  if (!real && (!contentType || !contentType.startsWith('image/'))) {
    return { erro: 'o conteúdo baixado não tem assinatura de imagem (aceito jpg, png, webp, gif e avif)' };
  }
  const tipoFinal = real ? real.mime : contentType;
  const ext = real ? real.ext
    : contentType.includes('webp') ? 'webp' : contentType.includes('png') ? 'png' : contentType.includes('gif') ? 'gif' : 'jpg';

  const up = await uploadThumb(buf, tipoFinal, `${shortcode}.${ext}`, { SU, SK });
  if (up.erro) return { erro: up.erro };
  return { url: urlPublica(up.path, { SU }, Date.now()), bytes: buf.length, tipo: tipoFinal };
}

// localhost, loopback, link-local e faixas privadas escritas como IP
function enderecoInterno(host) {
  const hn = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!hn) return true;
  if (hn === 'localhost' || hn.endsWith('.localhost') || hn.endsWith('.internal') || hn.endsWith('.local')) return true;
  if (hn === '::1' || hn.startsWith('fe80:') || hn.startsWith('fc') || hn.startsWith('fd')) return true;
  const ip = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hn);
  if (!ip) return false;
  const [a, b] = [parseInt(ip[1], 10), parseInt(ip[2], 10)];
  return a === 10 || a === 127 || a === 0
    || (a === 192 && b === 168)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 169 && b === 254)
    || (a === 100 && b >= 64 && b <= 127);
}

function detectarTipoImagem(b) {
  if (b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { mime: 'image/png', ext: 'png' };
  if (b.toString('ascii', 0, 3) === 'GIF') return { mime: 'image/gif', ext: 'gif' };
  if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return { mime: 'image/webp', ext: 'webp' };
  if (b.toString('ascii', 4, 8) === 'ftyp' && /avif|heic|mif1/i.test(b.toString('ascii', 8, 12))) return { mime: 'image/avif', ext: 'avif' };
  return null;
}

// ── ACTION replicar ─────────────────────────────────────────────────────────
// preview:true → captura, hospeda a imagem e DEVOLVE tudo sem gravar no banco.
// preview ausente → grava. O manual SEMPRE vence o automático: o dono viu o
// número na tela; a captura pública é chute educado.
async function replicar(req, res, { SU, SK, h }) {
  const body = req.body || {};
  const alvo = parseUrlInstagram(body.url || req.query.url);
  if (!alvo) {
    return res.status(400).json({ error: 'URL inválida — precisa ser instagram.com/reel/CODIGO/ (também aceito /p/ e /tv/)' });
  }
  const preview = body.preview === true || body.preview === 'true';
  const avisos = [];

  // 1) Tentativa AUTOMÁTICA, sem cookie e sem login. Pode falhar — é normal.
  let auto = { avisos: [] };
  if (body.pular_captura !== true && body.pular_captura !== 'true') {
    try { auto = await capturarPublico(alvo); } catch (e) { auto = { avisos: ['captura: ' + e.message] }; }
  }
  // DEFEITO 3: o aviso antigo só saía quando baixarPaginaPublica devolvia
  // 'erro'. Parede de login vem com HTTP 200 → sem erro → avisos vazio →
  // NENHUMA menção de que a leitura falhou chegava à tela do dono; sobrava só
  // 'falta_imagem', que fala de imagem e não de "não consegui ler a página".
  // Agora todo aviso da captura sobe, e a parede tem aviso próprio e explícito.
  if (auto.pagina_ilegivel) {
    avisos.push('⚠ NÃO CONSEGUI LER ESSA PÁGINA (parede de login do Instagram). Nada foi capturado: legenda, autor e métricas ficam SÓ com o que você digitar.');
  }
  if (auto.avisos && auto.avisos.length) avisos.push(...auto.avisos);

  // 2) O que o dono digitou
  const manual = {
    titulo: limpaTexto(body.titulo, 2200),
    autor: (limpaTexto(body.autor, 60) || '').replace(/^@/, '').toLowerCase() || null,
    autor_nome: limpaTexto(body.autor_nome, 120),
    nicho: limpaTexto(body.nicho, 60),
    views: parseNumeroHumano(body.views),
    likes: parseNumeroHumano(body.likes),
    comments: parseNumeroHumano(body.comments),
  };

  // 3) Fusão — manual primeiro, sempre
  const escolha = (campo) => (manual[campo] !== null && manual[campo] !== undefined ? manual[campo]
    : (auto[campo] !== null && auto[campo] !== undefined ? auto[campo] : null));
  const dados = {
    titulo: escolha('titulo'),
    autor: escolha('autor'),
    autor_nome: manual.autor_nome || auto.autor_nome || manual.autor || auto.autor || null,
    nicho: manual.nicho,
    views: escolha('views'),
    likes: escolha('likes'),
    comments: escolha('comments'),
  };
  // TRÊS estados de verdade, não dois. Antes, "não consegui ler" se disfarçava
  // de "vazio" — o mesmo selo de um campo que ninguém tentou preencher. O selo
  // do admin precisa distinguir: preenchido por VOCÊ, CAPTURADO de verdade, e
  // NÃO CONSEGUI LER (a página era parede de login).
  const CAMPOS_CAPTURAVEIS = new Set(['titulo', 'autor', 'autor_nome', 'views', 'likes', 'comments']);
  const marca = (campo) => {
    if (manual[campo] !== null && manual[campo] !== undefined) return 'manual';
    if (auto[campo] !== null && auto[campo] !== undefined) return 'automatico';
    // 'nicho' nunca vem de captura — marcar como ilegível seria mentira ao contrário
    if (auto.pagina_ilegivel && CAMPOS_CAPTURAVEIS.has(campo)) return 'ilegivel';
    return 'vazio';
  };
  const origem = {
    titulo: marca('titulo'), autor: marca('autor'), autor_nome: marca('autor_nome'),
    nicho: marca('nicho'),
    views: marca('views'), likes: marca('likes'), comments: marca('comments'),
  };

  // 4) Imagem — a parte que não pode falhar em silêncio.
  // Ordem: arquivo enviado > URL colada > captura automática. A primeira que
  // hospedar com sucesso ganha; as falhas viram aviso COM MOTIVO.
  const candidatos = [];
  if (body.imagem_base64) candidatos.push({ fonte: 'arquivo enviado', src: body.imagem_base64 });
  if (body.imagem_url) candidatos.push({ fonte: 'URL colada', src: body.imagem_url });
  if (auto.thumb_origem) candidatos.push({ fonte: 'captura automática', src: auto.thumb_origem });

  let imagem = null;
  let imagemFonte = null;
  for (const c of candidatos) {
    const r = await hospedarImagem(c.src, alvo.shortcode, { SU, SK });
    if (r.url) { imagem = r; imagemFonte = c.fonte; break; }
    avisos.push(`Imagem (${c.fonte}) não deu: ${r.erro}`);
  }

  const capturado = {
    shortcode: alvo.shortcode,
    video_url: alvo.url,
    ...dados,
    origem,
    // Sobe pra tela: o admin precisa VER que a leitura falhou, não deduzir.
    pagina_ilegivel: !!auto.pagina_ilegivel,
    fontes: auto.fontes || [],
    imagem_url: imagem ? imagem.url : null,
    imagem_fonte: imagemFonte,
    imagem_bytes: imagem ? imagem.bytes : null,
  };

  if (!imagem) {
    const explicacao = candidatos.length
      ? 'Nenhuma das imagens funcionou — veja os avisos abaixo.'
      : 'Nada foi capturado da página pública e você não enviou imagem.';
    if (preview) {
      // Preview NÃO falha: mostra o que deu e pede a imagem
      return res.status(200).json({
        ok: true, preview: true, capturado, avisos,
        falta_imagem: true,
        aviso_imagem: explicacao + ' Cole a URL direta de uma imagem OU envie um arquivo antes de salvar.',
      });
    }
    return res.status(422).json({
      error: 'Card sem imagem é card morto — não salvo sem capa. ' + explicacao + ' Cole a URL direta de uma imagem (.jpg/.png/.webp) OU envie um arquivo.',
      capturado, avisos,
    });
  }

  // 5) Métricas — cada uma por si (defeito 4). No preview ainda não leio o
  // banco (é chamada barata e sem gravação): só na hora de gravar.
  const decisaoPreview = decidirMetricas({
    dados, origem, medidoEmBruto: body.medido_em, existente: { lido: false },
  });
  avisos.push(...decisaoPreview.avisos);
  if (!dados.titulo) {
    avisos.push(auto.pagina_ilegivel
      ? 'Sem legenda: NÃO consegui ler a página e você não digitou nada — o card vai sair "sem legenda" (melhor do que publicar a copy institucional da Meta como se fosse a legenda do Reel).'
      : 'Sem título/legenda — o card vai mostrar "sem legenda".');
  }

  if (preview) {
    return res.status(200).json({
      ok: true, preview: true, capturado, avisos,
      // medido_em pode ser null: sem métrica medida não existe "medido em".
      medido_em: decisaoPreview.medidoEm,
      metrics_source: decisaoPreview.fonte,
      metricas_medidas: decisaoPreview.medidas,
      pagina_ilegivel: !!auto.pagina_ilegivel,
    });
  }

  // 6) Gravação. Métrica ausente NÃO pode virar 0 (o DEFAULT da coluna morde no
  // INSERT) nem apagar um valor bom já salvo (o upsert é merge-duplicates).
  // decidirMetricas resolve os dois lados: null explícito quando não há nada bom
  // a preservar, omissão quando há.
  const existente = await lerMetricasExistentes(alvo.shortcode, { SU, h });
  const decisao = decidirMetricas({ dados, origem, medidoEmBruto: body.medido_em, existente });
  const medidoEm = decisao.medidoEm;
  const fonteMetrica = decisao.fonte;

  const agora = new Date().toISOString();
  const base = {
    shortcode: alvo.shortcode,
    video_url: alvo.url,
    thumbnail_url: imagem.url,           // SEMPRE nossa. URL da Meta nunca entra aqui.
    // Mesma doença das métricas, versão texto: se a parede de login derrubou a
    // captura e o dono não digitou nada, `caption: null` APAGARIA a legenda boa
    // de uma réplica anterior. Valor inválido não substitui um bom — quando não
    // tenho nada, omito o campo e o upsert preserva o que já estava lá.
    ...textoOuPreserva('caption', dados.titulo, existente),
    ...textoOuPreserva('author_handle', dados.autor, existente),
    ...textoOuPreserva('author_name', dados.autor_nome, existente),
    fonte: 'replica',
    status: 'active',                    // recolar a URL reativa um Reel removido
    last_error: null,
    // metrics_updated_at = "quando mexemos na linha" (o cron carimba até em
    // falha). metrics_measured_at = "quando o número foi medido de verdade" e
    // fica NULL se nada foi medido — é ele que o card usa pro "medido em".
    metrics_updated_at: medidoEm || agora,
    last_seen_at: agora,
    ...decisao.colunas,
  };
  const extras = { congelado: true, metrics_measured_at: medidoEm, metrics_source: fonteMetrica, nicho: dados.nicho };

  const gravar = (row) => fetch(`${SU}/rest/v1/instagram_virais?on_conflict=shortcode`, {
    method: 'POST',
    headers: { ...h, Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify([row]),
  });

  let r = await gravar({ ...base, ...extras });
  let sqlPendente = false;
  if (!r.ok) {
    const txt = await r.text();
    // Colunas novas ainda não existem = sql/instagram_replica.sql não rodou.
    // Contingência: grava o essencial mesmo assim (imagem nossa + métrica) e
    // avisa em alto e bom som o que falta. Melhor degradado do que nada.
    if (/column|schema cache|PGRST204/i.test(txt)) {
      sqlPendente = true;
      r = await gravar(base);
      if (!r.ok) {
        return res.status(500).json({ error: 'Falha ao salvar no banco: ' + (await r.text()).slice(0, 200), capturado, avisos });
      }
      avisos.push('⚠ Rode sql/instagram_replica.sql no Supabase: as colunas congelado/metrics_measured_at/metrics_source/nicho ainda não existem. Salvei o resto, mas o cron de métricas ainda pode tentar consultar esse Reel e o card não mostra "medido em".');
    } else {
      return res.status(500).json({ error: 'Falha ao salvar no banco: ' + txt.slice(0, 200), capturado, avisos });
    }
  }

  return res.status(200).json({
    ok: true,
    replicado: true,
    sql_pendente: sqlPendente,
    video: { ...base, ...(sqlPendente ? {} : extras) },
    capturado,
    avisos,
    metricas_medidas: decisao.medidas,
    metrics_source: fonteMetrica,
    pagina_ilegivel: !!auto.pagina_ilegivel,
  });
}

// ── ADICIONAR PERFIL (admin cola link de perfil) ─────────────────────────────
// Resolve username→user_pk. O endpoint de resolução toma 429 fácil — fallback:
// admin pode mandar junto a URL de um Reel do perfil (reel_url), que dá o
// author_pk sem passar pelo endpoint sensível.
async function adicionarPerfil(req, res, { SU, SK, h }) {
  const body = req.body || {};
  const username = ig.parseUsernameDePerfil(body.url || '') || String(body.username || '').replace(/^@/, '').toLowerCase() || null;
  if (!username) return res.status(400).json({ error: 'Cole o link do perfil (instagram.com/nomedoperfil)' });
  if (!(await ig.temCookies())) return res.status(500).json({ error: 'Cookies não configurados — salve no painel (campo Cookies da conta)' });

  let perfil = null;
  let aviso = null;
  try {
    perfil = await ig.resolverUsername(username);
  } catch (e) {
    // Fallback: URL de um Reel do perfil → author_pk via media info
    if (body.reel_url) {
      try {
        const m = await ig.mediaInfo(body.reel_url);
        if (m.author_handle && m.author_handle.toLowerCase() !== username) {
          return res.status(400).json({ error: `O Reel enviado é de @${m.author_handle}, não de @${username}` });
        }
        if (!m.author_pk) {
          // Sem user_pk o coletor nunca conseguiria buscar esse perfil —
          // melhor falhar claro agora do que salvar um perfil morto
          return res.status(502).json({ error: 'O Instagram não retornou o id do autor nesse Reel — tente outro Reel do mesmo perfil.' });
        }
        perfil = { user_pk: m.author_pk, username: m.author_handle || username, full_name: m.author_name };
      } catch (e2) {
        return res.status(502).json({ error: 'Falha ao resolver o perfil (e o Reel de apoio também falhou)', detalhe: e2.message });
      }
    } else if (e.status === 429) {
      return res.status(429).json({
        error: 'Instagram limitou a consulta de perfis agora (429). Duas opções: tentar de novo em ~10min, OU colar junto a URL de um Reel qualquer desse perfil (campo reel_url) que eu resolvo por ela.',
      });
    } else {
      return res.status(502).json({ error: 'Perfil não encontrado ou inacessível', detalhe: e.message });
    }
  }

  const upP = await fetch(`${SU}/rest/v1/instagram_perfis?on_conflict=username`, {
    method: 'POST',
    headers: { ...h, Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify([{ username: perfil.username, user_pk: perfil.user_pk, full_name: perfil.full_name, active: true, last_error: null }]),
  });
  if (!upP.ok) return res.status(500).json({ error: 'Falha ao salvar perfil' });

  // 1ª coleta imediata (página 1) — admin já vê resultado na hora
  let coletados = 0, avaliados = 0;
  try {
    const page = await ig.clipsDoPerfil(perfil.user_pk, { pageSize: PERFIL_PAGE_SIZE });
    const candidatos = page.items.filter((m) => m.is_video && m.shortcode);
    avaliados = candidatos.length;
    const videos = candidatos.filter(passaRegua);
    const rows = [];
    for (const m of videos) rows.push(await mediaParaRow(m, { SU, SK }, { fonte: 'perfil', source_profile: perfil.username }));
    if (await upsertRows(rows, { SU, h })) coletados = rows.length;
    await fetch(`${SU}/rest/v1/instagram_perfis?username=eq.${encodeURIComponent(perfil.username)}`, {
      method: 'PATCH', headers: h, body: JSON.stringify({ last_collected_at: new Date().toISOString() }),
    });
  } catch (e) {
    aviso = 'Perfil salvo, mas a 1ª coleta falhou (' + e.message + ') — o cron tenta de novo sozinho.';
  }
  if (!aviso && avaliados > coletados) {
    aviso = `${avaliados - coletados} Reels do perfil ficaram FORA da régua (${(MIN_VIEWS_AUTO / 1e6)}M+ views e ${(MIN_LIKES_AUTO / 1e6)}M+ likes).`;
  }
  return res.status(200).json({ ok: true, perfil, coletados, avaliados, aviso });
}

// ── COLETAR PERFIS (cron) ────────────────────────────────────────────────────
async function coletarPerfis(req, res, { SU, SK, h }) {
  if (!(await ig.temCookies())) return res.status(200).json({ ok: false, motivo: 'sem_cookies' });
  const limit = Math.min(10, parseInt(req.query.limit, 10) || PERFIS_POR_RODADA);
  const r = await fetch(
    `${SU}/rest/v1/instagram_perfis?active=eq.true&user_pk=not.is.null&order=last_collected_at.asc.nullsfirst&limit=${limit}&select=username,user_pk`,
    { headers: h }
  );
  if (!r.ok) return res.status(500).json({ error: 'query_perfis_failed' });
  const perfis = await r.json();
  const resultado = { ok: true, perfis: perfis.length, inseridos: 0, avaliados: 0, fora_da_regua: 0, falhas: [] };

  for (const p of perfis) {
    try {
      const page = await ig.clipsDoPerfil(p.user_pk, { pageSize: PERFIL_PAGE_SIZE });
      const candidatos = page.items.filter((m) => m.is_video && m.shortcode);
      resultado.avaliados += candidatos.length;
      const videos = candidatos.filter(passaRegua);
      resultado.fora_da_regua += candidatos.length - videos.length;
      const rows = [];
      for (const m of videos) rows.push(await mediaParaRow(m, { SU, SK }, { fonte: 'perfil', source_profile: p.username }));
      if (await upsertRows(rows, { SU, h })) resultado.inseridos += rows.length;
      await fetch(`${SU}/rest/v1/instagram_perfis?username=eq.${encodeURIComponent(p.username)}`, {
        method: 'PATCH', headers: h, body: JSON.stringify({ last_collected_at: new Date().toISOString(), last_error: null }),
      });
    } catch (e) {
      resultado.falhas.push({ perfil: p.username, erro: e.message });
      await fetch(`${SU}/rest/v1/instagram_perfis?username=eq.${encodeURIComponent(p.username)}`, {
        method: 'PATCH', headers: h, body: JSON.stringify({ last_error: e.message.slice(0, 200) }),
      }).catch(() => {});
      if (e.status === 429) break; // Instagram pediu calma — para a rodada inteira
    }
    await new Promise((rs) => setTimeout(rs, 2500)); // espaçamento anti-flag
  }
  return res.status(200).json(resultado);
}

// ── ATUALIZAR MÉTRICAS (cron) ────────────────────────────────────────────────
// Pega os N com metrics_updated_at mais antigo e re-consulta views/likes.
// Falha NUNCA esconde o vídeo — só registra last_error e segue a vida.
async function atualizarMetricas(req, res, { SU, h }) {
  if (!(await ig.temCookies())) return res.status(200).json({ ok: false, motivo: 'sem_cookies' });
  const limit = Math.min(50, parseInt(req.query.limit, 10) || REFRESH_BATCH);
  const base = `${SU}/rest/v1/instagram_virais?status=eq.active&order=metrics_updated_at.asc.nullsfirst&limit=${limit}&select=shortcode`;
  // congelado=not.is.true casa false E null — RÉPLICA nunca volta ao Instagram.
  // Se a coluna ainda não existe (sql/instagram_replica.sql não rodado), o
  // PostgREST devolve 400: caímos na query antiga em vez de derrubar o cron.
  let r = await fetch(base + '&congelado=not.is.true', { headers: h });
  let semColunaCongelado = false;
  if (!r.ok) {
    semColunaCongelado = true;
    r = await fetch(base, { headers: h });
  }
  if (!r.ok) return res.status(500).json({ error: 'query_failed' });
  const rows = await r.json();
  if (semColunaCongelado) console.warn('[ig-virais] coluna "congelado" ausente — rode sql/instagram_replica.sql (réplicas podem ser reconsultadas)');
  const resultado = { ok: true, processados: 0, atualizados: 0, falhas: 0, abortado_429: false, sem_coluna_congelado: semColunaCongelado };

  for (const row of rows) {
    resultado.processados++;
    try {
      const m = await ig.mediaInfo(row.shortcode);
      // Guarda anti-zeramento: métrica que veio 0 numa resposta 200 não
      // sobrescreve o valor bom já salvo (IG às vezes esconde play_count)
      const body = {
        metrics_updated_at: new Date().toISOString(),
        last_seen_at: new Date().toISOString(),
        last_error: null,
      };
      if (m.views_count > 0) body.views_count = m.views_count;
      if (m.likes_count > 0) body.likes_count = m.likes_count;
      if (m.comments_count > 0) body.comments_count = m.comments_count;
      await fetch(`${SU}/rest/v1/instagram_virais?shortcode=eq.${encodeURIComponent(row.shortcode)}`, {
        method: 'PATCH', headers: h, body: JSON.stringify(body),
      });
      resultado.atualizados++;
    } catch (e) {
      resultado.falhas++;
      // Registra o motivo mas NÃO mexe em status — vídeo continua na vitrine
      await fetch(`${SU}/rest/v1/instagram_virais?shortcode=eq.${encodeURIComponent(row.shortcode)}`, {
        method: 'PATCH', headers: h,
        body: JSON.stringify({ metrics_updated_at: new Date().toISOString(), last_error: e.message.slice(0, 200) }),
      }).catch(() => {});
      if (e.status === 429) { resultado.abortado_429 = true; break; }
    }
    await new Promise((rs) => setTimeout(rs, REFRESH_SPACING_MS));
  }
  return res.status(200).json(resultado);
}

// ── LISTAR (grid público) ────────────────────────────────────────────────────
// Padrão do Instagram (decisão do user): TODOS os coletados, mais recentes
// primeiro — sem filtro de views/likes pré-selecionado.
async function listar(req, res, { SU, h }) {
  const period = req.query.period || 'all';
  const sortParam = req.query.sort || 'recent';
  const sort = sortParam === 'views' ? 'views_count.desc'
    : sortParam === 'likes' ? 'likes_count.desc'
    : 'collected_at.desc';
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  const offset = Math.max(0, parseInt(req.query.offset) || 0);

  const PERIOD_MS = { '24h': 86400000, '7d': 7 * 86400000, '30d': 30 * 86400000 };
  let url = `${SU}/rest/v1/instagram_virais?status=eq.active`;
  if (PERIOD_MS[period]) {
    url += `&collected_at=gte.${new Date(Date.now() - PERIOD_MS[period]).toISOString()}`;
  }
  url += `&order=${sort}&limit=${limit}&offset=${offset}`;
  const SELECT_BASE = 'shortcode,video_url,thumbnail_url,caption,author_handle,author_name,views_count,likes_count,comments_count,duration_sec,ig_created_at,fonte,source_profile,collected_at';
  // Colunas da réplica. Se sql/instagram_replica.sql ainda não rodou, o
  // PostgREST devolve 400 e ZERA a resposta — por isso o fallback: a vitrine
  // nunca fica vazia por causa de uma coluna que falta.
  const SELECT_REPLICA = SELECT_BASE + ',metrics_measured_at,metrics_source,congelado,nicho';

  let r = await fetch(`${url}&select=${SELECT_REPLICA}`, { headers: { ...h, Prefer: 'count=exact' } });
  let schemaAntigo = false;
  if (!r.ok) {
    schemaAntigo = true;
    r = await fetch(`${url}&select=${SELECT_BASE}`, { headers: { ...h, Prefer: 'count=exact' } });
  }
  const brutos = r.ok ? await r.json() : [];
  const total = parseInt((r.headers.get('content-range') || '').split('/')[1] || '0') || brutos.length;
  // Imagem SEMPRE pelo nosso domínio quando houver CDN (egress do Supabase)
  const items = brutos.map((v) => (v && v.thumbnail_url ? { ...v, thumbnail_url: aplicarCDN(v.thumbnail_url) } : v));
  return res.status(200).json({
    ok: true, period, sort: sortParam, limit, offset, total,
    has_more: offset + items.length < total,
    ...(schemaAntigo ? { schema_replica_pendente: true } : {}),
    items,
  });
}

// ── REMOVER (admin) ──────────────────────────────────────────────────────────
// Tombstone em vez de DELETE: status='removed' tira da vitrine/Blublu mas a
// linha fica — o coletor de perfis pode re-encontrar o shortcode e o upsert
// (que não envia status) preserva a remoção. DELETE físico ressuscitava.
async function remover(req, res, { SU, h }) {
  const shortcode = (req.body && req.body.shortcode) || req.query.shortcode;
  if (!shortcode) return res.status(400).json({ error: 'shortcode obrigatorio' });
  const r = await fetch(`${SU}/rest/v1/instagram_virais?shortcode=eq.${encodeURIComponent(shortcode)}`, {
    method: 'PATCH', headers: h, body: JSON.stringify({ status: 'removed' }),
  });
  return res.status(r.ok ? 200 : 500).json({ ok: r.ok });
}

// ── PERFIS (admin) ───────────────────────────────────────────────────────────
async function togglePerfil(req, res, { SU, h }) {
  const { username, active } = req.body || {};
  if (!username) return res.status(400).json({ error: 'username obrigatorio' });
  const r = await fetch(`${SU}/rest/v1/instagram_perfis?username=eq.${encodeURIComponent(username)}`, {
    method: 'PATCH', headers: h, body: JSON.stringify({ active: !!active }),
  });
  return res.status(r.ok ? 200 : 500).json({ ok: r.ok });
}

async function listarPerfis(req, res, { SU, h }) {
  const r = await fetch(`${SU}/rest/v1/instagram_perfis?select=*&order=added_at.desc`, { headers: h });
  if (!r.ok) return res.status(500).json({ error: 'query_failed' });
  return res.status(200).json({ ok: true, perfis: await r.json() });
}

// ── SALVAR COOKIES (admin, self-service) ─────────────────────────────────────
// Admin cola o cookies.txt no painel → validamos, salvamos em site_kv (sem
// redeploy) e testamos a sessão na hora. A env IG_COOKIES_B64 vira só fallback.
async function salvarCookies(req, res, { SU, h }) {
  const txt = (req.body && req.body.cookies_txt) || '';
  if (!txt.trim()) return res.status(400).json({ error: 'Cole o conteúdo do cookies.txt' });
  const b64 = Buffer.from(txt, 'utf8').toString('base64');
  const jar = ig.parseCookiesB64(b64);
  if (!jar || !jar.sessionid) {
    return res.status(400).json({ error: 'Cookies inválidos — precisa ser o cookies.txt exportado LOGADO (tem que conter "sessionid")' });
  }
  const upR = await fetch(`${SU}/rest/v1/site_kv?on_conflict=key`, {
    method: 'POST',
    headers: { ...h, Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify([{ key: 'ig_cookies_b64', value: b64 }]),
  });
  if (!upR.ok) return res.status(500).json({ error: 'Falha ao salvar no banco: ' + upR.status });
  ig.limparCacheCookies();
  const teste = await ig.validarSessao();
  return res.status(200).json({ ok: true, salvo: true, sessao: teste });
}

// ── HEALTH (público, agregado) ───────────────────────────────────────────────
async function health(req, res, { SU, h }) {
  const doisDias = new Date(Date.now() - 2 * 86400000).toISOString();
  const [totalR, staleR, errR, perfisR, replicaR] = await Promise.all([
    fetch(`${SU}/rest/v1/instagram_virais?select=shortcode&limit=1`, { headers: { ...h, Prefer: 'count=exact' } }),
    // Réplica é congelada por desenho: métrica "parada" nela é o esperado, não
    // sintoma. Fora da conta, senão o painel acusa DEGRADED sem nada quebrado.
    fetch(`${SU}/rest/v1/instagram_virais?status=eq.active&or=(fonte.is.null,fonte.neq.replica)&metrics_updated_at=lt.${doisDias}&select=shortcode&limit=1`, { headers: { ...h, Prefer: 'count=exact' } }),
    fetch(`${SU}/rest/v1/instagram_virais?last_error=not.is.null&or=(fonte.is.null,fonte.neq.replica)&select=shortcode&limit=1`, { headers: { ...h, Prefer: 'count=exact' } }),
    fetch(`${SU}/rest/v1/instagram_perfis?active=eq.true&select=username&limit=1`, { headers: { ...h, Prefer: 'count=exact' } }),
    // Réplicas: 'fonte' já existe no schema antigo, então esta conta nunca 400a
    fetch(`${SU}/rest/v1/instagram_virais?status=eq.active&fonte=eq.replica&select=shortcode&limit=1`, { headers: { ...h, Prefer: 'count=exact' } }),
  ]);
  const count = (resp) => parseInt((resp.headers.get('content-range') || '').split('/')[1] || '0', 10);
  const totalVideos = count(totalR);
  const metricasVelhas = count(staleR);
  const comErro = count(errR);
  const replicas = count(replicaR);
  const perfisAtivos = count(perfisR);
  const temCk = await ig.temCookies();
  return res.status(200).json({
    ok: true,
    timestamp: new Date().toISOString(),
    cookies_configurados: temCk,
    total_videos: totalVideos,
    perfis_ativos: perfisAtivos,
    replicas: replicas,
    metricas_atrasadas_48h: metricasVelhas,
    videos_com_erro_recente: comErro,
    // Conta caiu? Vídeos continuam no ar (banco = fonte da verdade). Dois
    // sinais de problema independentes: last_error acumulando (refresh RODA
    // mas falha — sessão morta/checkpoint; o refresh renova metrics_updated_at
    // até em falha, então SÓ o erro detecta isso) e métricas atrasadas
    // (cron parou de rodar).
    //
    // MODO RÉPLICA: sem cookies e sem perfis monitorados, mas com acervo
    // replicado, o sistema está fazendo exatamente o que foi pedido — nada
    // consulta o Instagram. Isso é SUCESSO, não degradação.
    status: (!temCk && perfisAtivos === 0 && replicas > 0) ? 'OK_MODO_REPLICA'
      : !temCk ? 'SEM_COOKIES'
      : totalVideos >= 5 && comErro / totalVideos > 0.3 ? 'DEGRADED_REFRESH_FALHANDO'
      : totalVideos > 0 && metricasVelhas / totalVideos > 0.5 ? 'DEGRADED_METRICAS_PARADAS'
      : 'OK',
  });
}

// ── Exportado para os testes (tests/unit/instagram_parede_login.test.mjs) ────
// O parser roda contra o HTML REAL da parede de login; sem exportar, o defeito
// mais grave (copy da Meta virando legenda) só seria pego em produção.
module.exports.detectarParedeDeLogin = detectarParedeDeLogin;
module.exports.extrairDePagina = extrairDePagina;
module.exports.escolherEntreFontes = escolherEntreFontes;
module.exports.capturarPublico = capturarPublico;
module.exports.decidirMetricas = decidirMetricas;
module.exports.legendaDoEmbed = legendaDoEmbed;
module.exports.legendaDoCaptionHtml = legendaDoCaptionHtml;
module.exports.lerMetaTags = lerMetaTags;
module.exports.FRASES_PAREDE = FRASES_PAREDE;
module.exports.textoOuPreserva = textoOuPreserva;
