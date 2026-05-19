// BlueTube FFmpeg Pipeline Service
// Rodado no Railway. Recebe jobs do Vercel (/api/blue-editor action=edit)
// e renderiza o vídeo final do BlueEditor com ffmpeg.

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process');
const axios = require('axios');
const os = require('os');
const multer = require('multer');
let sharp = null;
try { sharp = require('sharp'); } catch (e) { console.warn('[bluetube-ffmpeg] sharp não disponível — fingerprint desabilitado:', e.message); }

const app = express();
app.use(express.json({ limit: '2mb' }));

const PORT = process.env.PORT || 3000;
const JOBS = new Map(); // jobId → { status, progress, output_url, error }

// ── HELPERS ────────────────────────────────────────────────────────────────

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { ...opts });
    let stderr = '';
    let stdout = '';
    p.stdout.on('data', (d) => { stdout += d.toString(); });
    p.stderr.on('data', (d) => { stderr += d.toString(); });
    p.on('error', reject);
    p.on('close', (code, signal) => {
      if (code === 0) resolve({ stdout, stderr });
      else {
        const sigPart = signal ? ` (signal=${signal})` : '';
        const exitPart = code !== null ? ` (exit=${code})` : '';
        reject(new Error(`${cmd} failed${exitPart}${sigPart}: ${stderr.slice(-1000)}`));
      }
    });
  });
}

async function downloadFile(url, dest) {
  const writer = fs.createWriteStream(dest);
  const response = await axios.get(url, { responseType: 'stream', timeout: 60000 });
  response.data.pipe(writer);
  return new Promise((resolve, reject) => {
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
}

async function probeDuration(file) {
  const { stdout } = await run('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    file
  ]);
  return parseFloat(stdout.trim()) || 0;
}

// Converte #RRGGBB para formato ASS &HAABBGGRR& (ASS usa BGR)
function hexToAssColor(hex, alpha = '00') {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '#FFFFFF');
  const rgb = m ? m[1] : 'FFFFFF';
  const r = rgb.slice(0, 2), g = rgb.slice(2, 4), b = rgb.slice(4, 6);
  return `&H${alpha}${b}${g}${r}`.toUpperCase();
}

