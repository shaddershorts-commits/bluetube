// api/helpers/validate.js — Input validation helpers

const YT_SHORTS_RE = /(?:youtube\.com\/shorts\/|youtu\.be\/)([a-zA-Z0-9_-]{6,20})/;
const YT_VIDEO_RE = /(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{6,20})/;

function sanitize(text) {
  if (typeof text !== 'string') return '';
  return text.replace(/<[^>]*>/g, '').trim();
}

function extractVideoId(url) {
  if (!url || typeof url !== 'string') return null;
  const m = url.match(YT_SHORTS_RE) || url.match(YT_VIDEO_RE);
  return m ? m[1] : null;
}

function validateVideoUrl(url) {
  if (!url || typeof url !== 'string') return { ok: false, error: 'Link do vídeo é obrigatório.' };
  const id = extractVideoId(url.trim());
  if (!id) return { ok: false, error: 'Link inválido. Use um link de YouTube Shorts.' };
  return { ok: true, videoId: id };
}

function validateText(text, maxLen, fieldName) {
  if (!text || typeof text !== 'string' || !text.trim()) return { ok: false, error: `${fieldName || 'Texto'} é obrigatório.` };
  const clean = sanitize(text);
  if (clean.length > maxLen) return { ok: false, error: `${fieldName || 'Texto'} excede o limite de ${maxLen} caracteres.` };
  return { ok: true, text: clean };
}

module.exports = { sanitize, extractVideoId, validateVideoUrl, validateText };
