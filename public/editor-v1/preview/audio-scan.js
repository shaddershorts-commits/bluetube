// editor-v1/preview/audio-scan.js
// Baixa e decodifica o áudio de uma mídia pra análise (motor do "Cortar
// respiros"). Único módulo que toca rede/WebAudio nessa feature — a decisão de
// onde cortar mora em core/silencio.js, puro e testável.
//
// Decisões que importam:
//  · resampleia pra 16 kHz MONO no próprio decode (OfflineAudioContext): ~20x
//    menos memória que 48k estéreo, e 16 kHz cobre a banda da voz inteira.
//  · progresso REAL em bytes lidos (não barra fingida): o usuário pediu pra ver
//    o tempo do processo quando demora.
//  · cache por URL: reanalisar com outra sensibilidade não baixa de novo.
//  · funciona com o áudio DE DENTRO do vídeo — decodeAudioData aceita o mp4.

const cache = new Map();   // url -> { samples: Float32Array, sr: number }

/** Faz o download reportando progresso real. */
async function baixar(url, onProgress, signal) {
  const r = await fetch(url, { signal });
  if (!r.ok) throw new Error('Não consegui baixar a mídia (HTTP ' + r.status + ')');
  const total = Number(r.headers.get('content-length')) || 0;
  if (!r.body || !total) return new Uint8Array(await r.arrayBuffer());
  const reader = r.body.getReader();
  const partes = [];
  let lidos = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    partes.push(value);
    lidos += value.length;
    onProgress?.(Math.min(0.85, (lidos / total) * 0.85));   // download = 85% da barra
  }
  const buf = new Uint8Array(lidos);
  let off = 0;
  for (const p of partes) { buf.set(p, off); off += p.length; }
  return buf;
}

/**
 * @returns {Promise<{samples: Float32Array, sr: number}>}
 */
export async function scanAudio(url, { onProgress, signal, sr = 16000 } = {}) {
  const emCache = cache.get(url);
  if (emCache) { onProgress?.(1); return emCache; }

  const bytes = await baixar(url, onProgress, signal);
  onProgress?.(0.88);

  const AC = window.AudioContext || window.webkitAudioContext;
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!AC && !OAC) throw new Error('Este navegador não decodifica áudio');

  // OfflineAudioContext resampleia no decode; alguns Safari recusam sampleRate
  // baixo — daí cai no contexto normal (mais memória, mesmo resultado).
  let audioBuf = null;
  if (OAC) {
    try {
      const oac = new OAC(1, 1, sr);
      audioBuf = await oac.decodeAudioData(bytes.buffer.slice(0));
    } catch { audioBuf = null; }
  }
  if (!audioBuf) {
    const ac = new AC();
    try { audioBuf = await ac.decodeAudioData(bytes.buffer.slice(0)); }
    finally { try { ac.close(); } catch {} }
  }
  if (!audioBuf || !audioBuf.length) throw new Error('Esta mídia não tem faixa de áudio');
  onProgress?.(0.97);

  // mistura os canais em mono (a fala está nos dois; somar melhora a relação
  // sinal/ruído da detecção)
  const n = audioBuf.length;
  const canais = audioBuf.numberOfChannels;
  const samples = new Float32Array(n);
  for (let c = 0; c < canais; c++) {
    const dados = audioBuf.getChannelData(c);
    for (let i = 0; i < n; i++) samples[i] += dados[i] / canais;
  }
  const res = { samples, sr: audioBuf.sampleRate };
  cache.set(url, res);
  onProgress?.(1);
  return res;
}

export function limparCacheScan(url) {
  if (url) cache.delete(url); else cache.clear();
}