// Formata segundos para H:MM:SS.CS (ASS usa centésimos)
function fmtAssTime(sec) {
  sec = Math.max(0, sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const whole = Math.floor(s);
  const cs = Math.floor((s - whole) * 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(whole).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

// Mapeamento: fonte do estilo (nome Windows/Mac clássico) → fonte REAL disponível no container.
// Alpine tem só Liberation + DejaVu por padrão. Baixamos Bebas Neue, Oswald e Anton no Dockerfile.
function mapEstiloFont(fonte) {
  const f = (fonte || '').toLowerCase();
  if (f.includes('impact'))      return 'Bebas Neue';       // narrow bold caps
  if (f.includes('arial black')) return 'Anton';             // ultra-bold display
  if (f.includes('arial bold'))  return 'Oswald';            // condensed bold
  if (f.includes('oswald'))      return 'Oswald';
  if (f.includes('bebas'))       return 'Bebas Neue';
  if (f.includes('anton'))       return 'Anton';
  return 'Oswald'; // default moderno bold
}

// Palavras-gatilho que recebem ênfase visual (tamanho maior + cor forte + setas)
// Detecção case-insensitive, com/sem acento.
const TRIGGER_WORDS = [
  'IMPRESSIONANTE', 'INCRIVEL', 'INCRÍVEL', 'OLHA', 'NUNCA', 'JAMAIS', 'VEJA',
  'IMPOSSIVEL', 'IMPOSSÍVEL', 'ABSURDO', 'CHOCANTE', 'CHOCADO', 'SEGREDO',
  'NINGUEM', 'NINGUÉM', 'BOMBA', 'INACREDITAVEL', 'INACREDITÁVEL',
  'MILAGRE', 'PROIBIDO', 'FATAL', 'VIRAL', 'URGENTE', 'EXPLODIU', 'CHOROU'
];
function normalizeWord(w) {
  return (w || '')
    .toUpperCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Z0-9]/g, '');
}
const TRIGGER_SET = new Set(TRIGGER_WORDS.map(normalizeWord));
function isTrigger(word) {
  return TRIGGER_SET.has(normalizeWord(word));
}

// Monta o arquivo ASS de legendas estilo karaoke word-by-word
function buildAssSubtitles(words, estilo) {
  const fonte = mapEstiloFont(estilo.legenda_fonte);
  const tamanho = estilo.legenda_tamanho || 72;
  const corAtiva = hexToAssColor(estilo.legenda_cor_ativa || '#FFFF00');
  const corNormal = hexToAssColor(estilo.legenda_cor_normal || '#FFFFFF');
  const corFundo = '&H99000000'; // preto 60%
  const corOutline = '&H00000000';
  // MarginV calculado a partir da posição escolhida (960 = centro vertical em 1920px)
  const pos = estilo.legenda_posicao || 'centro';
  const marginV = pos === 'centro-baixo' ? 400 : pos === 'baixo' ? 200 : 960;

  // PlayRes deve combinar com o OUTPUT (720x1280) pra libass não deformar.
  // BorderStyle=1 (outline+shadow) ao invés de 3 (box) — fica mais clean, estilo dos Shorts virais.
  // Outline=5 preto grosso + Shadow=3 pra legibilidade em qualquer fundo.
  const header = `[Script Info]
Title: BlueEditor
ScriptType: v4.00+
PlayResX: ${OUT_W}
PlayResY: ${OUT_H}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Active,${fonte},${Math.round(tamanho * 0.75)},${corAtiva},${corAtiva},&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,5,3,5,40,40,${Math.round(marginV * 0.67)},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  // Fontsize base enfatizada pra palavras-gatilho (+45% e cor vermelha forte)
  const emphasizedSize = Math.round(tamanho * 0.75 * 1.45);
  const triggerRed = '&H000000FF'; // vermelho puro em BGR

  const events = [];
  for (const w of words || []) {
    const rawText = (w.word || '').trim().replace(/[{}\\]/g, '');
    if (!rawText) continue;
    const start = fmtAssTime(w.start);
    const end = fmtAssTime(Math.max(w.end, w.start + 0.1));
    const display = rawText.toUpperCase();

    // Se é palavra-gatilho: override inline com fontsize maior + cor vermelha + setas
    // Caso contrário: texto normal no estilo Active
    const text = isTrigger(rawText)
      ? `{\\fs${emphasizedSize}\\c${triggerRed}\\bord6}→ ${display} ←{\\r}`
      : display;
    events.push(`Dialogue: 0,${start},${end},Active,,0,0,0,,${text}`);
  }

  return header + events.join('\n') + '\n';
}

// Baixa arquivos + prepara /tmp/{jobId}/
async function prepareInputs(dir, opts) {
  fs.mkdirSync(dir, { recursive: true });
  await downloadFile(opts.video_url, path.join(dir, 'input.mp4'));
  await downloadFile(opts.audio_url, path.join(dir, 'narration.mp3'));
  if (opts.musica_url) {
    try { await downloadFile(opts.musica_url, path.join(dir, 'music.mp3')); }
    catch (e) { console.log('[music] download falhou, seguindo sem música:', e.message); }
  }
}

// Resolução de saída — 1080x1920 (full HD vertical, padrão Shorts).
// Viável agora porque o pipeline simplificou (zoompan removido, segmentação
// removida, render em 2 passes com -c:v copy no pass2). Memoria pico <400MB.
const OUT_W = 1080;
const OUT_H = 1920;

// Render em 2 passes (mesmo approach, mas SEM segmentação):
//   Pass 1: source (com -stream_loop se mais curto que narração) + scale+crop + ass → video_only
//   Pass 2: video_only + narração [+ música] → mux final com -c:v copy
// A segmentação por estilo (buildSegments) foi removida — era cosmética e estava produzindo
// bugs (duração incorreta, áudio dropado, -ss fast seek falhando em keyframes esparsos).
async function finalRender(dir, estilo, hasMusic, audioDur, videoDur) {
  // ASS filter precisa do path com colons escapados (ffmpeg filter parser)
  const assPath = path.join(dir, 'subs.ass').replace(/\\/g, '/').replace(/:/g, '\\:');
  const videoOnly = path.join(dir, 'video_only.mp4');

  // ── PASS 1: source + loop se necessário + scale/crop/ass → video_only (sem áudio) ──
  const pass1Args = ['-y', '-threads', '1'];
  if (videoDur > 0 && videoDur < audioDur) {
    // Source mais curto que narração → loop infinito até cobrir
    pass1Args.push('-stream_loop', '-1');
  }
  pass1Args.push(
    '-i', path.join(dir, 'input.mp4'),
    '-t', String(audioDur),
    '-vf', `scale=${OUT_W}:${OUT_H}:force_original_aspect_ratio=increase,crop=${OUT_W}:${OUT_H},setsar=1,ass=${assPath}`,
    '-an',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    videoOnly
  );
  await run('ffmpeg', pass1Args);

  // ── PASS 2: muxa áudio por cima (copy vídeo, encode só áudio) ──
  const musicVol = typeof estilo.musica_volume === 'number' ? estilo.musica_volume : 0.18;
  const args = [
    '-y', '-threads', '1',
    '-i', videoOnly,
    '-i', path.join(dir, 'narration.mp3'),
  ];
  if (hasMusic) args.push('-i', path.join(dir, 'music.mp3'));

  if (hasMusic) {
    // Mix narração + música via filter_complex
    args.push(
      '-filter_complex',
      `[1:a]volume=1.0[a1];[2:a]volume=${musicVol}[a2];[a1][a2]amix=inputs=2:duration=first:dropout_transition=0[a]`,
      '-map', '0:v',
      '-map', '[a]'
    );
  } else {
    // Caso simples: map direto do áudio do input 1, sem filter_complex
    args.push('-map', '0:v', '-map', '1:a');
  }

  args.push(
    '-c:v', 'copy',
    '-c:a', 'aac', '-b:a', '128k',
    '-shortest',
    '-movflags', '+faststart',
    path.join(dir, 'output.mp4')
  );

  await run('ffmpeg', args);
}

// Upload para Supabase Storage via REST
async function uploadToSupabase(filePath, outputPath, supabaseUrl, supabaseKey) {
  const bucket = 'blue-videos';
  const url = `${supabaseUrl}/storage/v1/object/${bucket}/${outputPath}`;
  const fileBuffer = fs.readFileSync(filePath);

  const res = await axios.post(url, fileBuffer, {
    headers: {
      'Content-Type': 'video/mp4',
      'Authorization': `Bearer ${supabaseKey}`,
      'apikey': supabaseKey,
      'x-upsert': 'true'
    },
    maxBodyLength: Infinity,
    maxContentLength: Infinity
  });

  if (res.status >= 200 && res.status < 300) {
    return `${supabaseUrl}/storage/v1/object/public/${bucket}/${outputPath}`;
  }
  throw new Error(`Upload failed: ${res.status}`);
}

// ── JOB RUNNER ─────────────────────────────────────────────────────────────

async function processJob(jobId, opts) {
  const dir = path.join('/tmp', jobId);
  const update = (status, progress, extra = {}) => {
    JOBS.set(jobId, { status, progress, ...extra });
  };

  try {
    update('downloading', 10);
    await prepareInputs(dir, opts);

    update('probing', 20);
    const videoDur = await probeDuration(path.join(dir, 'input.mp4'));
    const audioDur = await probeDuration(path.join(dir, 'narration.mp3'));
    if (audioDur < 1) throw new Error('Narração muito curta ou inválida');

    update('subtitles', 30);
    const assContent = buildAssSubtitles(opts.words, opts.estilo);
    fs.writeFileSync(path.join(dir, 'subs.ass'), assContent);

    update('rendering', 50);
    const hasMusic = opts.musica_url && fs.existsSync(path.join(dir, 'music.mp3'));
    await finalRender(dir, opts.estilo, hasMusic, audioDur, videoDur);

    update('uploading', 90);
    const outputPath = opts.output_path || `editor/${jobId}/output.mp4`;
    const outputUrl = await uploadToSupabase(
      path.join(dir, 'output.mp4'),
      outputPath,
      opts.supabase_url,
      opts.supabase_key
    );

    update('done', 100, { output_url: outputUrl });

    // Cleanup after 60s
    setTimeout(() => {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
    }, 60000);
  } catch (err) {
    console.error('[job]', jobId, 'failed:', err.message);
    JOBS.set(jobId, { status: 'error', progress: 0, error: err.message });
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  }
}

// ── ROUTES ──────────────────────────────────────────────────────────────────

app.get('/health', async (req, res) => {
  try {
    const { stdout: ffmpegOut } = await run('ffmpeg', ['-version']);
    const ffmpegVer = (ffmpegOut.match(/ffmpeg version (\S+)/) || [])[1] || 'unknown';
    let ytdlpVer = 'n/a';
    try {
      const { stdout: yOut } = await run('yt-dlp', ['--version']);
      ytdlpVer = yOut.trim();
    } catch (e) {}
    res.json({
      ok: true,
      ffmpeg: ffmpegVer,
      ytdlp: ytdlpVer,
      build: 'r5-multi-client',
      jobs_in_memory: JOBS.size
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/process', (req, res) => {
  const { video_url, audio_url, words, estilo, musica_url, supabase_url, supabase_key, output_path } = req.body || {};
  if (!video_url || !audio_url || !Array.isArray(words) || !estilo) {
    return res.status(400).json({ error: 'Faltam campos: video_url, audio_url, words[], estilo' });
  }
  if (!supabase_url || !supabase_key) {
    return res.status(400).json({ error: 'Faltam credenciais Supabase' });
  }

  const jobId = uuidv4();
  JOBS.set(jobId, { status: 'queued', progress: 0 });
  res.json({ ok: true, job_id: jobId });

  // Processa async (não bloqueia a resposta)
  processJob(jobId, { video_url, audio_url, words, estilo, musica_url, supabase_url, supabase_key, output_path })
    .catch(e => console.error('[job-runner] unexpected:', e));
});

app.get('/status/:jobId', (req, res) => {
  const job = JOBS.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job não encontrado (pode ter expirado)' });
  res.json(job);
});

// ── PROXY DOWNLOAD: streaming de URL remoto com CORS aberto ────────────────
// Resolve o problema de CDNs (tokcdn, cdninstagram, etc) que não mandam
// Access-Control-Allow-Origin, impedindo o browser de fetch + blob download.
// Railway baixa o arquivo server-side e re-stream pro browser com CORS:* .
//
// NÃO funciona pra googlevideo.com que é IP-bound (pra YouTube use /youtube-hq).
const PROXY_ALLOWED_HOSTS = [
  'tokcdn.com', 'tiktokcdn.com', 'tiktokv.com',
  'cdninstagram.com', 'fbcdn.net', 'fbsbx.com',
  'twimg.com', 'twitter.com', 'x.com',
  'redditmedia.com', 'redd.it', 'reddit.com',
  'supabase.co', 'supabase.in',
  'googlevideo.com', // tentativa; normalmente falha por IP-bind
  'ytimg.com',
  'up.railway.app', // Cobalt self-hosted (cobalt-production-*.up.railway.app)
  'sc-cdn.net', 'snapchat.com', // Snapchat CDN (cf-st.sc-cdn.net e variantes)
  // Camada 5: Piped + Invidious (fallback YouTube quando providers principais caem)
  'piped.video', 'kavin.rocks', 'adminforge.de', 'private.coffee', 'leptons.xyz',
  'invidious.io', 'yewtu.be', 'nadeko.net', 'nerdvpn.de', 'privacyredirect.com', 'melmac.space',
];
function isHostAllowed(host) {
  return PROXY_ALLOWED_HOSTS.some(h => host.endsWith(h) || host.includes(h));
}

app.get('/proxy-download', async (req, res) => {
  const target = req.query?.url;
  const filename = (req.query?.filename || 'video.mp4').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
  if (!target) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(400).json({ error: 'url query param required' });
  }

  let parsed;
  try { parsed = new URL(target); } catch (e) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(400).json({ error: 'invalid url' });
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(400).json({ error: 'only http/https allowed' });
  }
  if (!isHostAllowed(parsed.hostname)) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(403).json({ error: 'host not allowed: ' + parsed.hostname });
  }

  console.log('[proxy-download]', parsed.hostname, filename);

  // Referer dinâmico por host — CDNs frequentemente validam isso
  const refererFor = (h) => {
    if (h.includes('twimg')) return 'https://twitter.com/';
    if (h.includes('fbcdn') || h.includes('fbsbx')) return 'https://www.facebook.com/';
    if (h.includes('redd.it') || h.includes('redditmedia')) return 'https://www.reddit.com/';
    if (h.includes('cdninstagram') || h.includes('ig')) return 'https://www.instagram.com/';
    if (h.includes('tokcdn') || h.includes('tiktokv') || h.includes('tiktokcdn')) return 'https://www.tiktok.com/';
    if (h.includes('googlevideo') || h.includes('ytimg')) return 'https://www.youtube.com/';
    if (h.includes('sc-cdn') || h.includes('snapchat')) return 'https://www.snapchat.com/';
    return '';
  };
  const refererUrl = refererFor(parsed.hostname);

  const reqHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
  };
  if (refererUrl) {
    reqHeaders['Referer'] = refererUrl;
    // Origin header só pra twimg (Twitter valida estrito).
    // Outros CDNs (googlevideo, cdninstagram) rejeitam Origin cross-origin.
    if (parsed.hostname.includes('twimg')) {
      reqHeaders['Origin'] = refererUrl.replace(/\/$/, '');
    }
  }

  try {
    const upstream = await axios.get(target, {
      responseType: 'stream',
      timeout: 60000,
      maxRedirects: 5,
      headers: reqHeaders,
      validateStatus: () => true
    });

    if (upstream.status >= 400) {
      // FALLBACK yt-dlp local: URLs do googlevideo são IP-bound. Cobalt extrai
      // numa instância (IP_A), Railway proxy tenta baixar de outra (IP_B) → 403.
      // Quando o frontend passa &yt_url=<original_youtube_url>, rodamos yt-dlp
      // local que extrai E baixa no MESMO IP (Railway). Não viola allowlist
      // porque o URL final é googlevideo de qualquer jeito — só com signature
      // que casa com nosso IP.
      const ytUrl = req.query?.yt_url;
      const isGoogleVideo = parsed.hostname.includes('googlevideo');
      if (ytUrl && isGoogleVideo && (upstream.status === 403 || upstream.status === 401 || upstream.status === 410)) {
        return ytdlpFallbackStream(req, res, ytUrl, filename);
      }
      res.setHeader('Access-Control-Allow-Origin', '*');
      return res.status(502).json({ error: `upstream ${upstream.status}`, host: parsed.hostname });
    }

    // Headers CORS + download
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Type');
    res.setHeader('Content-Type', upstream.headers['content-type'] || 'video/mp4');
    if (upstream.headers['content-length']) {
      res.setHeader('Content-Length', upstream.headers['content-length']);
    }
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'public, max-age=3600');

    upstream.data.pipe(res);
    upstream.data.on('error', (err) => {
      console.error('[proxy-download] stream error:', err.message);
      if (!res.headersSent) res.status(500).end();
      else res.end();
    });
  } catch (err) {
    console.error('[proxy-download] failed:', err.message);
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (!res.headersSent) res.status(500).json({ error: 'proxy failed: ' + err.message.slice(0, 300) });
  }
});

// Handle CORS preflight
app.options('/proxy-download', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.status(204).end();
});

// Setup de cookies do YouTube (uma vez por boot). Env var YOUTUBE_COOKIES
// recebe o conteúdo completo de um cookies.txt exportado de browser logado.
// Sem isso, YouTube bloqueia downloads de IPs datacenter (Railway) com
// "Sign in to confirm you're not a bot" em 2026.
const YT_COOKIES_FILE = '/tmp/yt-cookies.txt'; // arquivo "global" (legacy — health/debug)
// Conteúdo já normalizado em cache de memória pra evitar re-processar a env var
let _ytCookiesContent = null;
function _normalizeCookies(raw) {
  if (!raw) return null;
  let content = raw.replace(/\r\n?/g, '\n');
  if (!content.startsWith('# Netscape HTTP Cookie File')) {
    content = '# Netscape HTTP Cookie File\n# http://curl.haxx.se/rfc/cookie_spec.html\n# This is a generated file!  Do not edit.\n\n' + content;
  }
  if (!content.endsWith('\n')) content += '\n';
  return content;
}
function setupYtCookies() {
  // Legacy: escreve o arquivo global pra /yt-cookies-status debug
  if (_ytCookiesContent !== null) return _ytCookiesContent !== false;
  const raw = process.env.YOUTUBE_COOKIES;
  if (!raw) { _ytCookiesContent = false; console.warn('[yt-dlp] YOUTUBE_COOKIES ausente'); return false; }
  try {
    _ytCookiesContent = _normalizeCookies(raw);
    fs.writeFileSync(YT_COOKIES_FILE, _ytCookiesContent, { mode: 0o600 });
    const lines = _ytCookiesContent.split('\n').filter(l => l && !l.startsWith('#')).length;
    console.log('[yt-dlp] cookies cacheados em memória:', _ytCookiesContent.length, 'bytes,', lines, 'cookies');
    return true;
  } catch (e) {
    console.error('[yt-dlp] falha cookies:', e.message);
    _ytCookiesContent = false;
    return false;
  }
}
// Escreve UMA CÓPIA fresca dos cookies pra um job específico. yt-dlp escreve
// session cookies de volta no arquivo durante o uso — se compartilharmos o
// mesmo arquivo entre jobs, o segundo lê um estado corrompido/inválido.
// Retorna o path pro arquivo job-específico, ou null se cookies não disponíveis.
function writeJobCookies(jobDir) {
  if (!setupYtCookies() || !_ytCookiesContent) return null;
  const jobCookiesFile = path.join(jobDir, 'cookies.txt');
  try {
    fs.writeFileSync(jobCookiesFile, _ytCookiesContent, { mode: 0o600 });
    return jobCookiesFile;
  } catch (e) { console.error('[yt-dlp] writeJobCookies falhou:', e.message); return null; }
}

// Health check leve dos cookies — usado pelo cron monitor em api/baixablue-cookies-monitor.js
// Roda yt-dlp --skip-download em vídeo conhecido que precisa de auth.
// Retorna {ok:true} se cookies válidos, {ok:false, reason:'bot_check'} se expirados.
// Custo: ~3-5s + zero quota YouTube significativa (só fetch metadata).
app.get('/cookies-health', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const TEST_URL = 'https://www.youtube.com/shorts/BUqlzukB1Mc'; // requer auth
  const jobDir = path.join('/tmp', 'cookies-health-' + Date.now());
  fs.mkdirSync(jobDir, { recursive: true });
  const cleanup = () => { try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch {} };
  const jobCookies = writeJobCookies(jobDir);

  if (!jobCookies) {
    cleanup();
    return res.json({ ok: false, reason: 'no_cookies', message: 'YOUTUBE_COOKIES env var ausente no Railway' });
  }

  const args = [
    '--cookies', jobCookies,
    '--skip-download',
    '--print', 'id',
    '--no-playlist',
    '--no-warnings',
    '--socket-timeout', '15',
    '--extractor-args', 'youtube:player_client=tv_embedded,android_vr,android_testsuite,ios',
    TEST_URL,
  ];

  try {
    const r = await run('yt-dlp', args);
    cleanup();
    const id = (r.stdout || '').trim();
    if (id && id.length === 11) return res.json({ ok: true, video_id: id });
    return res.json({ ok: false, reason: 'no_id', stdout: r.stdout.slice(0, 200), stderr: r.stderr.slice(0, 200) });
  } catch (err) {
    cleanup();
    const msg = String(err.message || err);
    const isBotCheck = /Sign in to confirm|not a bot|--cookies-from-browser/i.test(msg);
    return res.json({
      ok: false,
      reason: isBotCheck ? 'bot_check' : 'other',
      detail: msg.slice(0, 400),
    });
  }
});

// DEBUG endpoint pra diagnosticar cookies sem precisar de log do Railway
app.get('/yt-cookies-status', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const envPresent = !!process.env.YOUTUBE_COOKIES;
  const envSize = process.env.YOUTUBE_COOKIES?.length || 0;
  const envStarts = (process.env.YOUTUBE_COOKIES || '').slice(0, 40);
  setupYtCookies();
  let fileInfo = { exists: false };
  if (fs.existsSync(YT_COOKIES_FILE)) {
    const stat = fs.statSync(YT_COOKIES_FILE);
    const content = fs.readFileSync(YT_COOKIES_FILE, 'utf8');
    const lines = content.split('\n');
    const cookieLines = lines.filter(l => l && !l.startsWith('#'));
    // Domínios presentes (sanitiza valores)
    const domains = [...new Set(cookieLines.map(l => l.split('\t')[0]).filter(Boolean))].slice(0, 10);
    fileInfo = {
      exists: true,
      size: stat.size,
      total_lines: lines.length,
      cookie_lines: cookieLines.length,
      starts_with: content.slice(0, 60),
      has_youtube_domain: domains.some(d => d.includes('youtube')),
      domains_sample: domains,
      tab_separated: cookieLines.length > 0 ? cookieLines[0].includes('\t') : null,
    };
  }
  res.json({ env_present: envPresent, env_size: envSize, env_starts: envStarts, file: fileInfo });
});

// Fallback: roda yt-dlp local pra baixar+stream quando a URL signed do
// Cobalt deu 403 (IP-bound). Extração + download acontecem no MESMO IP
// (Railway), então a signature emitida agora bate na hora de baixar.
async function ytdlpFallbackStream(req, res, ytUrl, filename) {
  if (res.headersSent) return;
  console.log('[proxy-download] yt-dlp fallback start:', ytUrl);
  const jobId = uuidv4();
  const dir = path.join('/tmp', jobId);
  fs.mkdirSync(dir, { recursive: true });
  const outputFile = path.join(dir, 'video.mp4');
  const jobCookies = writeJobCookies(dir);

  // Cleanup helper — sempre roda
  const cleanup = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} };

  try {
    // Player clients ordenados pelos que MENOS triggam bot-check em IPs datacenter:
    // tv_embedded (smart TV embed, raro pede auth), android_vr (Meta Quest),
    // android_testsuite (test client menos restrito), ios (mais agressivo no fim).
    // REMOVIDOS: web_safari (triggava bot-check), android_creator (precisa auth).
    const ytArgs = [
      // Seletor permissivo: tenta MP4 com video+audio combinados primeiro
      // (single file, sem merge), depois separados (precisa ffmpeg merge),
      // depois qualquer best disponível. Alguns clients só retornam format 18
      // (360p mp4 combinado), o seletor velho rejeitava.
      '-f', 'best[ext=mp4][height<=720]/best[height<=720]/bv*+ba/best',
      '--merge-output-format', 'mp4',
      '--no-playlist',
      '--no-warnings',
      '--no-check-certificate',
      '--force-ipv4',
      '--extractor-args', 'youtube:player_client=tv_embedded,android_vr,android_testsuite,ios',
      '-o', outputFile,
      ytUrl
    ];
    if (jobCookies) {
      const oIdx = ytArgs.indexOf('-o');
      ytArgs.splice(oIdx, 0, '--cookies', jobCookies);
    }
    await run('yt-dlp', ytArgs);
    if (!fs.existsSync(outputFile)) throw new Error('yt-dlp no output');

    const stats = fs.statSync(outputFile);
    console.log('[proxy-download] yt-dlp fallback ok:', stats.size, 'bytes');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Type');
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Length', stats.size);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'public, max-age=3600');

    const stream = fs.createReadStream(outputFile);
    stream.pipe(res);
    stream.on('close', cleanup);
    stream.on('error', (err) => {
      console.error('[proxy-download] yt-dlp stream err:', err.message);
      cleanup();
      if (!res.headersSent) res.status(500).end(); else res.end();
    });
  } catch (err) {
    console.error('[proxy-download] yt-dlp fallback failed:', err.message);
    cleanup();
    if (!res.headersSent) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.status(502).json({ error: 'ytdlp_fallback_failed', detail: String(err.message || err).slice(0, 300) });
    }
  }
}

// ── YOUTUBE HQ: end-to-end ytstream + download + mux + upload no mesmo IP ──
// Resolve o problema de signed URLs IP-bound do YouTube: o IP que chama
// ytstream DEVE ser o mesmo que baixa do googlevideo.com, senão 403.
app.post('/youtube-hq', async (req, res) => {
  const { video_id, rapidapi_key, supabase_url, supabase_key, output_path } = req.body || {};
  if (!video_id) return res.status(400).json({ error: 'video_id required', step: 'validate' });
  if (!rapidapi_key) return res.status(400).json({ error: 'rapidapi_key required', step: 'validate' });
  if (!supabase_url || !supabase_key) return res.status(400).json({ error: 'supabase creds required', step: 'validate' });

  const jobId = uuidv4();
  const dir = path.join('/tmp', jobId);
  fs.mkdirSync(dir, { recursive: true });
  let step = 'init';

  // Sempre responde antes do processamento pesado travar — faz o cleanup async
  // safeStringify: axios errors em modo stream têm responseType:'stream' → response.data
  // é um ReadableStream com refs circulares (TLSSocket). JSON.stringify quebra. Try/catch.
  const safeStringify = (v) => {
    if (v == null) return '';
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    try { return JSON.stringify(v); }
    catch (e) {
      // Stream / circular → tenta extrair pedaço útil
      if (v.readable !== undefined) return '[stream]';
      try { return String(v); } catch { return '[unserializable]'; }
    }
  };
  const fail = (stepName, err) => {
    const detail = err.response?.status
      ? `HTTP ${err.response.status}: ${safeStringify(err.response.data).slice(0, 300)}`
      : (err.message || String(err));
    console.error('[youtube-hq]', jobId, 'step=' + stepName, 'error:', detail);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
    if (!res.headersSent) {
      res.status(500).json({ error: 'youtube-hq failed at ' + stepName, step: stepName, detail: detail.slice(0, 500) });
    }
  };

  try {
    // 1) ytstream call
    step = 'ytstream';
    console.log('[youtube-hq]', jobId, 'step=ytstream', video_id);
    let ytData;
    try {
      const ytR = await axios.get(
        `https://ytstream-download-youtube-videos.p.rapidapi.com/dl?id=${video_id}`,
        {
          headers: {
            'x-rapidapi-key': rapidapi_key,
            'x-rapidapi-host': 'ytstream-download-youtube-videos.p.rapidapi.com'
          },
          timeout: 30000,
          validateStatus: () => true
        }
      );
      if (ytR.status !== 200) {
        return fail('ytstream', { message: `ytstream status ${ytR.status}`, response: { status: ytR.status, data: ytR.data } });
      }
      ytData = ytR.data;
    } catch (e) { return fail('ytstream', e); }

    // 2) parse adaptive formats
    step = 'parse';
    const adaptive = Array.isArray(ytData?.adaptiveFormats) ? ytData.adaptiveFormats : [];
    if (!adaptive.length) return fail('parse', { message: 'ytstream sem adaptiveFormats (count=0, topKeys=' + Object.keys(ytData || {}).slice(0, 8).join(',') + ')' });

    const videoOnly = adaptive
      .filter(f => (f?.mimeType || '').includes('video/mp4') && (f?.mimeType || '').includes('avc1') && f?.url)
      .sort((a, b) => (b.height || 0) - (a.height || 0));
    const audioOnly = adaptive
      .filter(f => (f?.mimeType || '').includes('audio/mp4') && f?.url)
      .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

    const videoFmt = videoOnly[0];
    const audioFmt = audioOnly[0];
    if (!videoFmt) return fail('parse', { message: 'sem video-only mp4 avc1 (videoOnly=' + videoOnly.length + ' adaptiveCount=' + adaptive.length + ')' });
    if (!audioFmt) return fail('parse', { message: 'sem audio-only mp4 (audioOnly=' + audioOnly.length + ')' });

    console.log('[youtube-hq]', jobId, 'step=download v=' + videoFmt.itag + ' ' + videoFmt.qualityLabel + ' a=' + audioFmt.itag);

    // 3) download paralelo
    step = 'download';
    const vFile = path.join(dir, 'video.mp4');
    const aFile = path.join(dir, 'audio.m4a');
    try {
      await Promise.all([
        downloadFile(videoFmt.url, vFile),
        downloadFile(audioFmt.url, aFile)
      ]);
    } catch (e) { return fail('download', e); }

    const vStats = fs.statSync(vFile);
    const aStats = fs.statSync(aFile);
    console.log('[youtube-hq]', jobId, 'step=mux v=' + vStats.size + ' a=' + aStats.size);

    // 4) mux com ffmpeg
    step = 'mux';
    const output = path.join(dir, 'merged.mp4');
    try {
      await run('ffmpeg', [
        '-y', '-threads', '1',
        '-i', vFile,
        '-i', aFile,
        '-c', 'copy',
        '-map', '0:v:0',
        '-map', '1:a:0',
        '-movflags', '+faststart',
        output
      ]);
    } catch (e) { return fail('mux', e); }

    const outStats = fs.statSync(output);
    console.log('[youtube-hq]', jobId, 'step=upload ' + outStats.size);

    // 5) upload pro Supabase
    step = 'upload';
    let publicUrl;
    try {
      const finalPath = output_path || `downloads/youtube/${video_id}_${Date.now()}_hq.mp4`;
      publicUrl = await uploadToSupabase(output, finalPath, supabase_url, supabase_key);
    } catch (e) { return fail('upload', e); }

    // 6) cleanup + success
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}

    console.log('[youtube-hq]', jobId, 'step=done');
    res.json({
      ok: true,
      url: publicUrl,
      size: outStats.size,
      title: ytData.title || null,
      quality: videoFmt.qualityLabel || '1080p',
      video_itag: videoFmt.itag,
      audio_itag: audioFmt.itag,
      video_size: vStats.size,
      audio_size: aStats.size
    });
  } catch (err) {
    return fail(step, err);
  }
});

