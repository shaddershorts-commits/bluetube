// api/_helpers/embeddings.js
// Gera embeddings com fallback multi-provider. Usa cache persistente
// pra economizar quota. 3 camadas: cache -> OpenAI -> hash pseudo-embedding.

const crypto = require('crypto');

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

// Pseudo-embedding deterministico baseado em hash de palavras.
// Nao e tao bom quanto OpenAI mas permite similarity search basico.
function pseudoEmbedding(texto) {
  const palavras = texto.toLowerCase()
    .replace(/[^\w\sáàâãéêíóôõúçñü]/g, ' ')
    .split(/\s+/)
    .filter(p => p.length >= 3);

  const vec = new Array(1536).fill(0);
  palavras.forEach(p => {
    const idx = simpleHash(p) % 1536;
    vec[idx] += 1;
    // Espalha um pouco pra nao concentrar em 1 bucket
    vec[(idx + 17) % 1536] += 0.5;
    vec[(idx + 31) % 1536] += 0.3;
  });

  // Normaliza (L2)
  const mag = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  return vec.map(v => v / mag);
}

// Gera embedding com cache + fallback. Retorna { embedding, fonte } ou null.
async function gerarEmbedding(ctx, texto) {
  if (!texto || typeof texto !== 'string') return null;
  const hash = sha256(texto.toLowerCase().trim());
  const { SU, h } = ctx;

  // Camada 1: cache local
  try {
    const r = await fetch(
      `${SU}/rest/v1/embeddings_cache?texto_hash=eq.${hash}&select=embedding_json,embedding,modelo&limit=1`,
      { headers: h, signal: AbortSignal.timeout(3000) }
    );
    if (r.ok) {
      const [row] = await r.json();
      if (row) {
        const emb = row.embedding_json || row.embedding;
        if (emb) return { embedding: emb, fonte: 'cache', modelo: row.modelo };
      }
    }
  } catch (e) { /* segue */ }

  // Camada 2: OpenAI (se disponivel)
  if (process.env.OPENAI_API_KEY) {
    try {
      const r = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model: 'text-embedding-3-small', input: texto.slice(0, 8000) }),
        signal: AbortSignal.timeout(8000),
      });
      if (r.ok) {
        const data = await r.json();
        const emb = data.data?.[0]?.embedding;
        if (emb) {
          // Cacheia (best-effort, nao bloqueia)
          salvarCache(ctx, hash, texto, emb, 'openai-3-small').catch(() => {});
          return { embedding: emb, fonte: 'openai', modelo: 'openai-3-small' };
        }
      }
    } catch (e) { console.error('[embeddings] OpenAI falhou:', e.message); }
  }

  // Camada 3: pseudo-embedding por hash (sempre funciona, deterministico)
  try {
    const emb = pseudoEmbedding(texto);
    salvarCache(ctx, hash, texto, emb, 'pseudo-hash').catch(() => {});
    return { embedding: emb, fonte: 'pseudo', modelo: 'pseudo-hash' };
  } catch (e) {
    console.error('[embeddings] pseudo falhou:', e.message);
    return null;
  }
}

async function salvarCache(ctx, hash, texto, embedding, modelo) {
  const { SU, h } = ctx;
  // Tenta coluna vector (se pgvector habilitado), senao JSONB
  const body = {
    texto_hash: hash,
    texto_original: texto.slice(0, 500),
    modelo,
  };
  // Tenta com campo JSONB primeiro (formato mais comum sem pgvector)
  body.embedding_json = embedding;
  try {
    await fetch(`${SU}/rest/v1/embeddings_cache`, {
      method: 'POST',
      headers: { ...h, Prefer: 'return=minimal,resolution=merge-duplicates' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    // Se falhou, tenta sem embedding_json (caso tabela tenha so vector)
    delete body.embedding_json;
    body.embedding = embedding;
    try {
      await fetch(`${SU}/rest/v1/embeddings_cache`, {
        method: 'POST',
        headers: { ...h, Prefer: 'return=minimal,resolution=merge-duplicates' },
        body: JSON.stringify(body),
      });
    } catch (e2) { /* cache write falhou — ok, nao afeta retorno */ }
  }
}

function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 0 ? dot / denom : 0;
}

module.exports = { gerarEmbedding, pseudoEmbedding, cosineSimilarity, simpleHash, sha256 };
