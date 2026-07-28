// api/blue-tts.js — Geração de narração do BlueVoice (2026-07-28)
// =============================================================================
// Endpoint PRÓPRIO da narração, isolado do api/auth.js (que é ESM e intocável:
// mexer lá arrisca o login inteiro). Mesma lógica do bloco `action=tts` antigo
// — inclusive o retry com a outra chave — MAIS os controles de personalização
// que o ElevenLabs oferece e o BlueVoice não expunha:
//
//   model      eleven_v3 (expressivo) | eleven_multilingual_v2 (estável)
//   stability  0..1   criativo ←→ robusto
//   similarity 0..1   fidelidade à voz original
//   style      0..1   exagero de estilo (antes era FIXO em 0.4)
//   speed      0.7..1.2  velocidade da fala — SÓ v2 (a v3 não aceita)
//
// O auth.js segue funcionando pra qualquer consumidor antigo; este endpoint é
// o caminho novo do BlueVoice.

const LIMITE_CARACTERES = 3000;

const clamp = (v, min, max, def) => {
  const n = typeof v === 'number' ? v : parseFloat(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
};

// Registra que a voz clonada foi usada — é o sinal que impede o cron de
// hibernar quem está ativo. Fire-and-forget: nunca atrasa nem quebra a geração.
function marcarUsoDeClone(voiceId) {
  const SU = process.env.SUPABASE_URL, SK = process.env.SUPABASE_SERVICE_KEY;
  if (!SU || !SK || !voiceId) return;
  try {
    fetch(`${SU}/rest/v1/blue_voice_clones?voice_id=eq.${encodeURIComponent(voiceId)}`, {
      method: 'PATCH',
      headers: { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ last_used_at: new Date().toISOString() }),
    }).catch(() => {});
  } catch (e) { /* silencioso */ }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = req.body || {};
  const userKey = body.user_xi_key;
  const sysKey = process.env.ELEVENLABS_API_KEY;
  const XI_KEY = (userKey && userKey.length > 10) ? userKey : sysKey;
  if (!XI_KEY) return res.status(500).json({ error: 'ElevenLabs não configurado.' });

  const { voiceId, text } = body;
  if (!voiceId || !text) return res.status(400).json({ error: 'voiceId e text são obrigatórios' });
  if (String(text).length > LIMITE_CARACTERES) {
    return res.status(400).json({ error: `Texto excede ${LIMITE_CARACTERES} caracteres` });
  }

  const modelId = body.model === 'eleven_multilingual_v2' ? 'eleven_multilingual_v2' : 'eleven_v3';
  const stability = clamp(body.stability, 0, 1, 0.5);
  const similarity = clamp(body.similarity, 0, 1, 0.75);
  const style = clamp(body.style, 0, 1, 0.4);
  // speed só existe na v2 — mandar na v3 faz o ElevenLabs recusar a requisição
  const speed = modelId === 'eleven_multilingual_v2'
    ? clamp(body.speed, 0.7, 1.2, 1)
    : null;

  const voiceSettings = { stability, similarity_boost: similarity, style, use_speaker_boost: true };
  if (speed != null && speed !== 1) voiceSettings.speed = speed;

  const endpoint = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`;
  const payload = JSON.stringify({ text, model_id: modelId, voice_settings: voiceSettings });
  const headersFor = (key) => ({ 'xi-api-key': key, 'Content-Type': 'application/json', Accept: 'audio/mpeg' });

  try {
    let r = await fetch(endpoint, { method: 'POST', headers: headersFor(XI_KEY), body: payload });

    if (!r.ok) {
      // Retry com a outra chave (usuário ↔ sistema), igual ao fluxo antigo
      const fallbackKey = XI_KEY === userKey ? sysKey : (userKey && userKey.length > 10 ? userKey : null);
      if (fallbackKey && fallbackKey !== XI_KEY) {
        const retry = await fetch(endpoint, { method: 'POST', headers: headersFor(fallbackKey), body: payload });
        if (retry.ok) {
          const buf = await retry.arrayBuffer();
          return res.status(200).json({ audio: Buffer.from(buf).toString('base64'), format: 'mp3', model: modelId });
        }
        r = retry;
      }
      const err = await r.json().catch(() => ({}));
      const detalhe = (err.detail && (err.detail.message || err.detail.status)) || '';
      console.error('[blue-tts] ElevenLabs', r.status, String(detalhe).slice(0, 160));
      // Erro de parâmetro (ex: speed em modelo que não aceita) tem mensagem própria
      const paramRuim = /speed|voice_settings|invalid/i.test(String(detalhe));
      return res.status(400).json({
        error: paramRuim
          ? 'Essa combinação de ajustes não é aceita por este modelo. Tente o preset ↺ Padrão.'
          : 'Falha ao gerar narração. Esta voz pode não estar acessível.',
      });
    }

    const buf = await r.arrayBuffer();
    marcarUsoDeClone(voiceId); // alimenta a hibernação (fire-and-forget)
    return res.status(200).json({ audio: Buffer.from(buf).toString('base64'), format: 'mp3', model: modelId });
  } catch (e) {
    console.error('[blue-tts]', e && e.message);
    return res.status(500).json({ error: 'Falha ao gerar narração. Tente novamente.' });
  }
};