// ── MUX STREAMS ─────────────────────────────────────────────────────────────
// Baixa 2 streams separados (video-only + audio-only do YouTube adaptiveFormats),
// muxa com ffmpeg -c copy (zero re-encode, instantâneo), sobe pro Supabase.
// Usado pro BaixaBlue HQ: auth.js extrai itag=137 (video 1080p mp4) + itag=140
// (audio m4a) de ytstream, delega pra cá, recebe URL final muxada.
app.post('/mux-streams', async (req, res) => {
  const { video_url, audio_url, supabase_url, supabase_key, output_path, title } = req.body || {};
  if (!video_url || !audio_url) return res.status(400).json({ error: 'video_url + audio_url required' });
  if (!supabase_url || !supabase_key) return res.status(400).json({ error: 'supabase creds required' });

  const jobId = uuidv4();
  const dir = path.join('/tmp', jobId);
  fs.mkdirSync(dir, { recursive: true });

  try {
    console.log('[mux-streams]', jobId, 'downloading...');
    // Download paralelo dos 2 streams
    const vFile = path.join(dir, 'video.mp4');
    const aFile = path.join(dir, 'audio.m4a');
    await Promise.all([
      downloadFile(video_url, vFile),
      downloadFile(audio_url, aFile)
    ]);

    const vStats = fs.statSync(vFile);
    const aStats = fs.statSync(aFile);
    console.log('[mux-streams]', jobId, 'downloaded', vStats.size, '+', aStats.size);

    // Muxa com -c copy (zero re-encode, ~1-2s)
    const output = path.join(dir, 'merged.mp4');
    await run('ffmpeg', [
      '-y', '-threads', '1',
      '-i', vFile,
      '-i', aFile,
      '-c', 'copy',
      '-map', '0:v:0',
      '-map', '1:a:0',
      '-movflags', '+faststart',
      output
    ]);

    const outStats = fs.statSync(output);
    console.log('[mux-streams]', jobId, 'muxed', outStats.size);

    // Upload pro Supabase
    const finalPath = output_path || `downloads/youtube/${jobId}.mp4`;
    const publicUrl = await uploadToSupabase(output, finalPath, supabase_url, supabase_key);

    // Cleanup
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}

    res.json({
      ok: true,
      url: publicUrl,
      size: outStats.size,
      video_size: vStats.size,
      audio_size: aStats.size
    });
  } catch (err) {
    console.error('[mux-streams]', jobId, 'failed:', err.message);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
    res.status(500).json({ error: 'mux failed: ' + err.message.slice(0, 500) });
  }
});

