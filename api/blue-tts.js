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

// ── ANTI-FLOOD (2026-07-28) ─────────────────────────────────────────────────
// O BlueVoice É ILIMITADO pro Master — e continua sendo. Isto aqui NÃO é cota:
// é um respiro contra uso automatizado/abusivo (script disparando geração em
// loop). Os números são propositalmente ABSURDOS: quem escreve roteiro e ouve
// o resultado JAMAIS encosta neles. Quem encosta, não é gente digitando.
//
// Quando dispara, o BluBlu pede uma pausa curta — e a fala dele NUNCA menciona
// limite/cota, porque não é isso: é ele indo tomar uma água.
const RAJADA_JANELA_MIN = parseInt(process.env.BLUEVOICE_BURST_MIN, 10) || 15;
const RAJADA_MAX = parseInt(process.env.BLUEVOICE_BURST_MAX, 10) || 60;      // gerações na janela
const TETO_DIARIO_ABSURDO = parseInt(process.env.BLUEVOICE_DAILY_MAX, 10) || 400; // só trava robô

// Recados do BluBlu — pausa, não limite. Sem citar motor/fornecedor.
const RECADOS_PAUSA = [
  'Calma aí, paizão! Vai devagar nessas gerações. Vou ali tomar uma água e já volto em {min} minutos, beleza? 💧',
  'Opa, opa! Segura essa onda um pouquinho. Minha garganta tá pedindo arrego — {min} minutinhos e eu tô de volta na ativa. 🎙️',
  'Uau, você tá com a mão pesada hoje! Deixa eu respirar {min} minutos e a gente volta a todo vapor. 😅',
  'Ei, maratonista! Nem eu narro nesse ritmo. Me dá {min} minutos pra molhar a garganta e seguimos. 🏃',
];
const RECADOS_GLOBAL = [
  'Meu estúdio entrou em manutenção rapidinho. Não é você, sou eu — literalmente. Tenta de novo daqui a pouco que eu volto afinado. 🔧',
  'Pausa técnica no estúdio! Volto já já pra narrar até bula de remédio se você quiser. ⚡',
];
const sorteia = (arr) => arr[Math.floor(Math.random() * arr.length)];

// Uso do dia + rajada recente (por usuário). O registro serve TAMBÉM pra
// medição de consumo, que antes não existia em lugar nenhum.
async function lerUso(SU, SK, userId) {
  const dia = new Date().toISOString().slice(0, 10);
  const vazio = { geracoes: 0, caracteres: 0, dia, rajada: 0 };
  try {
    const [dR, rR] = await Promise.all([
      fetch(`${SU}/rest/v1/blue_voice_usage?user_id=eq.${encodeURIComponent(userId)}&dia=eq.${dia}&select=geracoes,caracteres`, {
        headers: { apikey: SK, Authorization: 'Bearer ' + SK },
      }),
      // gerações na janela recente (anti-flood)
      fetch(`${SU}/rest/v1/blue_voice_events?user_id=eq.${encodeURIComponent(userId)}&criado_em=gte.${new Date(Date.now() - RAJADA_JANELA_MIN * 60000).toISOString()}&select=id`, {
        headers: { apikey: SK, Authorization: 'Bearer ' + SK, Prefer: 'count=exact' },
      }),
    ]);
    const row = dR.ok ? (await dR.json())[0] : null;
    const rajada = parseInt((rR.headers.get('content-range') || '').split('/')[1] || '0', 10) || 0;
    return { geracoes: row?.geracoes || 0, caracteres: row?.caracteres || 0, dia, rajada };
  } catch (e) { return vazio; }
}

function registrarUso(SU, SK, userId, dia, uso, chars) {
  if (!userId) return;
  const H = { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' };
  // acumulado do dia (medição de consumo)
  fetch(`${SU}/rest/v1/blue_voice_usage?on_conflict=user_id,dia`, {
    method: 'POST',
    headers: { ...H, Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify([{ user_id: userId, dia, geracoes: (uso.geracoes || 0) + 1, caracteres: (uso.caracteres || 0) + chars, updated_at: new Date().toISOString() }]),
  }).catch(() => {});
  // evento individual (alimenta a janela do anti-flood)
  fetch(`${SU}/rest/v1/blue_voice_events`, {
    method: 'POST', headers: { ...H, Prefer: 'return=minimal' },
    body: JSON.stringify({ user_id: userId, caracteres: chars }),
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
      // Rajada: muitas gerações em poucos minutos = automação, não pessoa.
      // Pausa curta, sem falar em cota (o plano continua ilimitado).
      if (uso.rajada >= RAJADA_MAX) {
        return res.status(429).json({
          error: sorteia(RECADOS_PAUSA).replace('{min}', String(RAJADA_JANELA_MIN)),
          motivo: 'pausa', pausa_min: RAJADA_JANELA_MIN, blublu: true,
        });
      }
      // Teto diário deliberadamente absurdo — só um robô rodando a noite toda chega lá
      if (uso.geracoes >= TETO_DIARIO_ABSURDO) {
        return res.status(429).json({
          error: sorteia(RECADOS_PAUSA).replace('{min}', '30'),
          motivo: 'pausa', pausa_min: 30, blublu: true,
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

  // 192 kbps (2026-07-28): o plano Creator já paga por essa qualidade e a
  // narração saía em 128. Custo em créditos é IDÊNTICO — a cobrança é por
  // caractere, não por bitrate (medido: mesmo texto, mesmo consumo; arquivo
  // 56% maior). Se o formato for recusado, cai no padrão da conta.
  const endpoint = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_192`;
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
    // Sem devolver contador de uso: o plano é ilimitado e nada na tela deve
    // sugerir cota. A medição fica só no banco, pro admin.
    return res.status(200).json({ audio: Buffer.from(buf).toString('base64'), format: 'mp3', model: modelId });
  } catch (e) {
    console.error('[blue-tts]', e && e.message);
    return res.status(500).json({ error: 'Falha ao gerar narração. Tente novamente.' });
  }
};
