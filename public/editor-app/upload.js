/* ═══════════════════════════════════════════════════════════════════════════
   upload.js — Tela de upload + validacao + upload progressive
   ═══════════════════════════════════════════════════════════════════════════
   2 caminhos de input:
     1. Drag&drop arquivo
     2. File picker

   Pipeline:
     a) Validacao client-side (formato, tamanho, duracao via <video> probe)
     b) Pede signed URL via /api/blue-editor?action=upload-url (ja existe)
     c) Upload via XHR (progress + cancel + erro) pro Supabase Storage
     d) Probe metadata (duration, dimensions, aspect ratio)
     e) state.patch({video: {...}}) -> dispara render do player

   Mobile-safe: file picker funciona em iOS, drag&drop nao funciona iOS
   (suportado em Android Chrome mas desabilitado em iOS por design Apple).
   ═══════════════════════════════════════════════════════════════════════════ */

window.BEUpload = (function() {
  'use strict';

  // ─── Limites validacao ─────────────────────────────────────────────────
  const ACCEPTED_TYPES = ['video/mp4', 'video/quicktime']; // MP4 + MOV
  const ACCEPTED_EXTENSIONS = ['.mp4', '.mov', '.m4v'];    // fallback se mime vazio
  const MAX_SIZE_BYTES = 500 * 1024 * 1024;  // 500MB
  const MAX_DURATION_SEC = 600;               // 10 min

  let currentXhr = null; // pra permitir cancel
  let panelEl = null;

  // ─── Helpers ────────────────────────────────────────────────────────────
  function fmtBytes(b) {
    if (b < 1024) return b + ' B';
    if (b < 1048576) return (b/1024).toFixed(1) + ' KB';
    if (b < 1073741824) return (b/1048576).toFixed(1) + ' MB';
    return (b/1073741824).toFixed(2) + ' GB';
  }
  function fmtTime(s) {
    s = Math.max(0, s|0);
    const m = (s/60)|0;
    const r = s - m*60;
    return String(m).padStart(2,'0') + ':' + String(r).padStart(2,'0');
  }

  function isValidExtension(filename) {
    const lo = (filename || '').toLowerCase();
    return ACCEPTED_EXTENSIONS.some(ext => lo.endsWith(ext));
  }

  function isValidType(file) {
    if (ACCEPTED_TYPES.includes(file.type)) return true;
    // iOS Safari as vezes nao popula file.type — fallback por extensao
    return isValidExtension(file.name);
  }

  // ─── Probe metadata via HTML5 <video> ───────────────────────────────────
  // Cria <video> oculto, carrega metadata, le duracao + dimensoes.
  // Reusa em validacao client-side antes do upload e novamente apos.
  function probeVideoMetadata(srcUrlOrBlob) {
    return new Promise((resolve, reject) => {
      const v = document.createElement('video');
      v.preload = 'metadata';
      v.muted = true;
      v.playsInline = true;
      v.style.position = 'fixed';
      v.style.left = '-9999px';
      const cleanup = () => { try { v.remove(); } catch(e){} };
      const onError = () => { cleanup(); reject(new Error('Não foi possível ler o vídeo. Arquivo corrompido?')); };
      v.onerror = onError;
      v.onloadedmetadata = () => {
        const meta = {
          duration: v.duration || 0,
          width: v.videoWidth || 0,
          height: v.videoHeight || 0,
        };
        cleanup();
        if (!isFinite(meta.duration) || meta.duration <= 0) {
          return reject(new Error('Duração inválida'));
        }
        resolve(meta);
      };
      document.body.appendChild(v);
      v.src = (srcUrlOrBlob instanceof Blob) ? URL.createObjectURL(srcUrlOrBlob) : srcUrlOrBlob;
      // Timeout safety (5s)
      setTimeout(() => { if (!v.duration) onError(); }, 5000);
    });
  }

  function detectAspect(w, h) {
    if (!w || !h) return null;
    const r = w / h;
    if (r < 0.7) return 'vertical';    // 9:16, ~0.5625
    if (r > 1.4) return 'horizontal';  // 16:9, ~1.78
    return 'square';                   // 1:1, ~1.0
  }

  // ─── Tela de upload (renderiza no painel central) ───────────────────────
  function renderUploadScreen() {
    panelEl = document.getElementById('panelBody');
    if (!panelEl) return;
    panelEl.innerHTML = `
      <div class="upload-screen">
        <div class="upload-dropzone" id="uploadDropzone" tabindex="0" role="button" aria-label="Arraste vídeo ou clique pra selecionar">
          <div class="upload-icon">
            <svg viewBox="0 0 64 64" width="56" height="56" aria-hidden="true">
              <rect x="6" y="14" width="52" height="36" rx="4" fill="none" stroke="currentColor" stroke-width="2"/>
              <path d="M26 24l14 8-14 8V24z" fill="currentColor"/>
            </svg>
          </div>
          <div class="upload-title">Arraste seu vídeo aqui</div>
          <div class="upload-subtitle">ou clique pra escolher</div>
          <div class="upload-meta">MP4 ou MOV · até 500 MB · até 10 min</div>
          <input type="file" id="uploadFile" accept="video/mp4,video/quicktime,.mp4,.mov,.m4v" hidden>
        </div>

        <div class="upload-progress" id="uploadProgress" hidden>
          <div class="up-row">
            <span class="up-label" id="upLabel">Preparando…</span>
            <span class="up-pct" id="upPct">0%</span>
          </div>
          <div class="up-bar"><div class="up-bar-fill" id="upBarFill"></div></div>
          <div class="up-actions">
            <button class="up-cancel" id="upCancel">Cancelar</button>
          </div>
        </div>

        <div class="upload-error" id="uploadError" hidden></div>
      </div>
    `;
    bindUploadHandlers();
  }

  function bindUploadHandlers() {
    const dz = document.getElementById('uploadDropzone');
    const fileInput = document.getElementById('uploadFile');
    const cancelBtn = document.getElementById('upCancel');

    if (dz) {
      dz.addEventListener('click', () => fileInput && fileInput.click());
      dz.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
      });
      ['dragenter','dragover'].forEach(ev => dz.addEventListener(ev, e => {
        e.preventDefault(); e.stopPropagation();
        dz.classList.add('dragover');
      }));
      ['dragleave','drop'].forEach(ev => dz.addEventListener(ev, e => {
        e.preventDefault(); e.stopPropagation();
        dz.classList.remove('dragover');
      }));
      dz.addEventListener('drop', e => {
        const f = e.dataTransfer?.files?.[0];
        if (f) handleFile(f);
      });
    }

    if (fileInput) {
      fileInput.addEventListener('change', e => {
        const f = e.target.files?.[0];
        if (f) handleFile(f);
      });
    }

    if (cancelBtn) {
      cancelBtn.addEventListener('click', cancelUpload);
    }
  }

  // ─── Mensagens UI ──────────────────────────────────────────────────────
  function showError(msg) {
    const el = document.getElementById('uploadError');
    if (el) { el.hidden = false; el.textContent = msg; }
    hideProgress();
  }
  function showProgress(label, pct) {
    document.getElementById('uploadError').hidden = true;
    const p = document.getElementById('uploadProgress');
    if (p) p.hidden = false;
    setProgress(label, pct);
  }
  function setProgress(label, pct) {
    if (label != null) document.getElementById('upLabel').textContent = label;
    const cl = Math.max(0, Math.min(100, pct|0));
    document.getElementById('upPct').textContent = cl + '%';
    document.getElementById('upBarFill').style.width = cl + '%';
  }
  function hideProgress() {
    const p = document.getElementById('uploadProgress');
    if (p) p.hidden = true;
  }

  // ─── Validacao + processamento de arquivo ──────────────────────────────
  async function handleFile(file) {
    if (!file) return;
    document.getElementById('uploadError').hidden = true;

    // 1. Tipo
    if (!isValidType(file)) {
      return showError('Formato não suportado. Use MP4 ou MOV.');
    }

    // 2. Tamanho
    if (file.size > MAX_SIZE_BYTES) {
      return showError('Arquivo muito grande (' + fmtBytes(file.size) + '). Limite: 500 MB.');
    }
    if (file.size < 1024) {
      return showError('Arquivo muito pequeno. Vídeo válido?');
    }

    // 3. Probe metadata (duracao + dimensoes)
    showProgress('Lendo vídeo…', 5);
    let meta;
    try {
      meta = await probeVideoMetadata(file);
    } catch (e) {
      return showError('Erro ao ler vídeo: ' + e.message);
    }

    // 4. Duracao
    if (meta.duration > MAX_DURATION_SEC) {
      return showError('Vídeo muito longo (' + fmtTime(meta.duration) + '). Limite: 10 min.');
    }

    // 5. Pega signed URL do Supabase
    showProgress('Preparando upload…', 10);
    let signedData;
    try {
      const token = localStorage.getItem('bt_token');
      const ext = (file.name.match(/\.(\w+)$/)?.[1] || 'mp4').toLowerCase();
      const r = await fetch('/api/blue-editor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'get-upload-url', token, ext }),
      });
      const d = await r.json();
      if (!r.ok || !d.upload_url) {
        return showError('Falha ao iniciar upload: ' + (d.error || 'erro do servidor'));
      }
      signedData = d;
    } catch (e) {
      return showError('Erro de rede: ' + e.message);
    }

    // 6. Upload XHR com progress + cancel
    showProgress('Enviando vídeo…', 15);
    try {
      await uploadXhr(file, signedData.upload_url);
    } catch (e) {
      if (e.message === 'canceled') return showError('Upload cancelado.');
      return showError('Falha no upload: ' + e.message);
    }

    // 7. Sucesso — atualiza state e dispara render do player
    setProgress('Finalizando…', 95);
    const aspect = detectAspect(meta.width, meta.height);
    const newVideo = {
      url: signedData.public_url,
      path: signedData.path,
      filename: file.name,
      duration: meta.duration,
      width: meta.width,
      height: meta.height,
      aspect,
      size_bytes: file.size,
    };
    BEState.patch({
      video: newVideo,
      trim: { in: 0, out: meta.duration },
    });
    setProgress('Pronto!', 100);
    setTimeout(() => { hideProgress(); BEEditor.afterUploadComplete(); }, 400);
  }

  // ─── Upload XHR (progress, cancel) ─────────────────────────────────────
  function uploadXhr(file, signedUrl) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      currentXhr = xhr;
      xhr.open('PUT', signedUrl, true);
      // Supabase signed URL aceita o blob raw direto, define Content-Type pelo arquivo
      xhr.setRequestHeader('Content-Type', file.type || 'video/mp4');
      xhr.upload.addEventListener('progress', e => {
        if (e.lengthComputable) {
          const pct = 15 + Math.round((e.loaded / e.total) * 75); // 15-90
          setProgress('Enviando ' + fmtBytes(e.loaded) + ' / ' + fmtBytes(e.total), pct);
        }
      });
      xhr.onload = () => {
        currentXhr = null;
        if (xhr.status >= 200 && xhr.status < 300) resolve();
        else reject(new Error('HTTP ' + xhr.status));
      };
      xhr.onerror = () => { currentXhr = null; reject(new Error('Erro de rede')); };
      xhr.onabort = () => { currentXhr = null; reject(new Error('canceled')); };
      xhr.send(file);
    });
  }

  function cancelUpload() {
    if (currentXhr) currentXhr.abort();
  }

  return { renderUploadScreen };
})();
