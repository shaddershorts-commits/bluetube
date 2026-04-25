// api/_helpers/crypto.js — AES-256-GCM encryption helper
//
// Fix 5 (Gap 3): chave_pix em affiliates + affiliate_saques (string-based).
// Fix 7 (Gap 2): backups blue-backup.js (buffer-based, multi-domain key).
//
// Storage format: "aes256gcm:v1:<base64url(iv|ct|tag)>"
//   - iv: 12 bytes random per encryption (NIST recomendado pra GCM)
//   - tag: 16 bytes auth tag (GCM autenticado, deteccao de tampering)
//   - prefix versionado: futura rotacao/algoritmo nao quebra reads existentes
//
// Detecao automatica de formato: decryptValue() aceita AMBOS plaintext (legacy)
// e encrypted (novo). Permite migration in-place sem schema change.
//
// Multi-domain keys (Fix 7):
//   - 'affiliates' -> ENCRYPTION_KEY_AFFILIATES (Fix 5)
//   - 'backups'    -> ENCRYPTION_KEY_BACKUPS (Fix 7)
// Isolamento de dominio: comprometimento de uma chave nao afeta a outra.
//
// CRITICAL: chaves sao IRRECUPERAVEIS. Se perder, dados encrypted ficam
// ilegiveis pra sempre. Felipe mantem backup pessoal alem do Vercel.

const crypto = require('node:crypto');

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;
const PREFIX = 'aes256gcm:v1:';
// Header binario pra encryptBuffer: 14 bytes ASCII pra detectar format de buffer encrypted
const BUFFER_MAGIC = Buffer.from('AESGCM_v1\0\0\0\0\0', 'utf8'); // 14 bytes (padding pra 14)

const KEY_ENV_BY_DOMAIN = {
  affiliates: 'ENCRYPTION_KEY_AFFILIATES',
  backups: 'ENCRYPTION_KEY_BACKUPS',
};

function getKeyForDomain(domain) {
  const envName = KEY_ENV_BY_DOMAIN[domain];
  if (!envName) throw new Error(`getKeyForDomain: dominio invalido '${domain}' (use 'affiliates' ou 'backups')`);
  const raw = process.env[envName];
  if (!raw) throw new Error(`${envName} nao configurado`);
  // .trim() defensivo (lessao Fix 4: paste no Vercel pode pegar whitespace)
  const hex = raw.trim();
  if (hex.length !== 64) throw new Error(`${envName} deve ter 64 chars hex (32 bytes)`);
  return Buffer.from(hex, 'hex');
}

// Backward-compat: getKey() default usa dominio 'affiliates' (Fix 5 callers)
function getKey() { return getKeyForDomain('affiliates'); }

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

// ── BUFFER (binario) — Fix 7 (Gap 2): backups encrypted ──────────────────
//
// Format: [BUFFER_MAGIC (14B) | IV (12B) | CT (var) | TAG (16B)]
// Total overhead: 42 bytes vs plaintext.
// Domain default: 'backups' (Fix 7 callers passam 'backups' explicito).
//
// Pra arquivos pequenos-medios (<50MB cabem em RAM Vercel sem stream).

/**
 * encryptBuffer(plainBuf, domain) -> Buffer encrypted
 * Idempotente: se ja encrypted (header magic match), retorna como-esta.
 */
function encryptBuffer(plainBuf, domain = 'backups') {
  if (!Buffer.isBuffer(plainBuf)) throw new Error('encryptBuffer: input deve ser Buffer');
  if (plainBuf.length >= BUFFER_MAGIC.length && plainBuf.subarray(0, BUFFER_MAGIC.length).equals(BUFFER_MAGIC)) {
    return plainBuf; // ja encrypted, no-op
  }
  const key = getKeyForDomain(domain);
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plainBuf), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([BUFFER_MAGIC, iv, ct, tag]);
}

/**
 * decryptBuffer(encryptedBuf, domain) -> Buffer plaintext
 * Detecta format pelo magic header. Se nao tem header (legacy plaintext): retorna como-esta.
 * Se header presente mas decrypt falha (tag invalido / key errada): joga Error.
 */
function decryptBuffer(encryptedBuf, domain = 'backups') {
  if (!Buffer.isBuffer(encryptedBuf)) throw new Error('decryptBuffer: input deve ser Buffer');
  if (encryptedBuf.length < BUFFER_MAGIC.length + IV_LEN + TAG_LEN) {
    return encryptedBuf; // muito pequeno pra ser encrypted, assume legacy
  }
  if (!encryptedBuf.subarray(0, BUFFER_MAGIC.length).equals(BUFFER_MAGIC)) {
    return encryptedBuf; // sem magic header = legacy plaintext, retorna as-is
  }
  const key = getKeyForDomain(domain);
  const iv = encryptedBuf.subarray(BUFFER_MAGIC.length, BUFFER_MAGIC.length + IV_LEN);
  const tag = encryptedBuf.subarray(encryptedBuf.length - TAG_LEN);
  const ct = encryptedBuf.subarray(BUFFER_MAGIC.length + IV_LEN, encryptedBuf.length - TAG_LEN);
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

function isEncryptedBuffer(buf) {
  return Buffer.isBuffer(buf)
    && buf.length >= BUFFER_MAGIC.length
    && buf.subarray(0, BUFFER_MAGIC.length).equals(BUFFER_MAGIC);
}

module.exports = {
  encryptValue,
  decryptValue,
  decryptSafe,
  isEncrypted,
  PREFIX,
  // Fix 7 (Gap 2): buffer-based encryption pra backups
  encryptBuffer,
  decryptBuffer,
  isEncryptedBuffer,
  getKeyForDomain,
};
