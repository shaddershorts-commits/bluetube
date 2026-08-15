// editor-v1/preview/bg-fx.js
// REMOVER FUNDO no PREVIEW (15/08): canvas WebGL por cima do vídeo principal,
// com a MESMA conta do render:
//   chroma — distância no plano UV (BT.601), similarity/blend idênticos ao
//            chromakey do ffmpeg (core/fundo.js manda os números prontos);
//   custom — máscara pintada como textura (branco = remover);
//   auto   — vídeo DUPLO [cor|máscara]: amostra a metade esquerda como cor e
//            a direita como alpha (o mesmo recorte do render).
// A área removida sai PRETA — igual ao arquivo (faixa principal não tem
// "atrás"). O <video> fica invisível enquanto o canvas mostra o resultado.
import { segmentAt, formatoDoProjeto } from '../core/selectors.js';
import { chromaParaRender, rgbParaUv } from '../core/fundo.js';

const VS = `attribute vec2 p; varying vec2 t; void main(){ t = vec2((p.x+1.0)/2.0, (1.0-p.y)/2.0); gl_Position = vec4(p,0.,1.); }`;
const FS = `
precision mediump float;
varying vec2 t;
uniform sampler2D tex;      // frame do vídeo (ou do duplo)
uniform sampler2D mtex;     // máscara pintada (modo custom)
uniform int modo;           // 1=chroma 2=custom 3=auto(duplo)
uniform vec2 keyUv;         // UV da cor-chave (BT.601)
uniform float sim;          // similarity (régua do ffmpeg)
uniform float blend;
uniform float desp;         // limpar borda (despill 0..1)
uniform int despCanal;      // 1=verde 2=azul 0=nenhum
vec2 uvDe(vec3 c){ return vec2(-0.14713*c.r-0.28886*c.g+0.436*c.b, 0.615*c.r-0.51499*c.g-0.10001*c.b); }
void main(){
  vec3 cor; float a = 1.0;
  if (modo == 3) {
    cor = texture2D(tex, vec2(t.x*0.5, t.y)).rgb;             // metade esquerda
    a = texture2D(tex, vec2(0.5 + t.x*0.5, t.y)).r;           // direita = alpha
  } else {
    cor = texture2D(tex, t).rgb;
    if (modo == 1) {
      float d = distance(uvDe(cor), keyUv);
      a = (d < sim) ? 0.0 : (blend > 0.0001 ? clamp((d - sim)/blend, 0.0, 1.0) : 1.0);
      if (desp > 0.001 && a > 0.0) {                          // limpar borda
        if (despCanal == 1) { float m = max(cor.r, cor.b); if (cor.g > m) cor.g = mix(cor.g, m, desp); }
        if (despCanal == 2) { float m = max(cor.r, cor.g); if (cor.b > m) cor.b = mix(cor.b, m, desp); }
      }
    } else if (modo == 2) {
      a = 1.0 - texture2D(mtex, t).r;                         // branco pintado = remove
    }
  }
  gl_FragColor = vec4(cor * a, 1.0);                          // sobre PRETO (= render)
}`;

