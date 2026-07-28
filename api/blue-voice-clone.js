// api/blue-voice-clone.js — Clonagem de voz no BlueVoice (2026-07-28)
// =============================================================================
// O usuário grava/envia a própria voz PELO NOSSO SITE; a clonagem roda no motor
// do ElevenLabs e o resultado fica salvo no BlueVoice.
//
// REGRAS (decisão do user):
//   • Exclusivo Master · 1 clone por usuário (quem quiser mais, cria no
//     ElevenLabs e importa pelo fluxo já existente)
//   • Voz clonada é SEMPRE PRIVADA — nunca entra na vitrine da comunidade
//   • Slots do ElevenLabs (30 no plano Creator) são recurso escasso: clone
//     parado HIBERNA (some de lá, libera a vaga) mas o áudio fica guardado no
//     nosso storage pra reativar quando o dono voltar
//
// Actions:
//   upload-url  — devolve URL assinada pro navegador subir o áudio direto ao
//                 storage (evita o limite de corpo de request da Vercel)
//   criar       — cria a voz no ElevenLabs a partir do áudio já no storage
//   status      — situação do clone do usuário + vagas restantes
//   reativar    — recria a voz a partir do áudio guardado
//   remover     — apaga de vez (ElevenLabs + banco + storage)
//   hibernar    — (cron/admin) libera vagas de clones parados
//   slots       — (admin) panorama de ocupação

const EL_API = 'https://api.elevenlabs.io/v1';
const BUCKET = 'voice-samples';
const DIAS_INATIVIDADE = 30;       // sem uso por 30d → hiberna (libera a vaga)
const RESERVA_SLOTS = 3;           // deixa folga pro admin/importações
const MAX_BYTES = 12 * 1024 * 1024;

async function usuario(token, { SU, ANON }) {
  if (!token) return null;
  try {
    const r = await fetch(`${SU}/auth/v1/user`, { headers: { apikey: ANON, Authorization: 'Bearer ' + token } });
    if (!r.ok) return null;
    const u = await r.json();
    return u && u.id ? { id: u.id, email: String(u.email || '').toLowerCase() } : null;
  } catch (e) { return null; }
}

async function ehMaster(email, { SU, h }) {
  if (!email) return false;
  try {
    const r = await fetch(`${SU}/rest/v1/subscribers?email=eq.${encodeURIComponent(email)}&select=plan,plan_expires_at`, { headers: h });
    if (!r.ok) return false;
    const s = (await r.json())[0];
    if (!s || s.plan !== 'master') return false;
    if (s.plan_expires_at && new Date(s.plan_expires_at) < new Date()) return false;
    return true;
  } catch (e) { return false; }
}

// Vagas de voz clonada na conta ElevenLabs (o teto real do sistema)
async function vagas(EL) {
  try {
    const r = await fetch(`${EL_API}/user/subscription`, { headers: { 'xi-api-key': EL } });
    if (!r.ok) return null;
    const s = await r.json();
    const limite = s.voice_limit ?? 0;
    const usados = s.voice_slots_used ?? 0;
    return { usados, limite, livres: Math.max(0, limite - usados - RESERVA_SLOTS) };
  } catch (e) { return null; }
}

// Cria a voz no ElevenLabs a partir de um Buffer de áudio
async function clonarNoEleven(EL, nome, buffer, mime) {
  const fd = new FormData();
  fd.append('name', nome.slice(0, 60));
  fd.append('description', 'Voz clonada via BlueTube BlueVoice');
  fd.append('remove_background_noise', 'true');
  fd.append('files', new Blob([buffer], { type: mime || 'audio/mpeg' }), 'sample.mp3');
  const r = await fetch(`${EL_API}/voices/add`, { method: 'POST', headers: { 'xi-api-key': EL }, body: fd });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.voice_id) {
    const msg = (d.detail && (d.detail.message || d.detail.status)) || `HTTP ${r.status}`;
    const e = new Error(String(msg).slice(0, 200));
    e.status = r.status;
    throw e;
  }
  return d.voice_id;
}