// ── YOUTUBE PROCESS: download max + descaracterização (BlueMetadata) ───────
// Endpoint exclusivo do BaixaBlue pra YouTube. Sempre baixa melhor qualidade
// disponível e SEMPRE aplica 4 camadas de unicidade num único pass de FFmpeg:
//   1. Strip de metadados (-map_metadata -1) — remove EXIF/XMP/software tags
//   2. Reconfiguração visual: zoom random 2-5%, eq subtle, ruído leve
//   3. Descaracterização de áudio: atempo 1-2% (mantém pitch perceptível igual)
//   4. Hash novo: re-encode com bitrate aleatório + container fresh
// Cada chamada gera output diferente (parâmetros random) — vídeo nunca repete.
// runTracked: usa run() pra rodar e registra o process em activeProcs (pra abort).
// Diferente de run() puro porque expõe o process via callback p/ trackeamento.
function runTracked(cmd, args, onSpawn) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args);
    if (onSpawn) onSpawn(p);
    let stderr = '';
    let stdout = '';
    // CRÍTICO consumir AMBOS pipes — yt-dlp escreve progresso, se não consumir buffer fill = hang
    p.stdout.on('data', (d) => { stdout += d.toString(); });
    p.stderr.on('data', (d) => { stderr += d.toString(); });
    p.on('error', reject);
    p.on('close', (code, signal) => {
      if (code === 0) return resolve({ stdout, stderr });
      if (signal === 'SIGKILL' || signal === 'SIGTERM') return reject(new Error('aborted_by_client'));
      reject(new Error(`${cmd} failed (exit=${code}): ${stderr.slice(-800)}`));
    });
  });
}

