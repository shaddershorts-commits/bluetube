// api/_helpers/unsub-token.js — HMAC-signed unsubscribe tokens (Fix 4 - Gap 6)
//
// Format novo: <base64url(email)>.<base64url(hmac-sha256(email, SECRET))>
// Format legacy (retrocompat 30 dias): <base64url(email)> sem ponto
//
// Legacy aceito ate LEGACY_DEADLINE pra cobrir emails ja enviados em inboxes.
// Apos esse prazo, atualizar ou remover a branch legacy.

const crypto = require('crypto');

// Deploy Fix 4: 2026-04-25. Janela de 30 dias.
// Apos essa data, tokens sem HMAC sao rejeitados — ver docs/blue-pendencias.md.
const LEGACY_DEADLINE = new Date('2026-05-25T00:00:00Z').getTime();

function getSecret() {
  const raw = process.env.UNSUBSCRIBE_HMAC_SECRET;
  if (!raw) throw new Error('UNSUBSCRIBE_HMAC_SECRET nao configurado');
  // .trim() defensivo: paste no Vercel pode pegar whitespace/newline acidental
  const s = raw.trim();
  if (!s) throw new Error('UNSUBSCRIBE_HMAC_SECRET vazio apos trim');
  return s;
}

// DIAGNOSTIC TEMPORARIO (Fix 4 troubleshoot 2026-04-25): retorna fingerprint
// reversivel-zero do secret pra comparar local vs prod sem expor o valor.
// REMOVER apos diagnostico concluir + secret confirmado em producao.
function secretFingerprint() {
  try {
    const raw = process.env.UNSUBSCRIBE_HMAC_SECRET || '';
    const trimmed = raw.trim();
    const sha = crypto.createHash('sha256').update(trimmed).digest('hex').slice(0, 12);
    return { len_raw: raw.length, len_trim: trimmed.length, sha12: sha };
  } catch (e) { return { error: e.message }; }
}

function b64urlEncode(str) {
  return Buffer.from(str, 'utf8').toString('base64url');
}
function b64urlDecode(str) {
  try { return Buffer.from(str, 'base64url').toString('utf8'); }
  catch (e) { return null; }
}
function b64urlDecodeBuffer(str) {
  try { return Buffer.from(str, 'base64url'); }
  catch (e) { return null; }
}

function hmacEmail(email) {
  return crypto.createHmac('sha256', getSecret()).update(email).digest();
}

/**
 * signToken(email) -> "<emailB64>.<hmacB64>"
 * Sempre gera no formato novo (HMAC). Legacy e SO PRA decodificar tokens antigos.
 */
function signToken(email) {
  if (!email || typeof email !== 'string') throw new Error('Email obrigatorio');
  const emailB64 = b64urlEncode(email);
  const hmacB64 = hmacEmail(email).toString('base64url');
  return `${emailB64}.${hmacB64}`;
}

/**
 * verifyToken(token) -> { email, valid, format } | { email: null, valid: false }
 *  format: 'hmac' (novo) ou 'legacy' (sem HMAC, aceito ate LEGACY_DEADLINE)
 */
function verifyToken(token) {
  if (!token || typeof token !== 'string') return { email: null, valid: false };

  const parts = token.split('.');

  // Format novo: <emailB64>.<hmacB64>
  if (parts.length === 2) {
    const [emailB64, hmacB64] = parts;
    const email = b64urlDecode(emailB64);
    if (!email || !email.includes('@')) return { email: null, valid: false };

    const sentSig = b64urlDecodeBuffer(hmacB64);
    if (!sentSig) return { email: null, valid: false };

    let expectedSig;
    try { expectedSig = hmacEmail(email); }
    catch (e) { return { email: null, valid: false }; }

    if (sentSig.length !== expectedSig.length) return { email: null, valid: false };
    if (!crypto.timingSafeEqual(sentSig, expectedSig)) return { email: null, valid: false };

    return { email, valid: true, format: 'hmac' };
  }

  // Format legacy: <emailB64> (sem ponto). Aceito ate LEGACY_DEADLINE.
  if (parts.length === 1) {
    if (Date.now() > LEGACY_DEADLINE) return { email: null, valid: false };
    const email = b64urlDecode(parts[0]);
    if (!email || !email.includes('@')) return { email: null, valid: false };
    return { email, valid: true, format: 'legacy' };
  }

  return { email: null, valid: false };
}

module.exports = { signToken, verifyToken, LEGACY_DEADLINE, secretFingerprint };
