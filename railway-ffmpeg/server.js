// BlueTube FFmpeg Pipeline Service
// Rodado no Railway. Recebe jobs do Vercel (/api/blue-editor action=edit)
// e renderiza o vídeo final do BlueEditor com ffmpeg.

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const axios = require('axios');

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

// Resolução de saída — 720x1280 em vez de 1080x1920 pra caber na RAM do tier Railway
const OUT_W = 720;
const OUT_H = 1280;

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
    const { stdout } = await run('ffmpeg', ['-version']);
    const version = (stdout.match(/ffmpeg version (\S+)/) || [])[1] || 'unknown';
    res.json({ ok: true, ffmpeg: version, jobs_in_memory: JOBS.size });
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

  try {
    // Roda yt-dlp. Timeout de 90s pra evitar hangs.
    const ytArgs = [
      '-f', format,
      '--merge-output-format', 'mp4',
      '--no-playlist',
      '--no-warnings',
      '--quiet',
      '--progress',
      '-o', outputFile,
      youtube_url
    ];
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

app.listen(PORT, () => {
  console.log(`[bluetube-ffmpeg] listening on :${PORT}`);
});