app.post('/youtube-process', async (req, res) => {
  const { youtube_url } = req.body || {};
  if (!youtube_url) return res.status(400).json({ error: 'youtube_url obrigatório' });
  // [L5] whitelist de host — yt-dlp suporta 1000+ sites, queremos só YouTube
  if (!/^https?:\/\/(www\.|m\.)?(youtube\.com|youtu\.be)/i.test(youtube_url)) {
    return res.status(400).json({ error: 'apenas_youtube', detail: 'Endpoint exclusivo pra URLs do YouTube' });
  }
  // [C3] auth shared-secret — frontend injeta header X-Bluetube-Key.
  // Se YOUTUBE_PROCESS_KEY não setada, endpoint fica aberto (modo dev). Em prod, setar a env.
  const requiredKey = process.env.YOUTUBE_PROCESS_KEY;
  if (requiredKey && req.headers['x-bluetube-key'] !== requiredKey) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const jobId = uuidv4();
  const dir = path.join('/tmp', jobId);
  fs.mkdirSync(dir, { recursive: true });
  const inFilePattern = path.join(dir, 'in.%(ext)s'); // [H1] yt-dlp pode emitir .mkv etc
  const outFile = path.join(dir, 'out.mp4');
  const jobCookies = writeJobCookies(dir);
  const cleanup = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} };

  const log = (msg) => console.log('[youtube-process]', jobId, msg);

  // Abort handler removido temporariamente — req.on('close') tava firing
  // prematuramente em alguns cases e abortando a requisição válida. Quando
  // resolver isso (provavelmente via AbortController + req.on('aborted')),
  // re-adicionar. Por enquanto leaks bounded (~60s max por request orfã).
  let aborted = false;
  let currentProc = null;

  try {
    // ── 1. DOWNLOAD: usa a CADEIA COMPLETA de fallbacks do /api/auth ────
    // (Cobalt → ytstream RapidAPI → youtube-media-downloader RapidAPI → Invidious)
    // — esses serviços pagos têm anti-bot bypass próprio e funcionam sem cookies.
    // yt-dlp + cookies fica como ÚLTIMO recurso (~5% dos casos quando tudo falha).
    let inFile = null;
    let source = null;

    // ── 1a. TENTA COBALT TUNNEL 1080p PRIMEIRO ──────────────────────────
    // Cobalt com videoQuality=1080 escolhe adaptive 1080p que precisa muxing
    // → Cobalt retorna 'tunnel' status → ele MESMO streama o arquivo
    // (IP casa com a signature). Quando funciona = qualidade máxima sem
    // cookies. Quando Cobalt não tem auth pra esse vídeo, falha rápido (~2s).
    const cobaltUrl = process.env.COBALT_API_URL;
    if (cobaltUrl) {
      try {
        log('try cobalt tunnel 1080p');
        const cobaltHeaders = { 'Accept': 'application/json', 'Content-Type': 'application/json' };
        if (process.env.COBALT_API_KEY) cobaltHeaders['Authorization'] = 'Api-Key ' + process.env.COBALT_API_KEY;
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 25000);
        const cr = await fetch(cobaltUrl, {
          method: 'POST', headers: cobaltHeaders,
          body: JSON.stringify({ url: youtube_url, videoQuality: '1080' }),
          signal: ctrl.signal,
        });
        clearTimeout(timer);
        const cd = await cr.json().catch(() => ({}));
        // Só aceita TUNNEL (Cobalt streama = IP casa = sem 403). Redirect URL pode dar 403.
        if (cr.ok && cd.status === 'tunnel' && cd.url) {
          log('cobalt tunnel ok');
          const candidateFile = path.join(dir, 'in.mp4');
          const dlCtrl = new AbortController();
          const dlTimer = setTimeout(() => dlCtrl.abort(), 120000);
          try {
            const dlR = await fetch(cd.url, { signal: dlCtrl.signal });
            clearTimeout(dlTimer);
            if (dlR.ok) {
              const writer = fs.createWriteStream(candidateFile);
              const nodeStream = require('stream');
              await new Promise((resolve, reject) => {
                nodeStream.Readable.fromWeb(dlR.body).pipe(writer);
                writer.on('finish', resolve);
                writer.on('error', reject);
              });
              if (fs.existsSync(candidateFile) && fs.statSync(candidateFile).size > 100000) {
                inFile = candidateFile;
                source = 'cobalt:tunnel:1080';
                log('cobalt tunnel download ' + fs.statSync(candidateFile).size + ' bytes');
              }
            }
          } catch (e) { clearTimeout(dlTimer); log('cobalt tunnel dl err: ' + e.message); }
        } else {
          log('cobalt no tunnel (status: ' + (cd.status || cr.status) + ') — fallback chain');
        }
      } catch (e) { log('cobalt direct err: ' + e.message); }
    }

    // ── 1b. TENTA CHAIN via /api/auth?action=download ────────────────────
    // Pra cada qualidade, /api/auth retorna URL (proxy-wrapped pra Railway
    // ou direta). Se proxy-wrapped, o /proxy-download local lida com 403
    // automaticamente (tem fallback yt-dlp). Então MANTEMOS o wrapper.
    const SITE_URL = process.env.SITE_URL || 'https://bluetubeviral.com';
    const tryAuthChain = async (qualityParam) => {
      try {
        const qStr = qualityParam ? '&quality=' + qualityParam : '';
        log('try chain' + qStr);
        const authCtrl = new AbortController();
        const authTimeout = qualityParam === 'hq' ? 90000 : 35000;
        const authTimer = setTimeout(() => authCtrl.abort(), authTimeout);
        const authR = await fetch(`${SITE_URL}/api/auth?action=download&url=${encodeURIComponent(youtube_url)}${qStr}`, {
          signal: authCtrl.signal,
        });
        clearTimeout(authTimer);
        const authD = await authR.json().catch(() => ({}));
        if (!authR.ok || authD?.provider === 'hq-failed' || !authD?.url) return null;

        // KEEP proxy-download URL — ele tem fallback yt-dlp interno pra 403.
        // Pra URLs diretas (não proxy), também faz fetch direto.
        // Adiciona &yt_url=<original> em URLs proxy-download — ativa o
        // fallback yt-dlp interno (linha 457) quando googlevideo dá 403
        // IP-bound (signed URLs do YouTube sao IP-locked, retornadas por
        // ytstream/RapidAPI no IP da Vercel, falham se baixadas do Railway).
        // api/auth.js nao passa yt_url (intocavel); injetamos aqui.
        let chainUrl = authD.url;
        if (chainUrl.includes('/proxy-download?') && !chainUrl.includes('yt_url=')) {
          chainUrl += '&yt_url=' + encodeURIComponent(youtube_url);
        }
        const candidateFile = path.join(dir, 'in.mp4');
        const dlCtrl = new AbortController();
        const dlTimer = setTimeout(() => dlCtrl.abort(), 120000);
        try {
          const dlR = await fetch(chainUrl, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
              'Accept': '*/*',
            },
            signal: dlCtrl.signal,
          });
          clearTimeout(dlTimer);
          if (!dlR.ok) { log('chain url fetch ' + dlR.status); return null; }
          const writer = fs.createWriteStream(candidateFile);
          const nodeStream = require('stream');
          await new Promise((resolve, reject) => {
            nodeStream.Readable.fromWeb(dlR.body).pipe(writer);
            writer.on('finish', resolve);
            writer.on('error', reject);
          });
          if (fs.existsSync(candidateFile) && fs.statSync(candidateFile).size > 100000) {
            const sz = fs.statSync(candidateFile).size;
            log('chain ok ' + sz + ' bytes via ' + (qualityParam || 'auto'));
            return { file: candidateFile, source: 'chain:' + (qualityParam || 'auto') };
          }
        } catch (e) { clearTimeout(dlTimer); log('chain dl err: ' + e.message); return null; }
        return null;
      } catch (e) { log('chain call err: ' + e.message); return null; }
    };

    // Só tenta a chain se Cobalt tunnel direto não conseguiu (1a)
    if (!inFile) {
      let chainResult = await tryAuthChain('hq');
      if (!chainResult) {
        log('hq failed — try auto');
        chainResult = await tryAuthChain(null);
      }
      if (chainResult) { inFile = chainResult.file; source = chainResult.source; }
    }

    // ── 1b. FALLBACK YT-DLP (com cookies, último recurso) ────────────────
    if (!inFile) {
      log('try yt-dlp');
      // Seletor PERMISSIVO (sincronizado com ytdlpFallbackStream:641).
      // Os clients tv_embedded/android_vr frequentemente so retornam format 18
      // (360p mp4 combinado, sem streams DASH separados). Seletor antigo
      // pedia DASH (bv*+ba) e dava "Requested format is not available".
      // Agora: tenta MP4 combinado <=1080 -> DASH <=1080 -> best [2026-05-19]
      const ytArgs = [
        '-f', 'best[ext=mp4][height<=1080]/best[height<=1080]/bv*[height<=1080]+ba/bv*+ba/best',
        '--merge-output-format', 'mp4',
        '--no-playlist',
        '--no-warnings',
        '--no-check-certificate',
        '--force-ipv4',
        '--extractor-args', 'youtube:player_client=tv_embedded,android_vr,android_testsuite,ios',
        '-o', inFilePattern,
        youtube_url
      ];
      if (jobCookies) {
        const oIdx = ytArgs.indexOf('-o');
        ytArgs.splice(oIdx, 0, '--cookies', jobCookies);
      }
      await runTracked('yt-dlp', ytArgs, (p) => { currentProc = p; });
      if (aborted) return;
      const downloaded = fs.readdirSync(dir).filter(f => f.startsWith('in.'));
      if (!downloaded.length) throw new Error('download_failed_no_file');
      inFile = path.join(dir, downloaded[0]);
      source = 'yt-dlp';
    }

    const inStat = fs.statSync(inFile);
    if (inStat.size < 1024) throw new Error('download_failed_empty');
    log('source=' + source + ' size=' + inStat.size + ' file=' + path.basename(inFile));

    // ── 2. PARÂMETROS ALEATÓRIOS (cada chamada → vídeo diferente) ──────
    const rand = (min, max) => Math.random() * (max - min) + min;
    const zoom = rand(0.02, 0.05);                          // 2-5% zoom
    const noise = Math.floor(rand(1, 4));                   // ruído 1-3
    const brightness = rand(-0.02, 0.02).toFixed(4);        // ±2% brilho
    const saturation = rand(0.97, 1.03).toFixed(4);         // ±3% saturação
    const gamma = rand(0.97, 1.03).toFixed(4);              // ±3% gamma
    const tempo = rand(1.010, 1.025).toFixed(4);            // 1-2.5% mais rápido (algoritmos detectam ≥1%)
    const crfVar = (rand(17, 19)).toFixed(2);               // CRF 17-19 (visualmente lossless, source HQ 1080p preserva qualidade)
    // [L1] mirror DESLIGADO por padrão — flipa texto queimado (subtitles, watermarks).
    // Se quiser reativar futuro: criar query param ?allow_mirror=1.
    const mirror = '';

    const vf = `${mirror}scale=iw*(1+${zoom.toFixed(4)}):-2,crop=iw/(1+${zoom.toFixed(4)}):ih/(1+${zoom.toFixed(4)}),eq=brightness=${brightness}:saturation=${saturation}:gamma=${gamma},noise=alls=${noise}:allf=t`;
    const af = `atempo=${tempo}`;
    log(`process zoom=${(zoom*100).toFixed(1)}% noise=${noise} tempo=${tempo} crf=${crfVar}`);

    // ── 3. FFMPEG: strip metadata + visual + audio + re-encode em ALTA qualidade ─
    // Trocas pra preservar qualidade do source:
    //   - preset MEDIUM (era fast): melhor compressão pra mesma qualidade
    //   - CRF 18-21 random (era bitrate fixo): garante qualidade visual TARGET
    //     em vez de tentar caber em bitrate cap; libx264 usa o bitrate que
    //     precisar pra atingir a qualidade. Random params dos filtros (zoom,
    //     noise, atempo) garantem hash diferente sem depender de bitrate.
    //   - audio 192k (era 128k): preserva qualidade do source
    const ffArgs = [
      '-hide_banner', '-loglevel', 'error',
      '-i', inFile,
      '-map_metadata', '-1',
      '-vf', vf,
      '-af', af,
      '-c:v', 'libx264', '-preset', 'medium', '-crf', crfVar,
      '-pix_fmt', 'yuv420p',                 // compat máxima (sem yuv444)
      '-c:a', 'aac', '-b:a', '192k',
      '-movflags', '+faststart',
      '-y',
      outFile
    ];
    await runTracked('ffmpeg', ffArgs, (p) => { currentProc = p; });
    if (aborted) return;
    if (!fs.existsSync(outFile)) throw new Error('process_failed');
    const outStat = fs.statSync(outFile);
    log('processed ' + outStat.size + ' bytes');

    // ── 4. STREAM RESULTADO ─────────────────────────────────────────────
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Type');
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Length', String(outStat.size));
    res.setHeader('Content-Disposition', 'attachment; filename="video.mp4"');
    res.setHeader('Cache-Control', 'no-store');

    const stream = fs.createReadStream(outFile);
    stream.pipe(res);
    stream.on('close', cleanup);
    stream.on('error', (err) => {
      log('stream error: ' + err.message);
      cleanup();
      if (!res.headersSent) res.status(500).end(); else res.end();
    });
  } catch (err) {
    log('failed: ' + err.message);
    cleanup();
    if (!res.headersSent) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.status(500).json({ error: 'youtube_process_failed', detail: String(err.message || err).slice(0, 500) });
    }
  }
});

