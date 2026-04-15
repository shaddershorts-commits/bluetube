# BlueTube FFmpeg Pipeline (Railway)

Serviço Node/FFmpeg que renderiza o pipeline do BlueEditor no servidor.

## Deploy no Railway

1. No Railway, **New Project → Deploy from GitHub repo** → selecione `shaddershorts-commits/bluetube`
2. Em **Settings → Root Directory**, defina: `railway-ffmpeg`
3. Em **Settings → Build → Builder**, escolha `Dockerfile`
4. Adicione **Variables**:
   - `SUPABASE_URL` — mesma do projeto Vercel
   - `SUPABASE_SERVICE_KEY` — mesma do projeto Vercel
   - `PORT` = `3000` (opcional, default)
5. Deploy. Depois copie o domínio público gerado (ex: `bluetube-ffmpeg-production.up.railway.app`).
6. No Vercel do bluetube, adicione:
   - `RAILWAY_FFMPEG_URL` = `https://bluetube-ffmpeg-production.up.railway.app`

## Endpoints

### `GET /health`
Verifica se o serviço está ativo.

```json
{ "ok": true, "ffmpeg": "7.x.x", "jobs_in_memory": 0 }
```

### `POST /process`
Inicia um job de renderização. Retorna imediatamente com `job_id` e processa async.

**Body:**
```json
{
  "video_url": "https://.../input.mp4",
  "audio_url": "https://.../narration.mp3",
  "words": [{"word":"Olá","start":0.0,"end":0.3}, ...],
  "estilo": {
    "corte_intervalo": 1.5,
    "zoom_intensidade": 0.15,
    "legenda_fonte": "Arial Black",
    "legenda_tamanho": 72,
    "legenda_cor_ativa": "#FF4444",
    "legenda_cor_normal": "#FFFFFF"
  },
  "musica_url": "https://.../music.mp3",
  "supabase_url": "https://xxx.supabase.co",
  "supabase_key": "service_key",
  "output_path": "editor/{jobId}/output.mp4"
}
```

**Response:**
```json
{ "ok": true, "job_id": "abc-123..." }
```

### `GET /status/:jobId`
Retorna status do job em memória.

```json
{ "status": "rendering", "progress": 70 }
```

Quando concluído:
```json
{ "status": "done", "progress": 100, "output_url": "https://...supabase.co/.../output.mp4" }
```

Erros:
```json
{ "status": "error", "error": "ffmpeg failed: ..." }
```

## Pipeline (etapas)

1. **Download** — baixa `video_url`, `audio_url` e `musica_url` (se houver) para `/tmp/{jobId}/`
2. **Probe** — lê duração do vídeo-fonte e da narração via `ffprobe`
3. **Legendas ASS** — gera `subs.ass` com timestamp word-level vindo do Whisper
4. **Segmentação** — corta o vídeo-fonte em pedaços de `corte_intervalo` segundos, loopando se o vídeo for mais curto que a narração
5. **Concat** — concatena os segmentos em `concat.mp4` (1080x1920 vertical)
6. **Render final** — aplica legendas ASS + zoompan + muxa narração + música de fundo (mix de 100%/20%) + trunca pela duração da narração
7. **Upload** — envia `output.mp4` pro Supabase Storage via REST
8. **Cleanup** — apaga `/tmp/{jobId}/` após 60s

## Limitações v1 (TODO)

- [ ] Overlay de setas vermelhas nos gatilhos (IMPRESSIONANTE, INCRÍVEL, etc)
- [ ] Zoom keyframed nos momentos de impacto (hoje aplica zoompan estático via estilo)
- [ ] Transições entre segmentos (hoje é corte seco)
- [ ] Job persistence além da memória (hoje perde jobs se o container reiniciar)
