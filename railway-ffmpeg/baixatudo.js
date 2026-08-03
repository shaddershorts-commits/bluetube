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
// A diferença de propósito também é total:
//   /youtube-process → yt-dlp + libx264 crf18 preset medium (RE-ENCODE, minutos)
//   /baixatudo-video → yt-dlp com merge '-c copy' (CÓPIA de stream, segundos)
// O seletor força avc1+m4a de propósito: são os codecs nativos do mp4, então o
// merge sai por cópia. Deixar o yt-dlp pegar VP9/opus obrigaria transcode e
// jogaria fora exatamente a velocidade que é o ponto da feature.
//
// Rotas (montadas na raiz pelo server.js):
//   POST /baixatudo-list   { channel_url, limite? } → { canal, total, shorts[] }
//   GET  /baixatudo-video  ?id=&nome=               → stream do mp4 HD

const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const crypto = require('crypto');

const router = express.Router();

const TETO_SHORTS = parseInt(process.env.BAIXATUDO_MAX || '60', 10);
// Teto de processos simultâneos SÓ desta feature. Protege o download normal:
// mesmo que 10 pessoas disparem lotes juntas, o BaixaTudo nunca toma o
// container inteiro e deixa o /youtube-process sem CPU.
const TETO_SIMULTANEO = parseInt(process.env.BAIXATUDO_CONCURRENCY || '2', 10);
let rodando = 0;

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
// O yt-dlp exige o cabeçalho Netscape; sem ele o arquivo é rejeitado inteiro.
function cookiesDoJob(dir) {
  const bruto = process.env.YOUTUBE_COOKIES || '';
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

// Aceita @handle, /channel/UC..., /c/nome, /user/nome — devolve a ABA /shorts.
// Usar a aba oficial evita o erro que a Virais já cometeu: lá o corte era por
// DURAÇÃO e os Shorts de 91-180s foram descartados. Aqui o próprio YouTube diz
// o que é Short.
function urlDoCanal(bruto) {
  const u = String(bruto || '').trim();
  if (!u) return null;
  if (/^@[A-Za-z0-9._-]+$/.test(u)) return `https://www.youtube.com/${u}/shorts`;
  let m = u.match(/youtube\.com\/(@[A-Za-z0-9._-]+)/i);
  if (m) return `https://www.youtube.com/${m[1]}/shorts`;
  m = u.match(/youtube\.com\/(channel\/UC[A-Za-z0-9_-]{20,})/i);
  if (m) return `https://www.youtube.com/${m[1]}/shorts`;
  m = u.match(/youtube\.com\/((?:c|user)\/[A-Za-z0-9._-]+)/i);
  if (m) return `https://www.youtube.com/${m[1]}/shorts`;
  return null;
}

function amigavel(msg) {
  if (/Sign in to confirm|not a bot/i.test(msg)) return { status: 503, error: 'bot_check', detail: 'O YouTube pediu verificação agora. Tenta de novo em alguns minutos.' };
  if (/does not have|not found|Unable to recognize|Unable to download webpage/i.test(msg)) return { status: 404, error: 'canal_nao_encontrado', detail: 'Não achei esse canal — confere o link, ou ele não tem Shorts públicos.' };
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
router.options('/baixatudo-video', (req, res) => { cors(res); res.status(204).end(); });

// ── LISTAR ────────────────────────────────────────────────────────────────
// --flat-playlist: só metadata, não baixa vídeo nenhum. Rápido e sem custo.
router.post('/baixatudo-list', async (req, res) => {
  cors(res);
  const canal = urlDoCanal(req.body && req.body.channel_url);
  if (!canal) return res.status(400).json({ error: 'canal_invalido', detail: 'Cole o link do canal (ex: youtube.com/@nomedocanal).' });

  const limite = Math.min(parseInt((req.body && req.body.limite) || TETO_SHORTS, 10) || TETO_SHORTS, TETO_SHORTS);
  const dir = novoDir('btlist');
  try {
    const cookies = cookiesDoJob(dir);
    const args = [
      ...POT_ARGS,
      '--flat-playlist', '--dump-single-json',
      '--playlist-end', String(limite),
      '--no-warnings', '--no-check-certificate', '--force-ipv4',
      '--socket-timeout', '20',
    ];
    if (cookies) args.push('--cookies', cookies);
    args.push(canal);

    const { saida } = await rodar('yt-dlp', args, { timeoutMs: 90000 });
    const dados = JSON.parse(saida);
    const shorts = (Array.isArray(dados.entries) ? dados.entries : [])
      .filter((e) => e && e.id)
      .map((e) => ({
        id: e.id,
        titulo: e.title || 'Short',
        duracao: e.duration || null,
        views: e.view_count || null,
        thumb: `https://i.ytimg.com/vi/${e.id}/oardefault.jpg`,
      }));

    limpar(dir);
    return res.status(200).json({
      canal: dados.channel || dados.uploader || dados.title || 'Canal',
      canal_url: canal,
      total: shorts.length,
      teto_atingido: shorts.length >= limite,
      shorts,
    });
  } catch (e) {
    limpar(dir);
    const m = String(e.message || '');
    console.error('[baixatudo-list]', m.slice(0, 250));
    const f = amigavel(m);
    return res.status(f.status).json({ error: f.error, detail: f.detail });
  }
});

// ── BAIXAR UM SHORT EM HD ─────────────────────────────────────────────────
router.get('/baixatudo-video', async (req, res) => {
  cors(res);
  const id = String(req.query.id || '').trim();
  if (!/^[\w-]{11}$/.test(id)) return res.status(400).json({ error: 'id_invalido' });

  if (rodando >= TETO_SIMULTANEO) {
    // 429 explícito: o front espera e tenta de novo, em vez de empilhar
    // processos e roubar CPU do download normal.
    res.setHeader('Retry-After', '4');
    return res.status(429).json({ error: 'ocupado', detail: 'Fila cheia, tentando de novo…' });
  }

  rodando++;
  const dir = novoDir('btvid');
  const soltar = () => { rodando = Math.max(0, rodando - 1); limpar(dir); };

  try {
    const cookies = cookiesDoJob(dir);
    // HD por CÓPIA — a cascata desce de 1080p pro melhor disponível, mas as
    // 3 primeiras opções são avc1+m4a (merge por cópia). Só o último degrau
    // aceitaria transcode, e é rede de segurança pra vídeo exótico.
    const args = [
      ...POT_ARGS,
      '-f', 'bv*[height>=1080][vcodec^=avc1]+ba[ext=m4a]/bv*[vcodec^=avc1]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b',
      '--merge-output-format', 'mp4',
      '--no-playlist', '--no-warnings', '--no-check-certificate', '--force-ipv4',
      '--socket-timeout', '20',
      '--extractor-args', 'youtube:player_client=tv_embedded,android_vr,android_testsuite,ios',
      '-o', path.join(dir, 'v.%(ext)s'),
    ];
    if (cookies) args.push('--cookies', cookies);
    args.push(`https://www.youtube.com/shorts/${id}`);

    await rodar('yt-dlp', args, { timeoutMs: 180000 });

    const achados = fs.readdirSync(dir).filter((f) => f.startsWith('v.'));
    if (!achados.length) throw new Error('nenhum arquivo baixado');
    const arquivo = path.join(dir, achados[0]);
    const stat = fs.statSync(arquivo);
    if (stat.size < 1024) throw new Error('arquivo vazio');

    // Nome do arquivo = TÍTULO ORIGINAL do short (o front manda em ?nome=)
    const nome = String(req.query.nome || id).replace(/[^\w\s.()\-À-ÿ]/g, '_').trim().slice(0, 90) || id;
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Length', String(stat.size));
    res.setHeader('Content-Disposition', `attachment; filename="${nome}.mp4"`);

    const stream = fs.createReadStream(arquivo);
    stream.pipe(res);
    stream.on('close', soltar);
    stream.on('error', () => { soltar(); try { res.destroy(); } catch (e) {} });
    req.on('aborted', () => { try { stream.destroy(); } catch (e) {} soltar(); });
  } catch (e) {
    soltar();
    const m = String(e.message || '');
    console.error('[baixatudo-video]', id, m.slice(0, 200));
    if (res.headersSent) return;
    const f = amigavel(m);
    return res.status(f.status).json({ error: f.error, detail: f.detail });
  }
});

module.exports = router;
// helpers puros expostos pros testes (o router segue sendo o export principal —
// express Router é função, então pendurar propriedade não afeta o app.use)
module.exports._interno = { urlDoCanal, amigavel, TETO_SHORTS, TETO_SIMULTANEO };
