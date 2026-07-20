// editor-v1/ui/shell.js
// Monta a UI no layout CapCut: preview central + painel de propriedades
// CONTEXTUAL a direita (muda com a selecao) + timeline multi-track embaixo
// com cabecalhos de track. Store continua a unica fonte de verdade.

import * as act from '../core/actions.js';
import { totalDuration, canExport, timelineSegments, sourceToTimeline } from '../core/selectors.js';
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
  // primaryUrl: o player troca o src por take (multi-midia); pro PRINCIPAL a
  // url preferida e o objectURL local (instantaneo, pre-CDN) quando existir
  const player = createPlayer(videoEl, {
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

  let thumbs = null;
  let wave = null;
  let videoWave = null;
  // preview local do arquivo recem-enviado (playback instantaneo pre-CDN)
  const localPreview = { url: null, for: null };
  let mediaPanelOpen = false; // painel 🎞 Mídia (pool do projeto)

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
    // WYSIWYG do formato: letterbox = video inteiro com barras (contain)
    videoEl.style.objectFit = state.aspect_strategy === 'letterbox' ? 'contain' : 'cover';
    // audio destacado = video mudo (o audio vive nos audio_clips)
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

    renderTransitionsRow(state);
    syncPropsPanel(state);
    $('#beCapStyleRow').style.display = state.texts.some(t => t.caption) ? 'flex' : 'none';
  }
  store.subscribe(sync);
  player.onUpdate(() => {
    const state = store.getState();
    $('#beTimeLabel').textContent = `${formatTime(player.getTime())} / ${formatTime(totalDuration(state))}`;
    $('#bePlayBtn').textContent = player.isPlaying() ? '⏸' : '▶';
    if (player.isPlaying()) timeline.followPlayhead();
  });

  // ── painel de propriedades CONTEXTUAL (estilo CapCut) ──
  // nada selecionado -> propriedades do projeto
  // clip selecionado -> acoes do clip | texto selecionado -> editor de texto
  function syncPropsPanel(state) {
    const showText = state.selected_text_id != null;
    const showOv = !showText && state.selected_overlay_id != null;
    const showAudio = !showText && !showOv && state.selected_audio_id != null;
    const showClip = !showText && !showOv && !showAudio && state.selected_clip_id != null;
    const nadaSel = !showText && !showOv && !showAudio && !showClip;
    const showMedia = mediaPanelOpen && nadaSel;
    $('#beTextPanel').style.display = showText ? 'flex' : 'none';
    $('#bePropsAudio').style.display = showAudio ? 'flex' : 'none';
    $('#bePropsOverlay').style.display = showOv ? 'flex' : 'none';
    $('#bePropsClip').style.display = showClip ? 'flex' : 'none';
    $('#bePropsMedia').style.display = showMedia ? 'flex' : 'none';
    $('#bePropsProject').style.display = (nadaSel && !showMedia) ? 'flex' : 'none';
    if (showMedia) renderMediaPanel();
    if (showText) fillTextPanel(state);
    if (showAudio) {
      const ac = state.audio_clips.find(a => a.id === state.selected_audio_id);
      if (ac) {
        $('#beAudioPanelTitle').textContent = '♪ ' + (ac.filename || 'áudio');
        $('#beVolSelected').value = ac.volume ?? 1;
        $('#beAudioClipDur').textContent = (ac.source_out - ac.source_in).toFixed(1) + 's';
      }
    }
    if (showClip) {
      const clip = state.clips.find(c => c.id === state.selected_clip_id);
      if (clip) {
        $('#beClipDur').textContent = `${(clip.source_out - clip.source_in).toFixed(1)}s`;
        $('#beToggleClip2').textContent = clip.active === false ? '◉ Reativar cena' : '◌ Desativar cena';
      }
    }
    // botao "separar audio" so faz sentido antes do detach
    $('#beDetachAudio').style.display = state.audio_detached ? 'none' : 'block';
  }

  function setupThumbsAndWave(state) {
    thumbs?.destroy();
    thumbs = createThumbnails(videoEl, state.video.duration, () => timeline.draw());
    timeline.setThumbs(thumbs);
    // waveform do audio DO VIDEO (strip no clip, estilo CapCut). Usa o mesmo
    // src do player (objectURL local quando disponivel = zero rede).
    videoWave?.destroy();
    const waveSrc = (localPreview.for === state.video.url && localPreview.url)
      ? localPreview.url : state.video.url;
    videoWave = createWaveform(waveSrc, () => timeline.draw(), { color: 'rgba(34,197,94,.9)' });
    timeline.setVideoWave(videoWave);
    syncWaveRegistry(state);
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
        } else if (/^image\//.test(file.type)) {
          toast('Imagens na timeline: em breve — por enquanto vídeo e áudio', true);
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

  // ── painel Mídia (pool de midias do projeto) ──
  $('#beAddMedia').addEventListener('click', () => {
    mediaPanelOpen = !mediaPanelOpen;
    if (mediaPanelOpen) store.dispatch(act.selectClip(null)); // painel contextual libera
    renderMediaPanel();
    sync();
  });
  $('#beMediaImport')?.addEventListener('click', () => fileInput.click());
  $('#beMediaClose')?.addEventListener('click', () => { mediaPanelOpen = false; sync(); });

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
  function fillTextPanel(state) {
    const txt = state.texts.find(x => x.id === state.selected_text_id);
    if (!txt || editingTextId === txt.id) return; // nao sobrescreve enquanto digita
    editingTextId = txt.id;
    $('#beTextContent').value = txt.content;
    $('#beTextFont').value = txt.font;
    $('#beTextSize').value = txt.size;
    $('#beTextColor').value = txt.color;
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
  for (const [sel, field, parse] of [
    ['#beTextContent', 'content', v => v],
    ['#beTextFont', 'font', v => v],
    ['#beTextSize', 'size', v => v],
    ['#beTextColor', 'color', v => v],
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

  // ── audio extra ──
  const audioInput = $('#beAudioFile');
  const pickAudio = () => audioInput.click();
  $('#beAddAudio').addEventListener('click', pickAudio);
  $('#beAddAudio2').addEventListener('click', pickAudio);
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
  // words da ultima transcricao ficam em memoria: trocar o MODO nao paga
  // nova transcricao (regenera local a partir das palavras).
  let lastCaptionWords = null;
  let lastCaptionPhrases = null;

  function aplicarLegendas(mode) {
    const words = lastCaptionWords || [];
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

    const state = store.getState();
    // Whisper devolve tempos do ARQUIVO original; a timeline pode ter cortes/
    // reordenacao. Mapear fonte->timeline mantem a legenda em cima da fala
    // mesmo depois de editar (palavras em trechos cortados somem).
    const caps = [];
    for (const c of brutos) {
      const ts = sourceToTimeline(state, c.start);
      if (ts == null) continue; // fala num trecho removido
      const te = sourceToTimeline(state, c.end);
      const dur = te != null && te > ts ? te - ts : Math.max(0.25, c.end - c.start);
      caps.push({ text: c.text, start: ts, end: ts + dur });
    }
    if (!caps.length) return 0;

    // preserva o estilo atual (se o user ja tinha legendas estilizadas)
    const atual = state.texts.find(t => t.caption);
    const estilo = {
      font: atual?.font || 'Anton', size: atual?.size || 'medium',
      color: atual?.color || '#ffffff', y_pct: atual?.y_pct ?? 0.82,
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
    if (!state.video?.url) return toast('Envie um vídeo primeiro', true);
    const mode = $('#beCapMode')?.value || 'frase';
    try {
      if (!lastCaptionWords) {
        toast('Transcrevendo áudio… (pode levar ~1min)');
        const r = await api.autoCaptions(state.video.url);
        lastCaptionPhrases = r.captions || [];
        lastCaptionWords = r.words || [];
        if (!lastCaptionPhrases.length && !lastCaptionWords.length) {
          return toast('Nenhuma fala detectada no áudio', true);
        }
      }
      const n = aplicarLegendas(mode);
      if (!n) return toast('Nenhuma fala detectada no áudio', true);
      $('#beCapStyleRow').style.display = 'flex';
      toast(n + (mode === 'palavra' ? ' palavras' : ' legendas') + ' geradas ✓ — sincronizadas com a fala');
    } catch (e) {
      const msg = (e.status === 504 || /timeout|timed out|HTTP 50/i.test(e.message || ''))
        ? 'A transcrição demorou demais — tente um vídeo mais curto'
        : e.message;
      toast('Legendas: ' + msg, true);
    }
  }
  $('#beAutoCaptions').addEventListener('click', generateCaptions);
  $('#beAutoCaptions2').addEventListener('click', generateCaptions);
  // trocar o modo REGENERA na hora (sem nova transcricao) se ja ha legendas
  $('#beCapMode').addEventListener('change', () => {
    if (lastCaptionWords && store.getState().texts.some(t => t.caption)) {
      const n = aplicarLegendas($('#beCapMode').value);
      if (n) toast('Legendas regeneradas: ' + n + ' blocos');
    }
  });
  // limpar words se trocar de video
  let lastVideoUrl = store.getState().video?.url || null;
  store.subscribe(() => {
    const u = store.getState().video?.url || null;
    if (u !== lastVideoUrl) { lastVideoUrl = u; lastCaptionWords = null; lastCaptionPhrases = null; }
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
  $('#beCapPreset').addEventListener('change', (e) => {
    const p = CAP_PRESETS[e.target.value];
    if (!p) return;
    applyCapStyle(p);
    // espelha nos controles individuais
    $('#beCapSize').value = p.size;
    $('#beCapColor').value = p.color;
    toast('Estilo aplicado em todas as legendas ✓');
  });

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
      thumbs?.destroy(); wave?.destroy(); videoWave?.destroy();
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
  <input type="file" id="beFile" multiple accept="video/mp4,video/quicktime,video/webm,audio/mpeg,audio/wav,audio/mp4,.mp4,.mov,.webm,.mp3,.wav,.m4a,.aac" hidden/>
</div>

<div id="beWorkspace" class="be-workspace" style="display:none">

  <!-- rail de acoes (CapCut: Midia / Texto / Audio) -->
  <div class="be-rail">
    <button id="beAddMedia" class="be-rail-btn" title="Mídias do projeto — importar e ver vídeos/áudios (Ctrl+O importa direto)"><span>🎞</span>Mídia</button>
    <button id="beAddText" class="be-rail-btn" title="Adicionar texto"><span>T</span>Texto</button>
    <button id="beAddAudio" class="be-rail-btn" title="Adicionar música/narração"><span>♪</span>Áudio</button>
    <button id="beAutoCaptions" class="be-rail-btn" title="Gerar legendas automáticas (IA)"><span>💬</span>Legendas</button>
  </div>

  <!-- preview central -->
  <div class="be-preview-area">
    <div class="be-preview-frame">
      <video id="beVideo" playsinline preload="auto"></video>
      <div id="beOverlay"></div>
    </div>
    <audio id="beAudio" preload="auto"></audio>
    <div class="be-transport">
      <button id="bePlayBtn" class="be-play-btn">▶</button>
      <span id="beTimeLabel" class="be-time">0:00 / 0:00</span>
    </div>
  </div>

  <!-- painel de propriedades contextual (CapCut right panel) -->
  <div class="be-props">

    <div id="bePropsMedia" class="be-props-stack" style="display:none">
      <div class="be-side-title">🎞 Mídia do projeto <button id="beMediaClose" class="be-tool-btn" style="float:right;padding:1px 8px">✕</button></div>
      <button id="beMediaImport" class="be-tool-btn">＋ Importar mídias (Ctrl+O)</button>
      <div class="be-dim">Vídeos viram takes no fim da timeline; áudios entram na faixa de áudio. Pode selecionar vários de uma vez ou arrastar aqui.</div>
      <div id="beMediaList"></div>
    </div>

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
      <label class="be-dim" style="display:flex;flex-direction:column;gap:3px">Modo
        <select id="beCapMode">
          <option value="frase" selected>Frase (multilinha)</option>
          <option value="palavra">Palavra por palavra (acompanha a fala)</option>
        </select>
      </label>
      <button id="beAutoCaptions2" class="be-tool-btn">💬 Gerar legendas automáticas</button>
      <div id="beCapStyleRow" style="display:none;flex-direction:column;gap:6px">
        <label class="be-dim" style="display:flex;flex-direction:column;gap:3px">Estilo
          <select id="beCapPreset">
            <option value="">— escolher estilo —</option>
            <optgroup label="Clássicos">
              <option value="classico">Branco clássico</option>
              <option value="amarelo">Amarelo destaque</option>
            </optgroup>
            <optgroup label="Impacto">
              <option value="impacto">Bebas grande</option>
              <option value="oswald">Oswald forte</option>
            </optgroup>
            <optgroup label="Coloridos">
              <option value="neon">Ciano neon</option>
              <option value="lima">Verde lima</option>
              <option value="pop">Rosa pop</option>
            </optgroup>
          </select>
        </label>
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
      <div class="be-sep"></div>
      <div class="be-side-title">Transições</div>
      <div id="beTransitions" class="be-transitions"></div>
    </div>

    <div id="bePropsClip" class="be-props-stack" style="display:none">
      <div class="be-side-title">Cena selecionada</div>
      <div class="be-dim">Duração: <span id="beClipDur">–</span></div>
      <div class="be-dim">Arraste as bordas azuis na timeline pra ajustar o corte. Arraste o corpo pra reordenar.</div>
      <button id="beToggleClip2" class="be-tool-btn">◌ Desativar cena</button>
      <button id="beDelClip2" class="be-danger-btn">🗑 Excluir cena</button>
      <div class="be-dim">Atalhos: V liga/desliga · Delete exclui · Ctrl+B divide no cursor</div>
    </div>

    <div id="bePropsOverlay" class="be-props-stack" style="display:none">
      <div class="be-side-title">⧉ Camada (overlay)</div>
      <div class="be-dim">Arraste a camada direto no preview pra posicionar. Scroll em cima dela = tamanho. Arraste as bordas na timeline pra cortar.</div>
      <button id="beOverlayDelete" class="be-danger-btn">🗑 Excluir camada</button>
    </div>

    <div id="bePropsAudio" class="be-props-stack" style="display:none">
      <div class="be-side-title" id="beAudioPanelTitle">♪ Áudio</div>
      <div class="be-dim">Duração: <span id="beAudioClipDur">–</span> · corte com ✂, arraste pra mover</div>
      <label class="be-slider-label">Volume <input id="beVolSelected" type="range" min="0" max="2" step="0.05" value="1"/></label>
      <button id="beAudioItemDelete" class="be-danger-btn">🗑 Excluir áudio</button>
      <div class="be-dim">Delete/Backspace também exclui o item selecionado</div>
    </div>

    <div id="beTextPanel" class="be-props-stack" style="display:none">
      <div class="be-panel-head">Texto <button id="beTextClose" class="be-icon-btn">✕</button></div>
      <textarea id="beTextContent" rows="2" maxlength="200" placeholder="Digite o texto…"></textarea>
      <div class="be-panel-row">
        <label>Fonte <select id="beTextFont">${TEXT_FONTS.map(f => `<option>${f}</option>`).join('')}</select></label>
        <label>Tamanho <select id="beTextSize">${TEXT_SIZES.map(s => `<option value="${s}">${({ small: 'Pequeno', medium: 'Médio', large: 'Grande', xlarge: 'Gigante' })[s]}</option>`).join('')}</select></label>
      </div>
      <div class="be-panel-row">
        <label>Cor <input id="beTextColor" type="color" value="#ffffff"/></label>
        <label>Início (s) <input id="beTextStart" type="number" min="0" step="0.1"/></label>
        <label>Fim (s) <input id="beTextEnd" type="number" min="0" step="0.1"/></label>
      </div>
      <button id="beTextDelete" class="be-danger-btn">Excluir texto</button>
      <div class="be-dim">Arraste o texto direto no preview pra posicionar</div>
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