app.options('/youtube-process', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.status(204).end();
});

// ── UPLOAD-PROCESS: limpa metadata + BlueMetadata em vídeo do user ─────────
// User envia vídeo próprio (gravado/editado em CapCut/Premiere/etc).
// Mesmo pipeline FFmpeg do /youtube-process: strip metadata + zoom random +
// noise + atempo + CRF re-encode. Saída = vídeo único pra repostar.
// Aceita até 500MB. Streaming upload via multer (não carrega no RAM).
const uploadStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const jobId = uuidv4();
    const dir = path.join('/tmp', 'upload-' + jobId);
    fs.mkdirSync(dir, { recursive: true });
    req._uploadDir = dir;
    req._uploadJobId = jobId;
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    // Preserva extensão original (mp4, mov, mkv, webm) — FFmpeg detecta automático
    const ext = path.extname(file.originalname || '.mp4').toLowerCase().slice(0, 6) || '.mp4';
    cb(null, 'in' + ext);
  },
});
const uploadMw = multer({
  storage: uploadStorage,
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB max
  fileFilter: (req, file, cb) => {
    const ok = /^video\/(mp4|quicktime|x-matroska|webm|x-msvideo|x-flv|3gpp)$/i.test(file.mimetype) ||
               /\.(mp4|mov|mkv|webm|avi|flv|3gp|m4v)$/i.test(file.originalname || '');
    cb(ok ? null : new Error('formato_nao_suportado'), ok);
  },
});

// CORS allowlist pra endpoint de upload (evita abuso de origens externas)
function corsAllowed(origin) {
  if (!origin) return true; // direct curl/server-to-server permitido
  return /^https:\/\/(bluetubeviral\.com|.*\.bluetubeviral\.com|.*\.vercel\.app)$/i.test(origin) ||
         /^http:\/\/localhost(:\d+)?$/i.test(origin);
}

app.post('/upload-process', (req, res, next) => {
  // Allowlist origin pra evitar abuso de cost (anyone podia fazer form action pra cá)
  const origin = req.headers.origin || '';
  if (!corsAllowed(origin)) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(403).json({ error: 'origin_nao_permitido' });
  }
  uploadMw.single('video')(req, res, (err) => {
    if (err) {
      res.setHeader('Access-Control-Allow-Origin', origin || '*');
      // Cleanup do dir que foi criado pelo storage destination ANTES da validação falhar
      if (req._uploadDir) { try { fs.rmSync(req._uploadDir, { recursive: true, force: true }); } catch {} }
      const code = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
      const reason = err.code === 'LIMIT_FILE_SIZE' ? 'arquivo_muito_grande_max_500mb' : (err.message || 'upload_invalido');
      return res.status(code).json({ error: reason });
    }
    next();
  });
}, async (req, res) => {
  const origin = req.headers.origin || '';
  if (!req.file) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
    if (req._uploadDir) { try { fs.rmSync(req._uploadDir, { recursive: true, force: true }); } catch {} }
    return res.status(400).json({ error: 'nenhum_arquivo' });
  }
  const dir = req._uploadDir;
  const jobId = req._uploadJobId;
  const inFile = req.file.path;
  const outFile = path.join(dir, 'out.mp4');
  const cleanup = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} };
  const log = (m) => console.log('[upload-process]', jobId, m);

  // Abort handler: se cliente desconecta (switchMode, close tab), kill ffmpeg + cleanup
  let aborted = false;
  let currentProc = null;
  const onClose = () => {
    if (res.writableEnded) return;
    aborted = true;
    if (currentProc && !currentProc.killed) { try { currentProc.kill('SIGKILL'); } catch {} }
    cleanup();
    log('aborted by client');
  };
  req.on('close', onClose);

  // Timeout duro: 10 min máximo (FFmpeg em 500MB vídeo de 30min com preset medium = ~7-8min)
  req.setTimeout(600000);
  res.setTimeout(600000);

  try {
    if (req.file.size < 1024) throw new Error('arquivo_vazio');
    log('uploaded ' + req.file.size + ' bytes (' + path.basename(inFile) + ')');

    // Mesmos params random do /youtube-process
    const rand = (min, max) => Math.random() * (max - min) + min;
    const zoom = rand(0.02, 0.05);
    const noise = Math.floor(rand(1, 4));
    const brightness = rand(-0.02, 0.02).toFixed(4);
    const saturation = rand(0.97, 1.03).toFixed(4);
    const gamma = rand(0.97, 1.03).toFixed(4);
    const tempo = rand(1.010, 1.025).toFixed(4);
    const crfVar = rand(17, 19).toFixed(2);

    const vf = `scale=iw*(1+${zoom.toFixed(4)}):-2,crop=iw/(1+${zoom.toFixed(4)}):ih/(1+${zoom.toFixed(4)}),eq=brightness=${brightness}:saturation=${saturation}:gamma=${gamma},noise=alls=${noise}:allf=t`;
    const af = `atempo=${tempo}`;

    log(`process zoom=${(zoom*100).toFixed(1)}% noise=${noise} tempo=${tempo} crf=${crfVar}`);

    await runTracked('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-i', inFile,
      '-map_metadata', '-1',
      '-vf', vf,
      '-af', af,
      '-c:v', 'libx264', '-preset', 'medium', '-crf', crfVar,
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '192k',
      '-movflags', '+faststart',
      '-y',
      outFile,
    ], (p) => { currentProc = p; });
    if (aborted) return;

    if (!fs.existsSync(outFile)) throw new Error('process_failed');
    const stats = fs.statSync(outFile);
    log('processed ' + stats.size + ' bytes');

    res.setHeader('Access-Control-Allow-Origin', origin || '*');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Type');
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Length', String(stats.size));
    res.setHeader('Content-Disposition', 'attachment; filename="video_unico.mp4"');
    res.setHeader('Cache-Control', 'no-store');

    const stream = fs.createReadStream(outFile);
    stream.pipe(res);
    stream.on('close', () => { req.removeListener('close', onClose); cleanup(); });
    stream.on('error', () => { req.removeListener('close', onClose); cleanup(); if (!res.headersSent) res.status(500).end(); else res.end(); });
  } catch (err) {
    if (aborted) return;
    log('failed: ' + err.message);
    req.removeListener('close', onClose);
    cleanup();
    if (!res.headersSent) {
      res.setHeader('Access-Control-Allow-Origin', origin || '*');
      res.status(500).json({ error: 'upload_process_failed', detail: String(err.message || err).slice(0, 300) });
    }
  }
});

