// api/blue-report.js — Reports, bloqueios, banimentos, moderação
// CommonJS

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const SU = process.env.SUPABASE_URL;
  const SK = process.env.SUPABASE_SERVICE_KEY;
  const AK = process.env.SUPABASE_ANON_KEY || SK;
  const ADMIN_SECRET = process.env.ADMIN_SECRET;
  if (!SU || !SK) return res.status(500).json({ error: 'Config missing' });

  const h = { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' };
  const action = req.method === 'GET' ? req.query.action : (req.body && req.body.action);

  async function getUser(token) {
    if (!token) return null;
    const r = await fetch(`${SU}/auth/v1/user`, { headers: { apikey: AK, Authorization: 'Bearer ' + token } });
    return r.ok ? await r.json() : null;
  }

  function isAdmin(req) {
    const auth = req.headers['authorization'];
    return ADMIN_SECRET && auth === 'Bearer ' + ADMIN_SECRET;
  }

  // ── REPORTAR CONTEÚDO ───────────────────────────────────────────────────
  if (req.method === 'POST' && action === 'reportar') {
    const { token, tipo_alvo, alvo_id, motivo, descricao } = req.body;
    const user = await getUser(token);
    if (!user) return res.status(401).json({ error: 'Token inválido' });
    if (!tipo_alvo || !alvo_id || !motivo) return res.status(400).json({ error: 'tipo_alvo, alvo_id e motivo obrigatórios' });

    try {
      // Não reportar a si mesmo
      if (alvo_id === user.id) return res.status(400).json({ error: 'Não é possível reportar a si mesmo' });

      // Verificar se já reportou este conteúdo
      const eR = await fetch(`${SU}/rest/v1/blue_reports?reporter_id=eq.${user.id}&alvo_id=eq.${alvo_id}&tipo_alvo=eq.${tipo_alvo}&select=id`, { headers: h });
      if (eR.ok && (await eR.json()).length) return res.status(200).json({ ok: true, message: 'Você já reportou este conteúdo' });

      // Salvar report
      await fetch(`${SU}/rest/v1/blue_reports`, {
        method: 'POST', headers: { ...h, 'Prefer': 'return=minimal' },
        body: JSON.stringify({ reporter_id: user.id, tipo_alvo, alvo_id, motivo, descricao: descricao || null })
      });

      // Verificar se alvo tem 5+ reports → auto-hide
      const countR = await fetch(`${SU}/rest/v1/blue_reports?alvo_id=eq.${alvo_id}&status=eq.pendente&select=id`, { headers: h });
      const count = countR.ok ? (await countR.json()).length : 0;

      if (count >= 5) {
        // Auto-hide content based on type
        if (tipo_alvo === 'video') {
          await fetch(`${SU}/rest/v1/blue_videos?id=eq.${alvo_id}`, {
            method: 'PATCH', headers: { ...h, 'Prefer': 'return=minimal' },
            body: JSON.stringify({ status: 'under_review' })
          });
        } else if (tipo_alvo === 'comentario') {
          await fetch(`${SU}/rest/v1/blue_comments?id=eq.${alvo_id}`, {
            method: 'PATCH', headers: { ...h, 'Prefer': 'return=minimal' },
            body: JSON.stringify({ hidden: true })
          });
        }
        // Notify admin
        const RESEND = process.env.RESEND_API_KEY;
        if (RESEND) {
          fetch('https://api.resend.com/emails', { method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + RESEND },
            body: JSON.stringify({ from: 'Blue <noreply@bluetubeviral.com>', to: ['cannongames01@gmail.com'],
              subject: '🚨 Conteúdo auto-ocultado: ' + count + ' reports',
              html: '<p>Tipo: ' + tipo_alvo + '</p><p>ID: ' + alvo_id + '</p><p>Motivo mais comum: ' + motivo + '</p><p>Total reports: ' + count + '</p>'
            })
          }).catch(() => {});
        }
        console.log('🚨 Auto-hidden:', tipo_alvo, alvo_id, count, 'reports');
      }

      return res.status(200).json({ ok: true, message: 'Denúncia registrada. Analisaremos em até 24h.' });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  // ── BLOQUEAR / DESBLOQUEAR ──────────────────────────────────────────────
  if (req.method === 'POST' && action === 'bloquear') {
    const { token, bloqueado_id } = req.body;
    const user = await getUser(token);
    if (!user) return res.status(401).json({ error: 'Token inválido' });
    if (bloqueado_id === user.id) return res.status(400).json({ error: 'Não pode bloquear a si mesmo' });

    try {
      // Check if already blocked
      const eR = await fetch(`${SU}/rest/v1/blue_bloqueios?user_id=eq.${user.id}&bloqueado_id=eq.${bloqueado_id}&select=id`, { headers: h });
      const existing = eR.ok ? await eR.json() : [];

      if (existing.length) {
        // Unblock
        await fetch(`${SU}/rest/v1/blue_bloqueios?id=eq.${existing[0].id}`, { method: 'DELETE', headers: h });
        return res.status(200).json({ ok: true, bloqueado: false });
      } else {
        // Block
        await fetch(`${SU}/rest/v1/blue_bloqueios`, {
          method: 'POST', headers: { ...h, 'Prefer': 'return=minimal' },
          body: JSON.stringify({ user_id: user.id, bloqueado_id })
        });
        // Also unfollow if following
        fetch(`${SU}/rest/v1/blue_follows?follower_id=eq.${user.id}&following_id=eq.${bloqueado_id}`, { method: 'DELETE', headers: h }).catch(() => {});
        return res.status(200).json({ ok: true, bloqueado: true });
      }
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  // ── LISTA DE BLOQUEADOS ─────────────────────────────────────────────────
  if (action === 'bloqueados') {
    const user = await getUser(req.query.token);
    if (!user) return res.status(401).json({ error: 'Token inválido' });
    try {
      const bR = await fetch(`${SU}/rest/v1/blue_bloqueios?user_id=eq.${user.id}&select=bloqueado_id,created_at`, { headers: h });
      const blocks = bR.ok ? await bR.json() : [];
      if (!blocks.length) return res.status(200).json({ bloqueados: [] });
      const uIds = blocks.map(b => b.bloqueado_id);
      const pR = await fetch(`${SU}/rest/v1/blue_profiles?user_id=in.(${uIds.join(',')})&select=user_id,username,display_name,avatar_url`, { headers: h });
      const profiles = pR.ok ? await pR.json() : [];
      const pMap = {}; profiles.forEach(p => { pMap[p.user_id] = p; });
      return res.status(200).json({ bloqueados: blocks.map(b => ({ ...b, profile: pMap[b.bloqueado_id] || null })) });
    } catch(e) { return res.status(200).json({ bloqueados: [] }); }
  }

  // ── ADMIN: FILA DE MODERAÇÃO ────────────────────────────────────────────
  if (action === 'fila-moderacao') {
    if (!isAdmin(req)) return res.status(401).json({ error: 'Admin only' });
    try {
      const rR = await fetch(`${SU}/rest/v1/blue_reports?status=in.(pendente,analisando)&order=created_at.desc&limit=50&select=*`, { headers: h });
      const reports = rR.ok ? await rR.json() : [];

      // Priority sort: nudez/violencia first
      const priority = { nudez: 1, violencia: 1, assedio: 2, spam: 3, fake: 3, outro: 4 };
      reports.sort((a, b) => (priority[a.motivo] || 4) - (priority[b.motivo] || 4));

      // Count per reported user
      const alvos = [...new Set(reports.map(r => r.alvo_id))];
      const histR = await fetch(`${SU}/rest/v1/blue_reports?alvo_id=in.(${alvos.join(',')})&select=alvo_id`, { headers: h });
      const hist = histR.ok ? await histR.json() : [];
      const histCount = {};
      hist.forEach(h => { histCount[h.alvo_id] = (histCount[h.alvo_id] || 0) + 1; });

      // Stats
      const [banR, removedR] = await Promise.all([
        fetch(`${SU}/rest/v1/blue_banimentos?or=(expira_em.is.null,expira_em.gt.${new Date().toISOString()})&select=id`, { headers: h }),
        fetch(`${SU}/rest/v1/blue_reports?status=eq.resolvido&acao_tomada=eq.remover_conteudo&resolvido_em=gte.${new Date().toISOString().split('T')[0]}T00:00:00Z&select=id`, { headers: h }),
      ]);
      const activeBans = banR.ok ? (await banR.json()).length : 0;
      const removedToday = removedR.ok ? (await removedR.json()).length : 0;
      const urgent = reports.filter(r => r.motivo === 'nudez' || r.motivo === 'violencia').length;

      return res.status(200).json({
        reports: reports.map(r => ({ ...r, historico_reports: histCount[r.alvo_id] || 0 })),
        stats: { pendentes: reports.length, urgentes: urgent, bans_ativos: activeBans, removidos_hoje: removedToday }
      });
    } catch(e) { return res.status(200).json({ reports: [], stats: {} }); }
  }

  // ── ADMIN: RESOLVER REPORT ──────────────────────────────────────────────
  if (req.method === 'POST' && action === 'admin-resolver') {
    if (!isAdmin(req)) return res.status(401).json({ error: 'Admin only' });
    const { report_id, acao, motivo_admin } = req.body;
    if (!report_id || !acao) return res.status(400).json({ error: 'report_id e acao obrigatórios' });

    try {
      // Get report
      const rR = await fetch(`${SU}/rest/v1/blue_reports?id=eq.${report_id}&select=*`, { headers: h });
      const report = rR.ok ? (await rR.json())[0] : null;
      if (!report) return res.status(404).json({ error: 'Report não encontrado' });

      const now = new Date().toISOString();

      if (acao === 'ignorar') {
        // Just mark as ignored
      } else if (acao === 'avisar') {
        // Find user who owns the content
        let targetUser = report.alvo_id;
        if (report.tipo_alvo === 'video') {
          const vR = await fetch(`${SU}/rest/v1/blue_videos?id=eq.${report.alvo_id}&select=user_id`, { headers: h });
          const v = vR.ok ? (await vR.json())[0] : null;
          if (v) targetUser = v.user_id;
        }
        await fetch(`${SU}/rest/v1/blue_avisos`, { method: 'POST', headers: { ...h, 'Prefer': 'return=minimal' },
          body: JSON.stringify({ user_id: targetUser, motivo: motivo_admin || report.motivo, conteudo_id: report.alvo_id, admin_id: 'admin' })
        });
        await fetch(`${SU}/rest/v1/blue_notificacoes`, { method: 'POST', headers: { ...h, 'Prefer': 'return=minimal' },
          body: JSON.stringify({ user_id: targetUser, tipo: 'aviso', titulo: '⚠️ Aviso de moderação', mensagem: 'Seu conteúdo recebeu um aviso por: ' + (motivo_admin || report.motivo) })
        });
      } else if (acao === 'remover_conteudo') {
        if (report.tipo_alvo === 'video') {
          await fetch(`${SU}/rest/v1/blue_videos?id=eq.${report.alvo_id}`, { method: 'PATCH', headers: { ...h, 'Prefer': 'return=minimal' },
            body: JSON.stringify({ status: 'removed' }) });
        } else if (report.tipo_alvo === 'comentario') {
          await fetch(`${SU}/rest/v1/blue_comments?id=eq.${report.alvo_id}`, { method: 'DELETE', headers: h });
        }
      } else if (acao === 'banir_temp' || acao === 'banir_perm') {
        let targetUser = report.alvo_id;
        if (report.tipo_alvo === 'video') {
          const vR = await fetch(`${SU}/rest/v1/blue_videos?id=eq.${report.alvo_id}&select=user_id`, { headers: h });
          const v = vR.ok ? (await vR.json())[0] : null;
          if (v) targetUser = v.user_id;
        }
        await fetch(`${SU}/rest/v1/blue_banimentos`, { method: 'POST', headers: { ...h, 'Prefer': 'return=minimal' },
          body: JSON.stringify({
            user_id: targetUser,
            motivo: motivo_admin || report.motivo,
            tipo: acao === 'banir_perm' ? 'permanente' : 'temporario',
            expira_em: acao === 'banir_perm' ? null : new Date(Date.now() + 7 * 86400000).toISOString(),
            admin_id: 'admin'
          })
        });
        await fetch(`${SU}/rest/v1/blue_notificacoes`, { method: 'POST', headers: { ...h, 'Prefer': 'return=minimal' },
          body: JSON.stringify({ user_id: targetUser, tipo: 'banimento', titulo: '🚫 Conta suspensa', mensagem: acao === 'banir_perm' ? 'Sua conta foi suspensa permanentemente.' : 'Sua conta foi suspensa por 7 dias.' })
        });
      }

      // Update report
      await fetch(`${SU}/rest/v1/blue_reports?id=eq.${report_id}`, {
        method: 'PATCH', headers: { ...h, 'Prefer': 'return=minimal' },
        body: JSON.stringify({ status: 'resolvido', acao_tomada: acao, admin_id: 'admin', resolvido_em: now })
      });

      // Notify reporter
      await fetch(`${SU}/rest/v1/blue_notificacoes`, { method: 'POST', headers: { ...h, 'Prefer': 'return=minimal' },
        body: JSON.stringify({ user_id: report.reporter_id, tipo: 'report_resolvido', titulo: '✅ Denúncia analisada', mensagem: 'Analisamos sua denúncia e tomamos as medidas necessárias.' })
      });

      return res.status(200).json({ ok: true, acao });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  // ── ADMIN: BANIMENTOS ATIVOS ────────────────────────────────────────────
  if (action === 'banimentos') {
    if (!isAdmin(req)) return res.status(401).json({ error: 'Admin only' });
    try {
      const bR = await fetch(`${SU}/rest/v1/blue_banimentos?or=(expira_em.is.null,expira_em.gt.${new Date().toISOString()})&order=created_at.desc&select=*`, { headers: h });
      const bans = bR.ok ? await bR.json() : [];
      const uIds = [...new Set(bans.map(b => b.user_id))];
      let profiles = {};
      if (uIds.length) {
        const pR = await fetch(`${SU}/rest/v1/blue_profiles?user_id=in.(${uIds.join(',')})&select=user_id,username,display_name`, { headers: h });
        if (pR.ok) (await pR.json()).forEach(p => { profiles[p.user_id] = p; });
      }
      return res.status(200).json({ banimentos: bans.map(b => ({ ...b, profile: profiles[b.user_id] || null })) });
    } catch(e) { return res.status(200).json({ banimentos: [] }); }
  }

  // ── ADMIN: REVOGAR BANIMENTO ────────────────────────────────────────────
  if (req.method === 'POST' && action === 'revogar-ban') {
    if (!isAdmin(req)) return res.status(401).json({ error: 'Admin only' });
    const { ban_id } = req.body;
    if (!ban_id) return res.status(400).json({ error: 'ban_id obrigatório' });
    try {
      await fetch(`${SU}/rest/v1/blue_banimentos?id=eq.${ban_id}`, { method: 'DELETE', headers: h });
      return res.status(200).json({ ok: true });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  return res.status(404).json({ error: 'Action não encontrada' });
};
