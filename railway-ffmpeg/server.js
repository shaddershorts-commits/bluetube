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

// PO Token: o yt-dlp standalone NAO aplica --plugin-dirs vindo do config file
// na busca de plugins (debug: "Plugin directories: none"). Precisa ser arg CLI.
// Injetamos esses args nas chamadas yt-dlp quando o provider esta configurado.
const POT_CLI_ARGS = process.env.BGUTIL_POT_BASE_URL
  ? ['--plugin-dirs', '/root/.config/yt-dlp/plugins']
  : [];

async function downloadFile(url, dest) {
  const writer = fs.createWriteStream(dest);
  const response = await axios.get(url, { responseType: 'stream', timeout: 60000 });
  response.data.pipe(writer);
  return new Promise((resolve, reject) => {
    // erro no stream de RESPOSTA nao propaga pelo pipe: sem listener vira
    // uncaught exception (derruba o processo) ou worker pendurado pra sempre.
    let idle = null;
    const arm = () => { clearTimeout(idle); idle = setTimeout(() => { const e = new Error('download parado (sem dados ha 60s): ' + url.slice(0, 80)); response.data.destroy(e); writer.destroy(); reject(e); }, 60000); };
    arm();
    response.data.on('data', arm);
    response.data.on('error', (e) => { clearTimeout(idle); writer.destroy(); reject(e); });
    writer.on('finish', () => { clearTimeout(idle); resolve(); });
    writer.on('error', (e) => { clearTimeout(idle); reject(e); });
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
async function uploadToSupabase(filePath, outputPath, supabaseUrl, supabaseKey, contentType) {
  const bucket = 'blue-videos';
  const url = `${supabaseUrl}/storage/v1/object/${bucket}/${outputPath}`;
  const fileBuffer = fs.readFileSync(filePath);

  const res = await axios.post(url, fileBuffer, {
    headers: {
      'Content-Type': contentType || 'video/mp4',
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
      build: 'r26f-blueclean-grayfix',
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

app.post('/cancel/:jobId', (req, res) => {
  const job = JOBS.get(req.params.jobId);
  if (!job) return res.json({ ok: false, msg: 'not found' });
  JOBS.set(req.params.jobId, { ...job, status: 'cancelled', error: 'cancelled by user' });
  res.json({ ok: true });
});

// ── BlueEditor V0 — Fase 7 render endpoint ────────────────────────────────
// Recebe state simplificado do editor, pipeline FFmpeg:
//   1. Cada clip (source_in, source_out) -> trim+reencode pra video_only.mp4
//   2. Concat dos clips (xfade transitions se houver)
//   3. drawtext overlays (texts[])
//   4. amix vidio + audio_extra com volumes
//   5. scale + crop pra 1080×1920 (ou letterbox se aspect_strategy)
//   6. Upload pro Supabase
// Extrai a trilha de audio de um video em mp3 compacto (pro Whisper 25MB).
// ── BLUE FEED: transcode permanente de videos ─────────────────────────────
// Re-encoda pra H264 CRF 26 (cap 1080 largura) + AAC 128k + FASTSTART
// (moov no inicio = progressive streaming real). Sobrescreve o arquivo no
// MESMO storage_path; opcionalmente salva backup do original (.orig.mp4).
// Job assincrono (padrao JOBS do edit-v0): responde job_id, polling /status.
app.post('/blue-transcode', (req, res) => {
  const p = req.body || {};
  if (!p.video_url || !p.storage_path || !p.supabase_url || !p.supabase_key) {
    return res.status(400).json({ error: 'video_url, storage_path e credenciais obrigatorios' });
  }
  const jobId = uuidv4();
  JOBS.set(jobId, { status: 'queued', progress: 0 });
  res.json({ ok: true, job_id: jobId });
  processBlueTranscode(jobId, p).catch(e => {
    console.error('[blue-transcode]', jobId, e.message);
    JOBS.set(jobId, { status: 'error', progress: 0, error: e.message || String(e) });
  });
});

// Regenera SO a thumbnail de um video ja existente (anti-frame-preto).
// Sincrono — download + 3 frames leva poucos segundos.
app.post('/blue-thumb', async (req, res) => {
  const p = req.body || {};
  if (!p.video_url || !p.storage_path || !p.supabase_url || !p.supabase_key) {
    return res.status(400).json({ error: 'video_url, storage_path e credenciais obrigatorios' });
  }
  const dir = path.join('/tmp', 'bthumb-' + uuidv4());
  fs.mkdirSync(dir, { recursive: true });
  try {
    const src = path.join(dir, 'src.mp4');
    await downloadFile(p.video_url, src);
    const tf = await extractBrightThumb(src, dir);
    if (!tf) return res.status(500).json({ error: 'nenhum frame extraido' });
    const thumbPath = p.storage_path.replace(/[^/]+$/, 'thumb.jpg');
    await uploadToSupabase(tf, thumbPath, p.supabase_url, p.supabase_key, 'image/jpeg');
    const thumbUrl = `${p.supabase_url}/storage/v1/object/public/blue-videos/${thumbPath}?v=${Date.now()}`;
    if (p.video_id) {
      await fetch(`${p.supabase_url}/rest/v1/blue_videos?id=eq.${p.video_id}`, {
        method: 'PATCH',
        headers: { apikey: p.supabase_key, Authorization: 'Bearer ' + p.supabase_key, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({ thumbnail_url: thumbUrl }),
      }).catch(() => {});
    }
    res.json({ ok: true, thumbnail_url: thumbUrl });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    setTimeout(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }, 5000);
  }
});

// BlueClean v2 — gera a MASCARA de texto/marca-dagua a partir do vídeo
// original + o vídeo com texto pintado de preto (modo 'black' do detector).
// Diferença dos dois (com PTS re-alinhado por frame) = onde o texto estava.
// Sync alignment: setpts=N/FRAME_RATE/TB nos dois força pareamento por
// número de frame (o blend do ffmpeg parearia por timestamp, e os re-encodes
// têm PTS diferente → tudo branco). Sobe a máscara pro Supabase e devolve URL.
app.post('/blueclean-mask', (req, res) => {
  const p = req.body || {};
  if (!p.original_url || !p.black_url || !p.supabase_url || !p.supabase_key || !p.output_path) {
    return res.status(400).json({ error: 'original_url, black_url, output_path e credenciais obrigatorios' });
  }
  const jobId = uuidv4();
  JOBS.set(jobId, { status: 'processing', progress: 10 });
  res.json({ ok: true, job_id: jobId });
  processBlueCleanMask(jobId, p).catch((e) => {
    console.error('[blueclean-mask]', jobId, e.message);
    JOBS.set(jobId, { status: 'error', progress: 0, error: e.message || String(e) });
  });
});

async function processBlueCleanMask(jobId, p) {
  const dir = path.join('/tmp', 'bcmask-' + jobId);
  fs.mkdirSync(dir, { recursive: true });
  try {
    const orig = path.join(dir, 'orig.mp4');
    const black = path.join(dir, 'black.mp4');
    await downloadFile(p.original_url, orig);
    await downloadFile(p.black_url, black);

    // fps + dimensões do original pra re-indexar e posicionar o watermark
    let fps = 30, W = 0, Hh = 0;
    try {
      const { stdout } = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=r_frame_rate,width,height', '-of', 'default=noprint_wrappers=1:nokey=0', orig]);
      const g = (k) => { const m = String(stdout).match(new RegExp(k + '=([^\\n]+)')); return m ? m[1].trim() : ''; };
      const fr = g('r_frame_rate').split('/'); if (fr.length === 2 && +fr[1]) fps = +fr[0] / +fr[1]; else if (+fr[0]) fps = +fr[0];
      W = parseInt(g('width')) || 0; Hh = parseInt(g('height')) || 0;
    } catch (_) {}
    fps = Math.max(1, Math.min(60, Math.round(fps)));

    const thr = p.threshold || 45;      // sensibilidade da diferença
    const dil = Math.max(0, Math.min(6, p.dilation != null ? p.dilation : 2)); // margem
    const dilChain = Array(dil).fill('dilation').join(',');

    // Watermark é ESTÁTICO mas a detecção é intermitente (pequeno/fraco) →
    // ele "fica" no vídeo. Como fica sempre no rodapé, cobrimos uma faixa
    // inferior fixa na máscara (ProPainter reconstrói dos frames vizinhos).
    // wm_off=1 desliga. Faixa = 12% da altura, largura toda.
    let wmBox = '';
    if (p.watermark !== false && W && Hh) {
      const bh = Math.round(Hh * (p.wm_height_pct || 0.12));
      const by = Hh - bh - Math.round(Hh * 0.02);
      wmBox = `,drawbox=x=0:y=${by}:w=${W}:h=${bh}:color=white:t=fill`;
    }

    const out = path.join(dir, 'mask.mp4');
    const fc =
      `[0:v]setpts=N/FRAME_RATE/TB,fps=${fps},format=gray[a];` +
      `[1:v]setpts=N/FRAME_RATE/TB,fps=${fps},format=gray[b];` +
      `[a][b]blend=all_mode=difference,geq=lum='if(gt(lum(X,Y),${thr}),255,0)'` +
      (dilChain ? ',' + dilChain : '') + wmBox + `,format=gray[m]`;
    await run('ffmpeg', ['-y', '-i', orig, '-i', black, '-filter_complex', fc, '-map', '[m]',
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', String(fps), out]);

    await uploadToSupabase(out, p.output_path, p.supabase_url, p.supabase_key, 'video/mp4');
    const maskUrl = `${p.supabase_url}/storage/v1/object/public/blue-videos/${p.output_path}?v=${Date.now()}`;
    JOBS.set(jobId, { status: 'done', progress: 100, mask_url: maskUrl });
    setTimeout(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }, 5000);
  } catch (e) {
    console.error('[bcg-fatal]', String(e.stack || '').replace(/\n/g, ' | ').slice(0, 600)); if (e.config) console.error('[bcg-axios]', e.config.url, e.response ? JSON.stringify(e.response.data).slice(0, 300) : ''); JOBS.set(jobId, { status: 'error', progress: 0, error: e.message });
    setTimeout(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }, 5000);
  }
}

// ── BlueClean PROCESS — pipeline COMPLETO com chunking ─────────────────────
// Aguenta Shorts reais (15-60s+). Divide o video em trechos curtos (~5s,
// dentro do teto que os modelos aguentam), roda o pipeline completo em cada
// um (detecta texto -> gera mascara blend-diff PTS-aligned + faixa da marca
// d'agua -> preenche com ProPainter deep), reconcatena e recola o audio
// original (ProPainter descarta o audio). Job assincrono; polling em /status.
// Body: { video_url, output_path, supabase_url, supabase_key, replicate_token,
//         chunk_sec?, watermark?, wm_height_pct?, threshold?, dilation? }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Retry com backoff exponencial em 429 (rate limit) e 5xx. Respeita Retry-After.
// Blinda a rajada de chamadas do chunking (varios trechos em paralelo).
async function axiosRetry(label, fn, { tries = 6, base = 2000 } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); }
    catch (e) {
      last = e;
      const st = e.response?.status;
      if (st !== 429 && !(st >= 500 && st < 600)) {
        const body = e.response?.data ? JSON.stringify(e.response.data).slice(0, 200) : '';
        throw new Error(`${label} (HTTP ${st || '?'}) ${body || e.message}`);
      }
      if (i === tries - 1) break;
      const ra = parseInt(e.response?.headers?.['retry-after']) || 0;
      const wait = ra ? ra * 1000 : Math.min(30000, base * Math.pow(2, i)) + Math.floor(Math.random() * 800);
      await sleep(wait);
    }
  }
  const st = last?.response?.status;
  throw new Error(`${label} esgotou retries (HTTP ${st || '?'}): ${last?.message || ''}`);
}

// Cache de versao por modelo (persiste na instancia; versao muda raramente) —
// evita marretar o endpoint /versions a cada trecho.
const REPL_VER_CACHE = new Map();
async function replicateVersion(token, model) {
  if (REPL_VER_CACHE.has(model)) return REPL_VER_CACHE.get(model);
  const vr = await axiosRetry('replicate versions ' + model, () =>
    axios.get(`https://api.replicate.com/v1/models/${model}/versions`, { headers: { Authorization: 'Token ' + token } }));
  const version = vr.data?.results?.[0]?.id;
  if (!version) throw new Error('Replicate: versao nao encontrada de ' + model);
  REPL_VER_CACHE.set(model, version);
  return version;
}

async function replicateRun(token, model, input, { pollMs = 4000, timeoutMs = 12 * 60 * 1000 } = {}) {
  const version = await replicateVersion(token, model);
  const cr = await axiosRetry('replicate create ' + model, () =>
    axios.post('https://api.replicate.com/v1/predictions',
      { version, input }, { headers: { Authorization: 'Token ' + token, 'Content-Type': 'application/json' } }));
  let pred = cr.data;
  const deadline = Date.now() + timeoutMs;
  while (pred.status !== 'succeeded' && pred.status !== 'failed' && pred.status !== 'canceled') {
    if (Date.now() > deadline) throw new Error('Replicate timeout em ' + model);
    await sleep(pollMs);
    const gr = await axiosRetry('replicate poll ' + model, () =>
      axios.get(`https://api.replicate.com/v1/predictions/${pred.id}`, { headers: { Authorization: 'Token ' + token } }));
    pred = gr.data;
  }
  if (pred.status !== 'succeeded') throw new Error('Replicate ' + model + ' falhou: ' + (pred.error || pred.status));
  const out = Array.isArray(pred.output) ? pred.output[0] : pred.output;
  if (!out) throw new Error('Replicate ' + model + ' sem output');
  return out;
}

// Upload com retry (Supabase tambem pode 429 sob rajada de trechos).
async function uploadRetry(label, filePath, outputPath, SU, SK, ct) {
  return axiosRetry('upload ' + label, () => uploadToSupabase(filePath, outputPath, SU, SK, ct), { tries: 4, base: 1500 });
}

// ── YT-SUBS: extrai legenda/CC de vídeo do YouTube via yt-dlp (com cookies +
// PO token). Fallback do /api/transcript quando o Supadata esgota o plano.
// 1 chamada -J pra descobrir as tracks + 1 fetch da json3 escolhida.
app.get('/yt-subs', async (req, res) => {
  const v = String(req.query.v || '');
  if (!/^[a-zA-Z0-9_-]{6,20}$/.test(v)) return res.status(400).json({ error: 'v invalido' });
  const dir = path.join('/tmp', 'subs-' + uuidv4());
  fs.mkdirSync(dir, { recursive: true });
  const cleanup = () => setTimeout(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }, 2000);
  try {
    const jobCookies = writeJobCookies(dir);
    const { stdout } = await run('yt-dlp', [
      ...POT_CLI_ARGS,
      '--skip-download', '--no-playlist', '--no-warnings', '-J',
      '--ignore-no-formats-error',
      ...(jobCookies ? ['--cookies', jobCookies] : []),
      'https://www.youtube.com/watch?v=' + v,
    ]);
    const info = JSON.parse(stdout);
    const subs = info.subtitles || {};
    const autos = info.automatic_captions || {};
    // Ordem: legenda manual (qualquer) > auto original (-orig) > pt > en > es > primeira auto
    let pick = null, lang = null;
    const firstKey = (o) => Object.keys(o)[0];
    if (firstKey(subs)) { lang = firstKey(subs); pick = subs[lang]; }
    else {
      const orig = Object.keys(autos).find((k) => k.endsWith('-orig'));
      lang = orig || ['pt', 'pt-BR', 'en', 'es'].find((k) => autos[k]) || firstKey(autos);
      if (lang) pick = autos[lang];
    }
    const entry = pick && (pick.find((f) => f.ext === 'json3') || pick[0]);
    if (!entry?.url) { cleanup(); return res.status(404).json({ error: 'sem_legenda' }); }
    const cr = await axios.get(entry.url, { timeout: 20000 });
    const cd = typeof cr.data === 'string' ? JSON.parse(cr.data) : cr.data;
    const text = (cd.events || []).filter((e) => e.segs).map((e) => e.segs.map((s) => s.utf8 || '').join('')).join(' ').replace(/\s+/g, ' ').trim();
    cleanup();
    if (text.length < 20) return res.status(404).json({ error: 'sem_legenda' });
    const out = { content: text, lang: (lang || 'pt').replace('-orig', ''), source: 'ytdlp' };
    // seg=1 (Blublu confirma citacao): segmentos com timestamp em segundos —
    // permite responder "citado aos 2:13" e linkar direto no momento.
    if (String(req.query.seg || '') === '1') {
      out.segments = (cd.events || []).filter((e) => e.segs)
        .map((e) => ({ t: Math.round((e.tStartMs || 0) / 1000), x: e.segs.map((s) => s.utf8 || '').join('').replace(/\s+/g, ' ').trim() }))
        .filter((s) => s.x);
    }
    res.json(out);
  } catch (e) {
    cleanup();
    res.status(502).json({ error: (e.message || 'falha yt-dlp').slice(0, 200) });
  }
});

app.post('/blueclean-process', (req, res) => {
  const p = req.body || {};
  if (!p.video_url || !p.output_path || !p.supabase_url || !p.supabase_key || !p.replicate_token) {
    return res.status(400).json({ error: 'video_url, output_path, replicate_token e credenciais obrigatorios' });
  }
  if (p.engine === 'guided' && !(Array.isArray(p.boxes) && p.boxes.length) && !(Array.isArray(p.marks) && p.marks.length)) {
    return res.status(400).json({ error: 'engine guided exige boxes ou marks (marcacao do usuario)' });
  }
  const jobId = uuidv4();
  JOBS.set(jobId, { status: 'processing', progress: 2, stage: 'preparando', started_at: Date.now() });
  res.json({ ok: true, job_id: jobId });
  const runner = p.engine === 'guided' ? processBlueCleanGuided : processBlueClean;
  runner(jobId, p).catch((e) => {
    console.error('[blueclean-process]', jobId, e.message); console.error('[stack]', String(e.stack || '').replace(/\n/g, ' | ').slice(0, 600)); if (e.config) console.error('[axios-url]', e.config.url, e.response ? JSON.stringify(e.response.data).slice(0, 200) : '');
    JOBS.set(jobId, { status: 'error', progress: 0, error: e.message || String(e) });
  });
});

// Limpa 1 trecho: upload -> detecta (black) -> mascara -> ProPainter -> baixa.
// Retorna o caminho local do trecho ja preenchido (sem audio).
async function processChunkClean(dir, chunkPath, idx, token, SU, SK, tmpPrefix, uploaded, opt) {
  const chunkKey = `${tmpPrefix}/chunk_${idx}.mp4`;
  const chunkUrl = await uploadRetry('chunk ' + idx, chunkPath, chunkKey, SU, SK, 'video/mp4');
  uploaded.push(chunkKey);

  // (a) DETECCAO — modelo pinta texto/marca de preto (conf baixa)
  const blackUrl = await replicateRun(token, 'hjunior29/video-text-remover', {
    video: chunkUrl, method: 'black', conf_threshold: 0.08, iou_threshold: 0.15, margin: 8, resolution: 'original', detection_interval: 1,
  }, { pollMs: 3000, timeoutMs: 8 * 60 * 1000 });

  // (b) MASCARA — auto (blend-diff PTS-aligned pega legenda) UNIAO caixas
  // manuais (o que a IA nao pega: marca estatica, numero estilizado, seta).
  // Cada caixa tem intervalo de tempo GLOBAL; gatilhamos por tempo local do
  // trecho (chunkStart = idx*chunkSec). Caixa sem intervalo = trecho todo.
  const black = path.join(dir, `black_${idx}.mp4`);
  await downloadFile(blackUrl, black);
  const mask = path.join(dir, `mask_${idx}.mp4`);
  const fps = Math.max(1, Math.min(60, Math.round(opt.fps || 30)));
  const thr = opt.threshold || 45;
  const dil = Math.max(0, Math.min(6, opt.dilation != null ? opt.dilation : 2));
  const dilChain = Array(dil).fill('dilation').join(',');
  const W = opt.W, Hh = opt.Hh, chunkSec = opt.chunkSec || 5, chunkStart = idx * chunkSec;
  let boxChain = '';
  if (Array.isArray(opt.boxes) && W && Hh) {
    for (const b of opt.boxes) {
      const gs = (b.start_sec == null) ? -1e9 : +b.start_sec;
      const ge = (b.end_sec == null) ? 1e9 : +b.end_sec;
      if (ge < chunkStart || gs > chunkStart + chunkSec) continue; // caixa nao toca este trecho
      const x = Math.max(0, Math.round((b.x_pct || 0) * W));
      const y = Math.max(0, Math.round((b.y_pct || 0) * Hh));
      const w = Math.max(2, Math.round((b.w_pct || 0) * W));
      const h = Math.max(2, Math.round((b.h_pct || 0) * Hh));
      const ls = Math.max(0, gs - chunkStart), le = Math.min(chunkSec, ge - chunkStart);
      const en = (b.start_sec == null && b.end_sec == null) ? '' : `:enable='between(t\\,${ls.toFixed(3)}\\,${le.toFixed(3)})'`;
      boxChain += `,drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=white:t=fill${en}`;
    }
  }
  // DETECCAO DE ANOTACOES DESENHADAS (seta/circulo vermelho ou laranja) por cor.
  // O detector de texto (hjunior29) so pega TEXTO, nao grafismo que o editor
  // desenha. Condicao: R bem maior que G e B (pega vermelho E laranja), robusta
  // a pele (pele tem R~G, nao dispara). Unida (lighten = max) com a mascara de
  // texto (blend-diff por FORMA). Default ON; opt.detectAnnotations=false desliga.
  // Aspas simples nas geq protegem as virgulas (mesmo padrao do geq de texto).
  const annOn = opt.detectAnnotations !== false;
  const annCond = 'gt(r(X,Y)-g(X,Y),45)*gt(r(X,Y)-b(X,Y),60)*gt(r(X,Y),110)';
  const fc = annOn
    ? `[0:v]setpts=N/FRAME_RATE/TB,fps=${fps},split[cc0][cc1];` +
      `[cc0]format=gray[a];` +
      `[1:v]setpts=N/FRAME_RATE/TB,fps=${fps},format=gray[b];` +
      `[a][b]blend=all_mode=difference,geq=lum='if(gt(lum(X,Y),${thr}),255,0)'[txt];` +
      `[cc1]format=rgb24,geq=r='255*${annCond}':g='255*${annCond}':b='255*${annCond}',format=gray[ann];` +
      `[txt][ann]blend=all_mode=lighten` + (dilChain ? ',' + dilChain : '') + boxChain + `,format=gray[m]`
    : `[0:v]setpts=N/FRAME_RATE/TB,fps=${fps},format=gray[a];` +
      `[1:v]setpts=N/FRAME_RATE/TB,fps=${fps},format=gray[b];` +
      `[a][b]blend=all_mode=difference,geq=lum='if(gt(lum(X,Y),${thr}),255,0)'` +
      (dilChain ? ',' + dilChain : '') + boxChain + `,format=gray[m]`;
  await run('ffmpeg', ['-y', '-i', chunkPath, '-i', black, '-filter_complex', fc, '-map', '[m]',
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', String(fps), mask]);
  const maskKey = `${tmpPrefix}/mask_${idx}.mp4`;
  const maskUrl = await uploadRetry('mask ' + idx, mask, maskKey, SU, SK, 'video/mp4');
  uploaded.push(maskKey);

  // (c) PREENCHIMENTO — ProPainter deep (fp16 evita erro de dtype).
  // Settings SEGUROS de memoria (1080p a 44GB): neighbor_length/ref_stride nos
  // defaults (10/10) — subir pra 20 estoura CUDA OOM. mask_dilation 6 cobre a
  // borda anti-aliased de anotacoes grossas (circulo) e e barato (so morfologia).
  // subvideo_length 60 = processa em sub-videos menores (margem anti-OOM).
  // O ganho de qualidade real veio da DETECCAO de anotacoes na mascara (acima),
  // nao de settings pesados de ProPainter.
  // CAP DE RESOLUCAO (anti CUDA OOM): ProPainter estoura a GPU em Full HD
  // (1080x1920 tentou alocar 15.6GB). Limita o lado maior a ~896px pro
  // processamento; o composite depois recoloca a regiao inpaint (upscalada) SO
  // na mascara, sobre o original em RES CHEIA — resto fica pixel-perfect, so a
  // area do overlay (que ja e reconstruida) fica levemente mais suave.
  const maxDim = Math.max(W || 1080, Hh || 1080);
  const ppRatio = Math.min(1, 896 / maxDim);
  const filledUrl = await replicateRun(token, 'jd7h/propainter', {
    video: chunkUrl, mask: maskUrl, fp16: true,
    mask_dilation: 6, neighbor_length: 10, ref_stride: 10, raft_iter: 20,
    subvideo_length: 40, resize_ratio: ppRatio,
  }, { pollMs: 4000, timeoutMs: 12 * 60 * 1000 });
  const filled = path.join(dir, `filled_${idx}.mp4`);
  await downloadFile(filledUrl, filled);

  // (d) NORMALIZA — ProPainter pode devolver outra resolucao/timebase.
  const norm = path.join(dir, `norm_${idx}.mp4`);
  const scale = (W && Hh) ? `scale=${W}:${Hh}:flags=bicubic,` : '';
  await run('ffmpeg', ['-y', '-i', filled, '-an', '-vf', `${scale}fps=${fps},format=yuv420p`,
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-video_track_timescale', '90000', norm]);

  // (e) COMPOSITE — usa o preenchimento do ProPainter APENAS onde a mascara e
  // branca (regiao removida); o resto fica ORIGINAL pixel-perfect. Corrige o
  // "qualidade despencou" (ProPainter re-renderiza e borra o frame inteiro).
  const comp = path.join(dir, `comp_${idx}.mp4`);
  const cfc =
    `[0:v]setpts=N/FRAME_RATE/TB,fps=${fps},format=yuv420p[b];` +
    `[1:v]setpts=N/FRAME_RATE/TB,fps=${fps},format=yuv420p[o];` +
    `[2:v]setpts=N/FRAME_RATE/TB,fps=${fps},format=gray,boxblur=2[m];` +
    `[b][o][m]maskedmerge[out]`;
  await run('ffmpeg', ['-y', '-i', chunkPath, '-i', norm, '-i', mask, '-filter_complex', cfc, '-map', '[out]',
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '16', '-pix_fmt', 'yuv420p', '-video_track_timescale', '90000', comp]);
  return comp;
}

async function processBlueClean(jobId, p) {
  const dir = path.join('/tmp', 'bclean-' + jobId);
  fs.mkdirSync(dir, { recursive: true });
  const setJob = (o) => JOBS.set(jobId, { ...(JOBS.get(jobId) || {}), ...o });
  const token = p.replicate_token, SU = p.supabase_url, SK = p.supabase_key;
  const CHUNK = Math.max(3, Math.min(10, p.chunk_sec || 5));
  const tmpPrefix = `blueclean/_work/${jobId}`;
  const uploaded = [];
  try {
    // 1. baixa o original
    setJob({ progress: 5, stage: 'baixando' });
    const orig = path.join(dir, 'orig.mp4');
    await downloadFile(p.video_url, orig);

    // 2. probe: fps, dimensoes, duracao, audio
    let fps = 30, W = 0, Hh = 0;
    try {
      const { stdout } = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=r_frame_rate,width,height', '-of', 'default=noprint_wrappers=1:nokey=0', orig]);
      const g = (k) => { const m = String(stdout).match(new RegExp(k + '=([^\\n]+)')); return m ? m[1].trim() : ''; };
      const fr = g('r_frame_rate').split('/'); if (fr.length === 2 && +fr[1]) fps = +fr[0] / +fr[1]; else if (+fr[0]) fps = +fr[0];
      W = parseInt(g('width')) || 0; Hh = parseInt(g('height')) || 0;
    } catch (_) {}
    fps = Math.max(1, Math.min(60, Math.round(fps)));
    let hasAudio = false;
    try { const { stdout } = await run('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', orig]); hasAudio = /audio/.test(stdout); } catch (_) {}

    // 3. divide em trechos (re-encode + keyframes forcados = cortes limpos)
    setJob({ progress: 10, stage: 'dividindo' });
    const chunkDir = path.join(dir, 'chunks'); fs.mkdirSync(chunkDir, { recursive: true });
    await run('ffmpeg', ['-y', '-i', orig, '-an', '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p',
      '-force_key_frames', `expr:gte(t,n_forced*${CHUNK})`,
      '-f', 'segment', '-segment_time', String(CHUNK), '-reset_timestamps', '1', path.join(chunkDir, 'c_%03d.mp4')]);
    const chunkFiles = fs.readdirSync(chunkDir).filter((f) => /\.mp4$/.test(f)).sort();
    if (!chunkFiles.length) throw new Error('Falha ao dividir video em trechos');
    setJob({ chunks_total: chunkFiles.length });

    // 4. processa cada trecho (concorrencia limitada)
    const opt = { fps, W, Hh, threshold: p.threshold, dilation: p.dilation, boxes: Array.isArray(p.boxes) ? p.boxes : [], chunkSec: CHUNK };
    const filled = new Array(chunkFiles.length);
    const queue = chunkFiles.map((f, i) => ({ f, i }));
    let done = 0;
    const worker = async () => {
      while (queue.length) {
        const { f, i } = queue.shift();
        filled[i] = await processChunkClean(dir, path.join(chunkDir, f), i, token, SU, SK, tmpPrefix, uploaded, opt);
        done++;
        setJob({ progress: Math.min(88, 15 + Math.round((done / chunkFiles.length) * 70)), stage: `limpando ${done}/${chunkFiles.length}` });
      }
    };
    // CONC=1 (sequencial): evita o rate-limit burst-1 do Replicate (detect +
    // ProPainter por trecho = 2 predictions; 2 workers em paralelo throttlavam).
    // Mais lento mas CONFIÁVEL — prioridade em produção.
    const CONC = 1;
    await Promise.all(Array.from({ length: CONC }, worker));

    // 5. reconcatena os trechos preenchidos
    setJob({ progress: 90, stage: 'juntando' });
    const listFile = path.join(dir, 'concat.txt');
    fs.writeFileSync(listFile, filled.map((fp) => `file '${fp.replace(/'/g, "'\\''")}'`).join('\n'));
    const merged = path.join(dir, 'merged.mp4');
    await run('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', listFile,
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p', merged]);

    // 6. recola o audio original (ProPainter descarta o audio)
    setJob({ progress: 94, stage: 'audio' });
    const finalOut = path.join(dir, 'final.mp4');
    if (hasAudio) {
      await run('ffmpeg', ['-y', '-i', merged, '-i', orig, '-map', '0:v:0', '-map', '1:a:0',
        '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k', '-shortest', finalOut]);
    } else { fs.copyFileSync(merged, finalOut); }

    // 7. upload do resultado final
    setJob({ progress: 97, stage: 'finalizando' });
    const outputUrl = await uploadToSupabase(finalOut, p.output_path, SU, SK, 'video/mp4');

    // 8. limpa arquivos temporarios do storage (best effort)
    for (const pth of uploaded) {
      try { await axios.delete(`${SU}/storage/v1/object/blue-videos/${pth}`, { headers: { Authorization: 'Bearer ' + SK, apikey: SK } }); } catch (_) {}
    }

    JOBS.set(jobId, { status: 'done', progress: 100, stage: 'concluido', chunks: chunkFiles.length, output_url: outputUrl + '?v=' + Date.now() });
    setTimeout(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }, 8000);
  } catch (e) {
    // best-effort cleanup dos temporarios mesmo em erro
    for (const pth of uploaded) {
      try { await axios.delete(`${p.supabase_url}/storage/v1/object/blue-videos/${pth}`, { headers: { Authorization: 'Bearer ' + p.supabase_key, apikey: p.supabase_key } }); } catch (_) {}
    }
    console.error('[bcg-fatal]', String(e.stack || '').replace(/\n/g, ' | ').slice(0, 600)); if (e.config) console.error('[bcg-axios]', e.config.url, e.response ? JSON.stringify(e.response.data).slice(0, 300) : ''); JOBS.set(jobId, { status: 'error', progress: 0, error: e.message });
    setTimeout(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }, 8000);
  }
}

// ── BLUECLEAN GUIADO (engine=guided) ─────────────────────────────────────────
// O usuario MARCA na tela o que quer remover (caixas com intervalo de tempo
// opcional). As caixas viram a mascara diretamente — sem detector automatico
// (cobertura garantida, zero falso-positivo, mais barato). O preenchimento e
// POR-FRAME (inpaint espacial): reconstrucao independente em cada frame, o que
// elimina o fantasma de legenda persistente que o motor temporal deixava.
// Processa so o RECORTE da regiao marcada (mais rapido/barato) e recompoe sobre
// o frame original — resto do video fica pixel-perfect.
const GUIDED_MODEL = 'zylim0702/remove-object';

// ── DETECTOR DE TEXTO PRÓPRIO (r25): DBNet PP-OCRv4 ONNX rodando AQUI na CPU
// (~100-160ms/quadro) — substitui as 2 chamadas externas de detecção que eram
// o maior custo de tempo do guided (2-3min cada). Máscara SAI pixel-accurate
// direto do modelo. Carregamento preguiçoso + fallback: qualquer falha (ex:
// glibc no alpine) => volta pro detector externo sem quebrar nada.
let _ortSession = null, _ortTentado = false, _ortLib = null;
async function getDetSession() {
  if (_ortSession || _ortTentado) return _ortSession;
  _ortTentado = true;
  const modelo = process.env.DET_MODEL_PATH || '/app/det.onnx';
  if (!fs.existsSync(modelo)) { console.error('[det-proprio] modelo ausente:', modelo); return null; }
  try {
    const ort = require('onnxruntime-node');
    _ortSession = await ort.InferenceSession.create(modelo, { intraOpNumThreads: 3 });
    _ortLib = ort;
    console.log('[det-proprio] carregado (nativo):', modelo);
  } catch (e) {
    // Alpine/musl: gcompat NÃO cobre __vsnprintf_chk → binário nativo não
    // carrega (visto em produção r25g). onnxruntime-web roda o mesmo modelo
    // em WASM dentro do V8 (zero .so) com velocidade ~igual (134ms vs 145ms
    // por quadro, medido) e saída bit-idêntica.
    console.error('[det-proprio] nativo indisponivel, tentando wasm:', e.message.slice(0, 100));
    try {
      const ortw = require('onnxruntime-web');
      ortw.env.wasm.numThreads = 3;
      _ortSession = await ortw.InferenceSession.create(fs.readFileSync(modelo));
      _ortLib = ortw;
      console.log('[det-proprio] carregado (wasm):', modelo);
    } catch (e2) {
      console.error('[det-proprio] indisponivel (fallback externo):', e2.message.slice(0, 120));
      _ortSession = null; _ortLib = null;
    }
  }
  return _ortSession;
}

// Detecta texto em UM frame → máscara PNG full-res (255 = texto).
async function detProprioFrame(sess, imgPath, outPng, W, Hh, thr) {
  const ort = _ortLib; // lib que efetivamente carregou (nativo ou wasm)
  const sharp = require('sharp');
  const LADO = 736;
  const escala = LADO / Math.max(W, Hh);
  let nw = Math.max(32, Math.ceil((W * escala) / 32) * 32);
  let nh = Math.max(32, Math.ceil((Hh * escala) / 32) * 32);
  const raw = await sharp(imgPath).resize(nw, nh, { fit: 'fill' }).removeAlpha().raw().toBuffer();
  const mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225];
  const data = new Float32Array(3 * nh * nw);
  for (let i = 0; i < nh * nw; i++) {
    data[i] = (raw[i * 3] / 255 - mean[0]) / std[0];
    data[nh * nw + i] = (raw[i * 3 + 1] / 255 - mean[1]) / std[1];
    data[2 * nh * nw + i] = (raw[i * 3 + 2] / 255 - mean[2]) / std[2];
  }
  const input = new ort.Tensor('float32', data, [1, 3, nh, nw]);
  const out = await sess.run({ [sess.inputNames[0]]: input });
  const p = out[sess.outputNames[0]].data;
  const corte = thr || 0.25;
  const mask = Buffer.alloc(nh * nw);
  let acesos = 0;
  for (let i = 0; i < nh * nw; i++) if (p[i] > corte) { mask[i] = 255; acesos++; }
  // DESENCOLHE (unclip do DBNet): o mapa de prob cobre só o MIOLO da linha de
  // texto (~40-50% da altura do glifo) — sem expandir, legenda grossa com
  // contorno sobrevive ao inpaint mutilada ("isso" smoke20) ou vira borrão
  // ("entregou" smoke23: expansão FIXA não escala com letra grande). Unclip
  // PROPORCIONAL como no DBNet original: cada run vertical expande 0.8x o
  // próprio comprimento (letra grande = expansão grande), depois um alarga
  // horizontal fixo pro contorno lateral. Tudo em JS puro — encadear
  // .blur().threshold() no sharp não respeita ordem de chamada (pipeline
  // interna fixa) e mascarou dois smokes seguidos.
  const um = Buffer.alloc(nh * nw);
  for (let x = 0; x < nw; x++) {
    let y = 0;
    while (y < nh) {
      if (mask[y * nw + x]) {
        let y2 = y; while (y2 + 1 < nh && mask[(y2 + 1) * nw + x]) y2++;
        const r = Math.min(26, Math.max(3, Math.round(0.8 * (y2 - y + 1))));
        for (let k = Math.max(0, y - r); k <= Math.min(nh - 1, y2 + r); k++) um[k * nw + x] = 255;
        y = y2 + 1;
      } else y++;
    }
  }
  const fin = Buffer.alloc(nh * nw);
  const RH = 8; // alarga horizontal fixo (contorno lateral ~6px no res do modelo)
  for (let y = 0; y < nh; y++) {
    let x = 0;
    while (x < nw) {
      if (um[y * nw + x]) {
        let x2 = x; while (x2 + 1 < nw && um[y * nw + x2 + 1]) x2++;
        for (let k = Math.max(0, x - RH); k <= Math.min(nw - 1, x2 + RH); k++) fin[y * nw + k] = 255;
        x = x2 + 1;
      } else x++;
    }
  }
  await sharp(fin, { raw: { width: nw, height: nh, channels: 1 } })
    .resize(W, Hh, { fit: 'fill', kernel: 'nearest' }).png().toFile(outPng);
  return acesos;
}

// Detecta em LOTE (workers) → dir com dm_%05d.png. null se sessão indisponível.
async function detProprioLote(sess, fdir, frames, W, Hh, outDir, prefixo, conc, thr) {
  fs.mkdirSync(outDir, { recursive: true });
  const fila = frames.map((f, i) => ({ f, i }));
  await Promise.all(Array.from({ length: conc || 3 }, async () => {
    while (fila.length) {
      const { f, i } = fila.shift();
      const alvo = path.join(outDir, `${prefixo}_${String(i + 1).padStart(5, '0')}.png`);
      try { await detProprioFrame(sess, path.join(fdir, f), alvo, W, Hh, thr); }
      catch (e) {
        console.error('[det-proprio] frame', i, e.message.slice(0, 60));
        // buraco na sequência truncaria o vídeo de máscara → frame preto no lugar
        try {
          const sharp = require('sharp');
          await sharp(Buffer.alloc(W * Hh), { raw: { width: W, height: Hh, channels: 1 } }).png().toFile(alvo);
        } catch (_) {}
      }
    }
  }));
  return outDir;
}

// Prediction SINCRONA (Prefer: wait) — a resposta ja volta com o resultado na
// maioria dos casos, eliminando ~2,5s de latencia de polling POR QUADRO (em
// video de 20s/600 quadros isso somava minutos). Se o hold de 55s nao bastar,
// cai no polling normal so pra este quadro.
async function replicateRunSync(token, model, input) {
  const version = await replicateVersion(token, model);
  const cr = await axiosRetry('replicate sync ' + model, () =>
    axios.post('https://api.replicate.com/v1/predictions',
      { version, input },
      { headers: { Authorization: 'Token ' + token, 'Content-Type': 'application/json', Prefer: 'wait=55' }, timeout: 70000 }));
  let pred = cr.data;
  const deadline = Date.now() + 4 * 60 * 1000;
  while (pred.status !== 'succeeded' && pred.status !== 'failed' && pred.status !== 'canceled') {
    if (Date.now() > deadline) throw new Error('Replicate timeout em ' + model);
    await sleep(2000);
    const gr = await axiosRetry('replicate poll ' + model, () =>
      axios.get(`https://api.replicate.com/v1/predictions/${pred.id}`, { headers: { Authorization: 'Token ' + token } }));
    pred = gr.data;
  }
  if (pred.status !== 'succeeded') throw new Error('Replicate ' + model + ' falhou: ' + (pred.error || pred.status));
  const out = Array.isArray(pred.output) ? pred.output[0] : pred.output;
  if (!out) throw new Error('Replicate ' + model + ' sem output');
  return out;
}

// MOTOR PRINCIPAL: fal.ai (mesma familia LaMa, 1.7s/quadro e paralelismo REAL
// sem throttle — validado 2026-07-18: 8/8 em burst, qualidade identica).
// Replicate vira FALLBACK por quadro (dupla engine = robustez em camadas).
async function falInpaint(imageUrl, maskUrl) {
  const r = await axios.post('https://fal.run/fal-ai/lama',
    { image_url: imageUrl, mask_image_url: maskUrl },
    { headers: { Authorization: 'Key ' + (process.env.FAL_KEY || ''), 'Content-Type': 'application/json' }, timeout: 90000 });
  const out = r.data?.image?.url;
  if (!out) throw new Error('fal sem output: ' + JSON.stringify(r.data).slice(0, 120));
  return out;
}

// DATA-URI + FILA oficial do fal (r19b): o endpoint sincrono devolve 429 com
// muitas lanes (32 minhas + job do user = conta estourou). A FILA
// (queue.fal.run) absorve qualquer volume e processa na concorrencia da conta
// — zero 429, zero briga entre jobs simultaneos.
async function falInpaintPaths(imgPath, maskPath) {
  const FAL = process.env.FAL_KEY || '';
  const body = {
    image_url: 'data:image/jpeg;base64,' + fs.readFileSync(imgPath).toString('base64'),
    mask_image_url: 'data:image/png;base64,' + fs.readFileSync(maskPath).toString('base64'),
  };
  const sub = await axios.post('https://queue.fal.run/fal-ai/lama', body,
    { headers: { Authorization: 'Key ' + FAL, 'Content-Type': 'application/json' }, timeout: 60000 });
  const reqId = sub.data?.request_id;
  if (!reqId) throw new Error('fal queue sem request_id: ' + JSON.stringify(sub.data).slice(0, 100));
  const deadline = Date.now() + 150000;
  while (Date.now() < deadline) {
    await sleep(1100);
    const st = await axios.get(`https://queue.fal.run/fal-ai/lama/requests/${reqId}/status`,
      { headers: { Authorization: 'Key ' + FAL }, timeout: 30000, validateStatus: () => true });
    const stat = st.data?.status;
    if (stat === 'COMPLETED') {
      const rr = await axios.get(`https://queue.fal.run/fal-ai/lama/requests/${reqId}`,
        { headers: { Authorization: 'Key ' + FAL }, timeout: 30000 });
      const out = rr.data?.image?.url;
      if (!out) throw new Error('fal queue sem output');
      return out;
    }
    if (['FAILED', 'ERROR', 'CANCELLED'].includes(stat)) throw new Error('fal queue ' + stat);
  }
  throw new Error('fal queue timeout');
}

// Retry resiliente: fal 3 tentativas -> fallback Replicate (throttle-aware).
async function guidedInpaint(token, input) {
  if (process.env.FAL_KEY) {
    for (let a = 0; a < 3; a++) {
      try { return await falInpaint(input.image, input.mask); }
      catch (e) { if (a === 2) console.error('[guided] fal falhou 3x, fallback replicate:', e.message.slice(0, 100)); await sleep(1000 + a * 1500); }
    }
  }
  let lastErr;
  for (let a = 0; a < 8; a++) {
    try {
      return await replicateRunSync(token, GUIDED_MODEL, input);
    } catch (e) {
      lastErr = e;
      if (/throttl|rate.?limit|429/i.test(String(e.message || ''))) { await sleep(4000 + a * 3000); continue; }
      throw e;
    }
  }
  throw lastErr;
}

async function processBlueCleanGuided(jobId, p) {
  const dir = path.join('/tmp', 'bcg-' + jobId);
  fs.mkdirSync(dir, { recursive: true });
  const setJob = (o) => JOBS.set(jobId, { ...(JOBS.get(jobId) || {}), ...o });
  const token = p.replicate_token, SU = p.supabase_url, SK = p.supabase_key;
  const tmpPrefix = `blueclean/_work/${jobId}`;
  const uploaded = [];
  const startedAt = Date.now();
  try {
    setJob({ progress: 4, stage: 'baixando', started_at: startedAt });
    const orig = path.join(dir, 'orig.mp4');
    await downloadFile(p.video_url, orig);

    // probe fps/dimensoes/duracao/audio
    let fps = 30, W = 0, Hh = 0, dur = 0;
    try {
      const { stdout } = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=r_frame_rate,width,height', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=0', orig]);
      const g = (k) => { const m = String(stdout).match(new RegExp(k + '=([^\\n]+)')); return m ? m[1].trim() : ''; };
      const fr = g('r_frame_rate').split('/'); if (fr.length === 2 && +fr[1]) fps = +fr[0] / +fr[1]; else if (+fr[0]) fps = +fr[0];
      W = parseInt(g('width')) || 0; Hh = parseInt(g('height')) || 0; dur = parseFloat(g('duration')) || 0;
    } catch (_) {}
    fps = Math.max(1, Math.min(60, Math.round(fps)));
    if (!W || !Hh) throw new Error('Nao consegui ler as dimensoes do video');
    if (dur > 95) throw new Error('Video muito longo pro modo guiado (max 90s). Corte antes de limpar.');
    let hasAudio = false;
    try { const { stdout } = await run('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', orig]); hasAudio = /audio/.test(stdout); } catch (_) {}

    // explode frames (JPEG q2 ~ visualmente transparente; PNG estouraria o disco).
    // fps= conforma VFR/120fps pro mesmo fps da remontagem (senao video acelera/
    // trava e -shortest corta conteudo).
    setJob({ progress: 7, stage: 'preparando frames' });
    const fdir = path.join(dir, 'f'); fs.mkdirSync(fdir);
    await run('ffmpeg', ['-y', '-i', orig, '-vf', `fps=${fps}`, '-q:v', '2', path.join(fdir, 'i_%05d.jpg')]);
    const frames = fs.readdirSync(fdir).filter((f) => /^i_\d+\.jpg$/.test(f)).sort();
    const N = frames.length;
    if (!N) throw new Error('Falha ao extrair frames');
    // dimensoes REAIS pos-rotacao: o probe do mp4 da o tamanho codificado, mas o
    // ffmpeg auto-rotaciona no explode (video de celular com rotate=90 viraria
    // caixas no lugar errado). O frame extraido e a verdade.
    try {
      const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', path.join(fdir, frames[0])]);
      const [fw, fh] = String(stdout).trim().split(',').map((v) => parseInt(v));
      if (fw && fh) { W = fw; Hh = fh; }
    } catch (_) {}

    // caixas normalizadas em pixels (clampadas), com janela de tempo global
    const boxes = (Array.isArray(p.boxes) ? p.boxes : []).map((b) => ({
      x: Math.max(0, Math.min(W - 2, Math.round((b.x_pct || 0) * W))),
      y: Math.max(0, Math.min(Hh - 2, Math.round((b.y_pct || 0) * Hh))),
      w: Math.max(2, Math.round((b.w_pct || 0) * W)),
      h: Math.max(2, Math.round((b.h_pct || 0) * Hh)),
      s: b.start_sec == null ? -1e9 : +b.start_sec,
      e: b.end_sec == null ? 1e9 : +b.end_sec,
    })).map((b) => ({ ...b, w: Math.min(b.w, W - b.x), h: Math.min(b.h, Hh - b.y) }));

    // ── MARCAÇÕES ADAPTATIVAS (r26): anel/pincel com janela de tempo ────────
    // Caixa quadrada sobre círculo desperdiçava área e o miolo (rosto/objeto
    // destacado) era arriscado. Agora: 'ring' remove SÓ a borda elíptica;
    // 'brush' remove exatamente o traço pintado no front. Determinístico —
    // zero detecção de cor. s/e (janela) corta o trabalho aos quadros em que
    // a anotação existe (caso real: seta que aparece 3s e some).
    const marcas = [];
    if (Array.isArray(p.marks)) {
      for (const m of p.marks.slice(0, 12)) {
        if (m.type !== 'ring' && m.type !== 'brush') continue;
        const x = Math.max(0, Math.min(W - 2, Math.round((m.x_pct || 0) * W)));
        const y = Math.max(0, Math.min(Hh - 2, Math.round((m.y_pct || 0) * Hh)));
        const w = Math.max(2, Math.min(Math.round((m.w_pct || 0) * W), W - x));
        const h = Math.max(2, Math.min(Math.round((m.h_pct || 0) * Hh), Hh - y));
        marcas.push({
          type: m.type, x, y, w, h,
          s: m.start_sec == null ? -1e9 : +m.start_sec,
          e: m.end_sec == null ? 1e9 : +m.end_sec,
          thick: +m.thick_pct || 0.3, png: m.png,
        });
      }
    }
    // Formas viram PNGs (RGBA pro overlay time-gated + BW pra máscara de
    // inpaint). A REMOÇÃO delas acontece num passe TEMPORAL próprio depois da
    // legenda (ver "ANOTAÇÕES TRANSIENTES" abaixo) — espacial por-frame vira
    // borrão em anel largo sobre cena complexa (comprovado no smoke30).
    if (marcas.length) {
      try {
        const sharp = require('sharp');
        for (let k = 0; k < marcas.length; k++) {
          const m = marcas[k];
          const um = Buffer.alloc(W * Hh);
          if (m.type === 'ring') {
            // anel elíptico: fora do raio interno, dentro do externo. Folga
            // EXTERNA proporcional (7% do raio, mín 8px): círculo desenhado à
            // mão "balança" quadro a quadro — sem folga sobra arco (smoke32)
            const rx = m.w / 2, ry = m.h / 2, cx0 = m.x + rx, cy0 = m.y + ry;
            const th = Math.min(0.6, Math.max(0.12, m.thick));
            const inner = 1 - th;
            const folga = 1 + Math.max(0.07, 8 / Math.max(8, Math.min(rx, ry)));
            const mgm = Math.ceil(Math.max(rx, ry) * 0.1) + 8;
            for (let yy = Math.max(0, m.y - mgm); yy < Math.min(Hh, m.y + m.h + mgm); yy++) {
              for (let xx = Math.max(0, m.x - mgm); xx < Math.min(W, m.x + m.w + mgm); xx++) {
                const dx = (xx - cx0) / rx, dy = (yy - cy0) / ry;
                const q = dx * dx + dy * dy;
                if (q <= folga * folga && q >= inner * inner) um[yy * W + xx] = 255;
              }
            }
          } else {
            // pincel: PNG pintado no front (dataURL) → res real → binariza
            const b64 = String(m.png || '').split(',').pop();
            if (!b64 || b64.length < 100 || b64.length > 1400000) throw new Error('pincel invalido');
            const g = await sharp(Buffer.from(b64, 'base64'))
              .resize(W, Hh, { fit: 'fill' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
            const ch = g.info.channels; // traço = alpha OU luminância alta
            for (let i2 = 0; i2 < W * Hh; i2++) {
              const a = ch === 4 ? g.data[i2 * ch + 3] : 255;
              if (a > 60 && g.data[i2 * ch] + g.data[i2 * ch + 1] + g.data[i2 * ch + 2] > 90) um[i2] = 255;
            }
          }
          const rgba = Buffer.alloc(W * Hh * 4);
          for (let i2 = 0; i2 < W * Hh; i2++) { const v = um[i2]; rgba[i2 * 4] = v; rgba[i2 * 4 + 1] = v; rgba[i2 * 4 + 2] = v; rgba[i2 * 4 + 3] = v; }
          m.sp = path.join(dir, `shape_${k}.png`);
          await sharp(rgba, { raw: { width: W, height: Hh, channels: 4 } }).png().toFile(m.sp);
          m.spbw = path.join(dir, `shapebw_${k}.png`);
          await sharp(um, { raw: { width: W, height: Hh, channels: 1 } }).png().toFile(m.spbw);
        }
        console.log('[bcg]', jobId, `marcações adaptativas: ${marcas.map((m) => m.type).join(', ')}`);
      } catch (e) {
        marcas.length = 0;
        console.error('[bcg]', jobId, 'marcações falharam (seguem só caixas):', e.message.slice(0, 100));
      }
    }

    // ── CAIXAS AUTOMÁTICAS DE ANOTAÇÕES (r24, multi-cor + clusters) ─────────
    // r23b falhou no caso real: cropdetect faz UNIÃO — vermelho em 2 cantos =
    // caixa do frame inteiro = guard descartava = círculo intocado. Agora:
    // amostra frames → máscara MULTI-COR (vermelho/laranja/AMARELO/azul/verde
    // vivos) em grade baixa → CLUSTERS conectados em node → uma caixa POR
    // mancha, com guards de tamanho (gigante = roupa/cena, ignora; média =
    // seta/círculo/emoji, caixa nela).
    const ANN_CORES = [
      'gt(r(X,Y)-g(X,Y),45)*gt(r(X,Y)-b(X,Y),60)*gt(r(X,Y),110)',                 // vermelho/laranja
      'gt(r(X,Y),150)*gt(g(X,Y),120)*lt(b(X,Y),110)*gt(r(X,Y)-b(X,Y),70)',        // amarelo
      'gt(b(X,Y),140)*gt(b(X,Y)-r(X,Y),50)*gt(b(X,Y)-g(X,Y),40)',                 // azul vivo
      'gt(g(X,Y),140)*gt(g(X,Y)-r(X,Y),60)*gt(g(X,Y)-b(X,Y),50)',                 // verde vivo
    ];
    const ANN_COND = ANN_CORES.map((c) => `(${c})`).join('+');
    if (p.anotacoes) {
      try {
        const GS = 8; // grade: 1 celula = 8x8 px
        const gw = Math.ceil(W / GS), gh = Math.ceil(Hh / GS);
        const pdir = path.join(dir, 'annprobe'); fs.mkdirSync(pdir);
        await run('ffmpeg', ['-y', '-i', orig, '-vf',
          `fps=3,format=rgb24,geq=r='255*gte(${ANN_COND},1)':g='255*gte(${ANN_COND},1)':b='255*gte(${ANN_COND},1)',scale=${gw}:${gh}:flags=area,format=gray`,
          path.join(pdir, 'p_%03d.pgm')]);
        // grade acumulada (celula ativa se acesa em QUALQUER amostra)
        const grid = new Uint8Array(gw * gh);
        for (const f of fs.readdirSync(pdir)) {
          const buf = fs.readFileSync(path.join(pdir, f));
          // PGM P5: header ate o 3o \n (P5 \n W H \n MAX \n) — robusto a comentarios ausentes
          let pos = 0, nl = 0;
          while (nl < 3 && pos < buf.length) { if (buf[pos] === 0x0a) nl++; pos++; }
          const px = buf.subarray(pos);
          for (let i = 0; i < gw * gh && i < px.length; i++) if (px[i] > 40) grid[i] = 1;
        }
        // clusters conectados (BFS 4-viz) na grade
        const vista = new Uint8Array(gw * gh);
        const clusters = [];
        for (let idx = 0; idx < gw * gh; idx++) {
          if (!grid[idx] || vista[idx]) continue;
          const fila = [idx]; vista[idx] = 1;
          let minx = gw, maxx = 0, miny = gh, maxy = 0, cont = 0;
          while (fila.length) {
            const c = fila.pop(); cont++;
            const cx2 = c % gw, cy2 = (c / gw) | 0;
            if (cx2 < minx) minx = cx2; if (cx2 > maxx) maxx = cx2;
            if (cy2 < miny) miny = cy2; if (cy2 > maxy) maxy = cy2;
            for (const nb of [c - 1, c + 1, c - gw, c + gw]) {
              if (nb < 0 || nb >= gw * gh) continue;
              if (Math.abs((nb % gw) - cx2) > 1) continue; // sem wrap lateral
              if (grid[nb] && !vista[nb]) { vista[nb] = 1; fila.push(nb); }
            }
          }
          clusters.push({ minx, maxx, miny, maxy, cont });
        }
        // guards: mancha entre 0.03% e 12% do frame; max 5 caixas (maiores primeiro)
        const areaFrame = gw * gh;
        const validos = clusters
          .filter((c) => c.cont >= Math.max(3, areaFrame * 0.0003) && c.cont <= areaFrame * 0.12)
          .sort((a, b) => b.cont - a.cont).slice(0, 5);
        for (const c of validos) {
          const PADA = 26;
          const nb = {
            x: Math.max(0, c.minx * GS - PADA), y: Math.max(0, c.miny * GS - PADA),
            w: Math.min(W, (c.maxx - c.minx + 1) * GS + PADA * 2), h: Math.min(Hh, (c.maxy - c.miny + 1) * GS + PADA * 2),
            s: -1e9, e: 1e9,
          };
          nb.w = Math.min(nb.w, W - nb.x); nb.h = Math.min(nb.h, Hh - nb.y);
          boxes.push(nb);
          console.log('[bcg]', jobId, `caixa AUTO anotacao: ${nb.w}x${nb.h}@${nb.x},${nb.y} (${c.cont} celulas)`);
        }
        if (!validos.length) console.log('[bcg]', jobId, `auto-anotacoes: ${clusters.length} manchas, nenhuma no tamanho seta/circulo`);
      } catch (e) { console.error('[bcg] auto-anotacoes falhou:', e.message.slice(0, 100)); }
    }

    // mascara em cache por combinacao de caixas ativas (caixas estaticas = 1 so).
    // FRAME INTEIRO + mascara tamanho cheio: mandar so o recorte deixava a area
    // branca ~70% da imagem e o modelo devolvia preenchimento fraco (fantasma).
    // Com o frame inteiro a caixa vira fracao pequena e a remocao sai limpa
    // (validado: banda de legenda 12% do frame = zero fantasma).
    const maskCache = new Map(); // key -> { url, mpath }
    let maskSeq = 0; // nome unico sincrono (size no nome racearia entre workers)
    const PAD = 10; // folga na mascara alem da caixa do usuario (borda anti-aliased)

    // ── CAMADA 1: MÁSCARA EM FORMATO DE TEXTO dentro das caixas ─────────────
    // Problema real (caso bailarina 2026-07-18): caixa sobre PESSOA apagava a
    // pessoa junto (o inpaint reconstrói "fundo", não gente). Solução: detector
    // acha o desenho exato das LETRAS dentro da caixa → só os traços do texto
    // são reconstruídos → ~90% do rosto/corpo por baixo sobrevive.
    // Fallback automático: se o detector não achar texto na caixa (marca
    // d'água gráfica/logo), volta pra caixa cheia (comportamento atual).
    setJob({ progress: 9, stage: 'mapeando texto' });
    let textMaskDir = null; // per-frame m_%05d.png quando modo texto ativo
    let boxPngPath = null;  // limite das caixas (usado tambem no passe de verificacao)
    if (boxes.length && p.mask_mode !== 'caixa') {
      try {
        // caixa(s) do user viram um PNG-limite (uniao de todas, com PAD)
        const drawsAll = boxes.map((b) => `drawbox=x=${Math.max(0, b.x - PAD)}:y=${Math.max(0, b.y - PAD)}:w=${b.w + PAD * 2}:h=${b.h + PAD * 2}:color=white:t=fill`).join(',');
        const boxPng = path.join(dir, 'boxlimit.png');
        await run('ffmpeg', ['-y', '-f', 'lavfi', '-i', `color=black:size=${W}x${Hh}`, '-vf', drawsAll, '-frames:v', '1', boxPng]);
        boxPngPath = boxPng;
        // r25: DETECTOR PRÓPRIO primeiro (DBNet local ~140ms/quadro = segundos
        // no vídeo todo, vs minutos do externo); fallback externo se indisponível
        const sess = await getDetSession();
        let detSeqDir = null;
        // hjunior: obrigatório sem detector próprio; com anotações roda EM
        // PARALELO com o lote local — validado no smoke r25: seta com borda
        // PRETA não é cor viva nem "texto" pro DBNet, mas o detector externo
        // pinta gráficos bold (parecem glifos). Sem anotações: zero externo.
        const rodarHjunior = async () => {
          const blackUrl = await replicateRun(token, 'hjunior29/video-text-remover',
            { video: p.video_url, method: 'black', conf_threshold: 0.03, iou_threshold: 0.15, margin: 8, resolution: '720p', detection_interval: 1 },
            { pollMs: 4000, timeoutMs: 15 * 60 * 1000 });
          const bp = path.join(dir, 'black.mp4');
          await downloadFile(blackUrl, bp);
          return bp;
        };
        let blackPromise = null;
        if (!sess) blackPromise = rodarHjunior(); // falha aqui = job falha (não há detector nenhum)
        else if (p.anotacoes) blackPromise = rodarHjunior().catch((e) => { console.error('[bcg]', jobId, 'hjunior anotações falhou (segue com cor+DBNet):', e.message.slice(0, 80)); return null; });
        if (sess) {
          setJob({ progress: 10, stage: 'mapeando texto (motor próprio)' });
          detSeqDir = await detProprioLote(sess, fdir, frames, W, Hh, path.join(dir, 'dm'), 'dm', 3);
          console.log('[bcg]', jobId, 'detector PRÓPRIO usado no passe 1');
        }
        const black = blackPromise ? await blackPromise : null;
        // MÁSCARA r22 (rumo aos 100%): DENTRO da caixa do user, errar é limpar
        // demais — nunca de menos:
        //  - blend-diff threshold 45→26 (pega contorno/brilho fraco da letra)
        //  - SETAS/CÍRCULOS por COR (p.anotacoes=true, opção do user): condição
        //    vermelho/laranja validada em maio (r-g>45 & r-b>60 & r>110, não
        //    dispara em pele) somada por lighten
        //  - close 12/8 + tmix 5 quadros (herda 2 vizinhos de cada lado)
        //  - +2 dilations FINAIS: mata o halo anti-aliased ("vazamentos")
        const D = Array(12).fill('dilation').join(','), E = Array(8).fill('erosion').join(',');
        const annCond = 'gte(' + ANN_COND + ',1)'; // multi-cor (vermelho/amarelo/azul/verde vivos)
        const comAnn = !!p.anotacoes;
        const annDil = Array(10).fill('dilation').join(',');
        const maskVid = path.join(dir, 'maskv.mp4');
        // POST-PROCESSAMENTO DE OURO (idêntico nos 2 detectores): close 12/8 +
        // ∩ caixas + tmix 5 + rethreshold + 2 dilations finais
        const posOuro = `${D},${E}[txt];[2:v]format=gray[bx];[txt][bx]blend=all_mode=multiply,geq=lum='if(gt(lum(X,Y),128),255,0)',tmix=frames=5,geq=lum='if(gt(lum(X,Y),24),255,0)',dilation,dilation,format=gray[m]`;
        if (detSeqDir && black) {
          // anotações: DBNet (texto pixel-accurate) ∪ blend-diff hjunior
          // (gráficos bold/bordas pretas) ∪ camada de cor (setas/círculos)
          const annChain = comAnn ? `;[1:v]fps=${fps},format=rgb24,geq=r='255*${annCond}':g='255*${annCond}':b='255*${annCond}',format=gray,${annDil}[ann];[u1][ann]blend=all_mode=lighten[uni]` : '';
          const uniLbl = comAnn ? '[uni]' : '[u1]';
          await run('ffmpeg', ['-y', '-framerate', String(fps), '-i', path.join(detSeqDir, 'dm_%05d.png'), '-i', orig, '-i', boxPng, '-i', black, '-filter_complex',
            `[0:v]format=gray[dt];[1:v]fps=${fps},format=gray[a];[3:v]fps=${fps},format=gray[b];[a][b]blend=all_mode=difference,geq=lum='if(gt(lum(X,Y),26),255,0)'[df];[dt][df]blend=all_mode=lighten[u1]${annChain};${uniLbl}${posOuro}`,
            '-map', '[m]', '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', String(fps), maskVid]);
        } else if (detSeqDir) {
          // fonte = máscaras pixel-accurate do detector próprio (sequência)
          const annChain = comAnn ? `;[1:v]fps=${fps},format=rgb24,geq=r='255*${annCond}':g='255*${annCond}':b='255*${annCond}',format=gray,${annDil}[ann];[rawtxt][ann]blend=all_mode=lighten[uni]` : '';
          const uniLbl = comAnn ? '[uni]' : '[rawtxt]';
          await run('ffmpeg', ['-y', '-framerate', String(fps), '-i', path.join(detSeqDir, 'dm_%05d.png'), '-i', orig, '-i', boxPng, '-filter_complex',
            `[0:v]format=gray[rawtxt]${annChain};${uniLbl}${posOuro}`,
            '-map', '[m]', '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', String(fps), maskVid]);
        } else {
          // fonte = blend-diff do vídeo pintado pelo detector externo
          const txtChain = `[0:v]fps=${fps},format=gray[a];[1:v]fps=${fps},format=gray[b];[a][b]blend=all_mode=difference,geq=lum='if(gt(lum(X,Y),26),255,0)'[rawtxt]`;
          const annChain = comAnn ? `;[0:v]fps=${fps},format=rgb24,geq=r='255*${annCond}':g='255*${annCond}':b='255*${annCond}',format=gray,${annDil}[ann];[rawtxt][ann]blend=all_mode=lighten[uni]` : '';
          const uniLbl = comAnn ? '[uni]' : '[rawtxt]';
          await run('ffmpeg', ['-y', '-i', orig, '-i', black, '-i', boxPng, '-filter_complex',
            `${txtChain}${annChain};${uniLbl}${posOuro}`,
            '-map', '[m]', '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', String(fps), maskVid]);
        }
        if (comAnn) console.log('[bcg]', jobId, 'camada de ANOTAÇÕES (setas/círculos por cor) ativa');
        // cobertura media: se ~zero, detector nao achou texto -> fallback caixa
        const { stdout: st } = await run('ffmpeg', ['-i', maskVid, '-vf', 'signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-', '-f', 'null', '-']);
        const yavgs = [...String(st).matchAll(/YAVG=([0-9.]+)/g)].map((m) => parseFloat(m[1]));
        const media = yavgs.length ? yavgs.reduce((a, b) => a + b, 0) / yavgs.length : 0;
        if (media > 16.15) { // texto real detectado (>16: preto do range limitado x264 crava YAVG=16, gate antigo 0.15 passava SEMPRE e o fallback caixa-cheia estava morto)
          const mdir = path.join(dir, 'tm'); fs.mkdirSync(mdir);
          await run('ffmpeg', ['-y', '-i', maskVid, path.join(mdir, 'm_%05d.png')]);
          textMaskDir = mdir;
          console.log('[bcg]', jobId, 'modo TEXTO ativo (yavg medio', media.toFixed(2) + ')');
        } else {
          console.log('[bcg]', jobId, 'sem texto nas caixas (yavg', media.toFixed(2) + ') -> modo caixa');
        }
      } catch (e) {
        console.error('[bcg]', jobId, 'camada texto falhou -> modo caixa:', e.message.slice(0, 120));
      }
    }
    // YAVG por quadro da máscara FINAL (PNGs gray full-range: preto = 0.00).
    // Substitui o "PNG < 800 bytes = vazio" — PNG todo-preto tem ~10KB, então
    // NENHUM quadro era pulado (parte real dos 13min do job da seta).
    let tmYavg = null;
    if (textMaskDir) {
      try {
        const { stdout: st2 } = await run('ffmpeg', ['-framerate', String(fps), '-i', path.join(textMaskDir, 'm_%05d.png'),
          '-vf', 'signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-', '-f', 'null', '-']);
        tmYavg = [...String(st2).matchAll(/YAVG=([0-9.]+)/g)].map((mm) => parseFloat(mm[1]));
        const vazios = tmYavg.filter((v) => v <= 0.15).length;
        console.log('[bcg]', jobId, `máscara final: ${N - vazios}/${N} quadros com trabalho real`);
      } catch (_) { tmYavg = null; }
    }
    const mascaraVazia = (i) => !!(tmYavg && tmYavg[i] !== undefined && tmYavg[i] <= 0.15);
    // cache de upload de mascara pro FALLBACK replicate (mpath -> url)
    const textMaskCache = new Map();
    // semaforo de composicao: rede escala a 32, CPU nao
    let compSlots = 4; const compFila = [];
    const compAcquire = () => new Promise((res) => { if (compSlots > 0) { compSlots--; res(); } else compFila.push(res); });
    const compRelease = () => { const n = compFila.shift(); if (n) n(); else compSlots++; };

    async function maskFor(active) {
      const key = active.map((b) => `${b.x},${b.y},${b.w},${b.h}`).join('|');
      if (maskCache.has(key)) return maskCache.get(key);
      const seq = maskSeq++;
      const draws = active.map((b) => `drawbox=x=${Math.max(0, b.x - PAD)}:y=${Math.max(0, b.y - PAD)}:w=${b.w + PAD * 2}:h=${b.h + PAD * 2}:color=white:t=fill`).join(',');
      const mpath = path.join(dir, `mask_${seq}.png`);
      await run('ffmpeg', ['-y', '-f', 'lavfi', '-i', `color=black:size=${W}x${Hh}`, '-vf', draws, '-frames:v', '1', mpath]);
      const mkey = `${tmpPrefix}/mask_${seq}.png`;
      const url = await uploadRetry('gmask', mpath, mkey, SU, SK, 'image/png');
      uploaded.push(mkey);
      const entry = { url, mpath };
      maskCache.set(key, entry);
      return entry;
    }

    // fila de frames; worker por frame: crop -> upload -> inpaint -> composite
    setJob({ progress: 8, stage: `limpando 0/${N}`, frames_total: N, frames_done: 0 });
    const queue = frames.map((f, i) => ({ f, i }));
    let done = 0, failed = 0;

    // ── r20 MOSAICO (modo texto + fal): a conta fal processa 1 imagem por vez
    // (~1 quadro/s medido). Empacotar K recortes por chamada multiplica o
    // throughput por K sem tocar na qualidade — SEGURO porque a mascara de
    // texto e fina (fracao branca baixa mesmo no recorte; a regra "recorte
    // mata qualidade" valia pra mascara-caixa gorda). Modo caixa segue no
    // caminho por-frame (fracao alta = qualidade primeiro).
    const podeMosaico = !!(textMaskDir && process.env.FAL_KEY && boxes.length);
    let mosaicoOk = false;
    if (podeMosaico) {
      try {
        const MPAD = 42; // margem de contexto em volta da uniao das caixas
        const even2 = (v) => v - (v % 2);
        let x1 = Math.max(0, Math.min(...boxes.map((b) => b.x)) - MPAD);
        let y1 = Math.max(0, Math.min(...boxes.map((b) => b.y)) - MPAD);
        let x2 = Math.min(W, Math.max(...boxes.map((b) => b.x + b.w)) + MPAD);
        let y2 = Math.min(Hh, Math.max(...boxes.map((b) => b.y + b.h)) + MPAD);
        const cx = even2(x1), cy = even2(y1), cw = even2(x2 - cx), ch = even2(y2 - cy);
        const K = Math.max(1, Math.min(8, Math.floor(2200000 / Math.max(1, cw * ch))));
        if (cw * ch <= 0.55 * W * Hh && K >= 2) {
          mosaicoOk = true;
          const vertical = cw >= ch; // banda larga empilha; coluna estreita enfileira
          // frames que PRECISAM de inpaint (mascara com conteudo); resto copia
          const precisa = [];
          for (const { f, i } of queue) {
            const t = (i + 0.5) / fps;
            const src = path.join(fdir, f);
            const out = path.join(fdir, f.replace('i_', 'o_'));
            const mf = path.join(textMaskDir, `m_${String(i + 1).padStart(5, '0')}.png`);
            if (!boxes.some((b) => t >= b.s && t <= b.e) || !fs.existsSync(mf) || mascaraVazia(i)) {
              fs.copyFileSync(src, out); done++;
            } else precisa.push({ i, src, out, mf });
          }
          const grupos = [];
          for (let g = 0; g < precisa.length; g += K) grupos.push(precisa.slice(g, g + K));
          console.log('[bcg]', jobId, `mosaico: crop ${cw}x${ch} K=${K} ${vertical ? 'V' : 'H'} | ${precisa.length} frames em ${grupos.length} tiles`);

          // FASE A: monta tiles (CPU, semaforo) e SUBMETE tudo na fila do fal
          const stackF = vertical ? `vstack=${'{N}'}` : `hstack=${'{N}'}`;
          const buildTile = async (grupo, gi, tipo) => {
            const outP = path.join(dir, `${tipo}_${gi}.${tipo === 'tile' ? 'jpg' : 'png'}`);
            const inputs = [];
            grupo.forEach((fr) => { inputs.push('-i', tipo === 'tile' ? fr.src : fr.mf); });
            const crops = grupo.map((_, s) => `[${s}:v]crop=${cw}:${ch}:${cx}:${cy}[c${s}]`).join(';');
            const labels = grupo.map((_, s) => `[c${s}]`).join('');
            const fcx = grupo.length === 1 ? `${crops}` : `${crops};${labels}${stackF.replace('{N}', grupo.length)}[t]`;
            const mapLbl = grupo.length === 1 ? '[c0]' : '[t]';
            const args = ['-y', ...inputs, '-filter_complex', fcx, '-map', mapLbl];
            if (tipo === 'tile') args.push('-q:v', '3');
            args.push(outP);
            await compAcquire();
            try { await run('ffmpeg', args); } finally { compRelease(); }
            return outP;
          };
          const FAL = process.env.FAL_KEY;
          const submeter = async (tileP, maskP) => {
            const body = {
              image_url: 'data:image/jpeg;base64,' + fs.readFileSync(tileP).toString('base64'),
              mask_image_url: 'data:image/png;base64,' + fs.readFileSync(maskP).toString('base64'),
            };
            const sub = await axios.post('https://queue.fal.run/fal-ai/lama', body,
              { headers: { Authorization: 'Key ' + FAL, 'Content-Type': 'application/json' }, timeout: 60000 });
            if (!sub.data?.request_id) throw new Error('sem request_id');
            return sub.data.request_id;
          };
          setJob({ progress: 12, stage: `montando mosaicos 0/${grupos.length}` });
          const pendentes = []; // { grupo, gi, reqId, tileP, maskP }
          const falhosPorTile = [];
          {
            let gi2 = 0;
            const buildQ = grupos.map((g, gi) => ({ g, gi }));
            await Promise.all(Array.from({ length: 6 }, async () => {
              while (buildQ.length) {
                if ((JOBS.get(jobId) || {}).status === 'cancelled') return;
                const { g, gi } = buildQ.shift();
                try {
                  const tileP = await buildTile(g, gi, 'tile');
                  const maskP = await buildTile(g, gi, 'tmsk');
                  const reqId = await submeter(tileP, maskP);
                  pendentes.push({ grupo: g, gi, reqId, tileP, maskP });
                } catch (e) {
                  console.error('[bcg] tile', gi, 'falhou montar/submeter:', e.message.slice(0, 90));
                  falhosPorTile.push(g);
                }
                gi2++;
                if (gi2 % 5 === 0) setJob({ progress: Math.min(25, 12 + Math.round((gi2 / grupos.length) * 13)), stage: `montando mosaicos ${gi2}/${grupos.length}` });
              }
            }));
          }

          // FASE B: acompanha a fila e recompoe conforme conclui
          const deadlineAll = Date.now() + Math.max(300000, grupos.length * 4000 + 180000);
          const compor = async (p, resultP) => {
            for (let s = 0; s < p.grupo.length; s++) {
              const fr = p.grupo[s];
              const ox = vertical ? 0 : s * cw, oy = vertical ? s * ch : 0;
              await compAcquire();
              try {
                await run('ffmpeg', ['-y', '-i', fr.src, '-i', resultP, '-i', fr.mf, '-filter_complex',
                  `[1:v]crop=${cw}:${ch}:${ox}:${oy}[l];[2:v]crop=${cw}:${ch}:${cx}:${cy},format=gray,boxblur=1[mc];[0:v]crop=${cw}:${ch}:${cx}:${cy}[oc];[oc]format=gbrp[og];[l]format=gbrp[lg];[mc]format=gbrp[mg];[og][lg][mg]maskedmerge,format=yuvj420p[pt];[0:v][pt]overlay=${cx}:${cy}`,
                  '-q:v', '2', fr.out]);
              } finally { compRelease(); }
              done++;
            }
            fs.rmSync(resultP, { force: true }); fs.rmSync(p.tileP, { force: true }); fs.rmSync(p.maskP, { force: true });
          };
          while (pendentes.some((p) => !p._fim) && Date.now() < deadlineAll) {
            if ((JOBS.get(jobId) || {}).status === 'cancelled') break;
            const abertos = pendentes.filter((p) => !p._fim).slice(0, 12);
            await Promise.all(abertos.map(async (p) => {
              try {
                const st = await axios.get(`https://queue.fal.run/fal-ai/lama/requests/${p.reqId}/status`,
                  { headers: { Authorization: 'Key ' + FAL }, timeout: 20000, validateStatus: () => true });
                const stat = st.data?.status;
                if (stat === 'COMPLETED') {
                  const rr = await axios.get(`https://queue.fal.run/fal-ai/lama/requests/${p.reqId}`, { headers: { Authorization: 'Key ' + FAL }, timeout: 30000 });
                  const outUrl = rr.data?.image?.url;
                  if (!outUrl) throw new Error('sem output');
                  const resP = path.join(dir, `tout_${p.gi}.png`);
                  await downloadFile(outUrl, resP);
                  p._fim = true;
                  await compor(p, resP);
                  setJob({ progress: Math.min(90, 25 + Math.round((done / N) * 65)), stage: `limpando ${done}/${N}`, frames_done: done, frames_total: N });
                } else if (['FAILED', 'ERROR', 'CANCELLED'].includes(stat)) {
                  p._fim = true; falhosPorTile.push(p.grupo);
                }
              } catch (e) { /* tenta na proxima varredura */ }
            }));
            await sleep(700);
          }
          for (const p of pendentes) if (!p._fim) { p._fim = true; falhosPorTile.push(p.grupo); }
          // tiles que falharam: caem no caminho por-frame (fila abaixo)
          queue.length = 0;
          for (const g of falhosPorTile) for (const fr of g) queue.push({ f: path.basename(fr.src), i: fr.i });
          if (queue.length) console.log('[bcg]', jobId, 'mosaico: ', queue.length, 'frames pro fallback por-frame');
        }
      } catch (e) {
        console.error('[bcg]', jobId, 'mosaico falhou, caminho por-frame:', e.message.slice(0, 120));
        mosaicoOk = false;
      }
    }
    const worker = async () => {
      while (queue.length) {
        // CANCELAMENTO obedecido: /cancel marca o job e as lanes param aqui
        if ((JOBS.get(jobId) || {}).status === 'cancelled') return;
        const { f, i } = queue.shift();
        const t = (i + 0.5) / fps;
        const active = boxes.filter((b) => t >= b.s && t <= b.e);
        const src = path.join(fdir, f);
        const out = path.join(fdir, f.replace('i_', 'o_'));
        if (!boxes.some((b) => t >= b.s && t <= b.e)) { fs.copyFileSync(src, out); done++; continue; }
        let mpath;
        if (textMaskDir) {
          // modo TEXTO: mascara por-frame (tracos das letras + formas ativas).
          // Mascara vazia (YAVG=0, nao tamanho de PNG — preto tem ~10KB) =
          // copia original (economiza 1 inpaint e preserva 100% o frame).
          const mf = path.join(textMaskDir, `m_${String(i + 1).padStart(5, '0')}.png`);
          if (!fs.existsSync(mf) || mascaraVazia(i)) { fs.copyFileSync(src, out); done++; continue; }
          mpath = mf; // upload so no fallback replicate (fal vai por data-URI)
        } else {
          if (!active.length) { fs.copyFileSync(src, out); done++; continue; }
          ({ mpath } = await maskFor(active));
        }
        try {
          // r19: fal via DATA-URI (zero upload por quadro). Fallback replicate
          // faz os uploads sob demanda (raro).
          let outUrl = null;
          if (process.env.FAL_KEY) {
            for (let a = 0; a < 3 && !outUrl; a++) {
              try { outUrl = await falInpaintPaths(src, mpath); }
              catch (e) { if (a === 2) console.error('[bcg] fal 3x falhou, fallback:', e.message.slice(0, 90)); else await sleep(700 + a * 1200); }
            }
          }
          if (!outUrl) {
            const fkey = `${tmpPrefix}/f_${i}.jpg`;
            const frameUrl = await uploadRetry('gframe ' + i, src, fkey, SU, SK, 'image/jpeg');
            uploaded.push(fkey);
            let mUrl = textMaskCache.get(mpath);
            if (!mUrl) {
              const mkey = `${tmpPrefix}/tm_${i}.png`;
              mUrl = await uploadRetry('tmask ' + i, mpath, mkey, SU, SK, 'image/png');
              uploaded.push(mkey);
              textMaskCache.set(mpath, mUrl);
            }
            outUrl = await replicateRunSync(token, GUIDED_MODEL, { image: frameUrl, mask: mUrl });
          }
          const lpath = path.join(dir, `l_${i}.img`);
          await downloadFile(outUrl, lpath);
          // composite: inpaint SO dentro da mascara; resto do frame original.
          // gbrp full-range (fix do fantasma 2026-07-17). Semaforo de 4: 32
          // lanes de rede nao podem virar 32 ffmpegs brigando por CPU.
          await compAcquire();
          try {
            await run('ffmpeg', ['-y', '-i', src, '-i', lpath, '-i', mpath, '-filter_complex',
              `[0:v]format=gbrp[b];[1:v]scale=${W}:${Hh},format=gbrp[l];[2:v]format=gray,boxblur=1,format=gbrp[mm];[b][l][mm]maskedmerge,format=yuvj420p`,
              '-q:v', '2', out]);
          } finally { compRelease(); }
          fs.rmSync(lpath, { force: true });
        } catch (e) {
          // frame que falhou nao derruba o job: mantem o original nele
          console.error('[bcg]', jobId, 'frame', i, e.message.slice(0, 120));
          fs.copyFileSync(src, out); failed++;
        }
        done++;
        if (done % 5 === 0 || done === N) {
          setJob({ progress: Math.min(90, 8 + Math.round((done / N) * 82)), stage: `limpando ${done}/${N}`, frames_done: done, frames_total: N });
        }
      }
    };
    // Paralelismo alto por padrao: o limite real vem do burst do Replicate
    // (proporcional ao saldo). Lane que toma 429 recua sozinha (retry com
    // backoff no guidedInpaint) — com saldo ok, 16 lanes rodam de verdade e um
    // video de 20s cai de ~40min pra poucos minutos.
    const CONC = Math.max(1, Math.min(40, parseInt(p.conc) || (process.env.FAL_KEY ? 24 : 16)));
    await Promise.all(Array.from({ length: CONC }, worker));
    if ((JOBS.get(jobId) || {}).status === 'cancelled') {
      // limpeza best-effort e sai mantendo o status cancelled
      (async () => { for (const pth of uploaded) { try { await axios.delete(`${SU}/storage/v1/object/blue-videos/${pth}`, { headers: { Authorization: 'Bearer ' + SK, apikey: SK } }); } catch (_) {} } })().catch(() => {});
      setTimeout(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }, 3000);
      return;
    }
    if (failed > N * 0.2) throw new Error(`Muitos frames falharam (${failed}/${N}). Tente de novo.`);

    // ── ANOTAÇÕES TRANSIENTES (r26): anel/pincel via inpaint TEMPORAL ────────
    // Espacial por-frame vira borrão em anel largo sobre cena complexa
    // (smoke30). A anotação é TRANSIENTE (janela s→e): o fundo real existe nos
    // quadros vizinhos sem ela → o motor temporal copia de lá (fill nítido).
    // Segmento = janela ± 0.7s de folga (os quadros de folga entram com máscara
    // PRETA = referência limpa pro motor). Composite maskedmerge devolve SÓ a
    // região da forma; resto do quadro fica como estava.
    const compositeMasked = async (baseJpg, fillPath, maskPath, tmpOut) => {
      await run('ffmpeg', ['-y', '-i', baseJpg, '-i', fillPath, '-i', maskPath, '-filter_complex',
        `[2:v]format=gray,dilation,dilation,dilation,dilation,boxblur=2[m];[0:v]format=gbrp[a];[1:v]format=gbrp[b];[m]format=gbrp[mg];[a][b][mg]maskedmerge,format=yuvj420p`,
        '-q:v', '2', tmpOut]);
      fs.copyFileSync(tmpOut, baseJpg);
    };
    if (marcas.length && (JOBS.get(jobId) || {}).status !== 'cancelled') {
      const durT = N / fps;
      for (let mk = 0; mk < marcas.length; mk++) {
        const m = marcas[mk];
        if (!m.sp || (JOBS.get(jobId) || {}).status === 'cancelled') continue;
        const mS = m.s === -1e9 ? 0 : Math.max(0, m.s);
        const mE = m.e === 1e9 ? durT : Math.min(durT, m.e);
        try {
          setJob({ progress: 87, stage: `removendo anotação ${mk + 1}/${marcas.length}` });
          const s0 = Math.max(0, mS - 0.7), e0 = Math.min(durT, mE + 0.7);
          const f0 = Math.max(0, Math.floor(s0 * fps)), f1 = Math.min(N - 1, Math.ceil(e0 * fps));
          const nseg = f1 - f0 + 1;
          if (nseg < 2) continue;
          // segmento a partir dos quadros JÁ limpos (legenda já saiu)
          const segV = path.join(dir, `seg_${mk}.mp4`);
          await run('ffmpeg', ['-y', '-start_number', String(f0 + 1), '-framerate', String(fps), '-i', path.join(fdir, 'o_%05d.jpg'),
            '-frames:v', String(nseg), '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', String(fps), segV]);
          const relS = Math.max(0, mS - (f0 / fps)), relE = Math.min(nseg / fps, mE - (f0 / fps));
          const segM = path.join(dir, `segm_${mk}.mp4`);
          await run('ffmpeg', ['-y', '-f', 'lavfi', '-i', `color=black:size=${W}x${Hh}:rate=${fps}`, '-loop', '1', '-i', m.sp,
            '-filter_complex', `[0:v][1:v]overlay=shortest=0:enable='between(t,${relS.toFixed(3)},${relE.toFixed(3)})',format=gray[m]`,
            '-map', '[m]', '-frames:v', String(nseg), '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', String(fps), segM]);
          // (r26d testou máscara adaptativa por cor ∩ banda: fantasma — máscara
          // fina amplifica vazamento de borda no upscale do motor temporal.
          // Anel ESTÁTICO com folga é o robusto; espessura é alavanca do user.)
          const segMuso = segM;
          const segKey = `${tmpPrefix}/seg_${mk}.mp4`, segMKey = `${tmpPrefix}/segm_${mk}.mp4`;
          const segUrl = await uploadRetry('seg' + mk, segV, segKey, SU, SK, 'video/mp4'); uploaded.push(segKey);
          const segMUrl = await uploadRetry('segm' + mk, segMuso, segMKey, SU, SK, 'video/mp4'); uploaded.push(segMKey);
          const ppRatio = Math.min(1, 896 / Math.max(W, Hh));
          const filledUrl = await replicateRun(token, 'jd7h/propainter', {
            video: segUrl, mask: segMUrl, fp16: true,
            mask_dilation: 8, neighbor_length: 10, ref_stride: 10, raft_iter: 20,
            subvideo_length: 40, resize_ratio: ppRatio,
          }, { pollMs: 4000, timeoutMs: 12 * 60 * 1000 });
          const filled = path.join(dir, `fill_${mk}.mp4`);
          await downloadFile(filledUrl, filled);
          const fillDir = path.join(dir, `filld_${mk}`); fs.mkdirSync(fillDir);
          await run('ffmpeg', ['-y', '-i', filled, '-vf', `scale=${W}:${Hh}:flags=bicubic,fps=${fps}`, '-q:v', '2', path.join(fillDir, 'p_%05d.jpg')]);
          // máscaras por-frame do composite = as MESMAS enviadas ao motor
          // (adaptativas seguem o traço; re-binariza o preto-16 do x264)
          const kDir = path.join(dir, `kmsk_${mk}`); fs.mkdirSync(kDir);
          // format=gray ANTES do geq: geq só-luma em yuv zera o chroma (máscara
          // VERDE → format=gray no composite virava 165/45 = fantasma 35%)
          await run('ffmpeg', ['-y', '-i', segMuso, '-vf', `format=gray,geq=lum='if(gt(lum(X,Y),100),255,0)'`, '-pix_fmt', 'gray', path.join(kDir, 'k_%05d.png')]);
          let comp = 0;
          const tmpOut = path.join(dir, `co_${mk}.jpg`);
          for (let i2 = 0; i2 < nseg; i2++) {
            const t2 = (f0 + i2 + 0.5) / fps;
            if (t2 < mS || t2 > mE) continue; // folga: intocada
            const oF = path.join(fdir, `o_${String(f0 + i2 + 1).padStart(5, '0')}.jpg`);
            const pF = path.join(fillDir, `p_${String(i2 + 1).padStart(5, '0')}.jpg`);
            const kF = path.join(kDir, `k_${String(i2 + 1).padStart(5, '0')}.png`);
            if (!fs.existsSync(oF) || !fs.existsSync(pF) || !fs.existsSync(kF)) continue;
            await compositeMasked(oF, pF, kF, tmpOut); comp++;
          }
          console.log('[bcg]', jobId, `anotação ${mk + 1} (${m.type}): ${comp} quadros compostos via motor temporal`);
        } catch (e) {
          console.error('[bcg]', jobId, `anotação ${mk + 1} temporal falhou, fallback espacial:`, e.message.slice(0, 100));
          // fallback: espacial por-frame só nos quadros da janela
          try {
            let fb = 0;
            const tmpOut = path.join(dir, `co_${mk}.jpg`);
            const tmpFill = path.join(dir, `cf_${mk}.jpg`);
            for (let i2 = 0; i2 < N; i2++) {
              const t2 = (i2 + 0.5) / fps;
              if (t2 < mS || t2 > mE) continue;
              if ((JOBS.get(jobId) || {}).status === 'cancelled') break;
              const oF = path.join(fdir, `o_${String(i2 + 1).padStart(5, '0')}.jpg`);
              let outUrl = null;
              if (process.env.FAL_KEY) {
                for (let a = 0; a < 2 && !outUrl; a++) { try { outUrl = await falInpaintPaths(oF, m.spbw); } catch (_) { await sleep(800); } }
              }
              if (!outUrl) continue;
              await downloadFile(outUrl, tmpFill);
              await compositeMasked(oF, tmpFill, m.spbw, tmpOut); fb++;
            }
            console.log('[bcg]', jobId, `anotação ${mk + 1}: fallback espacial em ${fb} quadros`);
          } catch (e2) { console.error('[bcg]', jobId, 'fallback espacial falhou:', e2.message.slice(0, 80)); }
        }
      }
    }

    // ── PASSE 2: VERIFICAÇÃO (rumo aos 100%) ─────────────────────────────────
    // O motor confere o PRÓPRIO trabalho: roda o detector no vídeo já limpo;
    // se ainda achar texto dentro das caixas ("vazamentos"), re-limpa SÓ os
    // quadros culpados com a máscara do resíduo. Garantia por inspeção, não fé.
    if (textMaskDir && boxPngPath && process.env.FAL_KEY && (JOBS.get(jobId) || {}).status !== 'cancelled') {
      try {
        setJob({ progress: 90, stage: 'verificando resultado' });
        const resVid = path.join(dir, 'resmask.mp4');
        const sess2 = await getDetSession();
        if (sess2) {
          // r25: verificação com o DETECTOR PRÓPRIO direto nos quadros limpos —
          // "ainda tem texto aqui?" sem upload interim nem chamada externa.
          // Resíduo = texto detectado no vídeo LIMPO ∩ caixas do user.
          // Threshold 0.45 (vs 0.25 do passe 1): no smoke r25 o 0.25 flagrou
          // 90/90 quadros (fantasmas fracos/textura) → 40 recorreções deixando
          // remendos claros visíveis. Verificação só deve disparar em texto NÍTIDO.
          const oFrames = fs.readdirSync(fdir).filter((f) => /^o_\d+\.jpg$/.test(f)).sort();
          const dvDir = await detProprioLote(sess2, fdir, oFrames, W, Hh, path.join(dir, 'dv'), 'dv', 3, 0.45);
          console.log('[bcg]', jobId, 'detector PRÓPRIO usado na verificação');
          await run('ffmpeg', ['-y', '-framerate', String(fps), '-i', path.join(dvDir, 'dv_%05d.png'), '-i', boxPngPath, '-filter_complex',
            `[0:v]format=gray[r];[1:v]format=gray[bx];[r][bx]blend=all_mode=multiply,geq=lum='if(gt(lum(X,Y),128),255,0)',tmix=frames=3,geq=lum='if(gt(lum(X,Y),24),255,0)',dilation,dilation,dilation,dilation,format=gray[m]`,
            '-map', '[m]', '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', String(fps), resVid]);
        } else {
          const interim = path.join(dir, 'interim.mp4');
          await run('ffmpeg', ['-y', '-framerate', String(fps), '-i', path.join(fdir, 'o_%05d.jpg'),
            '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p', interim]);
          const ikey = `${tmpPrefix}/interim.mp4`;
          const iurl = await uploadRetry('interim', interim, ikey, SU, SK, 'video/mp4');
          uploaded.push(ikey);
          const blackUrl2 = await replicateRun(token, 'hjunior29/video-text-remover',
            { video: iurl, method: 'black', conf_threshold: 0.2, iou_threshold: 0.15, margin: 10, resolution: '480p', detection_interval: 3 },
            { pollMs: 4000, timeoutMs: 15 * 60 * 1000 });
          const black2 = path.join(dir, 'black2.mp4');
          await downloadFile(blackUrl2, black2);
          // RESÍDUO EXATO (fix da explosão de 12min): antes era blend-diff com
          // threshold baixo que flagrava RUÍDO de compressão → 100% dos quadros
          // "culpados" → correção em massa por-frame. Agora: resíduo = onde o
          // detector PINTOU DE PRETO (lum<16) e o vídeo limpo NÃO era escuro
          // (lum>40) — detecção verdadeira, zero ruído.
          await run('ffmpeg', ['-y', '-i', interim, '-i', black2, '-i', boxPngPath, '-filter_complex',
            `[0:v]fps=${fps},format=gray,geq=lum='if(gt(lum(X,Y),40),255,0)'[na];[1:v]fps=${fps},format=gray,geq=lum='if(lt(lum(X,Y),16),255,0)'[pb];[na][pb]blend=all_mode=multiply[r];[2:v]format=gray[bx];[r][bx]blend=all_mode=multiply,geq=lum='if(gt(lum(X,Y),128),255,0)',tmix=frames=3,geq=lum='if(gt(lum(X,Y),24),255,0)',dilation,dilation,dilation,dilation,format=gray[m]`,
            '-map', '[m]', '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', String(fps), resVid]);
        }
        const rdir = path.join(dir, 'rm'); fs.mkdirSync(rdir);
        // re-binariza na extração (format=gray ANTES do geq: geq só-luma em yuv
        // zera o chroma = máscara verde; e o round-trip x264 limitado vira
        // "preto"=16 — sem isso a máscara ia cinza pro inpaint)
        await run('ffmpeg', ['-y', '-i', resVid, '-vf', `format=gray,geq=lum='if(gt(lum(X,Y),128),255,0)'`, '-pix_fmt', 'gray', path.join(rdir, 'r_%05d.png')]);
        // quadros culpados por ESTATÍSTICA DE LUMA, não tamanho de PNG:
        // PNG todo-preto tem ~10KB (bug r23b→r25: filtro >=800B flagrava
        // TODOS os quadros → 40 correções inúteis com remendos visíveis).
        // Preto limitado = YAVG 16.00 cravado; resíduo real sobe a média.
        const { stdout: rst } = await run('ffmpeg', ['-i', resVid, '-vf', 'signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-', '-f', 'null', '-']);
        const yvres = [...String(rst).matchAll(/YAVG=([0-9.]+)/g)].map((m) => parseFloat(m[1]));
        let culpados = [];
        for (let i = 0; i < Math.min(N, yvres.length); i++) {
          if (yvres[i] <= 16.15) continue; // ~0.05% do quadro aceso
          const rp = path.join(rdir, `r_${String(i + 1).padStart(5, '0')}.png`);
          if (fs.existsSync(rp)) culpados.push({ i, rp, yavg: yvres[i] });
        }
        console.log('[bcg]', jobId, `verificacao: ${culpados.length}/${N} quadros com residuo real`);
        culpados.sort((a, b) => b.yavg - a.yavg); if (culpados.length > 40) { console.log('[bcg]', jobId, 'cap de correcao: top-40 por tamanho de residuo'); culpados = culpados.slice(0, 40); }
        if (culpados.length) {
          setJob({ progress: 93, stage: `recorrigindo ${culpados.length} quadros` });
          const fila2 = [...culpados];
          await Promise.all(Array.from({ length: 12 }, async () => {
            while (fila2.length) {
              if ((JOBS.get(jobId) || {}).status === 'cancelled') return;
              const { i, rp } = fila2.shift();
              const oF = path.join(fdir, `o_${String(i + 1).padStart(5, '0')}.jpg`);
              try {
                let outUrl = null;
                for (let a = 0; a < 3 && !outUrl; a++) {
                  try { outUrl = await falInpaintPaths(oF, rp); } catch (e) { await sleep(600 + a * 900); }
                }
                if (!outUrl) continue; // mantem como esta (melhor 95% que job morto)
                const lp = path.join(dir, `l2_${i}.img`);
                await downloadFile(outUrl, lp);
                const tmpO = oF + '.new.jpg';
                await compAcquire();
                try {
                  await run('ffmpeg', ['-y', '-i', oF, '-i', lp, '-i', rp, '-filter_complex',
                    `[0:v]format=gbrp[b];[1:v]scale=${W}:${Hh},format=gbrp[l];[2:v]format=gray,boxblur=1,format=gbrp[mm];[b][l][mm]maskedmerge,format=yuvj420p`,
                    '-q:v', '2', tmpO]);
                } finally { compRelease(); }
                fs.renameSync(tmpO, oF);
                fs.rmSync(lp, { force: true });
              } catch (e) { console.error('[bcg] recorrecao frame', i, e.message.slice(0, 80)); }
            }
          }));
        }
      } catch (e) {
        console.error('[bcg]', jobId, 'verificacao falhou (segue sem passe 2):', e.message.slice(0, 120));
      }
    }

    // remonta + audio
    setJob({ progress: 92, stage: 'montando video' });
    const merged = path.join(dir, 'merged.mp4');
    await run('ffmpeg', ['-y', '-framerate', String(fps), '-i', path.join(fdir, 'o_%05d.jpg'),
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '17', '-pix_fmt', 'yuv420p', merged]);
    setJob({ progress: 95, stage: 'audio' });
    const finalOut = path.join(dir, 'final.mp4');
    if (hasAudio) {
      await run('ffmpeg', ['-y', '-i', merged, '-i', orig, '-map', '0:v:0', '-map', '1:a:0',
        '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k', '-shortest', finalOut]);
    } else { fs.copyFileSync(merged, finalOut); }

    setJob({ progress: 97, stage: 'finalizando' });
    const outputUrl = await uploadToSupabase(finalOut, p.output_path, SU, SK, 'video/mp4');
    // done ANTES do cleanup: milhares de DELETEs em serie deixariam o user
    // olhando "97%" por minutos com o video ja pronto. Cleanup vira best-effort
    // em lotes paralelos depois.
    JOBS.set(jobId, { status: 'done', progress: 100, stage: 'concluido', frames: N, frames_failed: failed, elapsed_sec: Math.round((Date.now() - startedAt) / 1000), output_url: outputUrl + '?v=' + Date.now() });
    (async () => {
      for (let i = 0; i < uploaded.length; i += 20) {
        await Promise.all(uploaded.slice(i, i + 20).map((pth) =>
          axios.delete(`${SU}/storage/v1/object/blue-videos/${pth}`, { headers: { Authorization: 'Bearer ' + SK, apikey: SK } }).catch(() => {})));
      }
    })().catch(() => {});
    setTimeout(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }, 8000);
  } catch (e) {
    for (const pth of uploaded) {
      try { await axios.delete(`${SU}/storage/v1/object/blue-videos/${pth}`, { headers: { Authorization: 'Bearer ' + SK, apikey: SK } }); } catch (_) {}
    }
    console.error('[bcg-fatal]', String(e.stack || '').replace(/\n/g, ' | ').slice(0, 600)); if (e.config) console.error('[bcg-axios]', e.config.url, e.response ? JSON.stringify(e.response.data).slice(0, 300) : ''); JOBS.set(jobId, { status: 'error', progress: 0, error: e.message });
    setTimeout(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }, 8000);
  }
}