async function baixarSample(SU, SK, path) {
  const r = await fetch(`${SU}/storage/v1/object/${BUCKET}/${path}`, {
    headers: { apikey: SK, Authorization: 'Bearer ' + SK },
  });
  if (!r.ok) throw new Error('sample_indisponivel');
  return Buffer.from(await r.arrayBuffer());
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const SU = process.env.SUPABASE_URL;
  const SK = process.env.SUPABASE_SERVICE_KEY;
  const ANON = process.env.SUPABASE_ANON_KEY || SK;
  const EL = process.env.ELEVENLABS_API_KEY;
  if (!SU || !SK) return res.status(500).json({ error: 'config_missing' });
  const h = { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' };

  const body = req.body || {};
  const action = body.action || req.query.action;

  try {
    // ── ADMIN: panorama de vagas ─────────────────────────────────────────
    if (action === 'slots') {
      if ((body.admin_secret || req.query.admin_secret) !== process.env.ADMIN_SECRET) {
        return res.status(401).json({ error: 'unauthorized' });
      }
      const v = EL ? await vagas(EL) : null;
      const r = await fetch(`${SU}/rest/v1/blue_voice_clones?select=user_id,name,status,last_used_at,created_at&order=last_used_at.asc`, { headers: h });
      const rows = r.ok ? await r.json() : [];
      return res.status(200).json({
        ok: true,
        elevenlabs: v,
        clones_ativos: rows.filter((x) => x.status === 'active').length,
        clones_hibernados: rows.filter((x) => x.status === 'hibernated').length,
        clones: rows,
      });
    }

    // ── CRON/ADMIN: hiberna clones parados (libera vagas) ────────────────
    if (action === 'hibernar') {
      const isCron = !!req.headers['x-vercel-cron'];
      const isAdmin = (body.admin_secret || req.query.admin_secret) === process.env.ADMIN_SECRET;
      if (!isCron && !isAdmin) return res.status(401).json({ error: 'unauthorized' });
      if (!EL) return res.status(200).json({ ok: false, motivo: 'sem_elevenlabs' });

      const corte = new Date(Date.now() - DIAS_INATIVIDADE * 86400000).toISOString();
      const r = await fetch(
        `${SU}/rest/v1/blue_voice_clones?status=eq.active&last_used_at=lt.${corte}&select=user_id,voice_id,name`,
        { headers: h }
      );
      const parados = r.ok ? await r.json() : [];
      const resultado = { ok: true, avaliados: parados.length, hibernados: 0, falhas: 0 };
      for (const c of parados) {
        try {
          if (c.voice_id) {
            await fetch(`${EL_API}/voices/${c.voice_id}`, { method: 'DELETE', headers: { 'xi-api-key': EL } }).catch(() => {});
          }
          await fetch(`${SU}/rest/v1/blue_voice_clones?user_id=eq.${encodeURIComponent(c.user_id)}`, {
            method: 'PATCH', headers: h,
            body: JSON.stringify({ status: 'hibernated', voice_id: null, hibernated_at: new Date().toISOString() }),
          });
          // A voz também some da lista do BlueVoice enquanto hibernada
          await fetch(`${SU}/rest/v1/blue_custom_voices?user_id=eq.${encodeURIComponent(c.user_id)}&voice_id=eq.${encodeURIComponent(c.voice_id || '')}`, {
            method: 'DELETE', headers: h,
          }).catch(() => {});
          resultado.hibernados++;
        } catch (e) { resultado.falhas++; }
      }
      return res.status(200).json(resultado);
    }

    // Daqui pra baixo: precisa de usuário logado
    const u = await usuario(body.token || req.query.token, { SU, ANON });
    if (!u) return res.status(401).json({ error: 'Faça login para clonar sua voz.' });
    const uid = encodeURIComponent(u.id);

    const atualR = await fetch(`${SU}/rest/v1/blue_voice_clones?user_id=eq.${uid}&select=*`, { headers: h });
    const atual = atualR.ok ? (await atualR.json())[0] : null;

    // ── STATUS ───────────────────────────────────────────────────────────
    if (action === 'status' || (!action && req.method === 'GET')) {
      const v = EL ? await vagas(EL) : null;
      return res.status(200).json({
        ok: true,
        tem_clone: !!atual,
        clone: atual ? {
          name: atual.name, status: atual.status, voice_id: atual.voice_id,
          created_at: atual.created_at, last_used_at: atual.last_used_at,
        } : null,
        vagas_livres: v ? v.livres : null,
        limite_por_usuario: 1,
      });
    }

    // ── UPLOAD-URL: navegador sobe o áudio direto pro storage ────────────
    if (action === 'upload-url') {
      if (!(await ehMaster(u.email, { SU, h }))) {
        return res.status(403).json({ error: 'A clonagem de voz é exclusiva do plano Master.' });
      }
      if (atual) {
        return res.status(400).json({
          error: 'Você já tem uma voz clonada. Cada conta pode clonar 1 voz — se quiser outra, remova a atual, ou crie no ElevenLabs e importe pelo botão "+ Adicionar".',
        });
      }
      const path = `${u.id}/${Date.now()}.mp3`;
      const r = await fetch(`${SU}/storage/v1/object/upload/sign/${BUCKET}/${path}`, {
        method: 'POST', headers: h, body: JSON.stringify({ expiresIn: 900 }),
      });
      if (!r.ok) {
        const t = await r.text().catch(() => '');
        return res.status(500).json({ error: 'Falha ao preparar upload', detalhe: t.slice(0, 160) });
      }
      const d = await r.json();
      return res.status(200).json({ ok: true, path, upload_url: `${SU}/storage/v1${d.url}` });
    }

    // ── CRIAR: clona no ElevenLabs a partir do áudio já no storage ───────
    if (action === 'criar') {
      if (!EL) return res.status(500).json({ error: 'ElevenLabs não configurado.' });
      if (!(await ehMaster(u.email, { SU, h }))) {
        return res.status(403).json({ error: 'A clonagem de voz é exclusiva do plano Master.' });
      }
      if (atual) return res.status(400).json({ error: 'Você já tem uma voz clonada (limite: 1 por conta).' });

      const { sample_path, name, genero, lang_code } = body;
      if (!sample_path || !String(sample_path).startsWith(u.id + '/')) {
        return res.status(400).json({ error: 'Áudio inválido. Envie a gravação de novo.' });
      }
      const v = await vagas(EL);
      if (v && v.livres <= 0) {
        return res.status(503).json({
          error: 'As vagas de clonagem estão cheias no momento. Vagas de quem não usa há um tempo são liberadas automaticamente — tente de novo mais tarde.',
          vagas: v,
        });
      }

      let buf;
      try { buf = await baixarSample(SU, SK, sample_path); }
      catch (e) { return res.status(400).json({ error: 'Não encontrei sua gravação. Grave novamente.' }); }
      if (buf.length > MAX_BYTES) return res.status(400).json({ error: 'Áudio muito grande (máx. 12 MB).' });
      if (buf.length < 20000) return res.status(400).json({ error: 'Gravação muito curta. Fale por pelo menos 30 segundos.' });

      let voiceId;
      try { voiceId = await clonarNoEleven(EL, name || `Voz de ${u.email.split('@')[0]}`, buf, 'audio/mpeg'); }
      catch (e) {
        const cheio = /limit|slot|maximum/i.test(e.message);
        return res.status(cheio ? 503 : 502).json({
          error: cheio ? 'As vagas de clonagem estão cheias agora. Tente mais tarde.' : 'O motor de clonagem recusou o áudio. Grave num lugar silencioso, falando de forma natural por 1 a 2 minutos.',
          detalhe: e.message.slice(0, 160),
        });
      }

      const nome = (name || 'Minha voz clonada').slice(0, 60);
      const agora = new Date().toISOString();
      await fetch(`${SU}/rest/v1/blue_voice_clones`, {
        method: 'POST', headers: { ...h, Prefer: 'return=minimal' },
        body: JSON.stringify({
          user_id: u.id, voice_id: voiceId, name: nome, sample_path,
          status: 'active', genero: genero || null, lang_code: lang_code || 'pt-BR',
          created_at: agora, last_used_at: agora,
        }),
      });
      // Espelha na lista do BlueVoice — is_clone marca como PRIVADA
      await fetch(`${SU}/rest/v1/blue_custom_voices?on_conflict=user_id,voice_id`, {
        method: 'POST', headers: { ...h, Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify([{
          user_id: u.id, voice_id: voiceId, name: nome,
          genero: genero || null, lang_code: lang_code || 'pt-BR',
          idioma_real: 'Português (Brasil)', lang_flag: '🇧🇷',
          lang_source: 'clone', descricao: 'Sua voz clonada', is_clone: true,
        }]),
      }).catch(() => {});

      return res.status(200).json({ ok: true, voice_id: voiceId, name: nome });
    }

    // ── REATIVAR: recria a voz a partir do áudio guardado ────────────────
    if (action === 'reativar') {
      if (!EL) return res.status(500).json({ error: 'ElevenLabs não configurado.' });
      if (!atual) return res.status(404).json({ error: 'Você não tem voz clonada.' });
      if (atual.status === 'active' && atual.voice_id) {
        return res.status(200).json({ ok: true, ja_ativa: true, voice_id: atual.voice_id });
      }
      const v = await vagas(EL);
      if (v && v.livres <= 0) {
        return res.status(503).json({ error: 'Sem vagas livres agora — tente novamente em algumas horas.', vagas: v });
      }
      let buf;
      try { buf = await baixarSample(SU, SK, atual.sample_path); }
      catch (e) { return res.status(410).json({ error: 'A gravação original não está mais disponível. Clone sua voz de novo.' }); }

      let voiceId;
      try { voiceId = await clonarNoEleven(EL, atual.name, buf, 'audio/mpeg'); }
      catch (e) { return res.status(502).json({ error: 'Não consegui recriar sua voz agora. Tente mais tarde.', detalhe: e.message.slice(0, 140) }); }

      const agora = new Date().toISOString();
      await fetch(`${SU}/rest/v1/blue_voice_clones?user_id=eq.${uid}`, {
        method: 'PATCH', headers: h,
        body: JSON.stringify({ voice_id: voiceId, status: 'active', last_used_at: agora, hibernated_at: null, reactivations: (atual.reactivations || 0) + 1 }),
      });
      await fetch(`${SU}/rest/v1/blue_custom_voices?on_conflict=user_id,voice_id`, {
        method: 'POST', headers: { ...h, Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify([{
          user_id: u.id, voice_id: voiceId, name: atual.name,
          genero: atual.genero, lang_code: atual.lang_code || 'pt-BR',
          idioma_real: 'Português (Brasil)', lang_flag: '🇧🇷',
          lang_source: 'clone', descricao: 'Sua voz clonada', is_clone: true,
        }]),
      }).catch(() => {});
      return res.status(200).json({ ok: true, voice_id: voiceId, reativada: true });
    }

    // ── REMOVER ──────────────────────────────────────────────────────────
    if (action === 'remover') {
      if (!atual) return res.status(404).json({ error: 'Você não tem voz clonada.' });
      if (EL && atual.voice_id) {
        await fetch(`${EL_API}/voices/${atual.voice_id}`, { method: 'DELETE', headers: { 'xi-api-key': EL } }).catch(() => {});
      }
      if (atual.voice_id) {
        await fetch(`${SU}/rest/v1/blue_custom_voices?user_id=eq.${uid}&voice_id=eq.${encodeURIComponent(atual.voice_id)}`, {
          method: 'DELETE', headers: h,
        }).catch(() => {});
      }
      await fetch(`${SU}/storage/v1/object/${BUCKET}/${atual.sample_path}`, {
        method: 'DELETE', headers: { apikey: SK, Authorization: 'Bearer ' + SK },
      }).catch(() => {});
      await fetch(`${SU}/rest/v1/blue_voice_clones?user_id=eq.${uid}`, { method: 'DELETE', headers: h });
      return res.status(200).json({ ok: true, removida: true });
    }

    return res.status(400).json({ error: 'action_invalida' });
  } catch (e) {
    console.error('[blue-voice-clone]', e && e.message);
    return res.status(500).json({ error: e && e.message });
  }
};
