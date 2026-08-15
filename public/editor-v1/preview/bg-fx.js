// editor-v1/preview/bg-fx.js
// REMOVER FUNDO no PREVIEW (15/08): canvas WebGL por cima de cada alvo com a
// MESMA conta do render:
//   chroma — distância UV (BT.601), similarity/blend idênticos ao chromakey;
//   custom — máscara pintada como textura (branco = remover);
//   auto   — vídeo DUPLO [cor|máscara] com FATOR de relógio (a gravação corre
//            em tempo de parede; dupla_dur compensa a régua esticada — sem
//            isso o sync entrava em tempestade de seeks = "vídeo travando").
// Alvos: a CENA principal (sai sobre PRETO, igual ao arquivo) e as CAMADAS
// (canvas TRANSPARENTE — o que está atrás aparece, igual ao arquivo).
import { segmentAt, effectiveOverlays, overlayTimelineDur, clipSpeed } from '../core/selectors.js';
import { chromaParaRender, rgbParaUv, fatorDoDuplo } from '../core/fundo.js';

const VS = `attribute vec2 p; varying vec2 t; void main(){ t = vec2((p.x+1.0)/2.0, (1.0-p.y)/2.0); gl_Position = vec4(p,0.,1.); }`;
const FS = `
precision mediump float;
varying vec2 t;
uniform sampler2D tex;
uniform sampler2D mtex;
uniform int modo;           // 1=chroma 2=custom 3=auto(duplo)
uniform int opaco;          // 1=cena (sobre preto) 0=camada (alpha real)
uniform vec2 keyUv;
uniform float sim;
uniform float blend;
uniform float desp;
uniform int despCanal;
vec2 uvDe(vec3 c){ return vec2(-0.14713*c.r-0.28886*c.g+0.436*c.b, 0.615*c.r-0.51499*c.g-0.10001*c.b); }
void main(){
  vec3 cor; float a = 1.0;
  if (modo == 3) {
    cor = texture2D(tex, vec2(t.x*0.5, t.y)).rgb;
    a = texture2D(tex, vec2(0.5 + t.x*0.5, t.y)).r;
  } else {
    cor = texture2D(tex, t).rgb;
    if (modo == 1) {
      float d = distance(uvDe(cor), keyUv);
      a = (d < sim) ? 0.0 : (blend > 0.0001 ? clamp((d - sim)/blend, 0.0, 1.0) : 1.0);
      if (desp > 0.001 && a > 0.0) {
        if (despCanal == 1) { float m = max(cor.r, cor.b); if (cor.g > m) cor.g = mix(cor.g, m, desp); }
        if (despCanal == 2) { float m = max(cor.r, cor.g); if (cor.b > m) cor.b = mix(cor.b, m, desp); }
      }
    } else if (modo == 2) {
      a = 1.0 - texture2D(mtex, t).r;
    }
  }
  if (opaco == 1) gl_FragColor = vec4(cor * a, 1.0);      // cena: sobre preto
  else gl_FragColor = vec4(cor * a, a);                    // camada: alpha real
}`;