// Extrai thumbnail EVITANDO frames pretos: testa 3 pontos do video e aceita
// o primeiro com brilho medio (YAVG) > 18. Corrige as "thumbs de tela preta"
// que a captura client-side (frame fixo em ~1s) gerava.
async function extractBrightThumb(src, dir) {
  let dur = 10;
  try {
    const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', src]);
    dur = parseFloat(stdout) || 10;
  } catch (_) {}
  let fallback = null;
  for (const pct of [0.15, 0.35, 0.6]) {
    const t = Math.max(0.3, Math.min(dur - 0.2, dur * pct));
    const out = path.join(dir, `thumb_${Math.round(pct * 100)}.jpg`);
    try {
      await run('ffmpeg', ['-y', '-ss', String(t.toFixed(2)), '-i', src, '-frames:v', '1', '-vf', "scale='min(720,iw)':-2", '-q:v', '4', out]);
      if (!fs.existsSync(out) || !fs.statSync(out).size) continue;
      if (!fallback) fallback = out;
      const { stdout: so, stderr: se } = await run('ffmpeg', ['-i', out, '-vf', 'signalstats,metadata=print:file=-', '-f', 'null', '-']);
      const m = (so + se).match(/YAVG[=:]\s*([\d.]+)/);
      const yavg = m ? parseFloat(m[1]) : 0;
      if (yavg > 18) return out;
    } catch (_) {}
  }
  return fallback;
}