export function createBgFx(container, videoEl, store, player) {
  const canvas = document.createElement('canvas');
  canvas.id = 'beBgFx';
  canvas.style.cssText = 'position:absolute;display:none;pointer-events:none;z-index:4;';
  container.appendChild(canvas);
  // preserveDrawingBuffer: a sonda lê pixels FORA do draw (readPixels depois
  // do present devolve zeros sem isso)
  const gl = canvas.getContext('webgl', { premultipliedAlpha: false, preserveDrawingBuffer: true });
  let prog = null, tex = null, mtex = null, uni = {};
  let maskImg = null, maskUrl = null;
  // vídeo DUPLO do modo auto (elemento próprio, sincronizado ao relógio)
  let dupEl = null, dupUrl = null;

  function initGl() {
    if (prog || !gl) return !!prog;
    const sh = (tipo, src) => {
      const s = gl.createShader(tipo); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { console.error('[bg-fx]', gl.getShaderInfoLog(s)); return null; }
      return s;
    };
    const v = sh(gl.VERTEX_SHADER, VS), f = sh(gl.FRAGMENT_SHADER, FS);
    if (!v || !f) return false;
    prog = gl.createProgram();
    gl.attachShader(prog, v); gl.attachShader(prog, f); gl.linkProgram(prog);
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    for (const u of ['tex', 'mtex', 'modo', 'keyUv', 'sim', 'blend', 'desp', 'despCanal']) {
      uni[u] = gl.getUniformLocation(prog, u);
    }
    tex = gl.createTexture(); mtex = gl.createTexture();
    for (const t2 of [tex, mtex]) {
      gl.bindTexture(gl.TEXTURE_2D, t2);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    }
    return true;
  }

  // NÃO esconde o <video>: o canvas é OPACO e cobre exatamente o box dele
  // (esconder era guerra perdida — o player restaura visibility a cada tick)
  function esconder() {
    if (canvas.style.display !== 'none') canvas.style.display = 'none';
    if (dupEl && !dupEl.paused) dupEl.pause();
  }

  function fonteDoFrame(bg, seg, t) {
    if (dupUrl !== bg.dupla_url) {
      if (!dupEl) {
        dupEl = document.createElement('video');
        dupEl.muted = true; dupEl.playsInline = true; dupEl.crossOrigin = 'anonymous';
        dupEl.style.display = 'none';
        container.appendChild(dupEl);
      }
      dupEl.src = bg.dupla_url; dupUrl = bg.dupla_url;
    }
    // relógio: t da régua → tempo DENTRO do duplo (t=0 ↔ src_in do arquivo)
    const c = seg.clip;
    const sp = c.speed > 0 ? c.speed : 1;
    const alvoT = Math.max(0, (c.source_in + (t - seg.tStart) * sp) - (bg.src_in || 0));
    if (Math.abs(dupEl.currentTime - alvoT) > 0.2) { try { dupEl.currentTime = alvoT; } catch {} }
    if (player.isPlaying() && dupEl.paused) dupEl.play().catch(() => {});
    if (!player.isPlaying() && !dupEl.paused) dupEl.pause();
    return dupEl;
  }

  function render() {
    const state = store.getState();
    const t = player.getTime();
    const seg = segmentAt(state, t);
    const bg = seg?.clip?.bg;
    if (!bg || !bg.modo || player.transRoles?.()) { esconder(); return; }
    if (!initGl()) { esconder(); return; }
    // o elemento EM EXIBIÇÃO (double-buffer: pode ser o beVideo ou o beVideo2)
    const elDisp = player.getDisplayEl?.() || videoEl;
    const fonte = bg.modo === 'auto' ? fonteDoFrame(bg, seg, t) : elDisp;
    if (!fonte || fonte.readyState < 2) { return; }
    // caixa: o canvas cobre exatamente o box do <video> em exibição
    const box = elDisp.getBoundingClientRect();
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
    gl.bindTexture(gl.TEXTURE_2D, tex);
    try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, fonte); } catch { return; }
    gl.uniform1i(uni.tex, 0);
    if (bg.modo === 'custom') {
      if (maskUrl !== bg.mask_url) {
        maskUrl = bg.mask_url; maskImg = null;
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => { maskImg = img; };
        img.src = bg.mask_url;
      }
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, mtex);
      if (maskImg) { try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, maskImg); } catch {} }
      else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, 1, 1, 0, gl.RGB, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0]));
      gl.uniform1i(uni.mtex, 1);
    }
    const modo = bg.modo === 'chroma' ? 1 : bg.modo === 'custom' ? 2 : 3;
    gl.uniform1i(uni.modo, modo);
    if (modo === 1) {
      const hex = (bg.cor || '#00d000').slice(1);
      const [r, g, b] = [0, 2, 4].map(k => parseInt(hex.slice(k, k + 2), 16) / 255);
      const kuv = rgbParaUv(r, g, b);
      const p = chromaParaRender(bg);
      gl.uniform2f(uni.keyUv, kuv.u, kuv.v);
      gl.uniform1f(uni.sim, p.similarity);
      gl.uniform1f(uni.blend, p.blend);
      gl.uniform1f(uni.desp, p.despill);
      gl.uniform1i(uni.despCanal, g >= r && g >= b ? 1 : (b > r ? 2 : 0));
    }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  const unsub = store.subscribe(render);
  const unsubP = player.onUpdate(render);
  render();

  return {
    canvas,
    /** lê um pixel do resultado (sonda): x/y em fração 0..1 */
    lerPixel(xPct, yPct) {
      if (!gl || canvas.style.display === 'none') return null;
      const px = new Uint8Array(4);
      gl.readPixels(Math.round(xPct * (canvas.width - 1)), Math.round((1 - yPct) * (canvas.height - 1)),
        1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      return { r: px[0], g: px[1], b: px[2] };
    },
    destroy() {
      unsub(); unsubP();
      esconder();
      dupEl?.remove(); canvas.remove();
    },
  };
}