export function createBgFx(container, videoEl, store, player) {
  const alvos = new Map();   // key -> {canvas, gl, prog, uni, tex, mtex, maskImg, maskUrl, dupEl, dupUrl}

  function criarAlvo(key) {
    const canvas = document.createElement('canvas');
    canvas.className = 'beBgFxCanvas';
    canvas.dataset.bgKey = key;
    canvas.style.cssText = 'position:absolute;display:none;pointer-events:none;z-index:4;';
    container.appendChild(canvas);
    // premultiplied + preserveDrawingBuffer (sonda lê pixel fora do draw)
    const gl = canvas.getContext('webgl', { premultipliedAlpha: true, alpha: true, preserveDrawingBuffer: true });
    const a = { canvas, gl, prog: null, uni: {}, tex: null, mtex: null, maskImg: null, maskUrl: null, dupEl: null, dupUrl: null };
    alvos.set(key, a);
    return a;
  }

  function initGl(a) {
    if (a.prog || !a.gl) return !!a.prog;
    const gl = a.gl;
    const sh = (tipo, src) => {
      const s = gl.createShader(tipo); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { console.error('[bg-fx]', gl.getShaderInfoLog(s)); return null; }
      return s;
    };
    const v = sh(gl.VERTEX_SHADER, VS), f = sh(gl.FRAGMENT_SHADER, FS);
    if (!v || !f) return false;
    a.prog = gl.createProgram();
    gl.attachShader(a.prog, v); gl.attachShader(a.prog, f); gl.linkProgram(a.prog);
    gl.useProgram(a.prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(a.prog, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    for (const u of ['tex', 'mtex', 'modo', 'opaco', 'keyUv', 'sim', 'blend', 'desp', 'despCanal']) {
      a.uni[u] = gl.getUniformLocation(a.prog, u);
    }
    a.tex = gl.createTexture(); a.mtex = gl.createTexture();
    for (const t2 of [a.tex, a.mtex]) {
      gl.bindTexture(gl.TEXTURE_2D, t2);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    }
    return true;
  }

  /** vídeo DUPLO sincronizado: srcTime (tempo do ARQUIVO original) → tempo do
   *  duplo via fator; tolerância larga + playbackRate casado = sem tempestade
   *  de seeks (o webm gravado não tem índice; seek nele é CARO). */
  function syncDuplo(a, bg, srcTime, velocidade) {
    if (a.dupUrl !== bg.dupla_url) {
      if (!a.dupEl) {
        a.dupEl = document.createElement('video');
        a.dupEl.muted = true; a.dupEl.playsInline = true; a.dupEl.crossOrigin = 'anonymous';
        a.dupEl.style.display = 'none';
        container.appendChild(a.dupEl);
      }
      a.dupEl.src = bg.dupla_url; a.dupUrl = bg.dupla_url;
    }
    const fator = fatorDoDuplo(bg);
    const alvoT = Math.max(0, (srcTime - (bg.src_in || 0)) * fator);
    const drift = Math.abs(a.dupEl.currentTime - alvoT);
    const tocando = player.isPlaying();
    a.dupEl.playbackRate = Math.min(4, Math.max(0.25, fator * (velocidade || 1)));
    if (drift > (tocando ? 0.6 : 0.25)) { try { a.dupEl.currentTime = alvoT; } catch {} }
    if (tocando && a.dupEl.paused) a.dupEl.play().catch(() => {});
    if (!tocando && !a.dupEl.paused) a.dupEl.pause();
    return a.dupEl;
  }

  function desenhar(a, bg, fonte, box, opaco) {
    if (!initGl(a)) return;
    const gl = a.gl, canvas = a.canvas;
    const pai = container.getBoundingClientRect();
    canvas.style.left = (box.left - pai.left) + 'px';
    canvas.style.top = (box.top - pai.top) + 'px';
    canvas.style.width = box.width + 'px';
    canvas.style.height = box.height + 'px';
    const W = Math.max(2, Math.round(Math.min(box.width, 960)));
    const H = Math.max(2, Math.round(W * (box.height / Math.max(1, box.width))));
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
    canvas.style.display = 'block';
    gl.viewport(0, 0, W, H);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, a.tex);
    try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, fonte); } catch { return; }
    gl.uniform1i(a.uni.tex, 0);
    if (bg.modo === 'custom') {
      if (a.maskUrl !== bg.mask_url) {
        a.maskUrl = bg.mask_url; a.maskImg = null;
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => { a.maskImg = img; };
        img.src = bg.mask_url;
      }
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, a.mtex);
      if (a.maskImg) { try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, a.maskImg); } catch {} }
      else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, 1, 1, 0, gl.RGB, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0]));
      gl.uniform1i(a.uni.mtex, 1);
    }
    const modo = bg.modo === 'chroma' ? 1 : bg.modo === 'custom' ? 2 : 3;
    gl.uniform1i(a.uni.modo, modo);
    gl.uniform1i(a.uni.opaco, opaco ? 1 : 0);
    if (modo === 1) {
      const hex = (bg.cor || '#00d000').slice(1);
      const [r, g, b] = [0, 2, 4].map(k => parseInt(hex.slice(k, k + 2), 16) / 255);
      const kuv = rgbParaUv(r, g, b);
      const p = chromaParaRender(bg);
      gl.uniform2f(a.uni.keyUv, kuv.u, kuv.v);
      gl.uniform1f(a.uni.sim, p.similarity);
      gl.uniform1f(a.uni.blend, p.blend);
      gl.uniform1f(a.uni.desp, p.despill);
      gl.uniform1i(a.uni.despCanal, g >= r && g >= b ? 1 : (b > r ? 2 : 0));
    }
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  function render() {
    const state = store.getState();
    const t = player.getTime();
    const vivos = new Set();
    // ── CENA principal (sobre preto) ────────────────────────────────────────
    const seg = segmentAt(state, t);
    const bgCena = seg?.clip?.bg;
    if (bgCena && bgCena.modo && !player.transRoles?.()) {
      const a = alvos.get('main') || criarAlvo('main');
      const elDisp = player.getDisplayEl?.() || videoEl;
      const srcTime = seg.clip.source_in + (t - seg.tStart) * (seg.effSpeed || clipSpeed(seg.clip));
      const fonte = bgCena.modo === 'auto'
        ? syncDuplo(a, bgCena, srcTime, seg.effSpeed || clipSpeed(seg.clip))
        : elDisp;
      if (fonte && fonte.readyState >= 2) {
        desenhar(a, bgCena, fonte, elDisp.getBoundingClientRect(), true);
        vivos.add('main');
      } else if (a.canvas.style.display !== 'none') {
        vivos.add('main');   // fonte carregando: segura o quadro anterior
      }
    }
    // ── CAMADAS com fundo removido (alpha REAL — o de trás aparece) ─────────
    for (const ov of effectiveOverlays(state)) {
      if (!ov.bg || !ov.bg.modo) continue;
      if (t < (ov.start || 0) - 1e-6 || t >= (ov.start || 0) + overlayTimelineDur(ov)) continue;
      const el = container.querySelector(`[data-ov-id="${ov.id}"]`);
      if (!el || el.style.display === 'none') continue;
      const key = 'ov' + ov.id;
      const a = alvos.get(key) || criarAlvo(key);
      const srcTime = ov.source_in + (t - ov.start) * clipSpeed(ov);
      const fonte = ov.bg.modo === 'auto' ? syncDuplo(a, ov.bg, srcTime, clipSpeed(ov)) : el;
      if (!fonte || fonte.readyState < 2) { vivos.add(key); continue; }
      const box = el.getBoundingClientRect();
      desenhar(a, ov.bg, fonte, box, false);
      // o canvas da camada fica NA FRENTE do <video> dela (mesma pilha de z)
      a.canvas.style.zIndex = String(10 + (ov.lane || 1));
      // o vídeo cru da camada não pode vazar por trás do resultado transparente
      el.style.opacity = '0';
      a.canvas.dataset.cobre = String(ov.id);
      vivos.add(key);
    }
    // esconde alvos que saíram + devolve a opacidade dos vídeos cobertos
    for (const [key, a] of alvos) {
      if (vivos.has(key)) continue;
      if (a.canvas.style.display !== 'none') a.canvas.style.display = 'none';
      if (a.dupEl && !a.dupEl.paused) a.dupEl.pause();
      if (a.canvas.dataset.cobre) {
        const el = container.querySelector(`[data-ov-id="${a.canvas.dataset.cobre}"]`);
        if (el) el.style.opacity = '';
        delete a.canvas.dataset.cobre;
      }
    }
  }

  const unsub = store.subscribe(render);
  const unsubP = player.onUpdate(render);
  render();

  const principal = () => alvos.get('main');
  return {
    get canvas() { return (principal() || criarAlvo('main')).canvas; },
    /** lê um pixel do resultado (sonda): x/y em fração 0..1; key opcional */
    lerPixel(xPct, yPct, key = 'main') {
      const a = alvos.get(key);
      if (!a || !a.gl || a.canvas.style.display === 'none') return null;
      const px = new Uint8Array(4);
      a.gl.readPixels(Math.round(xPct * (a.canvas.width - 1)), Math.round((1 - yPct) * (a.canvas.height - 1)),
        1, 1, a.gl.RGBA, a.gl.UNSIGNED_BYTE, px);
      return { r: px[0], g: px[1], b: px[2], a: px[3] };
    },
    destroy() {
      unsub(); unsubP();
      for (const [, a] of alvos) { a.dupEl?.remove(); a.canvas.remove(); }
      alvos.clear();
    },
  };
}