async function processBlueTranscode(jobId, p) {
  const dir = path.join('/tmp', 'bt-' + jobId);
  fs.mkdirSync(dir, { recursive: true });
  const update = (status, progress, extra = {}) => JOBS.set(jobId, { status, progress, ...extra });
  try {
    update('downloading', 10);
    const src = path.join(dir, 'src.mp4');
    await downloadFile(p.video_url, src);
    const beforeBytes = fs.statSync(src).size;

    // backup do original ANTES de sobrescrever (path .orig.mp4, mesmo bucket)
    if (p.backup) {
      update('backup', 25);
      try {
        await uploadToSupabase(src, p.storage_path.replace(/\.mp4$/i, '') + '.orig.mp4', p.supabase_url, p.supabase_key);
      } catch (e) { console.log('[blue-transcode] backup falhou (segue):', e.message); }
    }

    update('transcoding', 40);
    const out = path.join(dir, 'out.mp4');
    // scale: cap 1080 de largura, mantem aspect, par (h264 exige)
    await run('ffmpeg', [
      '-y', '-i', src,
      '-vf', "scale='min(1080,iw)':-2",
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26',
      '-maxrate', '4M', '-bufsize', '8M',
      '-c:a', 'aac', '-b:a', '128k',
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      out,
    ]);
    const afterBytes = fs.statSync(out).size;

    update('uploading', 80);
    // sobrescreve o MESMO path (URLs existentes continuam validas; CDN tem
    // cache 30d — o purge acontece pela query ?v= no cliente OU naturalmente)
    await uploadToSupabase(out, p.storage_path, p.supabase_url, p.supabase_key);

    // Thumbnail server-side com anti-frame-preto (substitui a captura do
    // cliente, que pegava frame fixo e saia preta em videos com intro escura)
    let thumbUrl = null;
    if (p.gen_thumb) {
      try {
        const tf = await extractBrightThumb(out, dir);
        if (tf) {
          const thumbPath = p.storage_path.replace(/[^/]+$/, 'thumb.jpg');
          await uploadToSupabase(tf, thumbPath, p.supabase_url, p.supabase_key, 'image/jpeg');
          thumbUrl = `${p.supabase_url}/storage/v1/object/public/blue-videos/${thumbPath}?v=${Date.now()}`;
        }
      } catch (e) { console.log('[blue-transcode] thumb falhou (segue):', e.message); }
    }

    // marca no banco + cache-bust: ?v=timestamp na video_url forca o
    // Cloudflare (cache 30d) a buscar o arquivo novo. Se transcoded_at
    // ainda nao existir como coluna, repete so com a video_url.
    if (p.video_id) {
      const dbHeaders = {
        apikey: p.supabase_key, Authorization: 'Bearer ' + p.supabase_key,
        'Content-Type': 'application/json', Prefer: 'return=minimal',
      };
      const bustedUrl = String(p.video_url).split('?')[0] + '?v=' + Date.now();
      const extra = thumbUrl ? { thumbnail_url: thumbUrl } : {};
      const patchDb = (body) => fetch(`${p.supabase_url}/rest/v1/blue_videos?id=eq.${p.video_id}`, {
        method: 'PATCH', headers: dbHeaders, body: JSON.stringify(body),
      });
      try {
        const r1 = await patchDb({ video_url: bustedUrl, ...extra, transcoded_at: new Date().toISOString() });
        if (!r1.ok) await patchDb({ video_url: bustedUrl, ...extra });
      } catch (e) { console.log('[blue-transcode] patch db falhou (segue):', e.message); }
    }

    update('done', 100, { before_bytes: beforeBytes, after_bytes: afterBytes });
    setTimeout(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }, 60000);
  } catch (err) {
    console.error('[blue-transcode]', jobId, err.message);
    JOBS.set(jobId, { status: 'error', progress: 0, error: err.message || err.code || String(err) });
    setTimeout(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }, 10000);
  }
}

