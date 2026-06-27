# BlueEditor V0 — Documentação interna

Editor de vídeo client-side com pipeline server-side de export. Construído com vanilla JS, zero dependências externas pagas.

## Arquitetura

```
┌─────────────────────────────────────────────────────────────┐
│  BROWSER (vanilla JS + Canvas 2D + Web Audio + WebCodecs?)  │
│                                                              │
│  state.js  ──────  pub/sub + autosave + sessionStorage     │
│   ▲                                                          │
│   ├─ history.js   Command Pattern undo/redo (stack 100)     │
│   ├─ clips.js     split/delete/move/toggleActive            │
│   ├─ upload.js    drag-drop + validação + signed URL XHR    │
│   ├─ player.js    HTML5 video + transport + keyboard        │
│   ├─ thumbnails.js  N frames via canvas + ImageBitmap       │
│   ├─ timeline.js  canvas 2D + handles + waveform + clips    │
│   ├─ text.js      overlay canvas WYSIWYG + drag             │
│   ├─ audio.js     <audio> sync + volume mix                 │
│   └─ editor.js    orquestra tudo + tabs + modais + export   │
└─────────────────────────────────────────────────────────────┘
                          │
                          │ POST /api/blue-editor action=save-project (debounced 2s)
                          │ POST /api/blue-editor action=edit-v0 (no Exportar)
                          ▼
┌─────────────────────────────────────────────────────────────┐
│  VERCEL (api/blue-editor.js)                                │
│  ├─ save-project / load-project / list / delete             │
│  ├─ edit-v0 — valida + envia pro Railway                    │
│  ├─ status-v0 — polling progresso                           │
│  └─ cancel-v0 — aborta render                               │
└─────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│  RAILWAY (railway-ffmpeg/server.js endpoint /edit-v0)       │
│  1. Download source + audio extra                           │
│  2. Trim cada clip (-ss -t + re-encode + key frames)        │
│  3. Concat via demuxer                                       │
│  4. Extrair + concat áudio source                           │
│  5. scale+crop 1080×1920 + drawtext overlays                │
│  6. amix vídeo + audio extra com volumes                    │
│  7. Upload Supabase blue-videos/editor/v0/{jobId}/output.mp4│
└─────────────────────────────────────────────────────────────┘
```

## Schema state (versão 1)

```js
{
  version: 1,
  project_id: uuid | null,
  nome_projeto: string,
  video: { url, path, filename, duration, width, height, aspect, size_bytes },
  trim: { in: sec, out: sec },                  // bounds globais (handles externos)
  clips: [{ id, source_in, source_out, active }], // se vazio, usa virtual do trim
  next_clip_id: int,
  selected_clip_id: int | null,
  texts: [{ id, content, font, color, size, x_pct, y_pct, start_sec, end_sec, active }],
  audio_extra: { url, path, filename, duration, size_bytes } | null,
  transitions: [{ between: clipIdx, type: 'cut'|'fade'|'crossfade', duration }],
  style_id: int | null,
  volumes: { video: 0-2, audio_extra: 0-2 },
  aspect_strategy: 'crop_center' | 'letterbox',
  created_at, updated_at,
}
```

## Shortcuts (CapCut-compatível)

| Tecla | Ação |
|---|---|
| `Ctrl + B` | Split no playhead |
| `Q` | Delete left of playhead |
| `W` | Delete right of playhead |
| `V` | Toggle clip active |
| `I` / `O` | Set In/Out point |
| `Space` | Play/Pause |
| `J` / `K` / `L` | Shuttle |
| `←` / `→` | Frame (Shift = 10 frames) |
| `↑` / `↓` | Cut point prev/next |
| `Home` / `End` | Início/fim |
| `Ctrl + +/-` | Zoom timeline |
| `Shift + Z` | Zoom to fit |
| `Shift + X` / `Alt + X` | Select/Deselect clip |
| `Delete` / `Backspace` | Excluir clip selecionado |
| `Ctrl + Z` / `Ctrl + Shift + Z` | Undo/Redo |

## Troubleshooting

| Erro no console | Causa | Fix |
|---|---|---|
| `[timeline waveform] unavailable fetch failed` | CORS Supabase Storage | Habilitar CORS no bucket `blue-videos` |
| `[timeline waveform] unavailable AudioContext` | Browser antigo | Usar Chrome/Edge/Safari 14+ |
| `[BEState] sem login` | Token expirado | Recarregar página + relogar |
| Autosave `retry N/5 em Xs` | Backend instável | Aguarda backoff exponencial automático |
| `[thumbnails] too many failures` | Codec do MP4 sem suporte canvas | Browser não consegue extrair frames (raro) |
| `Railway timeout (3min)` | Vídeo muito grande / Railway sobrecarregado | Reduzir duração ou retry depois |

## Endpoints backend

- `POST /api/blue-editor` actions:
  - `save-project`, `load-project`, `list-projects`, `delete-project`
  - `edit-v0` — inicia export (precisa Railway)
  - `status-v0` — polling com auto-update de `editor_jobs.status`
  - `cancel-v0` — kill job no Railway

- `POST /api/editor-flag` (publico) — feature flag `EDITOR_V0_ENABLED`

## Pendências conhecidas (V1+)

- [ ] Multi-track (camadas) — modelo 2D clips × tracks
- [ ] Magnetic snap entre clips (visual + threshold de proximidade)
- [ ] Drag-up cria nova camada de áudio
- [ ] Transições FFmpeg reais (atualmente Cut apenas no render — fade/cross-fade UI cadastra mas backend não aplica ainda)
- [ ] Speed control (0.5x-2x)
- [ ] Stickers / emojis
- [ ] Filtros / color grading
- [ ] Croma key
- [ ] Auto-legenda Whisper (opcional)
- [ ] Estilos pré-prontos (tab Estilo)

## Smoke test

```bash
BASE="https://bluetube-git-blueeditor-v0-shaddershorts-commits-projects.vercel.app"
curl -sS "$BASE/blueEditor-app" -o /dev/null -w "HTML: %{http_code}\n"
for js in state history clips upload player thumbnails timeline text audio editor; do
  echo "$js.js: $(curl -sS -o /dev/null -w '%{http_code}' "$BASE/editor-app/$js.js")"
done
curl -sS -X POST "$BASE/api/blue-editor" -H "Content-Type: application/json" \
  -d '{"action":"save-project"}' -w "\nsave sem token: %{http_code}\n"
```

Esperado: HTML 200, todos .js 200, save sem token 401.