app.options('/upload-process', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.status(204).end();
});

// ── YOUTUBE DOWNLOAD via yt-dlp ────────────────────────────────────────────
// Baixa direto da CDN do YouTube com escolha de qualidade, muxa vídeo+áudio
// separados quando necessário (adaptive streams), sobe pro Supabase e retorna URL.
app.post('/download-youtube', async (req, res) => {
  const { youtube_url, quality, supabase_url, supabase_key, output_path } = req.body || {};
  if (!youtube_url) return res.status(400).json({ error: 'youtube_url required' });
  if (!supabase_url || !supabase_key) return res.status(400).json({ error: 'supabase creds required' });

  const jobId = uuidv4();
  const dir = path.join('/tmp', jobId);
  fs.mkdirSync(dir, { recursive: true });

  // Mapeia quality → format selector yt-dlp
  // bv = best video, ba = best audio, [filters]
  const q = String(quality || '720');
  let format;
  if (q === 'max' || q === 'best' || q === '1080') {
    format = 'bv*[ext=mp4][height<=1080]+ba[ext=m4a]/bv*[height<=1080]+ba/b[height<=1080]/bv+ba/b';
  } else if (q === '720') {
    format = 'bv*[ext=mp4][height<=720]+ba[ext=m4a]/bv*[height<=720]+ba/b[height<=720]/bv+ba/b';
  } else if (q === '480') {
    format = 'bv*[ext=mp4][height<=480]+ba[ext=m4a]/bv*[height<=480]+ba/b[height<=480]/bv+ba/b';
  } else {
    format = 'bv*+ba/b';
  }

  const outputFile = path.join(dir, 'video.mp4');

  // Player clients ordenados pelos que MENOS triggam bot-check em IPs datacenter
  // em 2026: tv_embedded, android_vr, android_testsuite, ios.
  // Removidos web_safari + android_creator (triggam bot-check no Railway).
  const extractorArgs = 'youtube:player_client=tv_embedded,android_vr,android_testsuite,ios';
  const jobCookies = writeJobCookies(dir);

  try {
    const ytArgs = [
      '-f', format,
      '--merge-output-format', 'mp4',
      '--no-playlist',
      '--no-warnings',
      '--no-check-certificate',
      '--geo-bypass',
      '--force-ipv4',
      '--sleep-requests', '1',
      '--sleep-interval', '2',
      '--max-sleep-interval', '5',
      '--extractor-args', extractorArgs,
      '-o', outputFile,
      youtube_url
    ];
    if (jobCookies) {
      const oIdx = ytArgs.indexOf('-o');
      ytArgs.splice(oIdx, 0, '--cookies', jobCookies);
    }
    console.log('[yt-dlp] start:', q, youtube_url);
    await run('yt-dlp', ytArgs);

    if (!fs.existsSync(outputFile)) {
      throw new Error('yt-dlp não gerou output');
    }
    const stats = fs.statSync(outputFile);
    console.log('[yt-dlp] done:', stats.size, 'bytes');

    // Upload pro Supabase Storage
    const finalPath = output_path || `editor/youtube/${jobId}/video.mp4`;
    const publicUrl = await uploadToSupabase(outputFile, finalPath, supabase_url, supabase_key);

    // Cleanup
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}

    res.json({
      ok: true,
      url: publicUrl,
      path: finalPath,
      size: stats.size,
      quality_requested: q
    });
  } catch (err) {
    console.error('[yt-dlp] failed:', err.message);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
    res.status(500).json({
      error: 'yt-dlp failed: ' + err.message.slice(0, 500),
      quality_requested: q
    });
  }
});

// Auto-update do yt-dlp no startup (Camada 1.2 da blindagem baixaBlue).
// Roda apos o listen pra nao bloquear health check do Railway.
// Resolve o problema do Docker layer cache prendendo yt-dlp em versao
// antiga: a cada restart/deploy, yt-dlp -U sincroniza com upstream.
function autoUpdateYtdlp() {
  console.log('[startup] yt-dlp auto-update iniciando...');
  exec('yt-dlp --version', (e1, before) => {
    if (e1) { console.warn('[startup] yt-dlp version check falhou:', e1.message); return; }
    const versionBefore = String(before || '').trim();
    console.log('[startup] yt-dlp atual:', versionBefore);

    exec('yt-dlp -U', { timeout: 90000 }, (e2, stdout) => {
      if (e2) { console.warn('[startup] yt-dlp -U falhou (nao-fatal):', e2.message); return; }
      const lastLines = String(stdout || '').trim().split('\n').slice(-2).join(' | ');
      console.log('[startup] yt-dlp -U:', lastLines);

      exec('yt-dlp --version', (e3, after) => {
        if (e3) return;
        const versionAfter = String(after || '').trim();
        if (versionAfter && versionAfter !== versionBefore) {
          console.log(`[startup] yt-dlp ATUALIZADO: ${versionBefore} -> ${versionAfter}`);
        } else {
          console.log('[startup] yt-dlp ja estava atualizado');
        }
      });
    });
  });
}

// ── BLUELENS ULTIMATE — frame extraction + visual fingerprint ──────────────
//
// POST /extract-fingerprint { url, fps?, max_seconds? }
// Baixa video → extrai N frames por segundo via ffmpeg → calcula multi-hash
// → retorna JSON pra Vercel salvar em video_visual_fingerprints.

async function computeAHash(framePath) {
  if (!sharp) return null;
  try {
    const buf = await sharp(framePath).resize(8, 8, { fit: 'fill' }).grayscale().raw().toBuffer();
    let sum = 0;
    for (let i = 0; i < 64; i++) sum += buf[i];
    const avg = sum / 64;
    let hash = 0n;
    for (let i = 0; i < 64; i++) if (buf[i] > avg) hash |= 1n << BigInt(63 - i);
    return hash.toString(16).padStart(16, '0');
  } catch (e) { return null; }
}

async function computeDHash(framePath) {
  if (!sharp) return null;
  try {
    const buf = await sharp(framePath).resize(9, 8, { fit: 'fill' }).grayscale().raw().toBuffer();
    let hash = 0n;
    let bit = 63;
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const left = buf[row * 9 + col];
        const right = buf[row * 9 + col + 1];
        if (left > right) hash |= 1n << BigInt(bit);
        bit--;
      }
    }
    return hash.toString(16).padStart(16, '0');
  } catch (e) { return null; }
}

async function computeColorHash(framePath) {
  if (!sharp) return null;
  try {
    const { data, info } = await sharp(framePath).resize(32, 32, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true });
    const ch = info.channels;
    const bins = { r: [0,0,0,0], g: [0,0,0,0], b: [0,0,0,0] };
    for (let i = 0; i < data.length; i += ch) {
      bins.r[Math.min(3, data[i] >> 6)]++;
      bins.g[Math.min(3, data[i+1] >> 6)]++;
      bins.b[Math.min(3, data[i+2] >> 6)]++;
    }
    const total = (data.length / ch);
    const enc = (arr) => arr.map(v => Math.min(255, Math.floor((v / total) * 255)).toString(16).padStart(2,'0')).join('');
    return (enc(bins.r) + enc(bins.g) + enc(bins.b));
  } catch (e) { return null; }
}