app.post('/extract-audio', async (req, res) => {
  const { video_url, supabase_url, supabase_key } = req.body || {};
  if (!video_url || !supabase_url || !supabase_key) {
    return res.status(400).json({ error: 'video_url + credenciais obrigatorios' });
  }
  const jobId = uuidv4();
  const dir = path.join('/tmp', 'xa-' + jobId);
  fs.mkdirSync(dir, { recursive: true });
  try {
    const src = path.join(dir, 'src.mp4');
    await downloadFile(video_url, src);
    const out = path.join(dir, 'audio.mp3');
    await run('ffmpeg', ['-y', '-i', src, '-vn', '-c:a', 'libmp3lame', '-b:a', '64k', '-ac', '1', out]);
    const url = await uploadToSupabase(out, `editor/captions/${jobId}.mp3`, supabase_url, supabase_key);
    res.json({ ok: true, url });
  } catch (e) {
    console.error('[extract-audio]', e.message);
    res.status(500).json({ error: e.message });
  } finally {
    setTimeout(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }, 5000);
  }
});

app.post('/edit-v0', (req, res) => {
  const p = req.body || {};
  if (!p.video_url || !Array.isArray(p.clips) || p.clips.length === 0) {
    return res.status(400).json({ error: 'video_url e clips[] obrigatórios' });
  }
  if (!p.supabase_url || !p.supabase_key) {
    return res.status(400).json({ error: 'Faltam credenciais Supabase' });
  }
  const jobId = uuidv4();
  JOBS.set(jobId, { status: 'queued', progress: 0 });
  res.json({ ok: true, job_id: jobId });
  processEditV0(jobId, p).catch(e => {
    console.error('[edit-v0]', jobId, 'failed:', e.message);
    console.error('[bcg-fatal]', String(e.stack || '').replace(/\n/g, ' | ').slice(0, 600)); if (e.config) console.error('[bcg-axios]', e.config.url, e.response ? JSON.stringify(e.response.data).slice(0, 300) : ''); JOBS.set(jobId, { status: 'error', progress: 0, error: e.message });
  });
});

