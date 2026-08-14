// api/separar-audio.js — SEPARAR VOZ × MÚSICA (Demucs htdemucs no Replicate)
// Decisão de infra do dono em 14/08/2026 (opção C): mesmo modelo top
// open-source, GPU por segundo — smoke real mediu 2,7s de GPU (~US$0,0006)
// pra 20s de áudio, separação limpa (voz -25dB onde há fala vs -80dB onde é
// só música). Endpoint ISOLADO (regra da casa) — o editor consome via menu.
//
// actions:
//   start  {audio_url}  → { job_id }
//   status {job_id}     → { status: processing|done|error, vocals_url, no_vocals_url }
// Ao concluir, os stems são COPIADOS pro nosso Storage (replicate.delivery
// expira) num caminho determinístico por job — o status é idempotente.
//
// Gate: login + Master (mesmo padrão do BlueClean).

const DEMUCS_VERSION = '5a7041cc9b82e5a558fea6b3d7b12dea89625e89da33f0447bd727c2d0ab9e77';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });

  const SU = process.env.SUPABASE_URL;
  const SK = process.env.SUPABASE_SERVICE_KEY;
  const AK = process.env.SUPABASE_ANON_KEY || SK;
  const RT = process.env.REPLICATE_API_TOKEN;
  if (!SU || !SK || !RT) return res.status(500).json({ error: 'config' });
  const H = { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' };

  // ── AUTH: login + Master ───────────────────────────────────────────────────
  const token = req.body?.token;
  let userId = null;
  if (token) {
    try {
      const ur = await fetch(`${SU}/auth/v1/user`, { headers: { apikey: AK, Authorization: 'Bearer ' + token } });
      if (ur.ok) {
        const u = await ur.json();
        const pr = await fetch(`${SU}/rest/v1/subscribers?email=eq.${encodeURIComponent(u.email)}&select=plan,plan_expires_at,is_manual`, { headers: H });
        if (pr.ok) {
          const sub = (await pr.json())[0];
          const vivo = sub && sub.plan === 'master' && (sub.is_manual || !sub.plan_expires_at || new Date(sub.plan_expires_at) > new Date());
          if (vivo) userId = u.id;
        }
      }
    } catch (e) {}
  }
  if (!userId) return res.status(403).json({ error: 'Separar voz × música é exclusivo do plano Master.', upgrade: true });

  const action = req.body?.action;

  if (action === 'start') {
    const audioUrl = String(req.body?.audio_url || '');
    if (!/^https?:\/\//.test(audioUrl) || audioUrl.length > 800) {
      return res.status(400).json({ error: 'áudio inválido' });
    }
    try {
      const pred = await fetch('https://api.replicate.com/v1/predictions', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + RT, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: DEMUCS_VERSION,
          input: { audio: audioUrl, stem: 'vocals', model: 'htdemucs', output_format: 'mp3' },
        }),
      }).then((r) => r.json());
      if (!pred.id) {
        console.error('[separar-audio] start:', JSON.stringify(pred).slice(0, 200));
        return res.status(502).json({ error: 'A separação não começou. Tenta de novo.' });
      }
      return res.status(200).json({ job_id: pred.id });
    } catch (e) {
      console.error('[separar-audio] start:', e.message);
      return res.status(502).json({ error: 'A separação não começou. Tenta de novo.' });
    }
  }

  if (action === 'status') {
    const id = String(req.body?.job_id || '').slice(0, 64);
    if (!/^[a-z0-9]+$/i.test(id)) return res.status(400).json({ error: 'job_id' });
    try {
      const st = await fetch('https://api.replicate.com/v1/predictions/' + id, {
        headers: { Authorization: 'Bearer ' + RT },
      }).then((r) => r.json());
      if (st.status === 'failed' || st.status === 'canceled') {
        console.error('[separar-audio] falhou:', String(st.error || '').slice(0, 200));
        return res.status(200).json({ status: 'error', error: 'A separação falhou. Tenta de novo.' });
      }
      if (st.status !== 'succeeded') return res.status(200).json({ status: 'processing' });
      const vocals = st.output?.vocals, resto = st.output?.no_vocals || st.output?.other;
      if (!vocals || !resto) return res.status(200).json({ status: 'error', error: 'Separação sem resultado. Tenta de novo.' });
      // copia pro NOSSO Storage (replicate.delivery expira; caminho por job = idempotente)
      const copiar = async (url, nome) => {
        const p = `editor/separado/${userId}/${id}/${nome}.mp3`;
        const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
        const up = await fetch(`${SU}/storage/v1/object/blue-videos/${p}`, {
          method: 'POST', headers: { 'Content-Type': 'audio/mpeg', Authorization: 'Bearer ' + SK, 'x-upsert': 'true' },
          body: buf,
        });
        if (!up.ok) throw new Error('upload ' + up.status);
        return `${SU}/storage/v1/object/public/blue-videos/${p}`;
      };
      const [vocalsUrl, restoUrl] = await Promise.all([copiar(vocals, 'voz'), copiar(resto, 'musica')]);
      return res.status(200).json({ status: 'done', vocals_url: vocalsUrl, no_vocals_url: restoUrl });
    } catch (e) {
      console.error('[separar-audio] status:', e.message);
      return res.status(502).json({ error: 'status indisponível' });
    }
  }

  return res.status(400).json({ error: 'action inválida' });
};
