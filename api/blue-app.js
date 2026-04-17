// api/blue-app.js — Serve o public/blue.html em rotas /blue/* (deep links do SPA).
// Contorna o conflito entre cleanUrls:true e subpaths de um arquivo existente
// (/blue.html + /blue/@foo confundiam o router do Vercel — rewrites caiam 404).
// O blue.html em /blue continua sendo servido nativamente pelo static hosting.

const fs = require('fs');
const path = require('path');

let _cached = null;
let _cachedAt = 0;
const CACHE_TTL_MS = 15_000; // Re-le o HTML a cada 15s no servidor (negligivel no hot path)

module.exports = function handler(req, res) {
  try {
    const now = Date.now();
    if (!_cached || now - _cachedAt > CACHE_TTL_MS) {
      _cached = fs.readFileSync(path.join(process.cwd(), 'public/blue.html'), 'utf8');
      _cachedAt = now;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.status(200).send(_cached);
  } catch (e) {
    res.status(500).send('Error loading app');
  }
};
