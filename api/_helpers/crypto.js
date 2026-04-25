// api/_helpers/crypto.js — AES-256-GCM encryption helper for affiliate PII
// (Fix 5 - Gap 3). Cobre chave_pix em affiliates + affiliate_saques.
//
// Storage format: "aes256gcm:v1:<base64url(iv|ct|tag)>"
//   - iv: 12 bytes random per encryption (NIST recomendado pra GCM)
//   - tag: 16 bytes auth tag (GCM autenticado, deteccao de tampering)
//   - prefix versionado: futura rotacao/algoritmo nao quebra reads existentes
//
// Detecao automatica de formato: decryptValue() aceita AMBOS plaintext (legacy)
// e encrypted (novo). Permite migration in-place sem schema change.
//
// CRITICAL: ENCRYPTION_KEY_AFFILIATES e IRRECUPERAVEL. Se perder, dados
// encrypted ficam ilegiveis pra sempre. Felipe mantem backup pessoal alem
// do Vercel.

const crypto = require('node:crypto');

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;
const PREFIX = 'aes256gcm:v1:';

function getKey() {
  const raw = process.env.ENCRYPTION_KEY_AFFILIATES;
  if (!raw) throw new Error('ENCRYPTION_KEY_AFFILIATES nao configurado');
  // .trim() defensivo (lessao Fix 4: paste no Vercel pode pegar whitespace)
  const hex = raw.trim();
  if (hex.length !== 64) throw new Error('ENCRYPTION_KEY_AFFILIATES deve ter 64 chars hex (32 bytes)');
  return Buffer.from(hex, 'hex');
}

/**
 * isEncrypted(value) — detecta se valor esta no formato encrypted ou legacy plaintext.
 */
function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

/**
 * encryptValue(plain) -> "aes256gcm:v1:<base64url(iv|ct|tag)>"
 * Idempotente: se ja encrypted, retorna como-esta (evita double-encrypt).
 * null/undefined/'' passam through unchanged.
 */
function encryptValue(plain) {
  if (plain == null || plain === '') return plain;
  if (typeof plain !== 'string') throw new Error('encryptValue: input deve ser string');
  if (isEncrypted(plain)) return plain; // ja encrypted, no-op

  const key = getKey();
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const payload = Buffer.concat([iv, ct, tag]).toString('base64url');
  return PREFIX + payload;
}

/**
 * decryptValue(stored) -> plaintext
 *  - Se stored comeca com PREFIX: decifra e retorna plaintext
 *  - Se stored e plaintext legacy (sem PREFIX): retorna como-esta (compat durante migration)
 *  - null/undefined/'' passam through
 *  - Se decrypt falhar (auth tag invalido, key errada): joga Error
 */
function decryptValue(stored) {
  if (stored == null || stored === '') return stored;
  if (typeof stored !== 'string') return stored;
  if (!isEncrypted(stored)) return stored; // legacy plaintext

  const key = getKey();
  const payload = Buffer.from(stored.slice(PREFIX.length), 'base64url');
  if (payload.length < IV_LEN + TAG_LEN + 1) throw new Error('decryptValue: payload muito curto');

  const iv = payload.subarray(0, IV_LEN);
  const tag = payload.subarray(payload.length - TAG_LEN);
  const ct = payload.subarray(IV_LEN, payload.length - TAG_LEN);

  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  return plain;
}

/**
 * decryptSafe(stored) -> plaintext OU stored se decrypt falhar (silencioso).
 * Util pra contextos onde quebrar a request inteira por 1 valor corrupto e pior
 * que mostrar valor "bruto" — exemplo: admin panel listando saques antigos.
 */
function decryptSafe(stored) {
  try { return decryptValue(stored); }
  catch (e) { return stored; }
}

module.exports = {
  encryptValue,
  decryptValue,
  decryptSafe,
  isEncrypted,
  PREFIX,
};
