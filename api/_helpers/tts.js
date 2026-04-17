// api/_helpers/tts.js — ElevenLabs primário, OpenAI TTS como fallback.
// Retorna { audio: Buffer, format: 'mp3', provider, warning? }.

const TIMEOUT_MS = 60000;

function withTimeout(ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return { signal: ctrl.signal, clear: () => clearTimeout(timer) };
}

// Mapa de voz OpenAI por idioma/gender (fallback quando ElevenLabs cair)
const OPENAI_VOICE_MAP = {
  'pt-BR-male': 'onyx',
  'pt-BR-female': 'nova',
  'en-US-male': 'echo',
  'en-US-female': 'shimmer',
  'es-ES-female': 'nova',
  default: 'alloy',
};

const PROVIDERS = [
  {
    name: 'elevenlabs',
    available: () => !!process.env.ELEVENLABS_API_KEY,
    call: async (text, voiceId, options) => {
      if (!voiceId) throw new Error('ElevenLabs: voiceId obrigatório');
      const t = withTimeout(TIMEOUT_MS);
      try {
        const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
          method: 'POST',
          headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text,
            model_id: options?.modelId || 'eleven_multilingual_v2',
            voice_settings: {
              stability: options?.stability ?? 0.5,
              similarity_boost: options?.similarity ?? 0.75,
            },
          }),
          signal: t.signal,
        });
        if (!r.ok) {
          const body = await r.text().catch(() => '');
          throw new Error(`ElevenLabs ${r.status} ${body.slice(0, 200)}`);
        }
        const buffer = Buffer.from(await r.arrayBuffer());
        return { audio: buffer, format: 'mp3', provider: 'elevenlabs' };
      } finally { t.clear(); }
    },
  },
  {
    name: 'openai-tts',
    available: () => !!process.env.OPENAI_API_KEY,
    call: async (text, _voiceId, options) => {
      const lang = options?.language || 'default';
      const voice = OPENAI_VOICE_MAP[lang] || OPENAI_VOICE_MAP.default;
      const t = withTimeout(TIMEOUT_MS);
      try {
        const r = await fetch('https://api.openai.com/v1/audio/speech', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + process.env.OPENAI_API_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'tts-1', input: text, voice, response_format: 'mp3' }),
          signal: t.signal,
        });
        if (!r.ok) {
          const body = await r.text().catch(() => '');
          throw new Error(`OpenAI TTS ${r.status} ${body.slice(0, 200)}`);
        }
        const buffer = Buffer.from(await r.arrayBuffer());
        return {
          audio: buffer,
          format: 'mp3',
          provider: 'openai-tts',
          warning: 'Voz alternativa — provider primário temporariamente indisponível',
        };
      } finally { t.clear(); }
    },
  },
];

/**
 * @param {string} text — texto a sintetizar
 * @param {string} voiceId — voz preferida (usado pelo ElevenLabs)
 * @param {object} [options] — { language, stability, similarity, modelId }
 */
async function generateSpeech(text, voiceId, options = {}) {
  if (!text?.trim()) throw new Error('Texto vazio');
  const errors = [];
  for (const p of PROVIDERS) {
    if (!p.available()) { errors.push({ provider: p.name, error: 'unavailable' }); continue; }
    try {
      return await p.call(text, voiceId, options);
    } catch (e) {
      console.error(`[tts] ${p.name} falhou: ${e.message}`);
      errors.push({ provider: p.name, error: e.message });
    }
  }
  const err = new Error('Todos os providers de TTS falharam');
  err.attempts = errors;
  throw err;
}

module.exports = { generateSpeech, OPENAI_VOICE_MAP };
