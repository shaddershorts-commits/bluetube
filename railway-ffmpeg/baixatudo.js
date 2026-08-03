// railway-ffmpeg/baixatudo.js — BaixaTudo (2026-08-03)
// ===========================================================================
// MÓDULO TOTALMENTE ISOLADO. Regra do dono: "não deve usar nada da estrutura
// atual do baixaBlue, pra não ter risco de afetar o download normal".
//
// Por isso este arquivo NÃO importa nada do server.js — tem os próprios
// helpers (cookies, spawn, PO token). Um bug aqui não tem como quebrar o
// /youtube-process, e o mount no server.js é envolvido em try/catch: se este
// módulo nem carregar, o serviço sobe igual, só sem o BaixaTudo.
//
// PAPEL DESTE MÓDULO: só a LISTAGEM dos Shorts do canal (yt-dlp
// --flat-playlist, metadata pura). O DOWNLOAD não passa por aqui — quem pede o
// link HD é /api/baixatudo?action=link na Vercel (que fala com o Cobalt
// self-hosted) e quem baixa é o NAVEGADOR, direto do túnel do Cobalt.
// Consequência: nenhum byte de mídia atravessa este container compartilhado.
//
// Por que não yt-dlp pro download: nesta imagem ele bate em 'n challenge
// solving failed' (falta interpretador JS) e 'GVS PO Token which was not
// provided' — só entrega 360p. O Cobalt resolve o n challenge sozinho e
// devolve 1080p h264 (medido no @XiroRanks: 1080x1920 60fps em ~2s).
//
// Rota (montada na raiz pelo server.js):
//   POST /baixatudo-list     { channel_url, limite? } → { canal, total, shorts[] }
//   GET  /baixatudo-health   → a listagem ainda funciona?

const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const crypto = require('crypto');

const router = express.Router();

// 1000 = "todos, na prática". O dono pediu o canal INTEIRO — o teto de 60
// cortava um canal de 76 e ele sentiu no primeiro teste. Aqui é só rede de
// segurança contra canal gigante virar job infinito.
const TETO_SHORTS = parseInt(process.env.BAIXATUDO_MAX || '1000', 10);
// Teto de processos simultâneos SÓ desta feature. Protege o download normal:
// mesmo que 10 pessoas disparem lotes juntas, o BaixaTudo nunca toma o
// container inteiro e deixa o /youtube-process sem CPU.
const TETO_SIMULTANEO = parseInt(process.env.BAIXATUDO_CONCURRENCY || '2', 10);
let rodando = 0;

// ── CACHE DE LISTAGEM (em memória, de propósito) ───────────────────────────
// Não usa Upstash nem nada compartilhado: a regra do dono é isolamento total,
// e um cache externo seria mais uma peça capaz de quebrar. Em memória o pior
// caso é perder o cache num deploy — custo zero, risco zero.
const CACHE_TTL_MS = parseInt(process.env.BAIXATUDO_CACHE_TTL_MS || '900000', 10); // 15 min
const CACHE_MAX = 120;                       // teto de entradas (poucos KB cada)
const cache = new Map();                     // chave → { em, dados }
let cacheHits = 0, cacheMiss = 0;

function cacheLer(chave) {
  const v = cache.get(chave);
  if (!v) { cacheMiss++; return null; }
  if (Date.now() - v.em > CACHE_TTL_MS) { cache.delete(chave); cacheMiss++; return null; }
  // renova a posição (LRU simples: reinserir manda pro fim do Map)
  cache.delete(chave); cache.set(chave, v);
  cacheHits++;
  return v.dados;
}
function cacheGravar(chave, dados) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value); // remove o mais antigo
  cache.set(chave, { em: Date.now(), dados });
}

// ── DISJUNTOR POR REDE ─────────────────────────────────────────────────────
// Se o YouTube (ou o TikTok) começa a punir, não adianta martelar: cada
// tentativa piora o castigo. Depois de N falhas seguidas a rede fica em
// descanso e devolvemos erro na hora, sem gastar processo.
const DISJUNTOR_FALHAS = parseInt(process.env.BAIXATUDO_CB_FALHAS || '4', 10);
const DISJUNTOR_PAUSA_MS = parseInt(process.env.BAIXATUDO_CB_PAUSA_MS || '120000', 10); // 2 min
const disjuntor = { youtube: { falhas: 0, ate: 0 }, tiktok: { falhas: 0, ate: 0 }, instagram: { falhas: 0, ate: 0 } };

