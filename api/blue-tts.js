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

// ── PROTEÇÃO DE QUOTA (2026-07-28) ──────────────────────────────────────────
// O plano ElevenLabs tem teto MENSAL de créditos (1 crédito ≈ 1 caractere).
// "Ilimitado pro Master" sem freio = fatura estourada / feature fora do ar pra
// todo mundo. Dois freios, ambos ajustáveis por env:
//   1. teto DIÁRIO por usuário  (uso normal nem encosta)
//   2. reserva GLOBAL da conta  (trava novas gerações antes de zerar a quota)
const LIMITE_DIARIO_CHARS = parseInt(process.env.BLUEVOICE_DAILY_CHARS, 10) || 6000;
const RESERVA_GLOBAL_PCT = 0.05; // guarda os últimos 5% da quota do mês

// Recados do BluBlu — ácidos, mas sempre dizendo o que fazer em seguida
const RECADOS_LIMITE = [
  'Opa. Você torrou seus {limite} caracteres de hoje. Eu narraria a noite toda, mas minhas cordas vocais são alugadas — e o senhorio cobra por caractere. Volta amanhã que eu tô aqui. Não é como se eu tivesse vida social. 🎙️',
  'Fim da cota diária, campeão. Sim, eu também acho pouco. Não, eu não posso fazer nada — sou uma IA com síndrome de estagiário: muita vontade, orçamento nenhum. Amanhã a gente continua. 💅',
  'Seus {limite} caracteres de hoje viraram áudio. Todos eles. Eu tô impressionado e levemente preocupado. Descansa esse roteiro — amanhã tem mais. 🔥',
];
const RECADOS_GLOBAL = [
  'Notícia ruim: a reserva de voz da casa tá no vermelho esse mês. Não é você, sou eu — mais especificamente, minha conta de luz. Volta quando a quota renovar que eu narro até guia telefônica. ⚡',
  'A quota mensal do estúdio acabou. Eu avisei que aquele roteiro de 3 mil caracteres sobre pinguins ia custar caro. Ninguém me escuta. Literalmente. 🐧',
];
const sorteia = (arr) => arr[Math.floor(Math.random() * arr.length)];

// Uso do dia (por usuário). Sem token identificado, o freio diário não se
// aplica — a reserva global continua protegendo a conta.
async function lerUso(SU, SK, userId) {
  const dia = new Date().toISOString().slice(0, 10);
  try {
    const r = await fetch(`${SU}/rest/v1/blue_voice_usage?user_id=eq.${encodeURIComponent(userId)}&dia=eq.${dia}&select=geracoes,caracteres`, {
      headers: { apikey: SK, Authorization: 'Bearer ' + SK },
    });
    if (!r.ok) return { geracoes: 0, caracteres: 0, dia };
    const row = (await r.json())[0];
    return { geracoes: row?.geracoes || 0, caracteres: row?.caracteres || 0, dia };
  } catch (e) { return { geracoes: 0, caracteres: 0, dia }; }
}

function registrarUso(SU, SK, userId, dia, uso, chars) {
  if (!userId) return;
  fetch(`${SU}/rest/v1/blue_voice_usage?on_conflict=user_id,dia`, {
    method: 'POST',
    headers: { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify([{ user_id: userId, dia, geracoes: (uso.geracoes || 0) + 1, caracteres: (uso.caracteres || 0) + chars, updated_at: new Date().toISOString() }]),
  }).catch(() => {});
}

// Quota da conta ElevenLabs (cacheada 5min — não consulta a cada geração)
let _quotaCache = { at: 0, restante: null, limite: null };
async function quotaGlobal(EL) {
  if (Date.now() - _quotaCache.at < 300000) return _quotaCache;
  try {
    const r = await fetch('https://api.elevenlabs.io/v1/user/subscription', { headers: { 'xi-api-key': EL } });
    if (!r.ok) return _quotaCache;
    const s = await r.json();
    _quotaCache = { at: Date.now(), restante: (s.character_limit || 0) - (s.character_count || 0), limite: s.character_limit || 0 };
  } catch (e) {}
  return _quotaCache;
}

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
  const chars = String(text).length;
  if (chars > LIMITE_CARACTERES) {
    return res.status(400).json({ error: `Texto excede ${LIMITE_CARACTERES} caracteres` });
  }

  // ── FREIOS DE QUOTA ───────────────────────────────────────────────────────
  // Só valem quando a geração usa a chave DA CASA. Quem trouxe a própria chave
  // do ElevenLabs gasta a quota dele — não faz sentido limitar.
  const SU = process.env.SUPABASE_URL, SK = process.env.SUPABASE_SERVICE_KEY;
  const usandoChaveDaCasa = XI_KEY === sysKey;
  let uso = null, userId = null;
  if (usandoChaveDaCasa && SU && SK) {
    // 1) reserva global: protege a conta de zerar no meio do mês
    const q = await quotaGlobal(XI_KEY);
    if (q.limite && q.restante != null && q.restante < Math.max(2000, q.limite * RESERVA_GLOBAL_PCT)) {
      return res.status(429).json({ error: sorteia(RECADOS_GLOBAL), motivo: 'quota_mensal', blublu: true });
    }
    // 2) teto diário por usuário
    if (body.token) {
      try {
        const ur = await fetch(`${SU}/auth/v1/user`, {
          headers: { apikey: process.env.SUPABASE_ANON_KEY || SK, Authorization: 'Bearer ' + body.token },
        });
        if (ur.ok) userId = (await ur.json()).id || null;
      } catch (e) {}
    }
    if (userId) {
      uso = await lerUso(SU, SK, userId);
      if (uso.caracteres + chars > LIMITE_DIARIO_CHARS) {
        return res.status(429).json({
          error: sorteia(RECADOS_LIMITE).replace('{limite}', LIMITE_DIARIO_CHARS.toLocaleString('pt-BR')),
          motivo: 'limite_diario',
          usado_hoje: uso.caracteres,
          limite_diario: LIMITE_DIARIO_CHARS,
          blublu: true,
        });
      }
    }
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
    if (uso && userId) registrarUso(SU, SK, userId, uso.dia, uso, chars);
    return res.status(200).json({
      audio: Buffer.from(buf).toString('base64'), format: 'mp3', model: modelId,
      usado_hoje: uso ? uso.caracteres + chars : null,
      limite_diario: uso ? LIMITE_DIARIO_CHARS : null,
    });
  } catch (e) {
    console.error('[blue-tts]', e && e.message);
    return res.status(500).json({ error: 'Falha ao gerar narração. Tente novamente.' });
  }
};
