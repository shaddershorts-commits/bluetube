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
    p.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} exited ${code}: ${stderr.slice(-800)}`));
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

// Monta o arquivo ASS de legendas estilo karaoke word-by-word
function buildAssSubtitles(words, estilo) {
  const fonte = estilo.legenda_fonte || 'Arial Black';
  const tamanho = estilo.legenda_tamanho || 72;
  const corAtiva = hexToAssColor(estilo.legenda_cor_ativa || '#FFFF00');
  const corNormal = hexToAssColor(estilo.legenda_cor_normal || '#FFFFFF');
  const corFundo = '&H99000000'; // preto 60%
  const corOutline = '&H00000000';
  // MarginV calculado a partir da posição escolhida (960 = centro vertical em 1920px)
  const pos = estilo.legenda_posicao || 'centro';
  const marginV = pos === 'centro-baixo' ? 400 : pos === 'baixo' ? 200 : 960;

  const header = `[Script Info]
Title: BlueEditor
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Normal,${fonte},${tamanho},${corNormal},${corNormal},${corOutline},${corFundo},1,0,0,0,100,100,0,0,3,4,2,5,60,60,${marginV},1
Style: Active,${fonte},${tamanho},${corAtiva},${corAtiva},${corOutline},${corFundo},1,0,0,0,100,100,0,0,3,4,2,5,60,60,${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const events = [];
  for (const w of words || []) {
    const text = (w.word || '').trim().replace(/[{}\\]/g, '');
    if (!text) continue;
    const start = fmtAssTime(w.start);
    const end = fmtAssTime(Math.max(w.end, w.start + 0.1));
    // Uppercase pro estilo Shorts
    const display = text.toUpperCase();
    events.push(`Dialogue: 0,${start},${end},Active,,0,0,0,,${display}`);
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

// Segmenta vídeo-fonte em pedaços de cortIntervalo seg, looping se necessário
async function buildSegments(dir, videoDur, audioDur, estilo) {
  const cortIntervalo = Math.max(0.8, Math.min(4.0, parseFloat(estilo.corte_intervalo) || 1.8));
  const numSegments = Math.ceil(audioDur / cortIntervalo);
  const segmentsDir = path.join(dir, 'segments');
  fs.mkdirSync(segmentsDir, { recursive: true });

  const concatList = [];
  for (let i = 0; i < numSegments; i++) {
    // Loop o vídeo-fonte se a narração for mais longa
    const srcStart = (i * cortIntervalo) % Math.max(1, videoDur - cortIntervalo);
    const outFile = path.join(segmentsDir, `s${i}.mp4`);
    await run('ffmpeg', [
      '-y', '-ss', String(srcStart), '-t', String(cortIntervalo),
      '-i', path.join(dir, 'input.mp4'),
      '-vf', 'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1',
      '-an',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23',
      outFile
    ]);
    concatList.push(`file '${outFile}'`);
  }

  const listFile = path.join(dir, 'concat.txt');
  fs.writeFileSync(listFile, concatList.join('\n'));
  return listFile;
}

// Concatena segmentos num único concat.mp4
async function concatSegments(dir, listFile) {
  await run('ffmpeg', [
    '-y', '-f', 'concat', '-safe', '0', '-i', listFile,
    '-c', 'copy',
    path.join(dir, 'concat.mp4')
  ]);
}

// Render final: legendas ASS + zoompan + mux áudio + trim pela duração da narração
async function finalRender(dir, estilo, hasMusic, audioDur) {
  const zoomInt = Math.max(0, Math.min(0.5, parseFloat(estilo.zoom_intensidade) || 0.1));
  // zoompan aplica efeito contínuo leve (breathing effect) — simula zoom em impacto
  // zoom: 1.0 + intensidade oscilando ao longo de 4 segundos
  const vf = `ass=${path.join(dir, 'subs.ass').replace(/\\/g, '/').replace(/:/g, '\\:')},zoompan=z='min(zoom+${(zoomInt / 80).toFixed(5)},${(1 + zoomInt).toFixed(3)})':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1080x1920:fps=30`;

  const args = [
    '-y',
    '-i', path.join(dir, 'concat.mp4'),
    '-i', path.join(dir, 'narration.mp3'),
  ];

  if (hasMusic) {
    args.push('-i', path.join(dir, 'music.mp3'));
  }

  // Filter complex: video → ass+zoom; audio → mix narration + music (se houver)
  const musicVol = typeof estilo.musica_volume === 'number' ? estilo.musica_volume : 0.18;
  const filterComplex = hasMusic
    ? `[0:v]${vf}[v];[1:a]volume=1.0[a1];[2:a]volume=${musicVol}[a2];[a1][a2]amix=inputs=2:duration=first:dropout_transition=0[a]`
    : `[0:v]${vf}[v];[1:a]volume=1.0[a]`;

  args.push(
    '-filter_complex', filterComplex,
    '-map', '[v]', '-map', '[a]',
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
    '-c:a', 'aac', '-b:a', '192k',
    '-t', String(audioDur),
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

    update('segmenting', 40);
    const listFile = await buildSegments(dir, videoDur, audioDur, opts.estilo);

    update('concatenating', 60);
    await concatSegments(dir, listFile);

    update('rendering', 75);
    const hasMusic = opts.musica_url && fs.existsSync(path.join(dir, 'music.mp3'));
    await finalRender(dir, opts.estilo, hasMusic, audioDur);

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

app.listen(PORT, () => {
  console.log(`[bluetube-ffmpeg] listening on :${PORT}`);
});
