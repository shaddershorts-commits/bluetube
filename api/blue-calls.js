// api/blue-calls.js — Chamadas de voz/vídeo 1:1 do BlueChat (app v1.5.2+)
//
// Papel deste endpoint: REGISTRO e AVISO. A negociação técnica do WebRTC
// (SDP/ICE) nunca passa por aqui — vai por canal Supabase Realtime broadcast
// `call-<id>`, direto entre os dois aparelhos.
//
// Regra de privacidade (mesma do presence/status do blue-chat): só posso
// ligar pra quem me TEM nos contatos (blue_contatos user_id=destino,
// contato_id=eu). Estranho não faz seu celular tocar.
//
// Ações (POST, token obrigatório):
//   iniciar  { to_user_id, tipo }  → cria ringing + push "está te ligando"
//   atender  { call_id }           → ringing → active
//   recusar  { call_id }           → ringing → declined
//   cancelar { call_id }           → ringing → cancelled/missed + notif perdida
//   encerrar { call_id }           → active → ended (+duração)
//   estado   { call_id }           → status atual (pra quem chega pelo push)
// GET  historico&token=…           → minhas chamadas com perfil do outro lado

const RING_TIMEOUT_MS = 50 * 1000; // toque considerado "perdido" depois disso

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const SU = process.env.SUPABASE_URL;
  const SK = process.env.SUPABASE_SERVICE_KEY;
  const AK = process.env.SUPABASE_ANON_KEY || SK;
  if (!SU || !SK) return res.status(500).json({ error: 'Config missing' });
  const h = { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' };

  const action = req.method === 'GET' ? req.query.action : req.body?.action;
  const token = req.method === 'GET' ? req.query.token : req.body?.token;
  if (!token) return res.status(401).json({ error: 'Login necessário' });

  let userId;
  try {
    const uR = await fetch(`${SU}/auth/v1/user`, { headers: { apikey: AK, Authorization: 'Bearer ' + token } });
    if (!uR.ok) return res.status(401).json({ error: 'Token inválido' });
    userId = (await uR.json()).id;
  } catch (e) { return res.status(401).json({ error: 'Token inválido' }); }

  const getCall = async (id) => {
    const r = await fetch(`${SU}/rest/v1/blue_calls?id=eq.${encodeURIComponent(id)}&select=*&limit=1`, { headers: h });
    return r.ok ? (await r.json())[0] : null;
  };
  const patchCall = (id, body) =>
    fetch(`${SU}/rest/v1/blue_calls?id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH', headers: { ...h, Prefer: 'return=representation' }, body: JSON.stringify(body),
    });
  const perfil = async (uid) => {
    const r = await fetch(`${SU}/rest/v1/blue_profiles?user_id=eq.${uid}&select=user_id,username,display_name,avatar_url`, { headers: h });
    return r.ok ? (await r.json())[0] : null;
  };

  // ── GET historico ─────────────────────────────────────────────────────────
  if (req.method === 'GET' && action === 'historico') {
    try {
      const r = await fetch(
        `${SU}/rest/v1/blue_calls?or=(caller_id.eq.${userId},callee_id.eq.${userId})&select=*&order=started_at.desc&limit=60`,
        { headers: h }
      );
      const calls = r.ok ? await r.json() : [];
      const outros = [...new Set(calls.map((c) => (c.caller_id === userId ? c.callee_id : c.caller_id)))];
      let perfis = [];
      if (outros.length) {
        const pR = await fetch(
          `${SU}/rest/v1/blue_profiles?user_id=in.(${outros.join(',')})&select=user_id,username,display_name,avatar_url`,
          { headers: h }
        );
        perfis = pR.ok ? await pR.json() : [];
      }
      const byId = Object.fromEntries(perfis.map((p) => [p.user_id, p]));
      return res.status(200).json({
        calls: calls.map((c) => ({
          ...c,
          direcao: c.caller_id === userId ? 'out' : 'in',
          other: byId[c.caller_id === userId ? c.callee_id : c.caller_id] || null,
        })),
      });
    } catch (e) { return res.status(200).json({ calls: [] }); }
  }

  // ── POST iniciar ──────────────────────────────────────────────────────────
  if (req.method === 'POST' && action === 'iniciar') {
    const { to_user_id, tipo } = req.body || {};
    if (!to_user_id || to_user_id === userId) return res.status(400).json({ error: 'destinatário inválido' });
    const t = tipo === 'video' ? 'video' : 'audio';
    try {
      // portão de contato: o DESTINO precisa me ter como contato
      const cR = await fetch(
        `${SU}/rest/v1/blue_contatos?user_id=eq.${encodeURIComponent(to_user_id)}&contato_id=eq.${userId}&select=contato_id&limit=1`,
        { headers: h }
      );
      const souContato = cR.ok && (await cR.json()).length > 0;
      if (!souContato) {
        return res.status(403).json({ error: 'Vocês precisam ser contatos no BlueChat pra se ligarem. Manda uma mensagem primeiro. 😉' });
      }

      // ocupado? uma chamada viva já envolvendo qualquer um dos dois
      const bR = await fetch(
        `${SU}/rest/v1/blue_calls?status=in.(ringing,active)&or=(caller_id.eq.${userId},callee_id.eq.${userId},caller_id.eq.${to_user_id},callee_id.eq.${to_user_id})&select=id,started_at,status&limit=5`,
        { headers: h }
      );
      const vivas = bR.ok ? await bR.json() : [];
      // ringing velho (aparelho que morreu no meio) não pode travar pra sempre
      const agora = Date.now();
      const realmenteViva = vivas.find((c) =>
        c.status === 'active' || (agora - new Date(c.started_at).getTime()) < RING_TIMEOUT_MS + 15000
      );
      if (realmenteViva) return res.status(409).json({ error: 'Ocupado — já existe uma chamada em andamento.' });

      const iR = await fetch(`${SU}/rest/v1/blue_calls`, {
        method: 'POST', headers: { ...h, Prefer: 'return=representation' },
        body: JSON.stringify({ caller_id: userId, callee_id: to_user_id, tipo: t }),
      });
      if (!iR.ok) return res.status(500).json({ error: 'não deu pra criar a chamada' });
      const [call] = await iR.json();

      const eu = await perfil(userId);
      const nome = eu?.display_name || ('@' + (eu?.username || 'alguém'));
      // push com AWAIT (regra: efeito colateral em serverless nunca fire-and-forget)
      try {
        const { sendPushToUser } = require('./_helpers/push.js');
        await sendPushToUser(to_user_id, {
          title: t === 'video' ? `📹 ${nome} está te chamando` : `📞 ${nome} está te ligando`,
          body: 'Toca pra atender no Blue',
          data: { tipo: 'call', call_id: call.id, call_tipo: t, from_user_id: userId, url: '/blue' },
        }).catch(() => null);
      } catch (e) {}

      return res.status(200).json({ ok: true, call_id: call.id, caller: eu });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  // ── POST atender / recusar / cancelar / encerrar / estado ────────────────
  if (req.method === 'POST' && ['atender', 'recusar', 'cancelar', 'encerrar', 'estado'].includes(action)) {
    const { call_id } = req.body || {};
    if (!call_id) return res.status(400).json({ error: 'call_id obrigatório' });
    const call = await getCall(call_id);
    if (!call) return res.status(404).json({ error: 'chamada não encontrada' });
    const souParte = call.caller_id === userId || call.callee_id === userId;
    if (!souParte) return res.status(403).json({ error: 'não é sua chamada' });

    if (action === 'estado') return res.status(200).json({ call });

    try {
      if (action === 'atender') {
        if (call.callee_id !== userId) return res.status(403).json({ error: 'só quem recebe atende' });
        if (call.status !== 'ringing') return res.status(409).json({ error: 'chamada não está tocando', status: call.status });
        await patchCall(call_id, { status: 'active', answered_at: new Date().toISOString() });
        return res.status(200).json({ ok: true });
      }
      if (action === 'recusar') {
        if (call.callee_id !== userId) return res.status(403).json({ error: 'só quem recebe recusa' });
        if (call.status !== 'ringing') return res.status(200).json({ ok: true, ja: call.status });
        await patchCall(call_id, { status: 'declined', ended_at: new Date().toISOString() });
        return res.status(200).json({ ok: true });
      }
      if (action === 'cancelar') {
        // quem LIGA desiste antes de atenderem → vira chamada perdida do outro
        if (call.caller_id !== userId) return res.status(403).json({ error: 'só quem liga cancela' });
        if (call.status !== 'ringing') return res.status(200).json({ ok: true, ja: call.status });
        await patchCall(call_id, { status: 'missed', ended_at: new Date().toISOString() });
        try {
          const eu = await perfil(userId);
          const nome = eu?.display_name || ('@' + (eu?.username || 'alguém'));
          await fetch(`${SU}/rest/v1/blue_notificacoes`, {
            method: 'POST', headers: { ...h, Prefer: 'return=minimal' },
            body: JSON.stringify({
              user_id: call.callee_id, tipo: 'call_missed',
              titulo: 'Chamada perdida',
              mensagem: `${call.tipo === 'video' ? '📹' : '📞'} Chamada perdida de ${nome}`,
              dados: { from_user_id: userId, call_id },
            }),
          }).catch(() => {});
          const { sendPushToUser } = require('./_helpers/push.js');
          await sendPushToUser(call.callee_id, {
            title: 'Chamada perdida',
            body: `${call.tipo === 'video' ? '📹' : '📞'} de ${nome} — toca pra ligar de volta`,
            data: { tipo: 'call_missed', from_user_id: userId, url: '/blue' },
          }).catch(() => null);
        } catch (e) {}
        return res.status(200).json({ ok: true });
      }
      if (action === 'encerrar') {
        if (call.status === 'ended') return res.status(200).json({ ok: true });
        const dur = call.answered_at ? Math.max(0, Math.round((Date.now() - new Date(call.answered_at).getTime()) / 1000)) : 0;
        await patchCall(call_id, { status: 'ended', ended_at: new Date().toISOString(), duration_s: dur });
        return res.status(200).json({ ok: true, duration_s: dur });
      }
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  return res.status(400).json({ error: 'Ação inválida' });
};
