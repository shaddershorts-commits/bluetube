// api/blue-lives.js — Lives com 100ms + gorjetas + BlueCoins
// CommonJS

const crypto = require('crypto');
const { cacheGetOrSet, cacheDel } = require('./_helpers/cache');

const GORJETA_MAP = {
  '🌟': { coins: 10, valor: 0.50 },
  '💎': { coins: 50, valor: 2.50 },
  '🚀': { coins: 100, valor: 5.00 },
  '👑': { coins: 500, valor: 25.00 },
  '🔥': { coins: 1000, valor: 50.00 },
};
const CREATOR_CUT = 0.70; // criador fica com 70%

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const SU = process.env.SUPABASE_URL;
  const SK = process.env.SUPABASE_SERVICE_KEY;
  const AK = process.env.SUPABASE_ANON_KEY || SK;
  const HMS_ID = process.env.HMS_APP_ID;
  const HMS_SECRET = process.env.HMS_APP_SECRET;
  if (!SU || !SK) return res.status(500).json({ error: 'Config missing' });

  const h = { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' };
  const action = req.method === 'GET' ? req.query.action : (req.body && req.body.action);

  // Helper: resolve user from token
  async function getUser(token) {
    if (!token) return null;
    const r = await fetch(`${SU}/auth/v1/user`, { headers: { apikey: AK, Authorization: 'Bearer ' + token } });
    if (!r.ok) return null;
    const u = await r.json();
    // Get profile
    const pR = await fetch(`${SU}/rest/v1/blue_profiles?user_id=eq.${u.id}&select=user_id,username,display_name,avatar_url`, { headers: h });
    const pArr = pR.ok ? await pR.json() : [];
    return { id: u.id, email: u.email, profile: pArr[0] || null };
  }

  // Helper: generate 100ms management token
  function generateHmsToken() {
    if (!HMS_ID || !HMS_SECRET) return null;
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({
      access_key: HMS_ID,
      type: 'management',
      version: 2,
      iat: now,
      nbf: now,
      exp: now + 86400,
      jti: crypto.randomUUID()
    })).toString('base64url');
    const sig = crypto.createHmac('sha256', HMS_SECRET).update(header + '.' + payload).digest('base64url');
    return header + '.' + payload + '.' + sig;
  }

  // Helper: generate 100ms auth token for a room
  async function generateRoomToken(roomId, role, userId, userName) {
    const mgmtToken = generateHmsToken();
    if (!mgmtToken) return null;
    try {
      const r = await fetch('https://api.100ms.live/v2/room-codes/room/' + roomId, {
        headers: { Authorization: 'Bearer ' + mgmtToken }
      });
      if (!r.ok) return null;
      const codes = await r.json();
      // Find code for the role
      const code = (codes.data || []).find(c => c.role === role);
      if (!code) return null;
      // Get auth token from code
      const tR = await fetch('https://api.100ms.live/v2/room-codes/' + code.code + '/token', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + mgmtToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: userId || 'anon', user_name: userName || 'Viewer' })
      });
      if (!tR.ok) return null;
      const tD = await tR.json();
      return tD.token;
    } catch(e) { console.error('HMS token error:', e.message); return null; }
  }

  // ── INICIAR LIVE ────────────────────────────────────────────────────────
  if (req.method === 'POST' && action === 'iniciar') {
    const { token, titulo } = req.body;
    const user = await getUser(token);
    if (!user) return res.status(401).json({ error: 'Token inválido' });
    if (!titulo) return res.status(400).json({ error: 'Título obrigatório' });

    try {
      const mgmtToken = generateHmsToken();
      if (!mgmtToken) return res.status(500).json({ error: 'Lives não configuradas. Configure HMS_APP_ID e HMS_APP_SECRET no Vercel.' });

      // Create room on 100ms
      const roomName = 'live-' + user.id.slice(0, 8) + '-' + Date.now();
      const roomR = await fetch('https://api.100ms.live/v2/rooms', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + mgmtToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: roomName, description: titulo, template_id: process.env.HMS_TEMPLATE_ID || undefined })
      });
      if (!roomR.ok) {
        const err = await roomR.text();
        console.error('100ms room error:', err);
        return res.status(500).json({ error: 'Erro ao criar sala de live' });
      }
      const room = await roomR.json();

      // Get auth token for host
      const hostToken = await generateRoomToken(room.id, 'host', user.id, user.profile?.display_name || 'Host');

      // Save to DB
      const lR = await fetch(`${SU}/rest/v1/blue_lives`, {
        method: 'POST', headers: { ...h, 'Prefer': 'return=representation' },
        body: JSON.stringify({
          user_id: user.id,
          titulo,
          room_id: room.id,
          status: 'ativa',
          thumbnail_url: user.profile?.avatar_url || null,
          started_at: new Date().toISOString()
        })
      });
      const live = lR.ok ? (await lR.json())[0] : null;

      // Notify followers
      const flR = await fetch(`${SU}/rest/v1/blue_follows?following_id=eq.${user.id}&select=follower_id`, { headers: h });
      const followers = flR.ok ? await flR.json() : [];
      const uname = user.profile?.display_name || user.profile?.username || 'Alguém';
      for (const f of followers.slice(0, 100)) {
        fetch(`${SU}/rest/v1/blue_notificacoes`, { method: 'POST', headers: { ...h, 'Prefer': 'return=minimal' },
          body: JSON.stringify({ user_id: f.follower_id, tipo: 'live', titulo: '🔴 Ao vivo!', mensagem: `${uname} está ao vivo: ${titulo}`, dados: { live_id: live?.id } })
        }).catch(() => {});
      }

      cacheDel('lives:ativas');
      return res.status(200).json({ ok: true, live_id: live?.id, room_id: room.id, token_acesso: hostToken });
    } catch(e) {
      console.error('Live start error:', e.message);
      return res.status(500).json({ error: 'Erro ao iniciar live: ' + e.message });
    }
  }

  // ── ENTRAR NA LIVE ──────────────────────────────────────────────────────
  if (req.method === 'POST' && action === 'entrar') {
    const { token, live_id } = req.body;
    const user = await getUser(token);

    try {
      const lR = await fetch(`${SU}/rest/v1/blue_lives?id=eq.${live_id}&status=eq.ativa&select=*`, { headers: h });
      const lives = lR.ok ? await lR.json() : [];
      if (!lives.length) return res.status(404).json({ error: 'Live não encontrada ou encerrada' });
      const live = lives[0];

      const viewerToken = await generateRoomToken(live.room_id, 'viewer', user?.id || 'anon-' + Date.now(), user?.profile?.display_name || 'Viewer');

      // Increment viewers
      const newCount = (live.viewers_count || 0) + 1;
      const newPeak = Math.max(live.peak_viewers || 0, newCount);
      fetch(`${SU}/rest/v1/blue_lives?id=eq.${live_id}`, { method: 'PATCH', headers: { ...h, 'Prefer': 'return=minimal' },
        body: JSON.stringify({ viewers_count: newCount, peak_viewers: newPeak })
      }).catch(() => {});

      // Get host profile
      let hostProfile = null;
      if (live.user_id) {
        const pR = await fetch(`${SU}/rest/v1/blue_profiles?user_id=eq.${live.user_id}&select=user_id,username,display_name,avatar_url,verificado`, { headers: h });
        if (pR.ok) hostProfile = (await pR.json())[0];
      }

      return res.status(200).json({ ok: true, token_acesso: viewerToken, room_id: live.room_id, live: { ...live, host: hostProfile } });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  // ── ENCERRAR LIVE ───────────────────────────────────────────────────────
  if (req.method === 'POST' && action === 'encerrar') {
    const { token, live_id } = req.body;
    const user = await getUser(token);
    if (!user) return res.status(401).json({ error: 'Token inválido' });

    try {
      const lR = await fetch(`${SU}/rest/v1/blue_lives?id=eq.${live_id}&user_id=eq.${user.id}&select=*`, { headers: h });
      const lives = lR.ok ? await lR.json() : [];
      if (!lives.length) return res.status(403).json({ error: 'Apenas o dono pode encerrar' });
      const live = lives[0];

      // Close room on 100ms
      const mgmtToken = generateHmsToken();
      if (mgmtToken && live.room_id) {
        fetch('https://api.100ms.live/v2/active-rooms/' + live.room_id + '/end-room', {
          method: 'POST', headers: { Authorization: 'Bearer ' + mgmtToken, 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason: 'Live encerrada pelo host', lock: true })
        }).catch(() => {});
      }

      // Update DB
      const now = new Date();
      const started = new Date(live.started_at);
      const duracao = Math.round((now - started) / 60000); // minutes
      await fetch(`${SU}/rest/v1/blue_lives?id=eq.${live_id}`, { method: 'PATCH', headers: { ...h, 'Prefer': 'return=minimal' },
        body: JSON.stringify({ status: 'encerrada', ended_at: now.toISOString(), viewers_count: 0 })
      });

      // Get gorjetas summary
      const gR = await fetch(`${SU}/rest/v1/blue_gorjetas?live_id=eq.${live_id}&select=valor,emoji`, { headers: h });
      const gorjetas = gR.ok ? await gR.json() : [];
      const totalGorjetas = gorjetas.reduce((s, g) => s + parseFloat(g.valor || 0), 0);

      cacheDel('lives:ativas');
      return res.status(200).json({
        ok: true,
        resumo: {
          duracao_minutos: duracao,
          peak_viewers: live.peak_viewers || 0,
          total_gorjetas: parseFloat(totalGorjetas.toFixed(2)),
          gorjetas_count: gorjetas.length
        }
      });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  // ── LIVES ATIVAS — cached 30s ────────────────────────────────────────
  if (action === 'lives-ativas') {
    try {
      const data = await cacheGetOrSet('lives:ativas', async () => {
        const lR = await fetch(`${SU}/rest/v1/blue_lives?status=eq.ativa&order=viewers_count.desc&limit=20&select=*`, { headers: h });
        const lives = lR.ok ? await lR.json() : [];
        const uIds = [...new Set(lives.map(l => l.user_id).filter(Boolean))];
        let profiles = {};
        if (uIds.length) {
          const pR = await fetch(`${SU}/rest/v1/blue_profiles?user_id=in.(${uIds.join(',')})&select=user_id,username,display_name,avatar_url,verificado`, { headers: h });
          if (pR.ok) (await pR.json()).forEach(p => { profiles[p.user_id] = p; });
        }
        return { lives: lives.map(l => ({ ...l, host: profiles[l.user_id] || null })) };
      }, 30);
      return res.status(200).json(data);
    } catch(e) { return res.status(200).json({ lives: [] }); }
  }

  // ── ENVIAR GORJETA ──────────────────────────────────────────────────────
  if (req.method === 'POST' && action === 'enviar-gorjeta') {
    const { token, live_id, video_id, emoji, bluecoins: reqCoins } = req.body;
    const user = await getUser(token);
    if (!user) return res.status(401).json({ error: 'Token inválido' });

    const gInfo = GORJETA_MAP[emoji];
    if (!gInfo) return res.status(400).json({ error: 'Emoji inválido', emojis_validos: Object.keys(GORJETA_MAP) });

    try {
      // Get sender balance
      const bR = await fetch(`${SU}/rest/v1/blue_bluecoins?user_id=eq.${user.id}&select=saldo`, { headers: h });
      const balances = bR.ok ? await bR.json() : [];
      const saldo = balances[0]?.saldo || 0;
      if (saldo < gInfo.coins) return res.status(400).json({ error: 'Saldo insuficiente', saldo, necessario: gInfo.coins });

      // Find recipient
      let destId = null;
      if (live_id) {
        const lR = await fetch(`${SU}/rest/v1/blue_lives?id=eq.${live_id}&select=user_id`, { headers: h });
        const lives = lR.ok ? await lR.json() : [];
        destId = lives[0]?.user_id;
      } else if (video_id) {
        const vR = await fetch(`${SU}/rest/v1/blue_videos?id=eq.${video_id}&select=user_id`, { headers: h });
        const vids = vR.ok ? await vR.json() : [];
        destId = vids[0]?.user_id;
      }
      if (!destId) return res.status(400).json({ error: 'Destinatário não encontrado' });
      if (destId === user.id) return res.status(400).json({ error: 'Não pode enviar gorjeta para si mesmo' });

      // Debit sender
      await fetch(`${SU}/rest/v1/blue_bluecoins?user_id=eq.${user.id}`, { method: 'PATCH', headers: { ...h, 'Prefer': 'return=minimal' },
        body: JSON.stringify({ saldo: saldo - gInfo.coins, total_gasto: (balances[0]?.total_gasto || 0) + gInfo.coins, updated_at: new Date().toISOString() })
      });

      // Credit creator (70%)
      const creatorCoins = Math.floor(gInfo.coins * CREATOR_CUT);
      const cR = await fetch(`${SU}/rest/v1/blue_bluecoins?user_id=eq.${destId}&select=saldo,total_comprado`, { headers: h });
      const cBal = cR.ok ? (await cR.json())[0] : null;
      if (cBal) {
        await fetch(`${SU}/rest/v1/blue_bluecoins?user_id=eq.${destId}`, { method: 'PATCH', headers: { ...h, 'Prefer': 'return=minimal' },
          body: JSON.stringify({ saldo: (cBal.saldo || 0) + creatorCoins, updated_at: new Date().toISOString() })
        });
      } else {
        await fetch(`${SU}/rest/v1/blue_bluecoins`, { method: 'POST', headers: { ...h, 'Prefer': 'return=minimal' },
          body: JSON.stringify({ user_id: destId, saldo: creatorCoins })
        });
      }

      // Record gorjeta
      await fetch(`${SU}/rest/v1/blue_gorjetas`, { method: 'POST', headers: { ...h, 'Prefer': 'return=minimal' },
        body: JSON.stringify({ live_id: live_id || null, video_id: video_id || null, remetente_id: user.id, destinatario_id: destId, emoji, valor: gInfo.valor, bluecoins: gInfo.coins })
      });

      // Transaction logs
      const uname = user.profile?.display_name || 'Usuário';
      await Promise.all([
        fetch(`${SU}/rest/v1/blue_bluecoins_transacoes`, { method: 'POST', headers: { ...h, 'Prefer': 'return=minimal' },
          body: JSON.stringify({ user_id: user.id, tipo: 'gorjeta_enviada', quantidade: -gInfo.coins, descricao: `${emoji} gorjeta enviada` })
        }),
        fetch(`${SU}/rest/v1/blue_bluecoins_transacoes`, { method: 'POST', headers: { ...h, 'Prefer': 'return=minimal' },
          body: JSON.stringify({ user_id: destId, tipo: 'gorjeta_recebida', quantidade: creatorCoins, descricao: `${emoji} gorjeta de @${uname}` })
        }),
      ]);

      // Update live total
      if (live_id) {
        fetch(`${SU}/rest/v1/blue_lives?id=eq.${live_id}&select=total_gorjetas`, { headers: h })
          .then(r => r.ok ? r.json() : []).then(ls => {
            if (ls[0]) fetch(`${SU}/rest/v1/blue_lives?id=eq.${live_id}`, { method: 'PATCH', headers: { ...h, 'Prefer': 'return=minimal' },
              body: JSON.stringify({ total_gorjetas: parseFloat((ls[0].total_gorjetas || 0)) + gInfo.valor })
            });
          }).catch(() => {});
      }

      // Notify creator
      fetch(`${SU}/rest/v1/blue_notificacoes`, { method: 'POST', headers: { ...h, 'Prefer': 'return=minimal' },
        body: JSON.stringify({ user_id: destId, tipo: 'gorjeta', titulo: `${emoji} Gorjeta recebida!`, mensagem: `@${uname} enviou ${emoji} (${gInfo.coins} coins)`, dados: { from: user.id, emoji, coins: gInfo.coins } })
      }).catch(() => {});

      return res.status(200).json({ ok: true, novo_saldo: saldo - gInfo.coins });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  // ── CONVIDAR CO-HOST ─────────────────────────────────────────────────────
  if (req.method === 'POST' && action === 'convidar-cohost') {
    const { token, live_id, convidado_id } = req.body;
    const user = await getUser(token);
    if (!user) return res.status(401).json({ error: 'Token inválido' });
    try {
      // Verify user owns the live
      const lR = await fetch(`${SU}/rest/v1/blue_lives?id=eq.${live_id}&user_id=eq.${user.id}&status=eq.ativa&select=room_id,titulo`, { headers: h });
      const live = lR.ok ? (await lR.json())[0] : null;
      if (!live) return res.status(403).json({ error: 'Apenas o host pode convidar' });
      // Notify invited user
      const uname = user.profile?.display_name || user.profile?.username || 'Alguém';
      await fetch(`${SU}/rest/v1/blue_notificacoes`, { method: 'POST', headers: { ...h, 'Prefer': 'return=minimal' },
        body: JSON.stringify({ user_id: convidado_id, tipo: 'cohost', titulo: '🎬 Convite para live!', mensagem: `${uname} te convidou para participar da live: ${live.titulo}`, dados: { live_id, room_id: live.room_id, host_id: user.id } })
      });
      return res.status(200).json({ ok: true });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  // ── ACEITAR CO-HOST ─────────────────────────────────────────────────────
  if (req.method === 'POST' && action === 'aceitar-cohost') {
    const { token, live_id } = req.body;
    const user = await getUser(token);
    if (!user) return res.status(401).json({ error: 'Token inválido' });
    try {
      const lR = await fetch(`${SU}/rest/v1/blue_lives?id=eq.${live_id}&status=eq.ativa&select=room_id`, { headers: h });
      const live = lR.ok ? (await lR.json())[0] : null;
      if (!live) return res.status(404).json({ error: 'Live não encontrada' });
      // Generate co-host token (same as host role)
      const cohostToken = await generateRoomToken(live.room_id, 'host', user.id, user.profile?.display_name || 'Co-host');
      return res.status(200).json({ ok: true, token_acesso: cohostToken, room_id: live.room_id });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  // ── LIMPAR LIVES ANTIGAS (cron) ─────────────────────────────────────────
  if (action === 'limpar-lives-antigas') {
    try {
      const oneDayAgo = new Date(Date.now() - 86400000).toISOString();
      // Mark stale active lives as ended
      await fetch(`${SU}/rest/v1/blue_lives?status=eq.ativa&started_at=lt.${oneDayAgo}`, {
        method: 'PATCH', headers: { ...h, 'Prefer': 'return=minimal' },
        body: JSON.stringify({ status: 'encerrada', ended_at: new Date().toISOString(), viewers_count: 0 })
      });
      cacheDel('lives:ativas');
      return res.status(200).json({ ok: true });
    } catch(e) { return res.status(200).json({ ok: false }); }
  }

  return res.status(404).json({ error: 'Action não encontrada' });
};