function escapeDrawText(s) {
  // FFmpeg drawtext exige escape de :' \ %
  return String(s || '')
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/%/g, '\\%');
}
function fontFile(fontName) {
  // Mapeia fonte do user pra TTF instalada no container
  const f = (fontName || '').toLowerCase();
  if (f.includes('bebas')) return '/usr/share/fonts/truetype/bt/BebasNeue-Regular.ttf';
  if (f.includes('oswald')) return '/usr/share/fonts/truetype/bt/Oswald-Bold.ttf';
  if (f.includes('inter')) return '/usr/share/fonts/truetype/bt/Anton-Regular.ttf'; // fallback
  return '/usr/share/fonts/truetype/bt/Anton-Regular.ttf';
}
function sizePct(size) {
  return ({ small: 0.04, medium: 0.06, large: 0.09, xlarge: 0.13 })[size] || 0.06;
}
function hexToFfmpeg(hex) {
  // FFmpeg cor: 0xRRGGBB
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '#ffffff');
  return '0x' + (m ? m[1] : 'ffffff');
}

async function processEditV0(jobId, p) {
  const dir = path.join('/tmp', jobId);
  fs.mkdirSync(dir, { recursive: true });
  const update = (status, progress, extra = {}) => {
    if (JOBS.get(jobId)?.status === 'cancelled') throw new Error('cancelled');
    JOBS.set(jobId, { status, progress, ...extra });
  };

  try {
    // 1. Download source video
    update('downloading', 5);
    const sourcePath = path.join(dir, 'source.mp4');
    await downloadFile(p.video_url, sourcePath);
    // 2. Audio extra (opcional)
    let audioExtraPath = null;
    if (p.audio_extra_url) {
      audioExtraPath = path.join(dir, 'audio_extra.mp3');
      try { await downloadFile(p.audio_extra_url, audioExtraPath); }
      catch (e) { console.log('[edit-v0] audio extra falhou, seguindo sem:', e.message); audioExtraPath = null; }
    }

    // 3. Trim cada clip
    update('trimming', 15);
    const clipFiles = [];
    for (let i = 0; i < p.clips.length; i++) {
      const c = p.clips[i];
      const out = path.join(dir, `clip_${i}.mp4`);
      const dur = (c.source_out - c.source_in);
      if (dur < 0.05) continue;
      // -ss antes do -i = fast seek (keyframe). Pra accuracy: -ss depois do -i (frame accurate, lento)
      // V0 usa fast seek + re-encode pra balance
      await run('ffmpeg', [
        '-y', '-ss', String(c.source_in), '-t', String(dur),
        '-i', sourcePath,
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
        '-c:a', 'aac', '-b:a', '128k',
        '-force_key_frames', 'expr:gte(t,0)',
        '-an', // pass1 sem audio (audio mux na fase final)
        out,
      ]);
      clipFiles.push({ path: out, duration: dur });
    }
    if (clipFiles.length === 0) throw new Error('Nenhum clip valido apos trim');

    // 4. Concat clips (sem transicoes complexas no V0 — cut simples)
    update('concatenating', 40);
    const concatPath = path.join(dir, 'concat.mp4');
    if (clipFiles.length === 1) {
      // Sem concat — só renomeia
      fs.renameSync(clipFiles[0].path, concatPath);
    } else {
      // Concat via demuxer. Paths RELATIVOS ao .txt (demuxer resolve assim) —
      // absolutos quebram no Windows (dev local) e relativos funcionam igual
      // no Linux porque clips e concat.txt vivem no mesmo dir.
      const listFile = path.join(dir, 'concat.txt');
      fs.writeFileSync(listFile, clipFiles.map(c => `file '${path.basename(c.path)}'`).join('\n'));
      await run('ffmpeg', [
        '-y', '-f', 'concat', '-safe', '0', '-i', listFile,
        '-c:v', 'copy', concatPath,
      ]);
    }

    // 5. Trilha de áudio v0 (fallback): so quando NAO ha audio_clips v2
    update('audio', 55);
    const hasAudioClipsV2 = Array.isArray(p.audio_clips) && p.audio_clips.length > 0;
    const audioClipFiles = [];
    if (!hasAudioClipsV2)
    for (let i = 0; i < p.clips.length; i++) {
      const c = p.clips[i];
      const out = path.join(dir, `audio_${i}.aac`);
      const dur = (c.source_out - c.source_in);
      if (dur < 0.05) continue;
      try {
        await run('ffmpeg', [
          '-y', '-ss', String(c.source_in), '-t', String(dur),
          '-i', sourcePath, '-vn', '-c:a', 'aac', '-b:a', '128k', out,
        ]);
        audioClipFiles.push(out);
      } catch(e) { /* video pode nao ter audio */ }
    }
    let sourceAudioPath = null;
    if (audioClipFiles.length === 1) {
      sourceAudioPath = audioClipFiles[0];
    } else if (audioClipFiles.length > 1) {
      const listA = path.join(dir, 'audio_concat.txt');
      fs.writeFileSync(listA, audioClipFiles.map(a => `file '${path.basename(a)}'`).join('\n'));
      sourceAudioPath = path.join(dir, 'source_audio.aac');
      try {
        await run('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', listA, '-c', 'copy', sourceAudioPath]);
      } catch(e) { sourceAudioPath = null; }
    }

    // 6. Pipeline final: scale+crop 1080×1920 + drawtext overlays + audio mix
    update('rendering', 70);
    const OUT_W = p.output_width || 1080;
    const OUT_H = p.output_height || 1920;
    const aspectStrategy = p.aspect_strategy || 'crop_center';
    // Filter de aspect
    let vf;
    if (aspectStrategy === 'letterbox') {
      vf = `scale=${OUT_W}:${OUT_H}:force_original_aspect_ratio=decrease,pad=${OUT_W}:${OUT_H}:(ow-iw)/2:(oh-ih)/2,setsar=1`;
    } else {
      vf = `scale=${OUT_W}:${OUT_H}:force_original_aspect_ratio=increase,crop=${OUT_W}:${OUT_H},setsar=1`;
    }
    const texts = p.texts || [];

    // Volumes
    const volV = p.volumes?.video ?? 1;
    const volA = p.volumes?.audio_extra ?? 1;
    const finalPath = path.join(dir, 'output.mp4');
    const args = ['-y', '-threads', '1'];
    args.push('-i', concatPath);                     // input 0: video base
    const fc = [];                                   // filter_complex parts
    let inputIdx = 1;

    // ── OVERLAYS v2: trim de cada camada (arquivo pronto pro chain) ──
    const overlays = Array.isArray(p.overlays) ? p.overlays : [];
    const ovInputs = [];
    for (let i = 0; i < overlays.length; i++) {
      const o = overlays[i];
      const dur = o.source_out - o.source_in;
      if (dur < 0.05) continue;
      const out = path.join(dir, `ov_${i}.mp4`);
      await run('ffmpeg', [
        '-y', '-ss', String(o.source_in), '-t', String(dur),
        '-i', sourcePath,
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-an', out,
      ]);
      ovInputs.push({ idx: inputIdx, o, file: out });
      args.push('-i', out);
      inputIdx++;
    }

    // ── COMPOSIÇÃO POR LANE (v3, CapCut): overlays E textos entram na MESMA
    // ordem de camadas — lane MAIOR aplica por ÚLTIMO = fica NA FRENTE.
    // Texto em lane menor que um overlay fica ATRÁS do vídeo dele (regra do
    // user). Retrocompat: payload sem lane → overlays lane 1, textos lane 4
    // (texto na frente, default CapCut).
    const ops = [
      ...ovInputs.map((ov) => ({ kind: 'ov', lane: Number(ov.o.lane) || 1, ov })),
      ...texts.map((t) => ({ kind: 'text', lane: Number(t.lane) || 4, t })),
    ].sort((a, b) => a.lane - b.lane);

    let vLabel = 'base0';
    fc.push(`[0:v]${vf}[${vLabel}]`);
    ops.forEach((op, k) => {
      const nextL = `base${k + 1}`;
      if (op.kind === 'ov') {
        const { idx, o } = op.ov;
        const dur = o.source_out - o.source_in;
        const scaled = `ovs${k}`;
        // escala relativa a LARGURA do output + posicao central em pct
        fc.push(`[${idx}:v]scale=${Math.round((p.output_width || 1080) * (o.scale ?? 0.5))}:-2,setpts=PTS-STARTPTS+${(o.start ?? 0).toFixed(3)}/TB[${scaled}]`);
        fc.push(`[${vLabel}][${scaled}]overlay=x=${Math.round((p.output_width || 1080) * (o.x_pct ?? 0.5))}-w/2:y=${Math.round((p.output_height || 1920) * (o.y_pct ?? 0.5))}-h/2:enable='between(t,${(o.start ?? 0).toFixed(3)},${((o.start ?? 0) + dur).toFixed(3)})'[${nextL}]`);
      } else {
        const t = op.t;
        const fs_px = Math.round(sizePct(t.size) * OUT_W);
        const x_px = `(w*${t.x_pct.toFixed(4)}-text_w/2)`;
        const y_px = `(h*${t.y_pct.toFixed(4)}-text_h/2)`;
        const txt = escapeDrawText(t.content || '');
        const enable = `between(t,${t.start_sec.toFixed(3)},${t.end_sec.toFixed(3)})`;
        fc.push(`[${vLabel}]drawtext=fontfile=${fontFile(t.font)}:text='${txt}':fontsize=${fs_px}:fontcolor=${hexToFfmpeg(t.color)}:borderw=${Math.max(2, Math.round(fs_px*0.06))}:bordercolor=0x000000:x=${x_px}:y=${y_px}:enable='${enable}'[${nextL}]`);
      }
      vLabel = nextL;
    });

    // ── AUDIO v2: mixer de audio_clips (posicao/trim/volume por clip) ──
    const audioClips = Array.isArray(p.audio_clips) ? p.audio_clips : [];
    const aLabels = [];
    if (hasAudioClipsV2) {
      for (let i = 0; i < audioClips.length; i++) {
        const a = audioClips[i];
        let mediaPath;
        if (a.kind === 'video') {
          mediaPath = sourcePath;
        } else {
          mediaPath = path.join(dir, `aud_${i}`);
          try { await downloadFile(a.url, mediaPath); }
          catch (e) { console.log('[edit-v0] audio clip download falhou, pulando:', e.message); continue; }
        }
        args.push('-i', mediaPath);
        const delayMs = Math.round((a.start ?? 0) * 1000);
        const lbl = `ac${i}`;
        fc.push(`[${inputIdx}:a]atrim=${(a.source_in ?? 0).toFixed(3)}:${a.source_out.toFixed(3)},asetpts=PTS-STARTPTS,volume=${(a.volume ?? 1).toFixed(2)},adelay=${delayMs}|${delayMs}[${lbl}]`);
        aLabels.push(lbl);
        inputIdx++;
      }
      // trilha do proprio video (se nao mudo) entra no mix tambem
      if (volV > 0.001) {
        fc.push(`[0:a]volume=${volV}[acv]`);
        aLabels.push('acv');
      }
    } else {
      // fallback v0: trilha source + audio extra fixo
      if (sourceAudioPath) { args.push('-i', sourceAudioPath); fc.push(`[${inputIdx}:a]volume=${volV}[a1]`); aLabels.push('a1'); inputIdx++; }
      if (audioExtraPath) { args.push('-i', audioExtraPath); fc.push(`[${inputIdx}:a]volume=${volA}[a2]`); aLabels.push('a2'); inputIdx++; }
    }

    if (aLabels.length > 1) {
      fc.push(`[${aLabels.map(l => l).join('][')}]amix=inputs=${aLabels.length}:duration=longest:dropout_transition=0[aout]`);
    } else if (aLabels.length === 1) {
      fc.push(`[${aLabels[0]}]anull[aout]`);
    }

    args.push('-filter_complex', fc.join(';'));
    args.push('-map', `[${vLabel}]`);
    if (aLabels.length) args.push('-map', '[aout]');
    args.push(
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
      '-c:a', 'aac', '-b:a', '128k',
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      '-shortest',
      finalPath,
    );
    await run('ffmpeg', args);

    // 7. Upload
    update('uploading', 92);
    const outputPath = `editor/v0/${jobId}/output.mp4`;
    const outputUrl = await uploadToSupabase(finalPath, outputPath, p.supabase_url, p.supabase_key);

    update('done', 100, { output_url: outputUrl });
    setTimeout(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch(e){} }, 60000);
  } catch (err) {
    if (err.message === 'cancelled') return;
    console.error('[edit-v0]', jobId, err.message, err.stack?.slice(0, 400));
    const detail = err.message || err.code || (err.stack ? err.stack.slice(0, 300) : String(err));
    JOBS.set(jobId, { status: 'error', progress: 0, error: detail });
    setTimeout(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch(e){} }, 10000);
  }
}

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
  'douyinvod.com', 'zjcdn.com', 'snssdk.com', 'douyin.com', 'bytecdn.cn', // Douyin CDNs
  'threads.net', 'threads.com', // Threads (mídia real sai em fbcdn/cdninstagram, já na lista)
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
    if (h.includes('douyin') || h.includes('zjcdn') || h.includes('snssdk') || h.includes('bytecdn')) return 'https://www.douyin.com/';
    if (h.includes('threads')) return 'https://www.threads.net/';
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
    ...POT_CLI_ARGS,
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

