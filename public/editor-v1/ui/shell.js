// editor-v1/ui/shell.js
// Monta a UI inteira e liga os modulos. Paineis (texto/audio/export/projetos)
// vivem aqui como secoes — store continua a unica fonte de verdade.

import * as act from '../core/actions.js';
import { totalDuration, canExport, timelineSegments } from '../core/selectors.js';
import { TEXT_FONTS, TEXT_SIZES } from '../core/schema.js';
import { formatTime } from '../timeline/layout.js';
import { createPlayer } from '../preview/player.js';
import { createOverlay } from '../preview/overlay.js';
import { createTimelineController } from './timeline-controller.js';
import { attachShortcuts } from './shortcuts.js';
import { createThumbnails } from '../timeline/thumbnails.js';
import { createWaveform } from '../timeline/waveform.js';
import { uploadMedia } from '../services/upload.js';
import { createAutosave } from '../services/autosave.js';
import { createExporter } from '../services/exporter.js';
import { api } from '../services/api.js';

export function mountEditor(root, store) {
  root.innerHTML = TEMPLATE;
  const $ = (sel) => root.querySelector(sel);

  const videoEl = $('#beVideo');
  const audioEl = $('#beAudio');
  const player = createPlayer(videoEl, audioEl, store);
  const timeline = createTimelineController({
    canvas: $('#beTimeline'),
    store, player,
    onEditText: openTextPanel,
  });
  const overlay = createOverlay($('#beOverlay'), store, player, openTextPanel);
  const exporter = createExporter(store);
  const autosave = createAutosave(store, (s, detail) => {
    const el = $('#beSaveStatus');
    el.textContent = s === 'saving' ? '◌ salvando…' : s === 'saved' ? '✓ salvo' : s === 'error' ? '⚠ ' + (detail || 'erro ao salvar') : '';
    el.className = 'be-save-status ' + s;
  });
  const detachShortcuts = attachShortcuts({ store, player, timeline });

  let thumbs = null;
  let wave = null;

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
    $('#beVolAudio').value = state.volumes.audio_extra;
    $('#beAudioRow').style.display = state.audio_extra ? 'flex' : 'none';
    $('#beAudioName').textContent = state.audio_extra?.filename || '';
    $('#beAspect').value = state.aspect_strategy;
    // video source
    if (has && videoEl.src !== state.video.url) {
      videoEl.src = state.video.url;
      videoEl.load();
      setupThumbsAndWave(state);
    }
    if (state.audio_extra?.url) {
      if (audioEl.src !== state.audio_extra.url) { audioEl.src = state.audio_extra.url; audioEl.load(); }
    } else if (audioEl.src) {
      audioEl.removeAttribute('src'); audioEl.load();
    }
    renderTransitionsRow(state);
  }
  store.subscribe(sync);
  player.onUpdate(() => {
    const state = store.getState();
    $('#beTimeLabel').textContent = `${formatTime(player.getTime())} / ${formatTime(totalDuration(state))}`;
    $('#bePlayBtn').textContent = player.isPlaying() ? '⏸' : '▶';
    if (player.isPlaying()) timeline.followPlayhead();
  });

  function setupThumbsAndWave(state) {
    thumbs?.destroy();
    thumbs = createThumbnails(videoEl, state.video.duration, () => timeline.draw());
    timeline.setThumbs(thumbs);
    if (state.audio_extra?.url) {
      wave?.destroy();
      wave = createWaveform(state.audio_extra.url, () => timeline.draw());
      timeline.setWave(wave);
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
    const f = e.dataTransfer?.files?.[0];
    if (f) doUploadVideo(f);
  });
  fileInput.addEventListener('change', () => {
    if (fileInput.files?.[0]) doUploadVideo(fileInput.files[0]);
    fileInput.value = '';
  });

  async function doUploadVideo(file) {
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
      store.dispatch(act.setVideo(media));
      player.seek(0);
      timeline.zoomFit();
      toast('Vídeo carregado ✓');
    } catch (e) {
      toast(e.message, true);
      msg.textContent = 'Arraste um vídeo ou clique pra escolher';
    } finally {
      bar.style.display = 'none';
      bar.querySelector('i').style.width = '0%';
    }
  }

  // ── transporte ──
  $('#bePlayBtn').addEventListener('click', () => player.toggle());
  $('#beProjectName').addEventListener('change', (e) => store.dispatch(act.renameProject(e.target.value)));
  $('#beUndo').addEventListener('click', () => store.undo());
  $('#beRedo').addEventListener('click', () => store.redo());

  // ── toolbar ──
  $('#beSplit').addEventListener('click', () => store.dispatch(act.splitClipAt(player.getTime())));
  $('#beDelLeft').addEventListener('click', () => { store.dispatch(act.deleteRangeLeft(player.getTime())); player.seek(0.001); });
  $('#beDelRight').addEventListener('click', () => store.dispatch(act.deleteRangeRight(player.getTime())));
  $('#beToggleClip').addEventListener('click', () => {
    const s = store.getState();
    if (s.selected_clip_id != null) store.dispatch(act.toggleClip(s.selected_clip_id));
  });
  $('#beDelClip').addEventListener('click', () => {
    const s = store.getState();
    if (s.selected_clip_id != null) store.dispatch(act.deleteClip(s.selected_clip_id));
  });
  $('#beZoomIn').addEventListener('click', () => timeline.zoomBy(1.25));
  $('#beZoomOut').addEventListener('click', () => timeline.zoomBy(1 / 1.25));
  $('#beZoomFit').addEventListener('click', () => timeline.zoomFit());
  $('#beAddText').addEventListener('click', () => {
    const t = player.getTime();
    store.dispatch(act.addText({ content: 'Seu texto', start_sec: t, end_sec: Math.min(t + 3, Math.max(t + 1, totalDuration(store.getState()))) }));
    openTextPanel(store.getState().texts.at(-1).id);
  });

  // ── painel de texto ──
  const textPanel = $('#beTextPanel');
  let editingTextId = null;
  function openTextPanel(textId) {
    const state = store.getState();
    const txt = state.texts.find(x => x.id === textId);
    if (!txt) return;
    editingTextId = textId;
    $('#beTextContent').value = txt.content;
    $('#beTextFont').value = txt.font;
    $('#beTextSize').value = txt.size;
    $('#beTextColor').value = txt.color;
    $('#beTextStart').value = txt.start_sec.toFixed(1);
    $('#beTextEnd').value = txt.end_sec.toFixed(1);
    textPanel.classList.add('open');
    store.dispatch(act.selectText(textId));
    setTimeout(() => $('#beTextContent').focus(), 60);
  }
  $('#beTextClose').addEventListener('click', () => { textPanel.classList.remove('open'); editingTextId = null; });
  $('#beTextDelete').addEventListener('click', () => {
    if (editingTextId != null) store.dispatch(act.deleteText(editingTextId));
    textPanel.classList.remove('open');
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
      if (editingTextId == null) return;
      store.dispatch({ ...act.updateText(editingTextId, { [field]: parse(e.target.value) }), gestureId: 'textpanel-' + editingTextId + '-' + field });
    });
    $(sel).addEventListener('change', () => store.endGesture());
  }

  // ── audio extra ──
  const audioInput = $('#beAudioFile');
  $('#beAddAudio').addEventListener('click', () => audioInput.click());
  audioInput.addEventListener('change', async () => {
    const f = audioInput.files?.[0];
    audioInput.value = '';
    if (!f) return;
    try {
      toast('Enviando áudio…');
      const media = await uploadMedia(f, 'audio', () => {});
      store.dispatch(act.setAudioExtra(media));
      wave?.destroy();
      wave = createWaveform(media.url, () => timeline.draw());
      timeline.setWave(wave);
      toast('Áudio adicionado ✓');
    } catch (e) { toast(e.message, true); }
  });
  $('#beAudioRemove').addEventListener('click', () => {
    store.dispatch(act.removeAudioExtra());
    wave?.destroy(); wave = null;
    timeline.setWave(null);
  });
  $('#beVolVideo').addEventListener('input', (e) => {
    store.dispatch({ ...act.setVolume('video', parseFloat(e.target.value)), gestureId: 'vol-v' });
  });
  $('#beVolVideo').addEventListener('change', () => store.endGesture());
  $('#beVolAudio').addEventListener('input', (e) => {
    store.dispatch({ ...act.setVolume('audio_extra', parseFloat(e.target.value)), gestureId: 'vol-a' });
  });
  $('#beVolAudio').addEventListener('change', () => store.endGesture());
  $('#beAspect').addEventListener('change', (e) => store.dispatch(act.setAspect(e.target.value)));

  // ── transicoes ──
  function renderTransitionsRow(state) {
    const row = $('#beTransitions');
    const segs = timelineSegments(state);
    if (segs.length < 2) { row.innerHTML = '<span class="be-dim">Divida o vídeo em 2+ cenas pra ter transições</span>'; return; }
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
        const a = $('#beExportLink');
        a.href = url;
        const v = $('#beExportPreview');
        v.src = url;
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
              timeline.zoomFit();
              toast('Projeto restaurado ✓');
            }
          } catch (e) { toast('Falha ao carregar: ' + e.message, true); }
        });
      });
    } catch { /* sem projetos, segue */ }
  }
  showProjects();

  // ── toast ──
  function toast(msg, isError) {
    const el = $('#beToast');
    el.textContent = msg;
    el.className = 'be-toast show' + (isError ? ' err' : '');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove('show'), 3500);
  }

  sync();

  return {
    destroy() {
      detachShortcuts();
      player.destroy(); overlay.destroy(); timeline.destroy();
      autosave.destroy(); exporter.destroy();
      thumbs?.destroy(); wave?.destroy();
    },
  };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const TEMPLATE = `
<header class="be-header">
  <a href="/blueEditor" class="be-back">←</a>
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
  <input type="file" id="beFile" accept="video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm" hidden/>
</div>

<div id="beWorkspace" class="be-workspace" style="display:none">
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

  <div class="be-side">
    <div class="be-side-section">
      <div class="be-side-title">Áudio</div>
      <button id="beAddAudio" class="be-tool-btn">🎵 Adicionar música/narração</button>
      <input type="file" id="beAudioFile" accept="audio/mpeg,audio/wav,audio/mp4,.mp3,.wav,.m4a,.aac" hidden/>
      <div id="beAudioRow" class="be-audio-row" style="display:none">
        <span id="beAudioName" class="be-dim"></span>
        <button id="beAudioRemove" class="be-icon-btn" title="Remover">✕</button>
      </div>
      <label class="be-slider-label">Volume do vídeo <input id="beVolVideo" type="range" min="0" max="2" step="0.05" value="1"/></label>
      <label class="be-slider-label">Volume da música <input id="beVolAudio" type="range" min="0" max="2" step="0.05" value="1"/></label>
    </div>
    <div class="be-side-section">
      <div class="be-side-title">Transições</div>
      <div id="beTransitions" class="be-transitions"></div>
    </div>
    <div class="be-side-section">
      <div class="be-side-title">Formato</div>
      <select id="beAspect" class="be-select">
        <option value="crop_center">Preencher 9:16 (corta bordas)</option>
        <option value="letterbox">Caber inteiro (barras)</option>
      </select>
      <div class="be-dim">Saída: 1080×1920 vertical</div>
    </div>
  </div>

  <div class="be-timeline-area">
    <div class="be-toolbar">
      <button id="beSplit" class="be-tool-btn" title="Dividir no cursor (Ctrl+B)">✂ Dividir</button>
      <button id="beDelLeft" class="be-tool-btn" title="Apagar antes do cursor (Q)">⇤ Apagar antes</button>
      <button id="beDelRight" class="be-tool-btn" title="Apagar depois do cursor (W)">⇥ Apagar depois</button>
      <button id="beToggleClip" class="be-tool-btn" title="Ativar/desativar cena (V)">◫ Liga/desliga</button>
      <button id="beDelClip" class="be-tool-btn" title="Excluir cena selecionada (Delete)">🗑 Excluir</button>
      <span class="be-toolbar-sep"></span>
      <button id="beAddText" class="be-tool-btn">＋ Texto</button>
      <span class="be-toolbar-spacer"></span>
      <button id="beZoomOut" class="be-icon-btn" title="Zoom - (Ctrl -)">−</button>
      <button id="beZoomFit" class="be-icon-btn" title="Caber (Shift+Z)">⤢</button>
      <button id="beZoomIn" class="be-icon-btn" title="Zoom + (Ctrl +)">＋</button>
    </div>
    <div class="be-timeline-wrap">
      <canvas id="beTimeline"></canvas>
    </div>
    <div class="be-hint be-dim">Espaço reproduz · Ctrl+B divide · Q/W apagam antes/depois · arraste as cenas pra reordenar · toque longo (celular) move</div>
  </div>
</div>

<div id="beTextPanel" class="be-panel">
  <div class="be-panel-head">Editar texto <button id="beTextClose" class="be-icon-btn">✕</button></div>
  <textarea id="beTextContent" rows="2" maxlength="200" placeholder="Digite o texto…"></textarea>
  <div class="be-panel-row">
    <label>Fonte <select id="beTextFont">${TEXT_FONTS.map(f => `<option>${f}</option>`).join('')}</select></label>
    <label>Tamanho <select id="beTextSize">${TEXT_SIZES.map(s => `<option value="${s}">${({ small: 'Pequeno', medium: 'Médio', large: 'Grande', xlarge: 'Gigante' })[s]}</option>`).join('')}</select></label>
    <label>Cor <input id="beTextColor" type="color" value="#ffffff"/></label>
  </div>
  <div class="be-panel-row">
    <label>Início (s) <input id="beTextStart" type="number" min="0" step="0.1"/></label>
    <label>Fim (s) <input id="beTextEnd" type="number" min="0" step="0.1"/></label>
    <button id="beTextDelete" class="be-danger-btn">Excluir texto</button>
  </div>
  <div class="be-dim">Arraste o texto direto no preview pra posicionar</div>
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
