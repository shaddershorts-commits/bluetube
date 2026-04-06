// api/helpers/sanitize.js — Prompt injection detection + input sanitization

const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?(previous|above|prior)/i,
  /forget\s+(everything|all|your|the)/i,
  /you\s+are\s+now/i,
  /act\s+as\s+(a|an)/i,
  /pretend\s+(you|to)/i,
  /system\s*:/i,
  /\[INST\]/i,
  /###\s*(instruction|system|prompt)/i,
  /jailbreak/i,
  /DAN\s+mode/i,
  /override\s+(your|all|safety)/i,
  /disregard\s+(all|your|the)/i,
  /new\s+instructions?\s*:/i,
];

function detectInjection(text) {
  if (!text || typeof text !== 'string') return false;
  return INJECTION_PATTERNS.some(p => p.test(text));
}

function sanitizeInput(text) {
  if (!text || typeof text !== 'string') return '';
  return text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').slice(0, 5000).trim();
}

module.exports = { detectInjection, sanitizeInput };