app.post('/extract-fingerprint', async (req, res) => {
  if (!sharp) return res.status(500).json({ error: 'sharp não instalado no Railway' });
  const { url, fps = 1, max_seconds = 60 } = req.body || {};
  if (!url) return res.status(400).json({ error: 'url obrigatorio' });

  const jobId = uuidv4();
  const workDir = path.join(os.tmpdir(), 'bluelens-' + jobId);
  fs.mkdirSync(workDir, { recursive: true });
  const videoPath = path.join(workDir, 'video.mp4');
  const framesDir = path.join(workDir, 'frames');
  fs.mkdirSync(framesDir, { recursive: true });

  const startTs = Date.now();

  try {
    // 1. Tenta yt-dlp direto. Se falhar (YouTube anti-bot, etc), fallback Cobalt.
    let downloadOk = false;
    let ytdlpError = '';
    try {
      await new Promise((resolve, reject) => {
        const args = [
          '--no-warnings', '--no-playlist',
          '-f', 'best[height<=720]/best',
          '--postprocessor-args', `ffmpeg:-ss 0 -t ${max_seconds}`,
          '-o', videoPath,
          url,
        ];
        const p = spawn('yt-dlp', args);
        let stderr = '';
        p.stderr.on('data', d => { stderr += d.toString(); });
        p.on('close', code => {
          if (code === 0 && fs.existsSync(videoPath)) resolve();
          else reject(new Error(stderr.slice(0, 300) || 'exit ' + code));
        });
        p.on('error', reject);
      });
      downloadOk = true;
    } catch (e) {
      ytdlpError = e.message;
      console.warn('[extract-fingerprint] yt-dlp falhou, tentando Cobalt fallback:', ytdlpError.slice(0, 100));
    }

    // FALLBACK: Cobalt instance (cobalt-production-*.up.railway.app)
    // Cobalt baixa via diferentes estrategias (incluindo API oficial),
    // contorna anti-bot do YouTube com IP da propria instance Cobalt.
    if (!downloadOk) {
      const COBALT_URL = process.env.COBALT_API_URL || 'https://cobalt-production-9d27.up.railway.app';
      try {
        const cobalt = await axios.post(COBALT_URL, { url, videoQuality: '720' }, {
          headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
          timeout: 30000,
        });
        const tunnelUrl = cobalt.data?.url;
        if (!tunnelUrl) throw new Error('Cobalt sem tunnel URL');
        // Baixa via tunnel
        const writer = fs.createWriteStream(videoPath);
        const dl = await axios.get(tunnelUrl, { responseType: 'stream', timeout: 60000 });
        await new Promise((res, rej) => {
          dl.data.pipe(writer);
          writer.on('finish', res);
          writer.on('error', rej);
        });
        // Limita duracao com ffmpeg pos-download
        if (max_seconds && fs.statSync(videoPath).size > 0) {
          const trimPath = videoPath + '.trim.mp4';
          await new Promise((resolve) => {
            const p = spawn('ffmpeg', ['-y', '-i', videoPath, '-t', String(max_seconds), '-c', 'copy', trimPath]);
            p.on('close', () => resolve());
            p.on('error', () => resolve());
          });
          if (fs.existsSync(trimPath) && fs.statSync(trimPath).size > 0) {
            fs.renameSync(trimPath, videoPath);
          }
        }
        downloadOk = true;
        console.log('[extract-fingerprint] Cobalt fallback OK');
      } catch (cobaltErr) {
        throw new Error(`Ambos providers falharam. yt-dlp: ${ytdlpError.slice(0,150)} | Cobalt: ${cobaltErr.message.slice(0,150)}`);
      }
    }

    // 2. ffprobe pra metadata
    let duration = 0, width = 0, height = 0;
    try {
      const probe = await new Promise((resolve, reject) => {
        const p = spawn('ffprobe', ['-v','error','-select_streams','v:0','-show_entries','stream=width,height,duration','-of','json', videoPath]);
        let stdout = '';
        p.stdout.on('data', d => { stdout += d.toString(); });
        p.on('close', () => { try { resolve(JSON.parse(stdout)); } catch { resolve({}); } });
        p.on('error', reject);
      });
      const stream = probe.streams?.[0] || {};
      width = stream.width || 0;
      height = stream.height || 0;
      duration = parseFloat(stream.duration || 0);
    } catch (_) {}

    // 3. ffmpeg extrai frames
    await new Promise((resolve, reject) => {
      const args = ['-i', videoPath, '-vf', `fps=${fps}`, '-q:v', '4', path.join(framesDir, 'f_%04d.jpg')];
      const p = spawn('ffmpeg', args);
      let stderr = '';
      p.stderr.on('data', d => { stderr += d.toString(); });
      p.on('close', code => code === 0 ? resolve() : reject(new Error('ffmpeg falhou: ' + stderr.slice(0, 300))));
      p.on('error', reject);
    });

    const frameFiles = fs.readdirSync(framesDir).filter(f => f.startsWith('f_') && f.endsWith('.jpg')).sort();

    // 4. Multi-hash em lotes paralelos (8 frames por vez)
    const BATCH = 8;
    const p_hashes = [];
    const d_hashes = [];
    const color_hashes = [];

    for (let i = 0; i < frameFiles.length; i += BATCH) {
      const batch = frameFiles.slice(i, i + BATCH);
      const results = await Promise.all(batch.map(async f => {
        const fp = path.join(framesDir, f);
        const [a, d, c] = await Promise.all([computeAHash(fp), computeDHash(fp), computeColorHash(fp)]);
        return { a, d, c };
      }));
      for (const r of results) {
        p_hashes.push(r.a || '0000000000000000');
        d_hashes.push(r.d || '0000000000000000');
        color_hashes.push(r.c || '000000000000000000000000');
      }
    }

    return res.status(200).json({
      ok: true,
      job_id: jobId,
      duration_ms: Date.now() - startTs,
      duration_seconds: duration,
      width, height,
      total_frames_extracted: frameFiles.length,
      fps_extracted: fps,
      p_hashes,
      d_hashes,
      color_hashes,
    });
  } catch (e) {
    console.error('[extract-fingerprint]', e.message);
    return res.status(500).json({ error: e.message });
  } finally {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (_) {}
  }
});

// ── SNAPCHAT EXTRACT via yt-dlp ────────────────────────────────────────────
// Cobalt v11 só suporta /spotlight/ do Snapchat. Pra /highlight/, /story/ e
// outros formatos públicos, yt-dlp tem extractor robusto. Esse endpoint
// extrai URL CDN (yt-dlp -g) — não baixa o arquivo. Frontend depois chama
// /proxy-download pra resolver CORS.
//
// Auth: se env SNAPCHAT_PROCESS_KEY setada, exige header X-Internal-Token
// matching (rate-limit indireto via shared secret com baixa-generic.js).
// Se não setada, livre — compat com primeiro deploy. Felipe pode setar depois.
//
// Whitelist hosts MATCHING baixa-generic.js (host === 'snapchat.com' OU
// endsWith('.snapchat.com')) — evita mismatch onde Vercel aceita mas Railway rejeita.
app.post('/snapchat-extract', async (req, res) => {
  // Auth opcional (se env setada)
  const expectedKey = process.env.SNAPCHAT_PROCESS_KEY;
  if (expectedKey) {
    const got = req.headers['x-internal-token'] || '';
    if (got !== expectedKey) return res.status(401).json({ error: 'unauthorized' });
  }

  const { snapchat_url } = req.body || {};
  if (!snapchat_url || typeof snapchat_url !== 'string') {
    return res.status(400).json({ error: 'snapchat_url required' });
  }
  // Whitelist alinhada com baixa-generic.js (defesa em profundidade contra SSRF)
  let hostOk = false;
  try {
    const host = new URL(snapchat_url).hostname.replace(/^www\./, '');
    hostOk = host === 'snapchat.com' || host.endsWith('.snapchat.com');
  } catch (_) {}
  if (!hostOk) return res.status(400).json({ error: 'somente_snapchat' });

  try {
    // -g extrai URL CDN sem baixar. Roda --get-title EM PARALELO via -J (json full)
    // pra evitar 2 processos sequenciais (timeout cumulativo estourava Vercel).
    // -J retorna metadata + URL no mesmo call em ~5-8s.
    const args = [
      '-J',                       // dump JSON completo (URL + title + extras)
      '-f', 'best[ext=mp4]/best',
      '--no-warnings',
      '--no-playlist',
      '--no-check-certificate',
      '--socket-timeout', '15',
      snapchat_url
    ];
    const result = await new Promise((resolve, reject) => {
      const p = spawn('yt-dlp', args);
      let stdout = '', stderr = '';
      const timer = setTimeout(() => { try { p.kill('SIGKILL'); } catch (_) {} reject(new Error('timeout_18s')); }, 18000);
      p.stdout.on('data', d => { stdout += d.toString(); });
      p.stderr.on('data', d => { stderr += d.toString(); });
      p.on('close', code => {
        clearTimeout(timer);
        if (code === 0 && stdout.trim()) {
          try {
            const json = JSON.parse(stdout);
            const url = json.url || (json.formats && json.formats.length ? json.formats[json.formats.length - 1].url : null);
            if (!url) return reject(new Error('no_url_in_json'));
            // Detecta HLS — browser pode não baixar m3u8 como arquivo
            const isHls = /\.m3u8(\?|$)/i.test(url) || (json.protocol || '').includes('m3u8');
            if (isHls) {
              console.warn('[snapchat-extract] HLS detectado:', snapchat_url.slice(0, 80));
            }
            resolve({
              url,
              title: json.title || null,
              ext: json.ext || 'mp4',
              is_hls: isHls,
              extra_formats: (json.formats || []).length,
            });
          } catch (e) {
            reject(new Error('json_parse_failed: ' + e.message.slice(0, 100)));
          }
        } else {
          reject(new Error('yt-dlp_exit_' + code + ': ' + stderr.slice(0, 200)));
        }
      });
      p.on('error', e => { clearTimeout(timer); reject(e); });
    });

    const safeTitle = result.title ? result.title.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) : 'snapchat';
    return res.status(200).json({
      ok: true,
      url: result.url,
      title: result.title || 'Snapchat Video',
      filename: safeTitle + '.' + (result.ext || 'mp4'),
      is_hls: result.is_hls,
      extra_formats: result.extra_formats,
    });
  } catch (e) {
    console.error('[snapchat-extract]', e.message);
    return res.status(500).json({ error: 'extract_failed', detail: e.message.slice(0, 300) });
  }
});

app.listen(PORT, () => {
  console.log(`[bluetube-ffmpeg] listening on :${PORT}`);
  // Roda em background pra nao atrasar health check do Railway
  setTimeout(autoUpdateYtdlp, 2000);
});
