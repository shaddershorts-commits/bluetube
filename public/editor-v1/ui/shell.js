// editor-v1/ui/shell.js
// Monta a UI no layout CapCut: preview central + painel de propriedades
// CONTEXTUAL a direita (muda com a selecao) + timeline multi-track embaixo
// com cabecalhos de track. Store continua a unica fonte de verdade.

import * as act from '../core/actions.js';
import { totalDuration, canExport, timelineSegments, captionAudioPlan, mainTrackItems } from '../core/selectors.js';
import { TEXT_FONTS, TEXT_SIZES } from '../core/schema.js';
import { formatTime, METRICS } from '../timeline/layout.js';
import { createPlayer } from '../preview/player.js';
import { createOverlay } from '../preview/overlay.js';
import { createPip } from '../preview/pip.js';
import { createTimelineController } from './timeline-controller.js';
import { attachShortcuts, splitSelectedAt } from './shortcuts.js';
import { createThumbnails } from '../timeline/thumbnails.js';
import { createWaveform } from '../timeline/waveform.js';
import { uploadMedia } from '../services/upload.js';
import { createAutosave } from '../services/autosave.js';
import { createExporter } from '../services/exporter.js';
import { api } from '../services/api.js';
import { attachResizers } from './resizer.js';

export function mountEditor(root, store) {
  root.innerHTML = buildTemplate();
  const $ = (sel) => root.querySelector(sel);

  const videoEl = $('#beVideo');
  const videoEl2 = $('#beVideo2');
  // primaryUrl: o player troca o src por take (multi-midia); pro PRINCIPAL a
  // url preferida e o objectURL local (instantaneo, pre-CDN) quando existir
  const player = createPlayer(videoEl, {
    bufferEl: videoEl2,  // double-buffer: pré-carrega o próximo take (sem tela preta)
    primaryUrl: () => {
      const v = store.getState().video;
      if (!v) return null;
      return (localPreview.for === v.url && localPreview.url) ? localPreview.url : v.url;
    },
  }, store);
  const timeline = createTimelineController({
    canvas: $('#beTimeline'),
    store, player,
    onEditText: openTextPanel,
    onOpenCompound: enterCompound,
  });
  const overlay = createOverlay($('#beOverlay'), store, player, openTextPanel);
  const pip = createPip($('#beOverlay').parentElement, videoEl, store, player);
  const exporter = createExporter(store);
  const autosave = createAutosave(store, (s, detail) => {
    const el = $('#beSaveStatus');
    el.textContent = s === 'saving' ? '◌ salvando…' : s === 'saved' ? '✓ salvo' : s === 'error' ? '⚠ ' + (detail || 'erro ao salvar') : '';
    el.className = 'be-save-status ' + s;
  });
  const detachShortcuts = attachShortcuts({ store, player, timeline });

  // thumbnails/waveforms vivem em registries POR FONTE (ver setupThumbsAndWave)
  // preview local do arquivo recem-enviado (playback instantaneo pre-CDN)
  const localPreview = { url: null, for: null };
  let captionsPanelOpen = false; // painel 💬 Legendas (escolher estilo antes)
  let capChosenPreset = 'classico'; // estilo escolhido pra aplicar ao gerar
  let audioLibOpen = false;      // painel ♪ Áudio (biblioteca)
  let audioLibTab = 'musicas';   // musicas | efeitos | favoritos
  let audioLibQuery = '';
  let filledClipId = null;    // guard: não sobrescreve sliders enquanto arrasta
  let filledAudioId = null;
  let filledOvId = null;
  // mapeamento log do slider de velocidade: value -100..200 -> 0.10x..100x,
  // 0 = 1.00x (controle fino perto de 1x)
  const sliderToSpeed = (v) => Math.min(100, Math.max(0.1, Math.pow(10, v / 100)));
  const speedToSlider = (s) => Math.round(Math.log10(s > 0 ? s : 1) * 100);
  const fmtSpeed = (s) => s.toFixed(2) + 'x';

  // ── expose pra E2E (fora de producao) ──
  if (location.hostname !== 'www.bluetubeviral.com' && location.hostname !== 'bluetubeviral.com') {
    window.__BE__ = { store, player, timeline, getState: () => store.getState() };
  }

  // ── reatividade da UI ──
  function sync() {
    const state = store.getState();
    const has = !!state.video;
    $('#beDrop').style.display = has ? 'none' : 'flex';
    $('#beWorkspace').style.display = has ? 'grid' : 'none';
    $('#beProjectName').value = state.nome_projeto || '';
    $('#beTimeLabel').textContent = `${formatTime(player.getTime())} / ${formatTime(totalDuration(state))}`;
    $('#bePlayBtn').textContent = player.isPlaying() ? '⏸' : '▶';
    $('#beUndo').disabled = !store.canUndo();
    $('#beRedo').disabled = !store.canRedo();
    $('#beExportBtn').disabled = !canExport(state);
    $('#beVolVideo').value = state.volumes.video;
    $('#beAudioCount').textContent = state.audio_clips.length
      ? state.audio_clips.length + ' áudio(s) na timeline'
      : 'Nenhum áudio adicional';
    $('#beAspect').value = state.aspect_strategy;
    // WYSIWYG do formato: letterbox = video inteiro com barras (contain).
    // aplica nos DOIS elementos do double-buffer.
    const fit = state.aspect_strategy === 'letterbox' ? 'contain' : 'cover';
    videoEl.style.objectFit = fit; videoEl2.style.objectFit = fit;
    videoEl.muted = !!state.audio_detached;
    // video source: usa preview local (objectURL) quando disponivel —
    // instantaneo e imune a atraso de propagacao do CDN
    if (has) {
      // url preferida do video PRINCIPAL (blob local > CDN) — pip/player leem
      videoEl.dataset.primaryChoice = (localPreview.for === state.video.url && localPreview.url)
        ? localPreview.url : state.video.url;
    }
    if (has && videoEl.dataset.src !== state.video.url) {
      videoEl.dataset.src = state.video.url;
      videoEl.src = videoEl.dataset.primaryChoice;
      videoEl.load();
      setupThumbsAndWave(state);
    }
    // takes importados depois: garante miniatura+waveform deles (idempotente)
    if (has) syncMediaRegistries(state);

    renderTransitionsRow(state);
    syncPropsPanel(state);
    applyClipTransform();
    $('#beCapStyleRow').style.display = state.texts.some(t => t.caption) ? 'flex' : 'none';
  }
  store.subscribe(sync);
  player.onUpdate(() => {
    const state = store.getState();
    $('#beTimeLabel').textContent = `${formatTime(player.getTime())} / ${formatTime(totalDuration(state))}`;
    $('#bePlayBtn').textContent = player.isPlaying() ? '⏸' : '▶';
    if (player.isPlaying()) timeline.followPlayhead();
    applyClipTransform();
  });

  // WYSIWYG da aba Vídeo > Básico: aplica escala + opacidade da cena SOB o
  // playhead no <video> do preview (compound = transform do bloco inteiro).
  function applyClipTransform() {
    const state = store.getState();
    const t = player.getTime();
    const it = mainTrackItems(state).find(x => t >= x.tStart && t < x.tEnd);
    const clip = it?.clip;
    const scale = clip?.scale ?? 1;
    const opacity = clip?.opacity ?? 1;
    const sx = clip?.mirrored ? -scale : scale;   // Espelhar = inverte no eixo X
    const tf = (scale !== 1 || clip?.mirrored) ? `scale(${sx}, ${scale})` : '';
    // aplica no elemento ATIVO do double-buffer (pode ter trocado no swap)
    const el = player.getDisplayEl ? player.getDisplayEl() : videoEl;
    if (el.style.transform !== tf) el.style.transform = tf;
    const op = String(opacity);
    if (el.style.opacity !== op) el.style.opacity = op;
  }

  // ── painel de propriedades CONTEXTUAL (estilo CapCut) ──
  // nada selecionado -> propriedades do projeto
  // clip selecionado -> acoes do clip | texto selecionado -> editor de texto
  function syncPropsPanel(state) {
    const showText = state.selected_text_id != null;
    const showOv = !showText && state.selected_overlay_id != null;
    const showAudio = !showText && !showOv && state.selected_audio_id != null;
    const showClip = !showText && !showOv && !showAudio && state.selected_clip_id != null;
    const nadaSel = !showText && !showOv && !showAudio && !showClip;
    const showCaptions = captionsPanelOpen && nadaSel;
    const showAudioLib = audioLibOpen && nadaSel && !showCaptions;
    $('#beTextPanel').style.display = showText ? 'flex' : 'none';
    $('#bePropsAudio').style.display = showAudio ? 'flex' : 'none';
    $('#bePropsOverlay').style.display = showOv ? 'flex' : 'none';
    $('#bePropsClip').style.display = showClip ? 'flex' : 'none';
    $('#bePropsCaptions').style.display = showCaptions ? 'flex' : 'none';
    $('#bePropsAudioLib').style.display = showAudioLib ? 'flex' : 'none';
    $('#bePropsProject').style.display = (nadaSel && !showCaptions && !showAudioLib) ? 'flex' : 'none';
    if (showAudioLib) renderAudioLib();
    renderMediaPanel(); // biblioteca (coluna 1) sempre atualizada
    if (showText) fillTextPanel(state);
    if (showAudio) {
      const ac = state.audio_clips.find(a => a.id === state.selected_audio_id);
      if (ac) {
        $('#beAudioPanelTitle').textContent = '♪ ' + (ac.filename || 'áudio');
        $('#beVolSelected').value = ac.volume ?? 1;
        $('#beAudioClipDur').textContent = (ac.source_out - ac.source_in).toFixed(1) + 's';
        if (filledAudioId !== ac.id) {
          filledAudioId = ac.id;
          const sp = ac.speed ?? 1;
          $('#beAudioSpeed').value = speedToSlider(sp); $('#beAudioSpeedVal').textContent = fmtSpeed(sp);
        }
      }
    } else { filledAudioId = null; }
    if (showOv) {
      const ov = state.overlays.find(o => o.id === state.selected_overlay_id);
      if (ov && filledOvId !== ov.id) {
        filledOvId = ov.id;
        const sp = ov.speed ?? 1;
        $('#beOvSpeed').value = speedToSlider(sp); $('#beOvSpeedVal').textContent = fmtSpeed(sp);
        $('#beOvRot').value = Math.round(ov.rotation || 0); $('#beOvRotVal').textContent = Math.round(ov.rotation || 0) + '°';
      }
    } else { filledOvId = null; }
    if (showClip) {
      const clip = state.clips.find(c => c.id === state.selected_clip_id);
      if (clip) {
        const it = mainTrackItems(state).find(x => x.clip.id === clip.id);
        const dur = it ? it.tEnd - it.tStart : (clip.source_out - clip.source_in);
        $('#beClipDur').textContent = `${dur.toFixed(1)}s`;
        $('#beToggleClip2').textContent = clip.active === false ? '◉ Reativar cena' : '◌ Desativar cena';
        // sliders da aba Vídeo>Básico: só refila ao TROCAR de cena (não
        // sobrescreve enquanto o user arrasta o slider)
        if (filledClipId !== clip.id) {
          filledClipId = clip.id;
          const sc = Math.round((clip.scale ?? 1) * 100);
          const op = Math.round((clip.opacity ?? 1) * 100);
          $('#beClipScale').value = sc; $('#beClipScaleVal').textContent = sc + '%';
          $('#beClipOpacity').value = op; $('#beClipOpacityVal').textContent = op + '%';
          const sp = clip.speed ?? 1;
          $('#beClipSpeed').value = speedToSlider(sp); $('#beClipSpeedVal').textContent = fmtSpeed(sp);
        }
      }
    } else {
      filledClipId = null;
    }
    // botao "separar audio" so faz sentido antes do detach
    $('#beDetachAudio').style.display = state.audio_detached ? 'none' : 'block';
  }

  // registries POR FONTE de midia: cada vídeo (principal + takes) tem sua
  // própria miniatura e waveform, senão o take importado vinha sem thumbnail
  // e sem forma de onda (user 2026-07-20). Chave: 'main' ou media.id.
  const thumbsRegistry = new Map();
  const videoWaveRegistry = new Map();

  function setupThumbsAndWave(state) {
    // (re)cria a fonte PRINCIPAL ('main')
    thumbsRegistry.get('main')?.destroy();
    videoWaveRegistry.get('main')?.destroy();
    const mainSrc = (localPreview.for === state.video.url && localPreview.url)
      ? localPreview.url : state.video.url;
    thumbsRegistry.set('main', createThumbnails(mainSrc, state.video.duration, () => timeline.draw()));
    videoWaveRegistry.set('main', createWaveform(mainSrc, () => timeline.draw(), { color: 'rgba(34,197,94,.9)' }));
    // lookups por chave (o render escolhe pela midia de cada clip)
    timeline.setThumbs({ get: (k) => thumbsRegistry.get(k == null ? 'main' : k) });
    timeline.setVideoWave({ get: (k) => videoWaveRegistry.get(k == null ? 'main' : k) });
    syncMediaRegistries(state);
    syncWaveRegistry(state);
  }

  // garante miniatura + waveform pra cada TAKE do pool (idempotente)
  function syncMediaRegistries(state) {
    for (const m of (state.media || [])) {
      if (!thumbsRegistry.has(m.id)) {
        thumbsRegistry.set(m.id, createThumbnails(m.url, m.duration, () => timeline.draw()));
      }
      if (!videoWaveRegistry.has(m.id)) {
        videoWaveRegistry.set(m.id, createWaveform(m.url, () => timeline.draw(), { color: 'rgba(34,197,94,.9)' }));
      }
    }
  }

  // ── upload de video ──
  const drop = $('#beDrop');
  const fileInput = $('#beFile');
  drop.addEventListener('click', () => fileInput.click());
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    importFiles(e.dataTransfer?.files);
  });
  fileInput.addEventListener('change', () => {
    importFiles(fileInput.files);
    fileInput.value = '';
  });
  // drag&drop com a edicao JA aberta: solta em qualquer lugar do editor e a
  // midia e ACRESCENTADA na timeline (nao reseta o projeto) — user 2026-07-20
  window.addEventListener('dragover', (e) => { e.preventDefault(); });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    if ($('#beWorkspace').style.display !== 'none') importFiles(e.dataTransfer?.files);
  });

  const isVideoFile = (f) => /^video\//.test(f.type) || /\.(mp4|mov|webm)$/i.test(f.name);
  const isAudioFile = (f) => /^audio\//.test(f.type) || /\.(mp3|wav|m4a|aac)$/i.test(f.name);
  const isImageFile = (f) => /^image\//.test(f.type) || /\.(png|jpg|jpeg|webp|gif)$/i.test(f.name);

  /** Importa QUALQUER quantidade de midias. 1º video de projeto vazio =
   *  principal; demais videos = takes ACRESCENTADOS no fim da timeline;
   *  audios = faixa de audio. Nunca reseta o que ja esta em edicao. */
  async function importFiles(fileList) {
    const files = [...(fileList || [])];
    if (!files.length) return;
    let ok = 0;
    for (const file of files) {
      try {
        if (isVideoFile(file)) {
          if (!store.getState().video) await uploadPrimary(file);
          else {
            toast(`Enviando ${file.name}…`);
            const media = await uploadMedia(file, 'video', () => {});
            store.dispatch(act.addMediaClip(media));
          }
          ok++;
        } else if (isAudioFile(file)) {
          toast(`Enviando áudio ${file.name}…`);
          const media = await uploadMedia(file, 'audio', () => {});
          store.dispatch(act.addAudioClip(media));
          syncWaveRegistry(store.getState());
          ok++;
        } else if (isImageFile(file)) {
          toast(`Enviando imagem ${file.name}…`);
          const media = await uploadMedia(file, 'image', () => {});
          store.dispatch(act.addImageOverlay(media, player.getTime()));
          ok++;
        } else {
          toast(`Formato não suportado: ${file.name}`, true);
        }
      } catch (e) { toast(`${file.name}: ${e.message}`, true); }
    }
    if (ok > 1) toast(`${ok} mídias adicionadas à timeline ✓`);
    else if (ok === 1) toast('Mídia adicionada ✓');
    renderMediaPanel();
  }

  async function uploadPrimary(file) {
    const bar = $('#beDropProgress');
    const msg = $('#beDropMsg');
    try {
      bar.style.display = 'block';
      msg.textContent = 'Enviando 0%';
      const media = await uploadMedia(file, 'video', (pct) => {
        msg.textContent = `Enviando ${pct}%`;
        bar.querySelector('i').style.width = pct + '%';
      });
      msg.textContent = 'Processando…';
      if (localPreview.url) URL.revokeObjectURL(localPreview.url);
      localPreview.url = URL.createObjectURL(file);
      localPreview.for = media.url;
      store.dispatch(act.setVideo(media));
      player.seek(0);
      // zoomFit apos o browser medir o canvas recem-visivel; fallback
      // pendingFit no controller cobre se o RO ainda nao mediu
      requestAnimationFrame(() => requestAnimationFrame(() => timeline.zoomFit()));
      toast('Vídeo carregado ✓');
    } catch (e) {
      toast(e.message, true);
      msg.textContent = 'Arraste um vídeo ou clique pra escolher';
      throw e;
    } finally {
      bar.style.display = 'none';
      bar.querySelector('i').style.width = '0%';
    }
  }

  // ── biblioteca de mídia (coluna 1, sempre visível) ──
  // "Mídia" e "＋ Importar" abrem o seletor de arquivos
  $('#beAddMedia').addEventListener('click', () => fileInput.click());
  $('#beMediaImport')?.addEventListener('click', () => fileInput.click());

  let _mediaSig = null;
  function renderMediaPanel() {
    const list = $('#beMediaList');
    if (!list) return;
    const s = store.getState();
    const rows = [];
    if (s.video) {
      rows.push({ icon: '🎬', name: s.video.filename || 'vídeo principal', dur: s.video.duration, tag: 'principal' });
    }
    for (const m of (s.media || [])) {
      rows.push({ icon: '🎞', name: m.filename, dur: m.duration, mediaId: m.id, tag: 'take' });
    }
    const audUrls = new Set();
    for (const a of (s.audio_clips || []).filter(a => a.kind !== 'video' && a.url)) {
      if (audUrls.has(a.url)) continue;
      audUrls.add(a.url);
      rows.push({ icon: '🎵', name: a.filename || 'áudio', dur: a.media_duration, tag: 'áudio' });
    }
    const imgUrls = new Set();
    for (const o of (s.overlays || []).filter(o => o.kind === 'image' && o.url)) {
      if (imgUrls.has(o.url)) continue;
      imgUrls.add(o.url);
      rows.push({ icon: '🖼', name: (o.url.split('/').pop() || 'imagem'), tag: 'imagem' });
    }
    // guard: só reconstrói a lista quando o conjunto de mídias muda (sem flicker)
    const sig = rows.map(r => r.icon + r.name + r.tag).join('|');
    if (sig === _mediaSig) return;
    _mediaSig = sig;
    list.innerHTML = rows.length ? '' : '<div class="be-dim">Nenhuma mídia importada ainda</div>';
    for (const r of rows) {
      const row = document.createElement('div');
      row.className = 'be-media-row';
      row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:6px 4px;border-bottom:1px solid rgba(255,255,255,.06)';
      const secs = r.dur ? Math.round(r.dur) + 's' : '';
      row.innerHTML = `<span>${r.icon}</span><span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${r.name}">${r.name}</span><span class="be-dim">${secs} · ${r.tag}</span>`;
      if (r.mediaId != null) {
        const btn = document.createElement('button');
        btn.className = 'be-tool-btn';
        btn.style.cssText = 'padding:2px 8px;font-size:11px';
        btn.textContent = '＋';
        btn.title = 'Adicionar de novo na timeline';
        btn.addEventListener('click', () => { store.dispatch(act.addClipFromMedia(r.mediaId)); toast('Take adicionado ✓'); });
        row.appendChild(btn);
      }
      list.appendChild(row);
    }
  }

  // ── fullscreen do preview (tecla F) com barra de tempo ──
  const frame = $('#beFrame');
  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else frame.requestFullscreen?.().catch(() => {});
  }
  $('#beFsExit').addEventListener('click', () => document.exitFullscreen?.());
  $('#beFsPlay').addEventListener('click', () => player.toggle());
  // scrub na barra do fullscreen
  const fsProg = $('#beFsProgress');
  let fsScrub = false;
  const fsSeekTo = (clientX) => {
    const r = fsProg.getBoundingClientRect();
    const pct = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    player.seek(pct * player.getDuration());
  };
  fsProg.addEventListener('pointerdown', (e) => { fsScrub = true; fsProg.setPointerCapture(e.pointerId); fsSeekTo(e.clientX); });
  fsProg.addEventListener('pointermove', (e) => { if (fsScrub) fsSeekTo(e.clientX); });
  fsProg.addEventListener('pointerup', () => { fsScrub = false; });
  // atualiza a barra do fullscreen
  player.onUpdate(() => {
    if (!document.fullscreenElement) return;
    const dur = player.getDuration() || 1;
    $('#beFsFill').style.width = (player.getTime() / dur * 100) + '%';
    $('#beFsPlay').textContent = player.isPlaying() ? '⏸' : '▶';
    $('#beFsTime').textContent = `${formatTime(player.getTime())} / ${formatTime(dur)}`;
  });
  // tecla F: entra/sai do fullscreen (ignora quando digitando)
  window.addEventListener('keydown', (e) => {
    const el = document.activeElement;
    const typing = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
    if (!typing && (e.key === 'f' || e.key === 'F') && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault(); toggleFullscreen();
    }
  });

  // ── transporte ──
  $('#bePlayBtn').addEventListener('click', () => player.toggle());
  $('#beProjectName').addEventListener('change', (e) => store.dispatch(act.renameProject(e.target.value)));
  $('#beUndo').addEventListener('click', () => store.undo());
  $('#beRedo').addEventListener('click', () => store.redo());

  // ── toolbar ──
  $('#beSplit').addEventListener('click', () => splitSelectedAt(store, player.getTime()));
  $('#beDelLeft').addEventListener('click', () => { store.dispatch(act.deleteRangeLeft(player.getTime())); player.seek(0.001); });
  $('#beDelRight').addEventListener('click', () => store.dispatch(act.deleteRangeRight(player.getTime())));
  const doToggleClip = () => {
    const s = store.getState();
    if (s.selected_clip_id != null) store.dispatch(act.toggleClip(s.selected_clip_id));
  };
  const doDeleteClip = () => {
    const s = store.getState();
    if (s.selected_clip_id != null) store.dispatch(act.deleteClip(s.selected_clip_id));
  };
  $('#beToggleClip').addEventListener('click', doToggleClip);
  $('#beDelClip').addEventListener('click', doDeleteClip);
  $('#beToggleClip2').addEventListener('click', doToggleClip);
  $('#beDelClip2').addEventListener('click', doDeleteClip);

  // ── painel de config com abas (Vídeo>Básico: Escala + Opacidade) ──
  // troca de aba de topo (Vídeo/Áudio/Velocidade/Animação/Ajuste)
  $('#beCfgTabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.be-cfg-tab'); if (!btn) return;
    const tab = btn.dataset.tab;
    $('#beCfgTabs').querySelectorAll('.be-cfg-tab').forEach(b => b.classList.toggle('active', b === btn));
    $('#bePropsClip').querySelectorAll('.be-cfg-panel').forEach(p =>
      p.style.display = p.dataset.panel === tab ? 'flex' : 'none');
  });
  // troca de sub-aba dentro de Vídeo (Básico/Remover fundo/Mascarar/Retoque)
  $('#beCfgSubtabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.be-cfg-subtab'); if (!btn) return;
    const sub = btn.dataset.sub;
    $('#beCfgSubtabs').querySelectorAll('.be-cfg-subtab').forEach(b => b.classList.toggle('active', b === btn));
    $('#bePropsClip').querySelectorAll('.be-cfg-sub').forEach(p =>
      p.style.display = p.dataset.sub === sub ? 'flex' : 'none');
  });
  // Escala + Opacidade: coalesce por gesto (1 undo por arraste), aplica ao vivo
  const bindClipSlider = (sel, valSel, field, toModel, toLabel) => {
    $(sel).addEventListener('input', (e) => {
      const id = store.getState().selected_clip_id;
      if (id == null) return;
      const raw = parseInt(e.target.value, 10);
      $(valSel).textContent = toLabel(raw);
      store.dispatch({ ...act.setClipTransform(id, { [field]: toModel(raw) }), gestureId: 'clip-' + field + '-' + id });
      applyClipTransform();
    });
    $(sel).addEventListener('change', () => store.endGesture());
  };
  bindClipSlider('#beClipScale', '#beClipScaleVal', 'scale', v => v / 100, v => v + '%');
  bindClipSlider('#beClipOpacity', '#beClipOpacityVal', 'opacity', v => v / 100, v => v + '%');

  // Velocidade (aba Velocidade do clip). Aplica só na CENA selecionada.
  $('#beClipSpeed').addEventListener('input', (e) => {
    const id = store.getState().selected_clip_id;
    if (id == null) return;
    const sp = sliderToSpeed(parseInt(e.target.value, 10));
    $('#beClipSpeedVal').textContent = fmtSpeed(sp);
    store.dispatch({ ...act.setSpeed('clip', id, sp), gestureId: 'clipspeed-' + id });
  });
  $('#beClipSpeed').addEventListener('change', () => store.endGesture());
  $('#beClipSpeedReset').addEventListener('click', () => {
    const id = store.getState().selected_clip_id;
    if (id == null) return;
    store.dispatch(act.setSpeed('clip', id, 1));
    $('#beClipSpeed').value = 0; $('#beClipSpeedVal').textContent = '1.00x';
  });
  // Velocidade do ÁUDIO selecionado (painel de áudio)
  $('#beAudioSpeed').addEventListener('input', (e) => {
    const id = store.getState().selected_audio_id;
    if (id == null) return;
    const sp = sliderToSpeed(parseInt(e.target.value, 10));
    $('#beAudioSpeedVal').textContent = fmtSpeed(sp);
    store.dispatch({ ...act.setSpeed('audio', id, sp), gestureId: 'audiospeed-' + id });
  });
  $('#beAudioSpeed').addEventListener('change', () => store.endGesture());
  // Velocidade + Giro da CAMADA (overlay) — igual à faixa principal
  $('#beOvSpeed').addEventListener('input', (e) => {
    const id = store.getState().selected_overlay_id;
    if (id == null) return;
    const sp = sliderToSpeed(parseInt(e.target.value, 10));
    $('#beOvSpeedVal').textContent = fmtSpeed(sp);
    store.dispatch({ ...act.setSpeed('overlay', id, sp), gestureId: 'ovspeed-' + id });
  });
  $('#beOvSpeed').addEventListener('change', () => store.endGesture());
  $('#beOvRot').addEventListener('input', (e) => {
    const id = store.getState().selected_overlay_id;
    if (id == null) return;
    const deg = parseInt(e.target.value, 10);
    $('#beOvRotVal').textContent = deg + '°';
    store.dispatch({ ...act.setOverlayTransform(id, { rotation: deg }), gestureId: 'ovrot-' + id });
  });
  $('#beOvRot').addEventListener('change', () => store.endGesture());

  $('#beZoomIn').addEventListener('click', () => timeline.zoomBy(1.25));
  $('#beZoomOut').addEventListener('click', () => timeline.zoomBy(1 / 1.25));
  $('#beZoomFit').addEventListener('click', () => timeline.zoomFit());
  $('#beAddText').addEventListener('click', addTextAtPlayhead);
  $('#beAddText2').addEventListener('click', addTextAtPlayhead);
  function addTextAtPlayhead() {
    const t = player.getTime();
    store.dispatch(act.addText({ content: 'Seu texto', start_sec: t, end_sec: Math.min(t + 3, Math.max(t + 1, totalDuration(store.getState()))) }));
    openTextPanel(store.getState().texts.at(-1).id);
  }

  // ── painel de texto (inline no painel de propriedades) ──
  let editingTextId = null;
  const isCaption = (t) => !!(t && t.caption);
  const posOf = (y) => Math.abs(y - 0.15) < 0.15 ? '0.15' : Math.abs(y - 0.5) < 0.2 ? '0.5' : '0.82';
  function fillTextPanel(state) {
    const txt = state.texts.find(x => x.id === state.selected_text_id);
    if (!txt) return;
    // caixa "Aplicar a todas as legendas" só faz sentido em legenda
    $('#beCapApplyAllRow').style.display = isCaption(txt) ? 'flex' : 'none';
    // sub-aba Legendas (transcrição) só quando há legendas
    const temCaptions = state.texts.some(t => t.caption);
    $('#beTextTabCap').style.display = temCaptions ? '' : 'none';
    if (temCaptions) renderTranscript(state);
    if (editingTextId === txt.id) return; // nao sobrescreve enquanto digita
    editingTextId = txt.id;
    $('#beTextContent').value = txt.content;
    $('#beTextFont').value = txt.font;
    $('#beTextSize').value = txt.size;
    $('#beTextColor').value = txt.color;
    $('#beTextPos').value = posOf(txt.y_pct ?? 0.82);
    $('#beTextStart').value = txt.start_sec.toFixed(1);
    $('#beTextEnd').value = txt.end_sec.toFixed(1);
  }
  function openTextPanel(textId) {
    editingTextId = null; // forca refill
    store.dispatch(act.selectText(textId));
    setTimeout(() => $('#beTextContent').focus(), 60);
  }
  $('#beTextClose').addEventListener('click', () => {
    editingTextId = null;
    store.dispatch(act.selectText(null));
  });
  $('#beTextDelete').addEventListener('click', () => {
    const s = store.getState();
    if (s.selected_text_id != null) store.dispatch(act.deleteText(s.selected_text_id));
    editingTextId = null;
  });
  // sub-abas Texto | Legendas
  $('#beTextTabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.be-cfg-tab'); if (!btn) return;
    const tab = btn.dataset.ttab;
    $('#beTextTabs').querySelectorAll('.be-cfg-tab').forEach(b => b.classList.toggle('active', b === btn));
    $('#beTextPanel').querySelectorAll('.be-text-tab').forEach(p =>
      p.style.display = p.dataset.ttab === tab ? 'flex' : 'none');
    if (tab === 'legendas') renderTranscript(store.getState());
  });

  // aplica um patch de ESTILO respeitando "Aplicar a todas as legendas"
  function applyTextStyle(patch) {
    const s = store.getState();
    const txt = s.texts.find(x => x.id === s.selected_text_id);
    if (!txt) return;
    const all = isCaption(txt) && $('#beCapApplyAll').checked;
    const targets = all ? s.texts.filter(t => t.caption) : [txt];
    for (const t of targets) store.dispatch({ ...act.updateText(t.id, patch), gestureId: 'textstyle' });
    store.endGesture();
  }
  // content/start/end são SEMPRE por-faixa (cada legenda tem seu texto/tempo)
  for (const [sel, field, parse] of [
    ['#beTextContent', 'content', v => v],
    ['#beTextStart', 'start_sec', v => parseFloat(v) || 0],
    ['#beTextEnd', 'end_sec', v => parseFloat(v) || 0],
  ]) {
    $(sel).addEventListener('input', (e) => {
      const s = store.getState();
      if (s.selected_text_id == null) return;
      store.dispatch({ ...act.updateText(s.selected_text_id, { [field]: parse(e.target.value) }), gestureId: 'textpanel-' + s.selected_text_id + '-' + field });
    });
    $(sel).addEventListener('change', () => store.endGesture());
  }
  // fonte/tamanho/cor/posição = ESTILO (respeita "aplicar a todas")
  $('#beTextFont').addEventListener('change', (e) => applyTextStyle({ font: e.target.value }));
  $('#beTextSize').addEventListener('change', (e) => applyTextStyle({ size: e.target.value }));
  $('#beTextColor').addEventListener('input', (e) => applyTextStyle({ color: e.target.value }));
  $('#beTextPos').addEventListener('change', (e) => applyTextStyle({ y_pct: parseFloat(e.target.value) }));
  // Caixa (TT/tt/Tt): transforma o conteúdo (respeita "aplicar a todas")
  const caseFns = {
    upper: (s) => s.toUpperCase(),
    lower: (s) => s.toLowerCase(),
    title: (s) => s.toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase()),
  };
  $('#beTextPanel').querySelectorAll('[data-case]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const fn = caseFns[btn.dataset.case];
      const s = store.getState();
      const txt = s.texts.find(x => x.id === s.selected_text_id);
      if (!txt || !fn) return;
      const all = isCaption(txt) && $('#beCapApplyAll').checked;
      const targets = all ? s.texts.filter(t => t.caption) : [txt];
      for (const t of targets) store.dispatch({ ...act.updateText(t.id, { content: fn(t.content) }), gestureId: 'textcase' });
      store.endGesture();
      editingTextId = null; // força refill do textarea
    });
  });

  // ── transcrição completa (aba Legendas): lista clicável ──
  function renderTranscript(state) {
    const list = $('#beTranscriptList');
    if (!list) return;
    const caps = state.texts.filter(t => t.caption).slice().sort((a, b) => a.start_sec - b.start_sec);
    if (!caps.length) { list.innerHTML = '<div class="be-dim">Gere as legendas primeiro (💬 Legendas).</div>'; return; }
    list.innerHTML = '';
    caps.forEach((t, i) => {
      const row = document.createElement('div');
      row.className = 'be-transcript-row' + (t.id === state.selected_text_id ? ' active' : '');
      const n = document.createElement('span'); n.className = 'be-transcript-n'; n.textContent = (i + 1);
      const tx = document.createElement('span'); tx.className = 'be-transcript-tx'; tx.textContent = t.content;
      row.appendChild(n); row.appendChild(tx);
      row.addEventListener('click', () => {
        editingTextId = null;
        store.dispatch(act.selectText(t.id));   // seleciona pra editar
        player.seek(t.start_sec + 0.01);          // pula pro ponto da fala
        // volta pra aba Texto pra editar aquele ponto
        $('#beTextTabs').querySelector('[data-ttab="texto"]').click();
      });
      list.appendChild(row);
    });
  }

  // ── audio extra + biblioteca de áudio ──
  const audioInput = $('#beAudioFile');
  const pickAudio = () => audioInput.click();
  // rail "Áudio": abre a BIBLIOTECA (Músicas/Efeitos/Favoritos), não importa direto
  $('#beAddAudio').addEventListener('click', () => {
    audioLibOpen = !audioLibOpen;
    if (audioLibOpen) { captionsPanelOpen = false; store.dispatch(act.selectClip(null)); }
    sync();
  });
  $('#beAddAudio2').addEventListener('click', pickAudio); // botão do painel de projeto = importar
  $('#beAudioLibClose')?.addEventListener('click', () => { audioLibOpen = false; sync(); });
  $('#beAudioLibImport')?.addEventListener('click', pickAudio);
  // sub-abas da biblioteca (Músicas / Efeitos / Favoritos)
  $('#beAudioLibTabs')?.addEventListener('click', (e) => {
    const b = e.target.closest('.be-cfg-subtab'); if (!b) return;
    audioLibTab = b.dataset.atab;
    $('#beAudioLibTabs').querySelectorAll('.be-cfg-subtab').forEach(x => x.classList.toggle('active', x === b));
    renderAudioLib();
  });
  $('#beAudioLibSearch')?.addEventListener('input', (e) => { audioLibQuery = e.target.value; renderAudioLibDebounced(); });
  let audioLibDeb = 0;
  function renderAudioLibDebounced() { clearTimeout(audioLibDeb); audioLibDeb = setTimeout(renderAudioLib, 350); }
  async function renderAudioLib() {
    const box = $('#beAudioLibResults'); if (!box) return;
    const q = (audioLibQuery || '').trim();
    if (audioLibTab === 'favoritos') {
      const favs = getAudioFavs();
      box.innerHTML = favs.length ? '' : '<div class="be-dim">Sem favoritos ainda. Salve com a ⭐ nos resultados.</div>';
      favs.forEach(f => box.appendChild(audioResultRow(f, true)));
      return;
    }
    if (!q) { box.innerHTML = '<div class="be-dim">Digite pra buscar ' + (audioLibTab === 'efeitos' ? 'efeitos sonoros' : 'músicas') + '.</div>'; return; }
    box.innerHTML = '<div class="be-dim">Buscando…</div>';
    try {
      const r = await api.audioSearch(q, audioLibTab === 'efeitos' ? 'sfx' : 'music');
      const items = r.results || [];
      if (!items.length) {
        box.innerHTML = '<div class="be-dim">' + (r.message || 'Nada encontrado.') + '</div>';
        return;
      }
      box.innerHTML = '';
      items.forEach(it => box.appendChild(audioResultRow(it, false)));
    } catch (e) {
      box.innerHTML = '<div class="be-dim">Biblioteca ainda não conectada. Use ＋ Importar por enquanto.</div>';
    }
  }
  function audioResultRow(it, isFav) {
    const row = document.createElement('div');
    row.className = 'be-audio-lib-row';
    const meta = [it.category, it.duration ? Math.round(it.duration) + 's' : ''].filter(Boolean).join(' · ');
    row.innerHTML = `<button class="be-audiolib-play" title="Ouvir">▶</button>
      <span class="be-audiolib-name" title="${it.name || ''}">${it.name || 'áudio'}</span>
      <span class="be-dim">${meta}</span>`;
    let audio = null;
    row.querySelector('.be-audiolib-play').addEventListener('click', () => {
      if (!it.preview) return;
      if (audio && !audio.paused) { audio.pause(); return; }
      audio = new Audio(it.preview); audio.play().catch(() => {});
    });
    const star = document.createElement('button');
    star.className = 'be-audiolib-star'; star.textContent = isFav ? '★' : '☆'; star.title = 'Favoritar';
    star.addEventListener('click', () => { toggleAudioFav(it); renderAudioLib(); });
    const use = document.createElement('button');
    use.className = 'be-tool-btn'; use.style.cssText = 'padding:2px 8px;font-size:11px'; use.textContent = '＋';
    use.title = 'Adicionar na timeline';
    use.addEventListener('click', () => {
      store.dispatch(act.addAudioClip({ url: it.url, filename: it.name, duration: it.duration || 10 }));
      syncWaveRegistry(store.getState());
      toast('Áudio adicionado ✓');
    });
    row.appendChild(star); row.appendChild(use);
    return row;
  }
  const AUDIO_FAV_KEY = 'be_v1_audio_favs';
  function getAudioFavs() { try { return JSON.parse(localStorage.getItem(AUDIO_FAV_KEY)) || []; } catch { return []; } }
  function toggleAudioFav(it) {
    const favs = getAudioFavs();
    const i = favs.findIndex(f => f.url === it.url);
    if (i >= 0) favs.splice(i, 1); else favs.push(it);
    try { localStorage.setItem(AUDIO_FAV_KEY, JSON.stringify(favs)); } catch {}
  }
  audioInput.addEventListener('change', async () => {
    const f = audioInput.files?.[0];
    audioInput.value = '';
    if (!f) return;
    try {
      toast('Enviando áudio…');
      const media = await uploadMedia(f, 'audio', () => {});
      store.dispatch(act.addAudioClip(media));
      syncWaveRegistry(store.getState());
      toast('Áudio adicionado ✓ — arraste na timeline pra posicionar');
    } catch (e) { toast(e.message, true); }
  });

  $('#beVolVideo').addEventListener('input', (e) => {
    store.dispatch({ ...act.setVolume('video', parseFloat(e.target.value)), gestureId: 'vol-v' });
  });
  $('#beVolVideo').addEventListener('change', () => store.endGesture());

  $('#beAspect').addEventListener('change', (e) => store.dispatch(act.setAspect(e.target.value)));

  // ── audio destacado (Ctrl+Shift+S) ──
  $('#beDetachAudio').addEventListener('click', () => {
    store.dispatch(act.detachAudio());
    toast('Áudio separado do vídeo ✓ (track própria)');
  });
  $('#beVolSelected').addEventListener('input', (e) => {
    const id = store.getState().selected_audio_id;
    if (id == null) return;
    store.dispatch({ ...act.setAudioVolume(id, parseFloat(e.target.value)), gestureId: 'vol-sel' });
  });
  $('#beVolSelected').addEventListener('change', () => store.endGesture());
  $('#beOverlayDelete').addEventListener('click', () => {
    const id = store.getState().selected_overlay_id;
    if (id != null) store.dispatch(act.deleteOverlay(id));
  });
  $('#beAudioItemDelete').addEventListener('click', () => {
    const id = store.getState().selected_audio_id;
    if (id != null) store.dispatch(act.deleteAudioClip(id));
  });

  // registry de waveforms por URL (multiplos arquivos de audio)
  const waveRegistry = new Map();
  function syncWaveRegistry(state) {
    for (const a of state.audio_clips) {
      if (a.kind === 'extra' && a.url && !waveRegistry.has(a.url)) {
        waveRegistry.set(a.url, createWaveform(a.url, () => timeline.draw()));
      }
    }
    timeline.setWave({ get: (url) => waveRegistry.get(url) });
  }

  // ── transicoes ──
  function renderTransitionsRow(state) {
    const row = $('#beTransitions');
    const segs = timelineSegments(state);
    if (segs.length < 2) { row.innerHTML = '<span class="be-dim">Divida o vídeo em 2+ cenas pra ter transições</span>'; row.dataset.rendered = ''; return; }
    let html = '';
    for (let i = 0; i < segs.length - 1; i++) {
      const tr = (state.transitions || []).find(x => x.between === i);
      html += `<label class="be-trans-item">Corte ${i + 1}→${i + 2}
        <select data-between="${i}">
          <option value="cut" ${!tr ? 'selected' : ''}>Corte seco</option>
          <option value="fade" ${tr?.type === 'fade' ? 'selected' : ''}>Fade</option>
        </select></label>`;
    }
    if (row.dataset.rendered !== html) {
      row.dataset.rendered = html;
      row.innerHTML = html;
      row.querySelectorAll('select').forEach(sel => {
        sel.addEventListener('change', () => {
          store.dispatch(act.setTransition(parseInt(sel.dataset.between, 10), sel.value, 0.3));
        });
      });
    }
  }

  // ── export ──
  const exportModal = $('#beExportModal');
  $('#beExportBtn').addEventListener('click', () => {
    exportModal.classList.add('open');
    $('#beExportProgress').style.display = 'block';
    $('#beExportDone').style.display = 'none';
    $('#beExportError').style.display = 'none';
    exporter.start({
      onProgress: (pct, label) => {
        $('#beExportBar').style.width = pct + '%';
        $('#beExportLabel').textContent = `${label} ${pct}%`;
      },
      onDone: (url) => {
        $('#beExportProgress').style.display = 'none';
        $('#beExportDone').style.display = 'block';
        $('#beExportLink').href = url;
        $('#beExportPreview').src = url;
      },
      onError: (msg) => {
        $('#beExportProgress').style.display = 'none';
        $('#beExportError').style.display = 'block';
        $('#beExportErrorMsg').textContent = msg;
      },
    });
  });
  $('#beExportCancel').addEventListener('click', async () => {
    await exporter.cancel();
    exportModal.classList.remove('open');
  });
  $('#beExportClose').addEventListener('click', () => exportModal.classList.remove('open'));

  // ── projetos ──
  async function showProjects() {
    try {
      const { projects } = await api.listProjects();
      if (!projects?.length) return;
      const box = $('#beProjects');
      box.innerHTML = '<div class="be-projects-title">Continuar de onde parou:</div>' + projects.map(p =>
        `<button class="be-project-item" data-id="${p.id}">📁 ${escapeHtml(p.nome_projeto || 'Sem título')} <span>${new Date(p.updated_at).toLocaleDateString('pt-BR')}</span></button>`
      ).join('');
      box.style.display = 'block';
      box.querySelectorAll('.be-project-item').forEach(btn => {
        btn.addEventListener('click', async () => {
          try {
            const { project } = await api.loadProject(btn.dataset.id);
            if (project?.project_state) {
              store.replaceState((await import('../core/schema.js')).normalizeLoadedState({ ...project.project_state, project_id: project.id }));
              store.dispatch(act.setProjectId(project.id));
              box.style.display = 'none';
              requestAnimationFrame(() => requestAnimationFrame(() => timeline.zoomFit()));
              toast('Projeto restaurado ✓');
            }
          } catch (e) { toast('Falha ao carregar: ' + e.message, true); }
        });
      });
    } catch { /* sem projetos, segue */ }
  }
  showProjects();

  // ── clipe composto: entrar/sair (CapCut) ──
  // Ao ENTRAR: o editor passa a mostrar SO o conteudo interno do composto.
  // Ao SAIR: o doc interno volta pro composto e o principal e restaurado.
  let compoundCtx = null; // { compoundId, savedDoc }
  function enterCompound(compoundId) {
    const state = store.getState();
    const comp = state.compounds.find(k => k.id === compoundId);
    if (!comp || compoundCtx) return;
    compoundCtx = { compoundId, savedDoc: state };
    const inner = {
      ...state,
      nome_projeto: comp.name,
      clips: comp.clips.map(c => ({ ...c })),
      texts: comp.texts.map(t => ({ ...t })),
      audio_clips: comp.audio_clips.map(a => ({ ...a })),
      overlays: comp.overlays.map(o => ({ ...o })),
      compounds: [], multi_selected: [],
      selected_clip_id: null, selected_text_id: null,
      selected_audio_id: null, selected_overlay_id: null,
    };
    store.replaceState(inner);
    $('#beCompoundBar').style.display = 'flex';
    $('#beCompoundName').textContent = '⧉ ' + comp.name;
    requestAnimationFrame(() => requestAnimationFrame(() => timeline.zoomFit()));
    toast('Editando clipe composto — clique em Sair pra voltar');
  }
  function exitCompound() {
    if (!compoundCtx) return;
    const inner = store.getState();
    const doc = {
      clips: inner.clips, texts: inner.texts,
      audio_clips: inner.audio_clips, overlays: inner.overlays,
    };
    const { compoundId, savedDoc } = compoundCtx;
    compoundCtx = null;
    store.replaceState(savedDoc);
    store.dispatch(act.updateCompound(compoundId, doc));
    $('#beCompoundBar').style.display = 'none';
    requestAnimationFrame(() => requestAnimationFrame(() => timeline.zoomFit()));
    toast('Alterações salvas no clipe composto ✓');
  }
  $('#beCompoundExit').addEventListener('click', exitCompound);

  // ── legendas automaticas (CapCut auto captions) ──
  // words da ultima transcricao + o PLANO de audio usado (qual fonte e como
  // mapear file-time -> timeline) ficam em memoria: trocar o MODO nao paga
  // nova transcricao.
  let lastCaptionWords = null;
  let lastCaptionPhrases = null;
  let lastCaptionPlan = null;   // { url, segments:[{tStart,fileIn,fileOut}] }
  let lastCaptionKey = null;    // url transcrita (invalidar quando a fonte muda)

  // file-time (dentro do arquivo transcrito) -> tempo VIRTUAL da timeline,
  // via os segmentos do plano. null se a fala caiu num trecho cortado.
  function fileToTimeline(ft, segments) {
    for (const s of segments) {
      if (ft >= s.fileIn - 1e-6 && ft <= s.fileOut + 1e-6) {
        return s.tStart + (ft - s.fileIn);
      }
    }
    return null;
  }

  function aplicarLegendas(mode) {
    const words = lastCaptionWords || [];
    const segments = lastCaptionPlan?.segments || [];
    if (!segments.length) return 0;
    const brutos = mode === 'palavra'
      // PALAVRA POR PALAVRA: cada palavra com o timestamp REAL da fala —
      // a legenda acompanha a narração exatamente (pedido do user)
      ? words.map((w, i) => ({
          text: w.word,
          start: w.start,
          // fica na tela ate a proxima palavra (sem buraco), min 0.25s
          end: Math.max(w.end, (words[i + 1]?.start ?? w.end + 0.4) - 0.02, w.start + 0.25),
        }))
      : (lastCaptionPhrases || []);
    if (!brutos.length) return 0;

    // Whisper devolve tempos DO ARQUIVO transcrito; mapeia pra timeline pelo
    // plano (funciona pra audio proprio do editor OU audio do video, e
    // respeita cortes — fala num trecho removido some).
    const caps = [];
    for (const c of brutos) {
      const ts = fileToTimeline(c.start, segments);
      if (ts == null) continue;
      const te = fileToTimeline(c.end, segments);
      const dur = te != null && te > ts ? te - ts : Math.max(0.25, c.end - c.start);
      caps.push({ text: c.text, start: ts, end: ts + dur });
    }
    if (!caps.length) return 0;

    // usa o estilo ESCOLHIDO no painel (ou preserva o atual se já estilizado)
    const atual = store.getState().texts.find(t => t.caption);
    const preset = CAP_PRESETS[capChosenPreset] || {};
    const estilo = {
      font: atual?.font || preset.font || 'Anton',
      size: atual?.size || preset.size || 'medium',
      color: atual?.color || preset.color || '#ffffff',
      y_pct: atual?.y_pct ?? 0.82,
    };
    // UM dispatch: nao rouba a selecao (painel fica), 1 undo, sem freeze
    // com videos longos (300+ palavras = 300 dispatches na versao antiga)
    store.dispatch(act.setCaptions(caps.map(c => ({
      content: c.text, start_sec: c.start, end_sec: c.end,
      x_pct: 0.5, ...estilo,
    }))));
    return caps.length;
  }

  async function generateCaptions() {
    const state = store.getState();
    const mode = $('#beCapMode')?.value || 'frase';
    // escolhe a fonte de audio REAL (voz do editor > audio do video; nunca
    // o audio fantasma de um video mudo) — user 2026-07-20
    const plan = captionAudioPlan(state);
    if (!plan) {
      return toast('Nenhum áudio com voz pra transcrever. Adicione seu áudio (aba Áudio) ou reative o áudio do vídeo.', true);
    }
    try {
      // re-transcreve se a FONTE mudou (trocou/adicionou áudio próprio etc)
      if (!lastCaptionWords || lastCaptionKey !== plan.url) {
        toast('Transcrevendo áudio… (pode levar ~1min)');
        const r = await api.autoCaptions(plan.url);
        lastCaptionPhrases = r.captions || [];
        lastCaptionWords = r.words || [];
        lastCaptionKey = plan.url;
        if (!lastCaptionPhrases.length && !lastCaptionWords.length) {
          return toast('Nenhuma fala detectada no áudio', true);
        }
      }
      lastCaptionPlan = plan; // mapa file->timeline atual (cortes podem ter mudado)
      const n = aplicarLegendas(mode);
      if (!n) return toast('Nenhuma fala detectada no trecho ativo', true);
      $('#beCapStyleRow').style.display = 'flex';
      toast(n + (mode === 'palavra' ? ' palavras' : ' legendas') + ' geradas ✓ — sincronizadas com a fala');
    } catch (e) {
      const msg = (e.status === 504 || /timeout|timed out|HTTP 50/i.test(e.message || ''))
        ? 'A transcrição demorou demais — tente um áudio mais curto'
        : e.message;
      toast('Legendas: ' + msg, true);
    }
  }
  // rail "Legendas": ABRE o painel dedicado (escolher estilo ANTES de gerar)
  $('#beAutoCaptions').addEventListener('click', () => {
    captionsPanelOpen = !captionsPanelOpen;
    if (captionsPanelOpen) { store.dispatch(act.selectClip(null)); }
    sync();
  });
  $('#beCapClose').addEventListener('click', () => { captionsPanelOpen = false; sync(); });
  $('#beAutoCaptions2').addEventListener('click', generateCaptions);
  // cards de MODO (Multilinha / Palavra por palavra) com preview animado
  $('#beCapModeCards').addEventListener('click', (e) => {
    const card = e.target.closest('.be-cap-card'); if (!card) return;
    const mode = card.dataset.mode;
    $('#beCapModeCards').querySelectorAll('.be-cap-card').forEach(c => c.classList.toggle('active', c === card));
    $('#beCapMode').value = mode;
    $('#beCapMode').dispatchEvent(new Event('change'));
  });
  // trocar o modo REGENERA na hora (sem nova transcricao) se ja ha legendas
  $('#beCapMode').addEventListener('change', () => {
    if (lastCaptionWords && lastCaptionPlan && store.getState().texts.some(t => t.caption)) {
      const n = aplicarLegendas($('#beCapMode').value);
      if (n) toast('Legendas regeneradas: ' + n + ' blocos');
    }
  });

  // ── ESTILOS DE LEGENDA por categoria (presets CapCut-like) ──
  // Limitados ao que o render REAL suporta (fontes com TTF no Railway +
  // cor/tamanho/posição) — WYSIWYG honesto: o que se vê é o que exporta.
  const CAP_PRESETS = {
    classico: { font: 'Anton',      color: '#ffffff', size: 'medium' },
    amarelo:  { font: 'Anton',      color: '#ffd32a', size: 'medium' },
    impacto:  { font: 'Bebas Neue', color: '#ffffff', size: 'large' },
    oswald:   { font: 'Oswald',     color: '#f5f5f5', size: 'large' },
    neon:     { font: 'Anton',      color: '#00d4ff', size: 'medium' },
    lima:     { font: 'Bebas Neue', color: '#a3e635', size: 'medium' },
    pop:      { font: 'Anton',      color: '#ff6b9d', size: 'medium' },
  };
  // grid de estilos com PREVIEW animado (constrói dos presets)
  const CAP_LABELS = {
    classico: 'Aa', amarelo: 'Aa', impacto: 'Aa', oswald: 'Aa',
    neon: 'Aa', lima: 'Aa', pop: 'Aa',
  };
  const CAP_NAMES = {
    classico: 'Clássico', amarelo: 'Amarelo', impacto: 'Impacto', oswald: 'Oswald',
    neon: 'Neon', lima: 'Lima', pop: 'Pop',
  };
  function buildCapStyleGrid() {
    const grid = $('#beCapStyleGrid');
    grid.innerHTML = '';
    for (const [key, p] of Object.entries(CAP_PRESETS)) {
      const card = document.createElement('button');
      card.className = 'be-cap-style' + (key === capChosenPreset ? ' active' : '');
      card.dataset.preset = key;
      card.title = CAP_NAMES[key];
      const b = document.createElement('b');
      b.textContent = CAP_NAMES[key];
      b.style.color = p.color;
      b.style.fontFamily = `'${p.font}', 'Anton', Impact, sans-serif`;
      card.appendChild(b);
      card.addEventListener('click', () => selectCapPreset(key));
      grid.appendChild(card);
    }
  }
  function selectCapPreset(key) {
    capChosenPreset = key;
    $('#beCapStyleGrid').querySelectorAll('.be-cap-style').forEach(c =>
      c.classList.toggle('active', c.dataset.preset === key));
    const p = CAP_PRESETS[key];
    if (p) {
      $('#beCapSize').value = p.size;
      $('#beCapColor').value = p.color;
      // se já há legendas, aplica na hora
      if (store.getState().texts.some(t => t.caption)) {
        applyCapStyle(p);
        toast('Estilo aplicado ✓');
      }
    }
  }
  buildCapStyleGrid();

  // estilo GLOBAL das legendas: muda uma vez, aplica em todas (CapCut)
  function applyCapStyle(patchObj) {
    for (const t of store.getState().texts.filter(t => t.caption)) {
      store.dispatch({ ...act.updateText(t.id, patchObj), gestureId: 'capstyle' });
    }
    store.endGesture();
  }
  $('#beCapSize').addEventListener('change', (e) => applyCapStyle({ size: e.target.value }));
  $('#beCapColor').addEventListener('change', (e) => applyCapStyle({ color: e.target.value }));
  $('#beCapPos').addEventListener('change', (e) => applyCapStyle({ y_pct: parseFloat(e.target.value) }));
  $('#beCapDeleteAll').addEventListener('click', () => {
    for (const t of store.getState().texts.filter(t => t.caption)) {
      store.dispatch({ ...act.deleteText(t.id), gestureId: 'capdel' });
    }
    store.endGesture();
    $('#beCapStyleRow').style.display = 'none';
  });
  $('#beGroupBtn').addEventListener('click', () => {
    if ((store.getState().compounds || []).length >= 4) {
      return toast('Máximo de 4 clipes compostos — desfaça um (botão direito nele) pra criar outro', true);
    }
    const antes = (store.getState().compounds || []).length;
    store.dispatch(act.createCompound());
    if ((store.getState().compounds || []).length > antes) toast('Clipe composto criado ✓');
  });

  // ── toast ──
  function toast(msg, isError) {
    const el = $('#beToast');
    el.textContent = msg;
    el.className = 'be-toast show' + (isError ? ' err' : '');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove('show'), 3500);
  }

  // flush do autosave ao esconder/fechar a aba (debounce de 2s podia perder
  // a ultima edicao). pagehide cobre iOS Safari.
  const flushOnHide = () => { if (document.visibilityState === 'hidden') autosave.flush(); };
  document.addEventListener('visibilitychange', flushOnHide);
  window.addEventListener('pagehide', () => autosave.flush());

  const detachResizers = attachResizers(root, () => timeline.draw());

  sync();

  return {
    destroy() {
      detachResizers();
      detachShortcuts();
      document.removeEventListener('visibilitychange', flushOnHide);
      player.destroy(); overlay.destroy(); pip.destroy(); timeline.destroy();
      autosave.destroy(); exporter.destroy();
      for (const t of thumbsRegistry.values()) t.destroy();
      for (const w of videoWaveRegistry.values()) w.destroy();
      for (const w of waveRegistry.values()) w.destroy();
      if (localPreview.url) URL.revokeObjectURL(localPreview.url);
    },
  };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Track headers espelham as alturas do layout do canvas (fonte unica: METRICS)
