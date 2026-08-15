// editor-v1/ui/remover-fundo.js
// REMOVER PLANO DE FUNDO — a fiação do painel (15/08, paridade CapCut):
//   · Remoção automática: segmentação de PESSOA no navegador (MediaPipe, o
//     mesmo modelo de videochamada do Google) → vídeo DUPLO [cor|máscara]
//     gravado ao vivo e enviado ao storage; o render compõe (zero infra nova
//     no Railway). Processa em ~1× a duração do trecho.
//   · Remoção personalizada: pincel/borracha DIRETO no preview → máscara PNG.
//   · Chroma key: conta-gotas no preview + sliders (números prontos pro
//     chromakey de verdade — core/fundo.js).
// Modos são exclusivos; o preview ao vivo é o bg-fx (WebGL).
import * as act from '../core/actions.js';
import { formatoDoProjeto, segmentAt } from '../core/selectors.js';
import { uploadMedia } from '../services/upload.js';

const MP_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
const MP_MODEL = 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite';

export function montarRemoverFundo({ root, store, player, videoEl, toast }) {
  const $ = (s) => root.querySelector(s);
  const stage = $('#beStage');
  const clipSel = () => { const s = store.getState(); return s.clips.find(c => c.id === s.selected_clip_id); };
  // o elemento EM EXIBIÇÃO (double-buffer: beVideo OU beVideo2)
  const elDisp = () => player.getDisplayEl?.() || videoEl;

  // ── pintura (remoção personalizada) ───────────────────────────────────────
  let pintando = false;          // modo pintura ligado
  let tool = 'pincel';
  let brush = 20;
  let off = null, offCtx = null; // máscara na resolução do PROJETO
  const paint = document.createElement('canvas');
  paint.style.cssText = 'position:absolute;display:none;z-index:6;cursor:crosshair;touch-action:none;';
  stage.appendChild(paint);
  const pctx = paint.getContext('2d');

  function ligarPintura() {
    const fp = formatoDoProjeto(store.getState());
    const W = Math.min(1080, fp.w), H = Math.round(W * fp.h / fp.w);
    if (!off || off.width !== W || off.height !== H) {
      off = document.createElement('canvas'); off.width = W; off.height = H;
      offCtx = off.getContext('2d');
      offCtx.fillStyle = '#000'; offCtx.fillRect(0, 0, W, H);
    }
    pintando = true;
    posicionaPaint();
    paint.style.display = 'block';
    desenhaPaint();
  }
  function desligarPintura() { pintando = false; paint.style.display = 'none'; }
  function posicionaPaint() {
    const box = elDisp().getBoundingClientRect();
    const pai = stage.getBoundingClientRect();
    paint.style.left = (box.left - pai.left) + 'px';
    paint.style.top = (box.top - pai.top) + 'px';
    paint.style.width = box.width + 'px';
    paint.style.height = box.height + 'px';
    if (paint.width !== Math.round(box.width)) { paint.width = Math.round(box.width); paint.height = Math.round(box.height); }
  }
  function desenhaPaint() {
    if (!pintando) return;
    pctx.clearRect(0, 0, paint.width, paint.height);
    // marca vermelha translúcida onde a máscara pinta (branco = remover)
    pctx.save();
    pctx.globalAlpha = 0.45;
    pctx.drawImage(off, 0, 0, paint.width, paint.height);
    pctx.globalCompositeOperation = 'source-in';
    pctx.fillStyle = '#f43f5e';
    pctx.fillRect(0, 0, paint.width, paint.height);
    pctx.restore();
  }
  let tracando = false;
  function pinta(e) {
    const r = paint.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width * off.width;
    const y = (e.clientY - r.top) / r.height * off.height;
    const raio = brush * (off.width / Math.max(1, r.width));
    offCtx.globalCompositeOperation = tool === 'pincel' ? 'source-over' : 'destination-out';
    offCtx.fillStyle = '#fff';
    offCtx.beginPath();
    offCtx.arc(x, y, raio, 0, Math.PI * 2);
    offCtx.fill();
    offCtx.globalCompositeOperation = 'source-over';
    desenhaPaint();
  }
  paint.addEventListener('pointerdown', (e) => { e.preventDefault(); paint.setPointerCapture(e.pointerId); tracando = true; pinta(e); });
  paint.addEventListener('pointermove', (e) => { if (tracando) pinta(e); });
  const soltou = () => { tracando = false; };
  paint.addEventListener('pointerup', soltou);
  paint.addEventListener('pointercancel', soltou);

  // ── conta-gotas (chroma) ─────────────────────────────────────────────────
  let contaGotas = false;
  const pick = document.createElement('canvas');
  const pickCtx = pick.getContext('2d', { willReadFrequently: true });
  function clickConta(e) {
    if (!contaGotas) return;
    const box = elDisp().getBoundingClientRect();
    if (e.clientX < box.left || e.clientX > box.right || e.clientY < box.top || e.clientY > box.bottom) return;
    e.preventDefault(); e.stopPropagation();
    contaGotas = false;
    stage.style.cursor = '';
    // frame atual → cor sob o clique (mapeia o object-fit contain/cover do el)
    const vEl = elDisp(); pick.width = vEl.videoWidth || 2; pick.height = vEl.videoHeight || 2;
    try { pickCtx.drawImage(vEl, 0, 0); } catch { toast('Não consegui ler a cor deste vídeo.', true); return; }
    const fx = (e.clientX - box.left) / box.width, fy = (e.clientY - box.top) / box.height;
    const d = pickCtx.getImageData(
      Math.round(fx * (pick.width - 1)), Math.round(fy * (pick.height - 1)), 1, 1).data;
    const cor = '#' + [d[0], d[1], d[2]].map(v => v.toString(16).padStart(2, '0')).join('');
    const c = clipSel(); if (!c) return;
    store.dispatch(act.setClipBg(c.id, { modo: 'chroma', cor }));
    $('#beBgCorSwatch').style.background = cor;
    toast(`Cor da chave: ${cor} ✓`);
  }
  stage.addEventListener('pointerdown', clickConta, true);

  // ── remoção AUTOMÁTICA (MediaPipe no navegador) ──────────────────────────
  let autoCancel = false;
  let segmenter = null;
  async function carregarModelo(status) {
    if (segmenter) return segmenter;
    status('Carregando o modelo de pessoa…');
    const vision = await import(`${MP_BASE}/vision_bundle.mjs`);
    const files = await vision.FilesetResolver.forVisionTasks(`${MP_BASE}/wasm`);
    segmenter = await vision.ImageSegmenter.createFromOptions(files, {
      baseOptions: { modelAssetPath: MP_MODEL },
      runningMode: 'VIDEO',
      outputConfidenceMasks: true,
    });
    return segmenter;
  }
  async function rodarAuto() {
    const c = clipSel(); if (!c) return;
    const state = store.getState();
    const url = c.media_id != null
      ? (state.media || []).find(m => m.id === c.media_id)?.url : state.video?.url;
    if (!url) { toast('Cena sem mídia.', true); return; }
    const status = (m) => { $('#beBgAutoStatus').textContent = m; };
    const barra = $('#beBgAutoBar');
    autoCancel = false;
    $('#beBgAutoBox').style.display = '';
    barra.style.display = ''; $('#beBgAutoCancel').style.display = '';
    try {
      const seg = await carregarModelo(status);
      // vídeo próprio pro processamento (não mexe no player)
      const v = document.createElement('video');
      v.crossOrigin = 'anonymous'; v.muted = true; v.playsInline = true;
      v.src = url;
      await new Promise((res, rej) => { v.onloadeddata = res; v.onerror = () => rej(new Error('não abriu o vídeo')); });
      const srcIn = c.source_in, srcOut = c.source_out;
      const W = Math.min(720, v.videoWidth || 720);
      const H = Math.round(W * (v.videoHeight || 1280) / Math.max(1, v.videoWidth || 720));
      const duplo = document.createElement('canvas');
      duplo.width = W * 2; duplo.height = H;
      const dctx = duplo.getContext('2d');
      const streamFps = 30;
      const stream = duplo.captureStream(streamFps);
      const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9' : 'video/webm;codecs=vp8';
      // 12 Mbps: bitrate baixo borrava o movimento (o "fantasma" do teste
      // real 15/08 — rastros de frames antigos são artefato de compressão)
      const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 12_000_000 });
      const pedacos = [];
      rec.ondataavailable = (e) => { if (e.data.size) pedacos.push(e.data); };
      const fim = new Promise((res) => { rec.onstop = res; });
      v.currentTime = srcIn;
      await new Promise((res) => { v.onseeked = res; });
      rec.start(250);
      // relógio de PAREDE da gravação: o MediaRecorder carimba em tempo real —
      // se a segmentação atrasar o playback, a régua do duplo ESTICA. Medimos
      // a duração real e guardamos (dupla_dur) pro preview e o render
      // compensarem com o fator — era o "vídeo travando" (tempestade de seeks
      // atrás de um relógio que não batia).
      const tRec0 = performance.now();
      v.play();
      status('Detectando a pessoa e removendo o fundo…');
      await new Promise((res, rej) => {
        let ultimoTs = -1;
        const passo = () => {
          if (autoCancel) return rej(new Error('cancelado'));
          if (v.currentTime >= srcOut - 0.03 || v.ended) return res();
          const ts = Math.round(v.currentTime * 1000);
          if (ts !== ultimoTs && v.readyState >= 2) {
            ultimoTs = ts;
            const r = seg.segmentForVideo(v, performance.now());
            const m = r?.confidenceMasks?.[0];
            dctx.drawImage(v, 0, 0, W, H);
            if (m) {
              // máscara float 0..1 (pessoa) → metade direita em cinza.
              // CURVA DE CORTE (teste real 15/08): a confiança "morna" nas
              // bordas/movimento virava meia-transparência suja — abaixo de
              // 0.35 é fundo CERTEZA (0), acima de 0.7 é pessoa CERTEZA (255),
              // no meio uma rampa curta (borda limpa sem serrilhado).
              const dados = m.getAsFloat32Array();
              const mw = m.width, mh = m.height;
              const img = dctx.createImageData(mw, mh);
              for (let k = 0; k < dados.length; k++) {
                const conf = dados[k];
                const t2 = Math.max(0, Math.min(1, (conf - 0.35) / 0.35));
                const vg = Math.round(t2 * t2 * (3 - 2 * t2) * 255);   // smoothstep
                img.data[k * 4] = vg; img.data[k * 4 + 1] = vg; img.data[k * 4 + 2] = vg; img.data[k * 4 + 3] = 255;
              }
              // desenha a máscara redimensionada na metade direita
              const tmp = passo._tmp || (passo._tmp = document.createElement('canvas'));
              tmp.width = mw; tmp.height = mh;
              tmp.getContext('2d').putImageData(img, 0, 0);
              dctx.drawImage(tmp, W, 0, W, H);
              m.close?.();
            } else {
              dctx.fillStyle = '#000'; dctx.fillRect(W, 0, W, H);
            }
            const pct = Math.min(99, Math.round(((v.currentTime - srcIn) / Math.max(0.1, srcOut - srcIn)) * 100));
            barra.firstElementChild.style.width = pct + '%';
          }
          requestAnimationFrame(passo);
        };
        v.onerror = () => rej(new Error('erro no vídeo'));
        requestAnimationFrame(passo);
      });
      v.pause();
      const duplaDur = Math.max(0.1, (performance.now() - tRec0) / 1000);
      rec.stop();
      await fim;
      status('Enviando…');
      const blob = new Blob(pedacos, { type: 'video/webm' });
      // conteúdo parado comprime MUITO (vp8/vp9): 1KB já é gravação real
      if (blob.size < 1000) throw new Error('gravação vazia');
      const file = new File([blob], `fundo_auto_${Date.now()}.webm`, { type: 'video/webm' });
      const up = await uploadMedia(file, 'video', (pct) => { barra.firstElementChild.style.width = pct + '%'; });
      store.dispatch(act.setClipBg(c.id, {
        modo: 'auto', dupla_url: up.url, src_in: srcIn, src_out: srcOut,
        dupla_dur: Math.round(duplaDur * 1000) / 1000,
      }));
      status('Fundo removido ✓ (pessoa detectada pelo modelo do Google)');
      toast('Remoção automática aplicada ✓');
    } catch (e) {
      console.error('[remover-fundo]', e);
      status('');
      if (e.message !== 'cancelado') {
        toast('Remoção automática falhou: ' + (e.message || 'erro') + ' — tente o Chroma key ou o pincel.', true);
      }
      // volta o checkbox pro estado real
      sync(store.getState());
    } finally {
      barra.style.display = 'none'; $('#beBgAutoCancel').style.display = 'none';
    }
  }

  // ── fiação do painel ─────────────────────────────────────────────────────
  $('#beBgAuto').addEventListener('change', (e) => {
    const c = clipSel(); if (!c) { e.target.checked = false; return; }
    if (e.target.checked) rodarAuto();
    else if (c.bg?.modo === 'auto') store.dispatch(act.setClipBg(c.id, null));
  });
  $('#beBgAutoCancel').addEventListener('click', () => { autoCancel = true; });
  $('#beBgCustom').addEventListener('change', (e) => {
    const c = clipSel(); if (!c) { e.target.checked = false; return; }
    if (e.target.checked) { ligarPintura(); toast('Pinte a área a REMOVER e clique Aplicar.'); }
    else {
      desligarPintura();
      if (c.bg?.modo === 'custom') store.dispatch(act.setClipBg(c.id, null));
    }
  });
  $('#beBgTools').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tool]'); if (!b) return;
    tool = b.dataset.tool;
    $('#beBgTools').querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
  });
  $('#beBgBrush').addEventListener('input', (e) => { brush = parseInt(e.target.value, 10); $('#beBgBrushVal').textContent = e.target.value; });
  $('#beBgAplicar').addEventListener('click', async () => {
    const c = clipSel(); if (!c || !off) return;
    try {
      const blob = await new Promise((res) => off.toBlob(res, 'image/png'));
      const file = new File([blob], `fundo_mask_${Date.now()}.png`, { type: 'image/png' });
      toast('Enviando a máscara…');
      const up = await uploadMedia(file, 'image', () => {});
      store.dispatch(act.setClipBg(c.id, { modo: 'custom', mask_url: up.url }));
      desligarPintura();
      toast('Remoção personalizada aplicada ✓');
    } catch (e2) {
      toast('Falha ao enviar a máscara: ' + e2.message, true);
    }
  });
  $('#beBgChroma').addEventListener('change', (e) => {
    const c = clipSel(); if (!c) { e.target.checked = false; return; }
    if (e.target.checked) store.dispatch(act.setClipBg(c.id, { modo: 'chroma' }));
    else if (c.bg?.modo === 'chroma') store.dispatch(act.setClipBg(c.id, null));
  });
  $('#beBgConta').addEventListener('click', () => {
    contaGotas = true;
    stage.style.cursor = 'crosshair';
    toast('Clique na COR do fundo no preview.');
  });
  const bindChromaSlider = (sel, valSel, campo) => {
    $(sel).addEventListener('input', (e) => {
      const c = clipSel(); if (!c) return;
      $(valSel).textContent = e.target.value;
      store.dispatch({ ...act.setClipBg(c.id, { modo: 'chroma', [campo]: parseInt(e.target.value, 10) }), gestureId: 'bg-' + campo + '-' + c.id });
    });
    $(sel).addEventListener('change', () => store.endGesture());
  };
  bindChromaSlider('#beBgInt', '#beBgIntVal', 'intensidade');
  bindChromaSlider('#beBgSua', '#beBgSuaVal', 'suavizar');
  bindChromaSlider('#beBgLim', '#beBgLimVal', 'limpar');
  $('#beBgReset').addEventListener('click', () => {
    const c = clipSel(); if (!c) return;
    desligarPintura();
    store.dispatch(act.setClipBg(c.id, null));
    toast('Remoção de fundo desligada ✓');
  });

  /** chamado pelo syncPropsPanel: reflete o bg da cena selecionada */
  function sync(state) {
    const c = state.clips.find(x => x.id === state.selected_clip_id);
    const modo = c?.bg?.modo || null;
    $('#beBgAuto').checked = modo === 'auto';
    $('#beBgChroma').checked = modo === 'chroma';
    const customAtivo = modo === 'custom' || pintando;
    $('#beBgCustom').checked = customAtivo;
    $('#beBgAutoBox').style.display = modo === 'auto' || $('#beBgAutoBar').style.display !== 'none' ? '' : 'none';
    $('#beBgCustomBox').style.display = customAtivo ? '' : 'none';
    $('#beBgChromaBox').style.display = modo === 'chroma' ? '' : 'none';
    if (modo === 'chroma' && c.bg) {
      $('#beBgCorSwatch').style.background = c.bg.cor;
      if (document.activeElement !== $('#beBgInt')) { $('#beBgInt').value = c.bg.intensidade; $('#beBgIntVal').textContent = c.bg.intensidade; }
      if (document.activeElement !== $('#beBgSua')) { $('#beBgSua').value = c.bg.suavizar; $('#beBgSuaVal').textContent = c.bg.suavizar; }
      if (document.activeElement !== $('#beBgLim')) { $('#beBgLim').value = c.bg.limpar; $('#beBgLimVal').textContent = c.bg.limpar; }
    }
    if (pintando) posicionaPaint();
  }

  return {
    sync,
    destroy() { paint.remove(); stage.removeEventListener('pointerdown', clickConta, true); try { segmenter?.close(); } catch {} },
  };
}