// DEBUG PO Token — diagnostica se o plugin carregou, se o config foi escrito
// e se o provider esta sendo alcancado. Captura yt-dlp -v COMPLETO.
app.get('/pot-debug', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const out = {};
  out.BGUTIL_POT_BASE_URL = process.env.BGUTIL_POT_BASE_URL || null;
  const cfgPath = '/root/.config/yt-dlp/config';
  out.config_exists = fs.existsSync(cfgPath);
  try { out.config_content = out.config_exists ? fs.readFileSync(cfgPath, 'utf8') : null; } catch (e) { out.config_content = 'err:' + e.message; }
  const pluginDir = '/root/.config/yt-dlp/plugins';
  try {
    const walk = (d, depth = 0) => {
      let r = []; if (depth > 5) return r;
      for (const f of fs.readdirSync(d)) {
        const p = path.join(d, f); r.push(p.replace(pluginDir, 'plugins'));
        try { if (fs.statSync(p).isDirectory()) r = r.concat(walk(p, depth + 1)); } catch {}
      }
      return r;
    };
    out.plugin_files = fs.existsSync(pluginDir) ? walk(pluginDir).slice(0, 80) : 'NO_PLUGIN_DIR';
  } catch (e) { out.plugin_files = 'err:' + e.message; }
  const testUrl = req.query.url || 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
  await new Promise((resolve) => {
    const p = spawn('yt-dlp', ['-v', ...POT_CLI_ARGS, '--skip-download', '--print', 'id', '--no-playlist', '--socket-timeout', '15', testUrl]);
    let so = '', se = '';
    p.stdout.on('data', d => so += d.toString());
    p.stderr.on('data', d => se += d.toString());
    p.on('error', e => { out.spawn_error = e.message; resolve(); });
    p.on('close', code => {
      out.exit_code = code;
      out.stdout = so.slice(0, 300);
      const lines = se.split('\n');
      out.plugin_pot_lines = lines.filter(l => /plugin|bgutil|pot|proof|origin|gvs/i.test(l)).slice(0, 40);
      out.stderr_head = se.slice(0, 1500);
      out.stderr_tail = se.slice(-1500);
      resolve();
    });
  });
  res.json(out);
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
      ...POT_CLI_ARGS,
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
        ...POT_CLI_ARGS,
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

// ── DOWNLOAD CHAIN PRA BLUELENS ────────────────────────────────────────────
// Replica blindagem do /youtube-process: 3 camadas de fallback resilientes
// a quebras de YouTube anti-bot, cookies expirados ou quedas de provedor.
// Retorna { file, source, attempts } ou throw 'all_providers_failed'.
//
// Camada A — Cobalt tunnel (~60% dos vídeos, sem cookies necessários)
// Camada B — chain /api/auth?action=download (RapidAPI + Piped/Invidious)
// Camada C — yt-dlp local com cookies + POT + player_clients tv_embedded etc
async function bluelensDownloadChain(youtubeUrl, dir, log) {
  const attempts = [];
  let inFile = null;
  let source = null;
  const candidateFile = path.join(dir, 'video.mp4');

  // ── A. Cobalt tunnel 720p ──────────────────────────────────────────────
  const cobaltUrl = process.env.COBALT_API_URL;
  if (cobaltUrl) {
    try {
      log('[chain-A] try cobalt tunnel');
      const cobaltHeaders = { Accept: 'application/json', 'Content-Type': 'application/json' };
      if (process.env.COBALT_API_KEY) cobaltHeaders.Authorization = 'Api-Key ' + process.env.COBALT_API_KEY;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 25000);
      const cr = await fetch(cobaltUrl, {
        method: 'POST', headers: cobaltHeaders,
        body: JSON.stringify({ url: youtubeUrl, videoQuality: '720' }),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      const cd = await cr.json().catch(() => ({}));
      if (cr.ok && cd.status === 'tunnel' && cd.url) {
        const dlCtrl = new AbortController();
        const dlTimer = setTimeout(() => dlCtrl.abort(), 90000);
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
              source = 'cobalt:tunnel:720';
              attempts.push({ layer: 'A', ok: true, size: fs.statSync(candidateFile).size });
              log('[chain-A] cobalt ok ' + fs.statSync(candidateFile).size);
            } else {
              attempts.push({ layer: 'A', ok: false, reason: 'small_or_missing' });
            }
          } else {
            attempts.push({ layer: 'A', ok: false, reason: 'dl_http_' + dlR.status });
          }
        } catch (e) {
          clearTimeout(dlTimer);
          attempts.push({ layer: 'A', ok: false, reason: 'dl_err:' + e.message.slice(0, 80) });
          log('[chain-A] cobalt dl err: ' + e.message);
        }
      } else {
        attempts.push({ layer: 'A', ok: false, reason: 'no_tunnel:' + (cd.status || cr.status) });
        log('[chain-A] cobalt no tunnel (status ' + (cd.status || cr.status) + ')');
      }
    } catch (e) {
      attempts.push({ layer: 'A', ok: false, reason: 'err:' + e.message.slice(0, 80) });
      log('[chain-A] cobalt err: ' + e.message);
    }
  } else {
    attempts.push({ layer: 'A', ok: false, reason: 'COBALT_API_URL_not_set' });
  }

  // ── B. Chain /api/auth?action=download (RapidAPI + Piped/Invidious) ────
  if (!inFile) {
    const SITE_URL = process.env.SITE_URL || 'https://bluetubeviral.com';
    try {
      log('[chain-B] try /api/auth download chain');
      const authCtrl = new AbortController();
      const authTimer = setTimeout(() => authCtrl.abort(), 40000);
      const authR = await fetch(
        `${SITE_URL}/api/auth?action=download&url=${encodeURIComponent(youtubeUrl)}`,
        { signal: authCtrl.signal }
      );
      clearTimeout(authTimer);
      const authD = await authR.json().catch(() => ({}));
      if (authR.ok && authD.url && authD.provider !== 'hq-failed') {
        let chainUrl = authD.url;
        if (chainUrl.includes('/proxy-download?') && !chainUrl.includes('yt_url=')) {
          chainUrl += '&yt_url=' + encodeURIComponent(youtubeUrl);
        }
        const dlCtrl = new AbortController();
        const dlTimer = setTimeout(() => dlCtrl.abort(), 90000);
        try {
          const dlR = await fetch(chainUrl, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
              Accept: '*/*',
            },
            signal: dlCtrl.signal,
          });
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
              source = 'chain:auth:' + (authD.provider || 'unknown');
              attempts.push({ layer: 'B', ok: true, provider: authD.provider, size: fs.statSync(candidateFile).size });
              log('[chain-B] chain ok ' + fs.statSync(candidateFile).size + ' via ' + authD.provider);
            } else {
              attempts.push({ layer: 'B', ok: false, reason: 'small_or_missing' });
            }
          } else {
            attempts.push({ layer: 'B', ok: false, reason: 'dl_http_' + dlR.status });
            log('[chain-B] chain dl ' + dlR.status);
          }
        } catch (e) {
          clearTimeout(dlTimer);
          attempts.push({ layer: 'B', ok: false, reason: 'dl_err:' + e.message.slice(0, 80) });
          log('[chain-B] chain dl err: ' + e.message);
        }
      } else {
        attempts.push({ layer: 'B', ok: false, reason: 'no_url:' + (authD.error || authD.provider || 'unknown') });
        log('[chain-B] chain no url');
      }
    } catch (e) {
      attempts.push({ layer: 'B', ok: false, reason: 'err:' + e.message.slice(0, 80) });
      log('[chain-B] chain err: ' + e.message);
    }
  }

  // ── C. yt-dlp local com cookies + POT + player_clients alternativos ────
  // Mesmo padrão do /youtube-process e ytdlpFallbackStream. Cookies do
  // YOUTUBE_COOKIES env var permitem auth em IP datacenter; player_clients
  // tv_embedded/android_vr/android_testsuite/ios fugem do bot-check default.
  if (!inFile) {
    try {
      log('[chain-C] try yt-dlp local with cookies');
      const jobCookies = writeJobCookies(dir);
      if (!jobCookies) {
        attempts.push({ layer: 'C', ok: false, reason: 'no_cookies_env' });
        log('[chain-C] YOUTUBE_COOKIES env ausente — pulando yt-dlp');
      } else {
        const ytArgs = [
          ...POT_CLI_ARGS,
          '--cookies', jobCookies,
          '-f', 'best[ext=mp4][height<=720]/best[height<=720]/best',
          '--merge-output-format', 'mp4',
          '--no-playlist',
          '--no-warnings',
          '--no-check-certificate',
          '--force-ipv4',
          '--socket-timeout', '30',
          '--extractor-args', 'youtube:player_client=tv_embedded,android_vr,android_testsuite,ios',
          '-o', candidateFile,
          youtubeUrl,
        ];
        try {
          await run('yt-dlp', ytArgs);
          if (fs.existsSync(candidateFile) && fs.statSync(candidateFile).size > 100000) {
            inFile = candidateFile;
            source = 'yt-dlp:cookies';
            attempts.push({ layer: 'C', ok: true, size: fs.statSync(candidateFile).size });
            log('[chain-C] yt-dlp ok ' + fs.statSync(candidateFile).size);
          } else {
            attempts.push({ layer: 'C', ok: false, reason: 'small_or_missing' });
            log('[chain-C] yt-dlp empty output');
          }
        } catch (e) {
          const msg = (e.message || '').slice(0, 200);
          const isBot = /Sign in to confirm|not a bot|--cookies-from-browser/i.test(msg);
          attempts.push({ layer: 'C', ok: false, reason: (isBot ? 'bot_check:' : 'err:') + msg.slice(0, 120) });
          log('[chain-C] yt-dlp err: ' + msg);
        }
      }
    } catch (e) {
      attempts.push({ layer: 'C', ok: false, reason: 'outer_err:' + e.message.slice(0, 80) });
    }
  }

  if (!inFile) {
    const err = new Error('all_providers_failed');
    err.attempts = attempts;
    throw err;
  }

  return { file: inFile, source, attempts };
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
  const log = (m) => console.log('[extract-fingerprint]', jobId, m);
  let downloadAttempts = [];
  let downloadSource = null;

  try {
    // 1. Download via chain de 3 camadas (Cobalt → /api/auth chain → yt-dlp+cookies)
    try {
      const result = await bluelensDownloadChain(url, workDir, log);
      downloadAttempts = result.attempts;
      downloadSource = result.source;
      // chain pode escrever em videoPath OU em outro nome — normaliza
      if (result.file !== videoPath) {
        if (fs.existsSync(result.file)) fs.renameSync(result.file, videoPath);
      }
    } catch (downloadErr) {
      console.error('[extract-fingerprint]', jobId, 'all_providers_failed', JSON.stringify(downloadErr.attempts || []));
      return res.status(500).json({
        error: 'all_providers_failed',
        detail: 'Cobalt + /api/auth chain + yt-dlp+cookies todos falharam pra esse vídeo',
        attempts: downloadErr.attempts || [],
      });
    }

    // Trim post-download (independente da source) — economiza ffmpeg de
    // baixar 30min de vídeo se algum provider não respeitou max_seconds
    if (max_seconds && fs.existsSync(videoPath)) {
      const trimPath = videoPath + '.trim.mp4';
      try {
        await new Promise((resolve) => {
          const p = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-i', videoPath, '-t', String(max_seconds), '-c', 'copy', trimPath]);
          let stderr = '';
          p.stderr.on('data', d => { stderr += d.toString(); });
          p.on('close', code => { if (code === 0) resolve(); else { log('trim non-zero ' + code + ': ' + stderr.slice(0, 120)); resolve(); } });
          p.on('error', () => resolve());
        });
        if (fs.existsSync(trimPath) && fs.statSync(trimPath).size > 1000) {
          fs.renameSync(trimPath, videoPath);
        }
      } catch (_) {}
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
      download_source: downloadSource,
      download_attempts: downloadAttempts,
    });
  } catch (e) {
    console.error('[extract-fingerprint]', jobId, e.message);
    return res.status(500).json({
      error: e.message,
      download_source: downloadSource,
      download_attempts: downloadAttempts,
    });
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

  const snapchat_url = (req.body || {}).snapchat_url || (req.body || {}).url;
  if (!snapchat_url || typeof snapchat_url !== 'string') {
    return res.status(400).json({ error: 'url required' });
  }
  // Whitelist alinhada com baixa-generic.js (defesa em profundidade contra
  // SSRF). 2026-07-16: ampliada pra Threads e Douyin — yt-dlp tem extractor
  // pros dois; o endpoint sempre foi genérico, só o gate era snapchat-only.
  const OK_HOSTS = ['snapchat.com', 'threads.net', 'threads.com', 'douyin.com', 'iesdouyin.com'];
  let hostOk = false;
  try {
    const host = new URL(snapchat_url).hostname.replace(/^www\./, '');
    hostOk = OK_HOSTS.some((h) => host === h || host.endsWith('.' + h));
  } catch (_) {}
  if (!hostOk) return res.status(400).json({ error: 'host_nao_suportado' });

  // Douyin: yt-dlp exige cookies "frescos" (anônimos servem — ttwid etc).
  // Buscamos na hora do próprio douyin.com e escrevemos um cookies.txt por job.
  let extraArgs = [], cookieDir = null;
  const isDouyin = /(^|\.)((ies)?douyin\.com)$/.test(new URL(snapchat_url).hostname.replace(/^www\./, ''));
  if (isDouyin) {
    try {
      cookieDir = path.join('/tmp', 'dycookies-' + uuidv4());
      fs.mkdirSync(cookieDir, { recursive: true });
      const cr = await axios.get('https://www.douyin.com/', {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36' },
        maxRedirects: 3, timeout: 10000, validateStatus: () => true,
      });
      const setC = cr.headers['set-cookie'] || [];
      const exp = String(Math.floor(Date.now() / 1000) + 86400);
      const lines = ['# Netscape HTTP Cookie File'];
      for (const c of setC) {
        const pair = c.split(';')[0]; const eq = pair.indexOf('=');
        if (eq < 1) continue;
        lines.push(['.douyin.com', 'TRUE', '/', 'TRUE', exp, pair.slice(0, eq).trim(), pair.slice(eq + 1).trim()].join('\t'));
      }
      if (lines.length > 1) {
        const cf = path.join(cookieDir, 'douyin_cookies.txt');
        fs.writeFileSync(cf, lines.join('\n'));
        extraArgs = ['--cookies', cf];
        console.log('[snapchat-extract] cookies douyin frescos:', lines.length - 1);
      }
    } catch (e) { console.warn('[snapchat-extract] cookies douyin falharam:', e.message); }
  }
  const cleanupCookies = () => { if (cookieDir) setTimeout(() => { try { fs.rmSync(cookieDir, { recursive: true, force: true }); } catch {} }, 2000); };

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
      ...extraArgs,
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

    cleanupCookies();
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
    cleanupCookies();
    console.error('[snapchat-extract]', e.message);
    return res.status(500).json({ error: 'extract_failed', detail: e.message.slice(0, 300) });
  }
});

app.listen(PORT, () => {
  console.log(`[bluetube-ffmpeg] listening on :${PORT}`);
  // Roda em background pra nao atrasar health check do Railway
  setTimeout(autoUpdateYtdlp, 2000);
});