function buildTemplate() {
  const M = METRICS;
  return `
<header class="be-header">
  <a href="/blueEditor" class="be-back">←</a>
  <span class="be-logo">Blue<b>Editor</b></span>
  <input id="beProjectName" class="be-project-name" maxlength="120" placeholder="Nome do projeto"/>
  <span id="beSaveStatus" class="be-save-status"></span>
  <div class="be-header-right">
    <button id="beUndo" class="be-icon-btn" title="Desfazer (Ctrl+Z)">↩</button>
    <button id="beRedo" class="be-icon-btn" title="Refazer (Ctrl+Shift+Z)">↪</button>
    <button id="beExportBtn" class="be-export-btn">⬆ Exportar</button>
  </div>
</header>

<div id="beDrop" class="be-drop">
  <div class="be-drop-inner">
    <div class="be-drop-icon">🎬</div>
    <div id="beDropMsg">Arraste um vídeo ou clique pra escolher</div>
    <div class="be-dim">MP4, MOV ou WebM · máx 500MB</div>
    <div id="beDropProgress" class="be-progress" style="display:none"><i></i></div>
  </div>
  <input type="file" id="beFile" multiple accept="video/mp4,video/quicktime,video/webm,audio/mpeg,audio/wav,audio/mp4,image/png,image/jpeg,image/webp,image/gif,.mp4,.mov,.webm,.mp3,.wav,.m4a,.aac,.png,.jpg,.jpeg,.webp,.gif" hidden/>
</div>

<div id="beWorkspace" class="be-workspace" style="display:none">

  <!-- BIBLIOTECA DE MÍDIA (coluna 1, esquerda — o "vermelho" do CapCut) -->
  <div class="be-library">
    <div class="be-rail">
      <button id="beAddMedia" class="be-rail-btn" title="Importar mídias (Ctrl+O)"><span>🎞</span>Mídia</button>
      <button id="beAddText" class="be-rail-btn" title="Adicionar texto"><span>T</span>Texto</button>
      <button id="beAddAudio" class="be-rail-btn" title="Adicionar música/narração"><span>♪</span>Áudio</button>
      <button id="beAutoCaptions" class="be-rail-btn" title="Gerar legendas automáticas (IA)"><span>💬</span>Legendas</button>
    </div>
    <div class="be-library-body">
      <button id="beMediaImport" class="be-tool-btn">＋ Importar mídias</button>
      <div class="be-dim">Vídeos viram takes · áudios entram na faixa · imagens (PNG) viram camada. Arraste aqui ou selecione vários.</div>
      <div id="beMediaList" class="be-library-list"></div>
    </div>
  </div>

  <!-- preview central -->
  <div class="be-preview-area">
    <div class="be-preview-frame" id="beFrame">
      <video id="beVideo" playsinline preload="auto"></video>
      <video id="beVideo2" playsinline preload="auto" muted class="be-buffering"></video>
      <div id="beOverlay"></div>
      <!-- barra de controle no FULLSCREEN (tecla F) -->
      <div id="beFsBar" class="be-fs-bar">
        <button id="beFsPlay" class="be-fs-play">▶</button>
        <div id="beFsProgress" class="be-fs-progress"><div id="beFsFill"></div></div>
        <span id="beFsTime" class="be-fs-time">0:00 / 0:00</span>
        <button id="beFsExit" class="be-fs-exit" title="Sair (Esc / F)">⤢</button>
      </div>
    </div>
    <audio id="beAudio" preload="auto"></audio>
    <div class="be-transport">
      <button id="bePlayBtn" class="be-play-btn">▶</button>
      <span id="beTimeLabel" class="be-time">0:00 / 0:00</span>
    </div>
  </div>

  <!-- CONFIGURAÇÕES DAS FAIXAS (coluna 2, meio — o "amarelo" do CapCut) -->
  <div class="be-props">

    <div id="bePropsProject" class="be-props-stack">
      <div class="be-side-title">Projeto</div>
      <label class="be-field">Formato de saída
        <select id="beAspect" class="be-select">
          <option value="crop_center">Preencher 9:16 (corta bordas)</option>
          <option value="letterbox">Caber inteiro (barras)</option>
        </select>
      </label>
      <div class="be-dim">Saída: 1080×1920 vertical</div>
      <div class="be-sep"></div>
      <div class="be-side-title">Áudio</div>
      <button id="beAddAudio2" class="be-tool-btn">🎵 Adicionar música/narração</button>
      <input type="file" id="beAudioFile" accept="audio/mpeg,audio/wav,audio/mp4,.mp3,.wav,.m4a,.aac" hidden/>
      <div id="beAudioCount" class="be-dim">Nenhum áudio adicional</div>
      <label class="be-slider-label">Volume do vídeo <input id="beVolVideo" type="range" min="0" max="2" step="0.05" value="1"/></label>
      <button id="beDetachAudio" class="be-tool-btn" title="Ctrl+Shift+S">🔀 Separar áudio do vídeo</button>
      <div class="be-sep"></div>
      <div class="be-side-title">Legendas</div>
      <div class="be-dim">Abra <b>💬 Legendas</b> na barra lateral pra escolher o estilo e gerar.</div>
      <div class="be-sep"></div>
      <div class="be-side-title">Transições</div>
      <div id="beTransitions" class="be-transitions"></div>
    </div>

    <!-- BIBLIOTECA DE ÁUDIO (Músicas / Efeitos / Favoritos) -->
    <div id="bePropsAudioLib" class="be-props-stack" style="display:none">
      <div class="be-side-title">♪ Áudio <button id="beAudioLibClose" class="be-tool-btn" style="float:right;padding:1px 8px">✕</button></div>
      <div class="be-cfg-subtabs" id="beAudioLibTabs">
        <button data-atab="musicas" class="be-cfg-subtab active">Músicas</button>
        <button data-atab="efeitos" class="be-cfg-subtab">Efeitos</button>
        <button data-atab="favoritos" class="be-cfg-subtab">Favoritos</button>
      </div>
      <input id="beAudioLibSearch" class="be-select" placeholder="🔎 Buscar…" style="width:100%"/>
      <div id="beAudioLibResults" class="be-audio-lib"></div>
      <div class="be-sep"></div>
      <button id="beAudioLibImport" class="be-tool-btn">＋ Importar seu áudio</button>
      <div class="be-dim">Narração/música própria (MP3, WAV, M4A).</div>
    </div>

    <!-- PAINEL DEDICADO DE LEGENDAS (escolhe estilo ANTES de transcrever) -->
    <div id="bePropsCaptions" class="be-props-stack" style="display:none">
      <div class="be-side-title">💬 Legendas <button id="beCapClose" class="be-tool-btn" style="float:right;padding:1px 8px">✕</button></div>
      <div class="be-dim">Escolha o modelo, depois gere. A legenda acompanha a fala do seu áudio (o áudio que você gravou tem prioridade).</div>

      <div class="be-side-sub">Modo</div>
      <div class="be-cap-modes" id="beCapModeCards">
        <button class="be-cap-card" data-mode="frase">
          <div class="be-cap-demo demo-multi"><span>sua fala</span><span>em multilinha</span></div>
          <div class="be-cap-name">Multilinha</div>
        </button>
        <button class="be-cap-card active" data-mode="palavra">
          <div class="be-cap-demo demo-word"><i>palavra</i><i>por</i><i>palavra</i></div>
          <div class="be-cap-name">Palavra por palavra</div>
        </button>
      </div>
      <select id="beCapMode" style="display:none"><option value="frase">frase</option><option value="palavra" selected>palavra</option></select>

      <div class="be-side-sub">Estilo</div>
      <div class="be-cap-styles" id="beCapStyleGrid"></div>

      <button id="beAutoCaptions2" class="be-tool-btn be-cap-generate">✨ Gerar legendas automáticas</button>

      <div id="beCapStyleRow" style="display:none;flex-direction:column;gap:8px">
        <div class="be-sep"></div>
        <div class="be-side-sub">Ajuste fino</div>
        <select id="beCapPreset" style="display:none"><option value=""></option></select>
        <div class="be-panel-row">
          <label>Tamanho <select id="beCapSize">
            <option value="small">Pequeno</option>
            <option value="medium" selected>Médio</option>
            <option value="large">Grande</option>
          </select></label>
          <label>Cor <input id="beCapColor" type="color" value="#ffffff"/></label>
          <label>Posição <select id="beCapPos">
            <option value="0.82" selected>Embaixo</option>
            <option value="0.5">Centro</option>
            <option value="0.15">Em cima</option>
          </select></label>
        </div>
        <button id="beCapDeleteAll" class="be-danger-btn">🗑 Remover todas as legendas</button>
      </div>
    </div>

    <div id="bePropsClip" class="be-props-stack" style="display:none">
      <div class="be-side-title">Cena selecionada <span class="be-dim" style="font-weight:400">· <span id="beClipDur">–</span></span></div>
      <!-- ABAS estilo CapCut -->
      <div class="be-cfg-tabs" id="beCfgTabs">
        <button data-tab="video" class="be-cfg-tab active">Vídeo</button>
        <button data-tab="audio" class="be-cfg-tab">Áudio</button>
        <button data-tab="velocidade" class="be-cfg-tab">Velocidade</button>
        <button data-tab="animacao" class="be-cfg-tab">Animação</button>
        <button data-tab="ajuste" class="be-cfg-tab">Ajuste</button>
      </div>

      <!-- ABA VÍDEO -->
      <div class="be-cfg-panel" data-panel="video">
        <div class="be-cfg-subtabs" id="beCfgSubtabs">
          <button data-sub="basico" class="be-cfg-subtab active">Básico</button>
          <button data-sub="fundo" class="be-cfg-subtab">Remover fundo</button>
          <button data-sub="mascarar" class="be-cfg-subtab">Mascarar</button>
          <button data-sub="retoque" class="be-cfg-subtab">Retoque</button>
        </div>
        <div class="be-cfg-sub" data-sub="basico">
          <label class="be-slider-label">Escala <b id="beClipScaleVal">100%</b>
            <input id="beClipScale" type="range" min="10" max="200" step="1" value="100"/>
          </label>
          <label class="be-slider-label">Opacidade <b id="beClipOpacityVal">100%</b>
            <input id="beClipOpacity" type="range" min="0" max="100" step="1" value="100"/>
          </label>
          <div class="be-sep"></div>
          <button id="beToggleClip2" class="be-tool-btn">◌ Desativar cena</button>
          <button id="beDelClip2" class="be-danger-btn">🗑 Excluir cena</button>
          <div class="be-dim">Arraste as bordas azuis na timeline pra cortar · V liga/desliga · Ctrl+B divide</div>
        </div>
        <div class="be-cfg-sub" data-sub="fundo" style="display:none">
          <div class="be-dim">🪄 Remoção de plano de fundo por IA — <b>em breve</b>.</div>
        </div>
        <div class="be-cfg-sub" data-sub="mascarar" style="display:none">
          <div class="be-dim">⬭ Máscaras (formas, recorte) — <b>em breve</b>.</div>
        </div>
        <div class="be-cfg-sub" data-sub="retoque" style="display:none">
          <div class="be-dim">✨ Retoque facial e ajustes de pele — <b>em breve</b>.</div>
        </div>
      </div>

      <!-- demais abas (placeholder até implementarmos) -->
      <div class="be-cfg-panel" data-panel="audio" style="display:none">
        <div class="be-dim">🔊 Volume e efeitos de áudio desta cena — <b>em breve</b>. (Por ora, separe o áudio com Ctrl+Shift+S pra editar na faixa.)</div>
      </div>
      <div class="be-cfg-panel" data-panel="velocidade" style="display:none">
        <label class="be-slider-label">Velocidade <b id="beClipSpeedVal">1.00x</b>
          <input id="beClipSpeed" type="range" min="-100" max="200" step="1" value="0"/>
        </label>
        <div class="be-dim">Arraste pra desacelerar (até 0.10x) ou acelerar (até 100x). Afeta só esta cena — a duração na timeline muda junto.</div>
        <button id="beClipSpeedReset" class="be-tool-btn">↺ Voltar pra 1.00x</button>
      </div>
      <div class="be-cfg-panel" data-panel="animacao" style="display:none">
        <div class="be-dim">🎬 Animações de entrada/saída — <b>em breve</b>.</div>
      </div>
      <div class="be-cfg-panel" data-panel="ajuste" style="display:none">
        <div class="be-dim">🎚 Brilho, contraste, saturação, temperatura — <b>em breve</b>.</div>
      </div>
    </div>

    <div id="bePropsOverlay" class="be-props-stack" style="display:none">
      <div class="be-side-title">⧉ Camada</div>
      <div class="be-dim">Arraste no preview pra posicionar · scroll = tamanho · ⟳ acima = girar · bordas na timeline = cortar.</div>
      <label class="be-slider-label">Velocidade <b id="beOvSpeedVal">1.00x</b>
        <input id="beOvSpeed" type="range" min="-100" max="200" step="1" value="0"/>
      </label>
      <label class="be-slider-label">Girar <b id="beOvRotVal">0°</b>
        <input id="beOvRot" type="range" min="0" max="359" step="1" value="0"/>
      </label>
      <div class="be-dim">Botão direito na camada = Copiar/Cortar/frente-trás. Q/W cortam no cursor.</div>
      <button id="beOverlayDelete" class="be-danger-btn">🗑 Excluir camada</button>
    </div>

    <div id="bePropsAudio" class="be-props-stack" style="display:none">
      <div class="be-side-title" id="beAudioPanelTitle">♪ Áudio</div>
      <div class="be-dim">Duração: <span id="beAudioClipDur">–</span> · corte com ✂, arraste pra mover</div>
      <label class="be-slider-label">Volume <input id="beVolSelected" type="range" min="0" max="2" step="0.05" value="1"/></label>
      <label class="be-slider-label">Velocidade <b id="beAudioSpeedVal">1.00x</b>
        <input id="beAudioSpeed" type="range" min="-100" max="200" step="1" value="0"/>
      </label>
      <button id="beAudioItemDelete" class="be-danger-btn">🗑 Excluir áudio</button>
      <div class="be-dim">Delete/Backspace também exclui o item selecionado</div>
    </div>

    <div id="beTextPanel" class="be-props-stack" style="display:none">
      <div class="be-panel-head">Texto <button id="beTextClose" class="be-icon-btn">✕</button></div>
      <!-- sub-abas: Legendas (transcrição) | Texto (formatação) -->
      <div class="be-cfg-tabs" id="beTextTabs">
        <button data-ttab="texto" class="be-cfg-tab active">Texto</button>
        <button data-ttab="legendas" class="be-cfg-tab" id="beTextTabCap">Legendas</button>
      </div>

      <!-- ABA TEXTO: formatação -->
      <div class="be-text-tab" data-ttab="texto">
        <label class="be-cap-applyall" id="beCapApplyAllRow" style="display:none">
          <input type="checkbox" id="beCapApplyAll" checked/> Aplicar a todas as legendas
        </label>
        <textarea id="beTextContent" rows="2" maxlength="200" placeholder="Digite o texto…"></textarea>
        <div class="be-panel-row">
          <label>Fonte <select id="beTextFont">${TEXT_FONTS.map(f => `<option>${f}</option>`).join('')}</select></label>
          <label>Tamanho <select id="beTextSize">${TEXT_SIZES.map(s => `<option value="${s}">${({ small: 'Pequeno', medium: 'Médio', large: 'Grande', xlarge: 'Gigante' })[s]}</option>`).join('')}</select></label>
        </div>
        <div class="be-panel-row">
          <label>Cor <input id="beTextColor" type="color" value="#ffffff"/></label>
          <label>Caixa
            <span class="be-btn-group">
              <button type="button" data-case="upper" title="MAIÚSCULAS">TT</button>
              <button type="button" data-case="lower" title="minúsculas">tt</button>
              <button type="button" data-case="title" title="Primeira Maiúscula">Tt</button>
            </span>
          </label>
        </div>
        <div class="be-panel-row">
          <label>Posição <select id="beTextPos">
            <option value="0.82">Embaixo</option>
            <option value="0.5">Centro</option>
            <option value="0.15">Em cima</option>
          </select></label>
          <label>Início (s) <input id="beTextStart" type="number" min="0" step="0.1"/></label>
          <label>Fim (s) <input id="beTextEnd" type="number" min="0" step="0.1"/></label>
        </div>
        <button id="beTextDelete" class="be-danger-btn">Excluir texto</button>
        <div class="be-dim">Arraste o texto direto no preview pra posicionar</div>
      </div>

      <!-- ABA LEGENDAS: transcrição completa clicável -->
      <div class="be-text-tab" data-ttab="legendas" style="display:none">
        <div class="be-dim">Transcrição completa — clique numa linha pra editar aquele ponto.</div>
        <div id="beTranscriptList" class="be-transcript"></div>
      </div>
    </div>

  </div>

  <!-- toolbar + timeline multi-track -->
  <div class="be-timeline-area">
    <div id="beCompoundBar" style="display:none;align-items:center;gap:10px;padding:4px 2px">
      <button id="beCompoundExit" class="be-tool-btn">← Sair do clipe</button>
      <span id="beCompoundName" class="be-dim"></span>
    </div>
    <div class="be-toolbar">
      <button id="beSplit" class="be-tool-btn" title="Dividir no cursor (Ctrl+B)">✂ Dividir</button>
      <button id="beDelLeft" class="be-tool-btn" title="Apagar antes do cursor (Q)">⇤ Apagar antes</button>
      <button id="beDelRight" class="be-tool-btn" title="Apagar depois do cursor (W)">⇥ Apagar depois</button>
      <button id="beToggleClip" class="be-tool-btn" title="Ativar/desativar cena (V)">◫ Liga/desliga</button>
      <button id="beDelClip" class="be-tool-btn" title="Excluir cena selecionada (Delete)">🗑 Excluir</button>
      <span class="be-toolbar-sep"></span>
      <button id="beAddText2" class="be-tool-btn" title="Adicionar texto no cursor">＋ Texto</button>
      <button id="beGroupBtn" class="be-tool-btn" title="Agrupar selecionados em clipe composto (Alt+G)">⧉ Agrupar</button>
      <span class="be-toolbar-spacer"></span>
      <button id="beZoomOut" class="be-icon-btn" title="Zoom - (Ctrl -)">−</button>
      <button id="beZoomFit" class="be-icon-btn" title="Caber (Shift+Z)">⤢</button>
      <button id="beZoomIn" class="be-icon-btn" title="Zoom + (Ctrl +)">＋</button>
    </div>
    <div class="be-timeline-row">
      <div class="be-track-headers" aria-hidden="true">
        <div style="height:${M.RULER_H + M.TRACK_GAP}px"></div>
        <div class="be-track-h" style="height:${M.VIDEO_TRACK_H}px" title="Vídeo">🎞</div>
        <div style="height:${M.TRACK_GAP}px"></div>
        <div class="be-track-h" style="height:${M.TEXT_TRACK_H}px" title="Textos">T</div>
        <div style="height:${M.TRACK_GAP}px"></div>
        <div class="be-track-h" style="height:${M.AUDIO_TRACK_H}px" title="Áudio">♪</div>
      </div>
      <div class="be-timeline-wrap">
        <canvas id="beTimeline"></canvas>
      </div>
    </div>
    <div class="be-hint be-dim">Espaço reproduz · Ctrl+B divide · Q/W apagam antes/depois · arraste as cenas pra reordenar · toque longo (celular) move</div>
  </div>
</div>

<div id="beExportModal" class="be-modal">
  <div class="be-modal-box">
    <div id="beExportProgress">
      <div class="be-modal-title">Exportando seu vídeo…</div>
      <div class="be-progress"><i id="beExportBar"></i></div>
      <div id="beExportLabel" class="be-dim">Preparando…</div>
      <button id="beExportCancel" class="be-tool-btn">Cancelar</button>
    </div>
    <div id="beExportDone" style="display:none">
      <div class="be-modal-title">✅ Pronto!</div>
      <video id="beExportPreview" controls playsinline class="be-export-video"></video>
      <a id="beExportLink" class="be-export-btn" download target="_blank" rel="noopener">⬇ Baixar vídeo</a>
      <button id="beExportClose" class="be-tool-btn">Fechar</button>
    </div>
    <div id="beExportError" style="display:none">
      <div class="be-modal-title">⚠ Algo deu errado</div>
      <div id="beExportErrorMsg" class="be-dim"></div>
      <button class="be-tool-btn" onclick="this.closest('.be-modal').classList.remove('open')">Fechar</button>
    </div>
  </div>
</div>

<div id="beProjects" class="be-projects" style="display:none"></div>
<div id="beToast" class="be-toast"></div>
`;
}