function disjuntorAberto(rede) {
  const d = disjuntor[rede];
  return !!(d && d.ate > Date.now());
}
function registrarFalha(rede) {
  const d = disjuntor[rede]; if (!d) return;
  d.falhas++;
  if (d.falhas >= DISJUNTOR_FALHAS) { d.ate = Date.now() + DISJUNTOR_PAUSA_MS; d.falhas = 0; }
}
function registrarSucesso(rede) {
  const d = disjuntor[rede]; if (!d) return;
  d.falhas = 0; d.ate = 0;
}

const espera = (ms) => new Promise((r) => setTimeout(r, ms));

const TMP = os.tmpdir();
const novoDir = (prefixo) => {
  const dir = path.join(TMP, `${prefixo}-${crypto.randomUUID()}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};
const limpar = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} };

// PO token: mesmo motivo do server.js (yt-dlp standalone ignora plugin-dirs do
// config file), mas lido aqui de forma independente.
const POT_ARGS = process.env.BGUTIL_POT_BASE_URL ? ['--plugin-dirs', '/root/.config/yt-dlp/plugins'] : [];

// Cookies próprios, gravados POR JOB (arquivo compartilhado entre jobs
// corrompe: dois yt-dlp escrevendo no mesmo cookies.txt).
// COOKIES — usados SÓ pra listar o canal (yt-dlp --flat-playlist).
// O DOWNLOAD não usa cookie nenhum — nem passa por este container.
// Env própria BAIXATUDO_COOKIES, NUNCA a YOUTUBE_COOKIES do BaixaBlue.
// ⚠️ Lição de 03/08: com cookie presente o yt-dlp DESCARTA os clients
// android_vr/ios ("does not support cookies") e sobra zero formato. Por isso a
// listagem tolera cookie ausente — e funciona melhor sem ele.
// O yt-dlp exige o cabeçalho Netscape; sem ele o arquivo é rejeitado inteiro.
function cookiesDoJob(dir, plataforma) {
  // UMA ENV POR REDE: queimar o cookie do Instagram não pode derrubar a
  // listagem do YouTube nem a do TikTok. Nenhuma delas é a do BaixaBlue.
  const porRede = {
    youtube: process.env.BAIXATUDO_COOKIES,
    tiktok: process.env.BAIXATUDO_TIKTOK_COOKIES,
    instagram: process.env.BAIXATUDO_IG_COOKIES,
  };
  const bruto = (plataforma ? porRede[plataforma] : process.env.BAIXATUDO_COOKIES) || '';
  if (!bruto || bruto.length < 50) return null;
  try {
    let conteudo = bruto.replace(/\r\n?/g, '\n');
    if (!conteudo.startsWith('# Netscape HTTP Cookie File')) {
      conteudo = '# Netscape HTTP Cookie File\n# http://curl.haxx.se/rfc/cookie_spec.html\n# This is a generated file!  Do not edit.\n\n' + conteudo;
    }
    if (!conteudo.endsWith('\n')) conteudo += '\n';
    const arquivo = path.join(dir, 'cookies.txt');
    fs.writeFileSync(arquivo, conteudo, { mode: 0o600 });
    return arquivo;
  } catch (e) { return null; }
}

// spawn próprio. Consome stdout E stderr sempre — se o buffer de um pipe
// enche sem leitor, o yt-dlp trava pra sempre.
function rodar(cmd, args, { timeoutMs = 180000 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args);
    let saida = '', erro = '', morto = false;
    const alarme = setTimeout(() => { morto = true; try { p.kill('SIGKILL'); } catch (e) {} }, timeoutMs);
    p.stdout.on('data', (d) => { saida += d.toString(); });
    p.stderr.on('data', (d) => { erro += d.toString(); });
    p.on('error', (e) => { clearTimeout(alarme); reject(e); });
    p.on('close', (code) => {
      clearTimeout(alarme);
      if (morto) return reject(new Error('timeout'));
      if (code === 0) return resolve({ saida, erro });
      reject(new Error(`yt-dlp saiu ${code}: ${erro.slice(-500)}`));
    });
  });
}

// Resolve o link do PERFIL nas 3 plataformas → { plataforma, url }.
// YouTube: usa a ABA /shorts (lista oficial). Isso evita o erro que a Virais já
// cometeu — lá o corte era por DURAÇÃO e Shorts de 91-180s foram descartados.
// TikTok/Instagram: a própria página do perfil já é a lista de vídeos.
function urlDoCanal(bruto) {
  const r = resolverPerfil(bruto);
  return r ? r.url : null;   // compat: quem só quer a URL
}

function resolverPerfil(bruto) {
  const u = String(bruto || '').trim();
  if (!u) return null;

  // ── TikTok ──
  let m = u.match(/tiktok\.com\/@([A-Za-z0-9._-]+)/i);
  if (m) return { plataforma: 'tiktok', perfil: '@' + m[1], url: `https://www.tiktok.com/@${m[1]}` };

  // ── Instagram (perfil, não post) ──
  m = u.match(/instagram\.com\/(?!p\/|reel\/|reels\/|stories\/)([A-Za-z0-9._]+)/i);
  if (m) return { plataforma: 'instagram', perfil: '@' + m[1], url: `https://www.instagram.com/${m[1]}/` };

  // ── YouTube ──
  if (/^@[A-Za-z0-9._-]+$/.test(u)) return { plataforma: 'youtube', perfil: u, url: `https://www.youtube.com/${u}/shorts` };
  m = u.match(/youtube\.com\/(@[A-Za-z0-9._-]+)/i);
  if (m) return { plataforma: 'youtube', perfil: m[1], url: `https://www.youtube.com/${m[1]}/shorts` };
  m = u.match(/youtube\.com\/(channel\/UC[A-Za-z0-9_-]{20,})/i);
  if (m) return { plataforma: 'youtube', perfil: m[1], url: `https://www.youtube.com/${m[1]}/shorts` };
  m = u.match(/youtube\.com\/((?:c|user)\/[A-Za-z0-9._-]+)/i);
  if (m) return { plataforma: 'youtube', perfil: m[1], url: `https://www.youtube.com/${m[1]}/shorts` };

  return null;
}

// Monta a URL do vídeo a partir do que o yt-dlp devolveu na listagem. O
// download precisa da URL COMPLETA (no TikTok o id sozinho não basta — o link
// carrega o @perfil).
function urlDoVideo(plataforma, entrada, perfil) {
  if (entrada.url && /^https?:\/\//.test(entrada.url)) return entrada.url;
  if (plataforma === 'youtube') return `https://www.youtube.com/shorts/${entrada.id}`;
  if (plataforma === 'tiktok') return `https://www.tiktok.com/${perfil}/video/${entrada.id}`;
  if (plataforma === 'instagram') return `https://www.instagram.com/reel/${entrada.id}/`;
  return null;
}

// Thumbnail: no YouTube dá pra montar por id; nas outras vem do próprio yt-dlp.
function thumbDe(plataforma, entrada) {
  if (plataforma === 'youtube') return `https://i.ytimg.com/vi/${entrada.id}/hqdefault.jpg`;
  return entrada.thumbnail || entrada.thumbnails?.[0]?.url || null;
}

function amigavel(msg, plataforma) {
  // Mensagem SEM jargão: quem lê é criador, não operador. O diagnóstico
  // técnico (motor fora, cookie etc) vive no /baixatudo-health.
  if (/Sign in to confirm|not a bot/i.test(msg)) return { status: 503, error: 'bot_check', detail: 'O YouTube pediu verificação agora. Tenta de novo em alguns minutos.' };
  // piso de 720p em todos os degraus do seletor: se não bateu, é porque o
  // YouTube não ofereceu HD pra esse vídeo. Falha explícita > 360p disfarçado.
  if (/Requested format is not available|No video formats found/i.test(msg)) {
    return { status: 422, error: 'sem_hd', detail: 'Esse Short não tem versão HD disponível no YouTube.' };
  }
  // O Instagram NÃO deixa enumerar perfil sem login — medido em 03/08: o
  // extractor instagram:user devolve "Unable to extract data" quando não há
  // cookie, e instagram:story diz "You need to log in" na cara. Cai aqui pra
  // não mentir "não achei esse perfil".
  if (plataforma === 'instagram' && /Unable to extract data|Unable to extract shared data/i.test(msg)) {
    return { status: 503, error: 'perfil_bloqueado', detail: 'O Instagram exige uma conta conectada pra listar um perfil. Ainda não configuramos isso — me avisa que eu ligo.' };
  }
  if (/login required|requested content is not available|rate.?limit reached|Restricted Video|You need to log in/i.test(msg)) {
    return { status: 503, error: 'perfil_bloqueado', detail: (plataforma === 'instagram'
      ? 'O Instagram exigiu login pra ler esse perfil. Perfis públicos costumam funcionar — se persistir, me avisa.'
      : 'A rede exigiu login pra ler esse perfil agora. Tenta de novo em alguns minutos.') };
  }
  if (/does not have|not found|Unable to recognize|Unable to download webpage|Unable to extract/i.test(msg)) return { status: 404, error: 'canal_nao_encontrado', detail: 'Não achei esse perfil — confere o link, ou ele não tem vídeos públicos.' };
  if (/private|unavailable|removed|age.?restricted/i.test(msg)) return { status: 404, error: 'indisponivel', detail: 'Esse vídeo está privado, foi removido ou tem restrição.' };
  if (/timeout/i.test(msg)) return { status: 504, error: 'timeout', detail: 'Demorou demais. Tenta de novo.' };
  return { status: 500, error: 'falhou', detail: msg.slice(0, 200) };
}

const cors = (res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
};

router.options('/baixatudo-list', (req, res) => { cors(res); res.status(204).end(); });

// ── SAÚDE DA LISTAGEM ─────────────────────────────────────────────────────
// Aqui só mora a listagem: o DOWNLOAD é Vercel→Cobalt→navegador e nem passa
// por este container. Além de "funciona?", reporta o estado da contenção.
router.get('/baixatudo-health', async (req, res) => {
  cors(res);
  const estado = {
    papel: 'apenas listagem (download nao passa por aqui)',
    fila: { rodando, teto: TETO_SIMULTANEO },
    cache: { entradas: cache.size, ttl_min: Math.round(CACHE_TTL_MS / 60000), hits: cacheHits, miss: cacheMiss },
    disjuntor: Object.fromEntries(Object.entries(disjuntor).map(([k, v]) => [k, v.ate > Date.now() ? 'EM DESCANSO' : 'ok'])),
    cookies: {
      youtube: (process.env.BAIXATUDO_COOKIES || '').length > 50,
      tiktok: (process.env.BAIXATUDO_TIKTOK_COOKIES || '').length > 50,
    },
  };
  if (req.query.rapido === '1') return res.status(200).json({ ok: true, ...estado });

  const dir = novoDir('btsaude');
  try {
    const cookies = cookiesDoJob(dir, 'youtube');
    const args = [...POT_ARGS, '--flat-playlist', '--dump-single-json',
      '--playlist-end', '1', '--no-warnings', '--force-ipv4', '--socket-timeout', '20'];
    if (cookies) args.push('--cookies', cookies);
    args.push('https://www.youtube.com/@XiroRanks/shorts');
    const t0 = Date.now();
    const { saida } = await rodar('yt-dlp', args, { timeoutMs: 60000 });
    const d = JSON.parse(saida);
    limpar(dir);
    return res.status(200).json({
      ok: true, ...estado,
      canal: d.channel || d.title || '?', achou: (d.entries || []).length, ms: Date.now() - t0,
    });
  } catch (e) {
    limpar(dir);
    const f = amigavel(String(e.message || ''), 'youtube');
    return res.status(200).json({ ok: false, reason: f.error, detail: f.detail, ...estado });
  }
});

// ── LISTAR ────────────────────────────────────────────────────────────────
// --flat-playlist: só metadata, não baixa vídeo nenhum. Rápido e sem custo.
router.post('/baixatudo-list', async (req, res) => {
  cors(res);
  const alvo = resolverPerfil(req.body && req.body.channel_url);
  if (!alvo) {
    return res.status(400).json({
      error: 'canal_invalido',
      detail: 'Cole o link do perfil: youtube.com/@canal ou tiktok.com/@perfil.',
    });
  }

  const limite = Math.min(parseInt((req.body && req.body.limite) || TETO_SHORTS, 10) || TETO_SHORTS, TETO_SHORTS);
  const debug = req.body && req.body.debug === 1;
  const urlAlvo = (req.body && req.body.url_teste) || alvo.url;
  const chave = alvo.plataforma + '|' + urlAlvo + '|' + limite;

  // ── cache: perfil listado de novo não roda yt-dlp ──
  if (!debug) {
    const guardado = cacheLer(chave);
    if (guardado) return res.status(200).json({ ...guardado, cache: true });
  }

  // ── disjuntor: rede castigada = erro na hora, sem gastar processo ──
  if (disjuntorAberto(alvo.plataforma)) {
    res.setHeader('Retry-After', '120');
    return res.status(503).json({
      error: 'rede_em_descanso',
      detail: 'A rede está limitando nossos acessos agora. Dá 2 minutinhos e tenta de novo.',
      plataforma: alvo.plataforma,
    });
  }

  // ── FILA: teto REAL de processos simultâneos ──
  // Sem isto, 50 pessoas = 50 yt-dlp no container que também roda o BaixaBlue.
  if (rodando >= TETO_SIMULTANEO) {
    res.setHeader('Retry-After', '5');
    return res.status(429).json({ error: 'ocupado', detail: 'Fila cheia — já já é sua vez.' });
  }
  rodando++;

  const dir = novoDir('btlist');
  const soltar = () => { rodando = Math.max(0, rodando - 1); limpar(dir); };

  try {
    const cookies = cookiesDoJob(dir, alvo.plataforma);
    const args = [
      ...POT_ARGS,
      '--flat-playlist', '--dump-single-json',
      '--playlist-end', String(limite),
      '--no-warnings', '--no-check-certificate', '--force-ipv4',
      '--socket-timeout', '20',
    ];
    if (cookies) args.push('--cookies', cookies);
    args.push(urlAlvo);

    // ── retry com espera progressiva: falha de rede costuma passar sozinha ──
    let saida = null, ultimo = null;
    for (let tentativa = 0; tentativa < 2; tentativa++) {
      try {
        const r = await rodar('yt-dlp', args, { timeoutMs: 240000 });
        saida = r.saida; ultimo = null; break;
      } catch (e) {
        ultimo = e;
        const m = String(e.message || '');
        // erro definitivo não merece segunda tentativa
        if (/Unsupported URL|not found|does not exist|Unable to extract data/i.test(m)) break;
        if (tentativa === 0) await espera(2500);
      }
    }
    if (ultimo) throw ultimo;

    const dados = JSON.parse(saida);
    const itens = (Array.isArray(dados.entries) ? dados.entries : [])
      .filter((e) => e && e.id)
      .map((e) => ({
        id: e.id,
        titulo: (e.title || e.description || '').toString().trim().slice(0, 120) || alvo.plataforma,
        url: urlDoVideo(alvo.plataforma, e, alvo.perfil),
        duracao: e.duration || null,
        views: e.view_count || null,
        thumb: thumbDe(alvo.plataforma, e),
      }))
      .filter((x) => x.url);

    const resposta = {
      plataforma: alvo.plataforma,
      canal: dados.channel || dados.uploader || dados.title || alvo.perfil,
      canal_url: alvo.url,
      total: itens.length,
      teto_atingido: itens.length >= limite,
      shorts: itens,
    };
    if (!debug && itens.length) cacheGravar(chave, resposta);
    registrarSucesso(alvo.plataforma);
    soltar();
    return res.status(200).json({ ...resposta, cache: false });
  } catch (e) {
    soltar();
    const m = String(e.message || '');
    console.error('[baixatudo-list]', alvo.plataforma, m.slice(0, 250));
    // só conta pro disjuntor o que cheira a punição da rede
    if (/Sign in to confirm|not a bot|rate.?limit|429|timeout|You need to log in/i.test(m)) {
      registrarFalha(alvo.plataforma);
    }
    const f = amigavel(m, alvo.plataforma);
    return res.status(f.status).json({
      error: f.error, detail: f.detail, plataforma: alvo.plataforma,
      ...(debug ? { cru: m.slice(0, 900), url_usada: urlAlvo } : {}),
    });
  }
});

module.exports = router;
// helpers puros expostos pros testes (o router segue sendo o export principal —
// express Router é função, então pendurar propriedade não afeta o app.use)
module.exports._interno = { urlDoCanal, resolverPerfil, urlDoVideo, amigavel, TETO_SHORTS, TETO_SIMULTANEO,
  cacheLer, cacheGravar, disjuntorAberto, registrarFalha, registrarSucesso, disjuntor };
