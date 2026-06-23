// api/_helpers/trial-token.js — HMAC-signed trial activation tokens (2026-06-23)
//
// Format: <base64url(email)>.<base64url(timestamp)>.<base64url(hmac-sha256(email|ts, SECRET))>
// Tokens expiram em 14 dias por seguranca (alem do limite de 7d na copy do email).
//
// Reusa UNSUBSCRIBE_HMAC_SECRET pra nao precisar configurar novo env var. Escopo
// se diferencia por incluir literal "trial:" no payload do HMAC.

const crypto = require('crypto');

const TRIAL_TOKEN_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 dias

function getSecret() {
  const raw = process.env.UNSUBSCRIBE_HMAC_SECRET;
  if (!raw) throw new Error('UNSUBSCRIBE_HMAC_SECRET nao configurado');
  return raw.trim();
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

function hmacPayload(email, ts) {
  return crypto.createHmac('sha256', getSecret())
    .update(`trial:${email}:${ts}`)
    .digest();
}

function signTrialToken(email) {
  if (!email || typeof email !== 'string') throw new Error('Email obrigatorio');
  const ts = String(Date.now());
  const emailB64 = b64urlEncode(email);
  const tsB64 = b64urlEncode(ts);
  const hmacB64 = hmacPayload(email, ts).toString('base64url');
  return `${emailB64}.${tsB64}.${hmacB64}`;
}

function verifyTrialToken(token) {
  if (!token || typeof token !== 'string') return { email: null, valid: false, reason: 'missing' };
  const parts = token.split('.');
  if (parts.length !== 3) return { email: null, valid: false, reason: 'malformed' };

  const [emailB64, tsB64, hmacB64] = parts;
  const email = b64urlDecode(emailB64);
  const ts = b64urlDecode(tsB64);
  if (!email || !email.includes('@') || !ts) return { email: null, valid: false, reason: 'decode' };

  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum)) return { email: null, valid: false, reason: 'ts_invalid' };
  if (Date.now() - tsNum > TRIAL_TOKEN_TTL_MS) {
    return { email, valid: false, reason: 'expired' };
  }

  const sentSig = b64urlDecodeBuffer(hmacB64);
  if (!sentSig) return { email: null, valid: false, reason: 'sig_decode' };

  let expectedSig;
  try { expectedSig = hmacPayload(email, ts); }
  catch (e) { return { email: null, valid: false, reason: 'no_secret' }; }

  if (sentSig.length !== expectedSig.length) return { email: null, valid: false, reason: 'sig_length' };
  if (!crypto.timingSafeEqual(sentSig, expectedSig)) return { email: null, valid: false, reason: 'sig_mismatch' };

  return { email, valid: true, ts: tsNum };
}

module.exports = { signTrialToken, verifyTrialToken, TRIAL_TOKEN_TTL_MS };
