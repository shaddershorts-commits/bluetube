// api/admin.js
// Returns admin dashboard data: users, subscribers, usage stats.
// Protected by ADMIN_SECRET environment variable.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Auth check
  const authHeader = req.headers['authorization'];
  const ADMIN_SECRET = process.env.ADMIN_SECRET;
  if (!ADMIN_SECRET || authHeader !== `Bearer ${ADMIN_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
  const headers = { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` };

  const { action, email, plan } = req.method === 'POST' ? req.body : req.query;

  // ── SAQUES: painel + acoes manuais ───────────────────────────────────────
  if (req.method === 'GET' && action === 'saques-panel') {
    return saquesPanelAction(req, res, { SUPABASE_URL, headers });
  }
  if (req.method === 'POST' && action === 'marcar-saque-pago') {
    return marcarSaquePagoAction(req, res, { SUPABASE_URL, headers });
  }

  // ── SET PLAN MANUALLY ────────────────────────────────────────────────────
  if (req.method === 'POST' && action === 'set_plan') {
    if (!email || !plan) return res.status(400).json({ error: 'Missing email or plan' });

    const payload = {
      plan,
      is_manual: true,
      plan_expires_at: plan === 'free' ? null : new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      updated_at: new Date().toISOString()
    };

    // Try PATCH first (update existing)
    const patch = await fetch(
      `${SUPABASE_URL}/rest/v1/subscribers?email=eq.${encodeURIComponent(email)}`,
      {
        method: 'PATCH',
        headers: { ...headers, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
        body: JSON.stringify(payload)
      }
    );

    const patchData = await patch.json();
    console.log('PATCH result:', patch.status, JSON.stringify(patchData).slice(0,200));

    // If no rows updated, INSERT new record
    if (patch.ok && Array.isArray(patchData) && patchData.length === 0) {
      const insert = await fetch(`${SUPABASE_URL}/rest/v1/subscribers`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
        body: JSON.stringify({ email, ...payload })
      });
      if (!insert.ok) {
        const err = await insert.json();
        console.error('INSERT error:', err);
        return res.status(500).json({ error: 'Failed to insert plan: ' + JSON.stringify(err) });
      }
    } else if (!patch.ok) {
      console.error('PATCH error:', patchData);
      return res.status(500).json({ error: 'Failed to update plan: ' + JSON.stringify(patchData) });
    }

    // Email motivacional pro usuário quando admin promove manualmente pra Full ou Master.
    // Fire-and-forget — não bloqueia resposta do admin.
    if (plan === 'full' || plan === 'master') {
      try {
        const { sendUpgradeEmail } = require('./_helpers/upgradeEmail.js');
        sendUpgradeEmail(email, plan, 'monthly').catch((e) => console.error('upgradeEmail (admin):', e.message));
      } catch (e) { console.error('upgradeEmail import (admin):', e.message); }
    }

    return res.status(200).json({ success: true, email, plan });
  }

  // ── RECUPERAR PAGAMENTO: busca no Stripe por email e ativa plano ─────────
  // Usado quando webhook falhou e pagamento > 15min ficou fora do payment-monitor.
  // Diferente do set_plan (is_manual:true), esse verifica que PAGOU no Stripe mesmo.
  if (req.method === 'POST' && action === 'recuperar-pagamento') {
    if (!email) return res.status(400).json({ error: 'email obrigatorio' });
    return recuperarPagamentoAction(req, res, { SUPABASE_URL, headers, email });
  }

  // ── COMMISSIONS DUPLICADAS: detector + cancelador manual ─────────────────
  // A constraint UNIQUE no banco (ix_commissions_uniq_per_month) ja impede
  // novas duplicatas. Isso aqui e pra auditar historico e limpar casos
  // anteriores a existencia da constraint.
  if (req.method === 'GET' && action === 'detectar-commissions-duplicadas') {
    return detectarCommissionsDuplicadasAction(req, res, { SUPABASE_URL, headers });
  }
  if (req.method === 'POST' && action === 'cancelar-commission') {
    return cancelarCommissionAction(req, res, { SUPABASE_URL, headers });
  }

  // ── AFFILIATE MANAGEMENT ─────────────────────────────────────────────────
  if (req.method === 'POST' && action === 'set_affiliate_status') {
    const { email, status } = req.body; // status: active | pending | suspended
    if (!email || !status) return res.status(400).json({ error: 'email e status obrigatórios' });
    const r = await fetch(`${SUPABASE_URL}/rest/v1/affiliates?email=eq.${encodeURIComponent(email)}`, {
      method: 'PATCH',
      headers: { ...headers, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
      body: JSON.stringify({ status, updated_at: new Date().toISOString() })
    });
    const data = await r.json();
    console.log(`Affiliate ${status}: ${email}`);
    return res.status(200).json({ success: true, email, status });
  }

  if (req.method === 'GET' && action === 'list_affiliates') {
    try {
      const sete = new Date(Date.now() - 7 * 86400000).toISOString();
      const [affRes, commRes, clksRes, clks7dRes] = await Promise.all([
        fetch(`${SUPABASE_URL}/rest/v1/affiliates?select=*&order=created_at.desc`, { headers }),
        fetch(`${SUPABASE_URL}/rest/v1/affiliate_commissions?select=affiliate_id,commission_amount,status&order=created_at.desc`, { headers }),
        fetch(`${SUPABASE_URL}/rest/v1/affiliate_clicks?select=affiliate_id,cookie_id&limit=50000`, { headers }),
        fetch(`${SUPABASE_URL}/rest/v1/affiliate_clicks?landed_at=gte.${sete}&select=affiliate_id&limit=50000`, { headers }),
      ]);
      const affiliates = affRes.ok ? await affRes.json() : [];
      const commissions = commRes.ok ? await commRes.json() : [];
      const clicks = clksRes.ok ? await clksRes.json() : [];
      const clicks7d = clks7dRes.ok ? await clks7dRes.json() : [];

      // Agrupa comissões por afiliado — IGNORA cancelled/refunded
      const commMap = {};
      (Array.isArray(commissions) ? commissions : []).forEach(c => {
        if (c.status !== 'pending' && c.status !== 'paid') return; // skip cancelled, refunded, etc
        if (!commMap[c.affiliate_id]) commMap[c.affiliate_id] = { pending: 0, paid: 0, total: 0 };
        const amt = parseFloat(c.commission_amount || 0);
        commMap[c.affiliate_id].total += amt;
        if (c.status === 'pending') commMap[c.affiliate_id].pending += amt;
        if (c.status === 'paid') commMap[c.affiliate_id].paid += amt;
      });

      // Agrupa clicks (total + visitantes unicos por cookie_id) por afiliado
      const clickMap = {};
      const uniqSets = {};
      (Array.isArray(clicks) ? clicks : []).forEach(c => {
        if (!clickMap[c.affiliate_id]) { clickMap[c.affiliate_id] = 0; uniqSets[c.affiliate_id] = new Set(); }
        clickMap[c.affiliate_id]++;
        if (c.cookie_id) uniqSets[c.affiliate_id].add(c.cookie_id);
      });
      const click7dMap = {};
      (Array.isArray(clicks7d) ? clicks7d : []).forEach(c => {
        click7dMap[c.affiliate_id] = (click7dMap[c.affiliate_id] || 0) + 1;
      });

      const enriched = (Array.isArray(affiliates) ? affiliates : []).map(a => {
        const cliques = clickMap[a.id] || 0;
        const visUnicos = uniqSets[a.id]?.size || 0;
        const pagantes = (a.total_full || 0) + (a.total_master || 0);
        const conv = cliques > 0 ? parseFloat(((pagantes / cliques) * 100).toFixed(2)) : 0;
        return {
          ...a,
          nivel: a.nivel || 'bronze',
          comissao_percentual: a.comissao_percentual || 30,
          commissions_pending: parseFloat((commMap[a.id]?.pending || 0).toFixed(2)),
          commissions_paid: parseFloat((commMap[a.id]?.paid || 0).toFixed(2)),
          commissions_total: parseFloat((commMap[a.id]?.total || 0).toFixed(2)),
          cliques_total: cliques,
          cliques_7d: click7dMap[a.id] || 0,
          visitantes_unicos: visUnicos,
          taxa_conversao: conv,
        };
      });
      return res.status(200).json(enriched);
    } catch(e) { return res.status(200).json([]); }
  }

  // ── SET AFFILIATE LEVEL ─────────────────────────────────────────────────
  if (req.method === 'POST' && action === 'set_affiliate_level') {
    const { affiliate_id, nivel, motivo } = req.body;
    if (!affiliate_id || !nivel) return res.status(400).json({ error: 'affiliate_id e nivel obrigatórios' });
    const NIVEL_RATES = { bronze: 30, prata: 45, ouro: 58 };
    const comissao = NIVEL_RATES[nivel];
    if (comissao === undefined) return res.status(400).json({ error: 'Nível inválido: bronze, prata ou ouro' });

    try {
      // Busca afiliado atual
      const ar = await fetch(`${SUPABASE_URL}/rest/v1/affiliates?id=eq.${affiliate_id}&select=*`, { headers });
      const affiliates = ar.ok ? await ar.json() : [];
      const affiliate = affiliates?.[0];
      if (!affiliate) return res.status(404).json({ error: 'Afiliado não encontrado' });

      const nivelAnterior = affiliate.nivel || 'bronze';
      if (nivelAnterior === nivel) return res.status(200).json({ ok: true, message: 'Já está neste nível', affiliate });

      // Atualiza nível
      await fetch(`${SUPABASE_URL}/rest/v1/affiliates?id=eq.${affiliate_id}`, {
        method: 'PATCH',
        headers: { ...headers, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
        body: JSON.stringify({
          nivel,
          comissao_percentual: comissao,
          nivel_atualizado_em: new Date().toISOString(),
          nivel_atualizado_por: 'admin',
          updated_at: new Date().toISOString()
        })
      });

      // Histórico
      await fetch(`${SUPABASE_URL}/rest/v1/affiliate_nivel_historico`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
        body: JSON.stringify({
          affiliate_id,
          nivel_anterior: nivelAnterior,
          nivel_novo: nivel,
          motivo: motivo || null,
          admin_email: 'admin'
        })
      });

      // Email de notificação — motivacional e personalizado por nível
      const RESEND = process.env.RESEND_API_KEY;
      if (RESEND && affiliate.email) {
        const nivelLabel = { bronze: 'Bronze', prata: 'Prata', ouro: 'Ouro' }[nivel];
        const nivelEmoji = { bronze: '🥉', prata: '🥈', ouro: '🥇' }[nivel];
        const nivelColor = { bronze: '#cd7f32', prata: '#c0c0c0', ouro: '#FFD700' }[nivel];
        const anteriorLabel = { bronze: 'Bronze', prata: 'Prata', ouro: 'Ouro' }[nivelAnterior] || 'Bronze';
        const anteriorRate = { bronze: 30, prata: 45, ouro: 58 }[nivelAnterior] || 30;
        const nome = affiliate.name || affiliate.email.split('@')[0];
        const exFull = (10 * 29.99 * comissao / 100).toFixed(2);
        const exMaster = (10 * 89.99 * comissao / 100).toFixed(2);

        const mensagens = {
          prata: {
            subject: `🥈 ${nome}, você foi promovido para Afiliado Prata!`,
            titulo: `Você mereceu, ${nome}!`,
            texto: `Seu esforço e dedicação chamaram nossa atenção. Você não é mais um afiliado comum — agora faz parte do grupo seleto de parceiros <strong style="color:#c0c0c0">Prata</strong> da BlueTube.`,
            motivacao: `Cada indicação sua ajuda criadores de conteúdo a transformarem seus canais. Isso tem um impacto real — e a gente reconhece quem faz a diferença.`,
            destaque: `Continue assim e o nível <strong style="color:#FFD700">Ouro (58%)</strong> está ao seu alcance. Nós acreditamos em você.`,
          },
          ouro: {
            subject: `🥇 ${nome}, bem-vindo ao nível Ouro! Você é elite.`,
            titulo: `${nome}, você chegou ao topo.`,
            texto: `Poucos chegam aqui. Você acaba de entrar para o grupo de parceiros mais valiosos da BlueTube — o nível <strong style="color:#FFD700">Ouro</strong>. Isso não é sorte, é resultado do seu trabalho excepcional.`,
            motivacao: `Você provou que é mais do que um afiliado — é um verdadeiro embaixador. Cada pessoa que você traz encontra uma ferramenta que transforma a vida dela como criador de conteúdo. Esse é o seu legado.`,
            destaque: `A partir de agora, você tem a maior comissão possível do programa: <strong style="color:#FFD700">58% vitalício</strong>. Pagamentos priorizados, suporte dedicado e acesso antecipado a novidades.`,
          },
          bronze: {
            subject: `🥉 ${nome}, seu nível foi atualizado para Bronze`,
            titulo: `${nome}, seu nível foi ajustado.`,
            texto: `Seu nível no programa de afiliados foi atualizado para <strong style="color:#cd7f32">Bronze</strong>. Isso não muda o quanto valorizamos sua parceria.`,
            motivacao: `Continue indicando a BlueTube e seu nível pode subir novamente. Cada indicação conta, e estamos torcendo por você.`,
            destaque: `Lembre-se: mesmo no Bronze, você ganha comissão recorrente em cada assinatura indicada. Seu potencial é ilimitado.`,
          },
        };
        const msg = mensagens[nivel] || mensagens.bronze;

        fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND}` },
          body: JSON.stringify({
            from: 'BlueTube <noreply@bluetubeviral.com>',
            to: [affiliate.email],
            subject: msg.subject,
            html: `<div style="font-family:'Segoe UI',Helvetica,Arial,sans-serif;background:#0a1628;color:#e8f4ff;max-width:520px;margin:0 auto;border-radius:20px;overflow:hidden">
              <!-- Header com gradiente do nível -->
              <div style="background:linear-gradient(135deg,${nivel==='ouro'?'#B8860B,#FFD700,#FFA500':nivel==='prata'?'#808080,#c0c0c0,#e0e0e0':'#8B4513,#cd7f32,#D2691E'});padding:36px 32px;text-align:center">
                <div style="font-size:56px;margin-bottom:8px">${nivelEmoji}</div>
                <h1 style="font-size:22px;font-weight:800;margin:0;color:${nivel==='prata'?'#1a1a2e':'#fff'}">${msg.titulo}</h1>
              </div>

              <div style="padding:32px">
                <!-- Texto motivacional -->
                <p style="font-size:15px;line-height:1.7;color:#c8d6e5;margin:0 0 16px">${msg.texto}</p>
                <p style="font-size:14px;line-height:1.7;color:#99aabb;margin:0 0 20px">${msg.motivacao}</p>

                <!-- Card de comissão: antes → depois -->
                <div style="background:rgba(255,255,255,0.04);border:1px solid ${nivelColor}33;border-radius:14px;padding:24px;text-align:center;margin-bottom:20px">
                  <div style="display:inline-block;vertical-align:middle">
                    <div style="font-size:11px;color:#667;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px">Antes</div>
                    <div style="font-size:28px;font-weight:800;color:#556;text-decoration:line-through">${anteriorRate}%</div>
                    <div style="font-size:10px;color:#556">${anteriorLabel}</div>
                  </div>
                  <div style="display:inline-block;vertical-align:middle;margin:0 20px;font-size:24px;color:${nivelColor}">→</div>
                  <div style="display:inline-block;vertical-align:middle">
                    <div style="font-size:11px;color:${nivelColor};text-transform:uppercase;letter-spacing:1px;margin-bottom:4px">Agora</div>
                    <div style="font-size:42px;font-weight:900;color:${nivelColor}">${comissao}%</div>
                    <div style="font-size:10px;color:${nivelColor}">${nivelLabel}</div>
                  </div>
                </div>

                <!-- Destaque -->
                <p style="font-size:14px;line-height:1.7;color:#c8d6e5;margin:0 0 20px">${msg.destaque}</p>

                <!-- Exemplos de ganhos -->
                <div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);border-radius:10px;padding:16px;margin-bottom:24px">
                  <div style="font-size:11px;color:#667;text-transform:uppercase;letter-spacing:1px;margin-bottom:10px">Seus ganhos potenciais</div>
                  <div style="font-size:13px;color:#99aabb;margin-bottom:6px">10 assinantes Full (R$29,99) = <strong style="color:${nivelColor}">R$${exFull}/mês</strong></div>
                  <div style="font-size:13px;color:#99aabb">10 assinantes Master (R$89,99) = <strong style="color:${nivelColor}">R$${exMaster}/mês</strong></div>
                </div>

                <!-- CTA -->
                <div style="text-align:center">
                  <a href="https://bluetubeviral.com/afiliado" style="display:inline-block;background:linear-gradient(135deg,${nivel==='ouro'?'#B8860B,#FFD700':nivel==='prata'?'#808080,#c0c0c0':'#4f46e5,#7c3aed'});color:${nivel==='prata'?'#1a1a2e':'#fff'};padding:16px 36px;border-radius:12px;text-decoration:none;font-weight:800;font-size:15px">Ver meu painel →</a>
                </div>

                <!-- Assinatura -->
                <div style="text-align:center;margin-top:28px;padding-top:20px;border-top:1px solid rgba(255,255,255,0.06)">
                  <div style="font-size:13px;color:#556">Equipe BlueTube</div>
                  <div style="font-size:11px;color:#445;margin-top:4px">Obrigado por fazer parte dessa jornada com a gente.</div>
                </div>
              </div>
            </div>`
          })
        }).catch((e) => console.error('Email send error:', e.message));
      }

      console.log(`🎖 Affiliate level: ${affiliate.email} ${nivelAnterior} → ${nivel} (${comissao}%)`);
      return res.status(200).json({ ok: true, affiliate: { ...affiliate, nivel, comissao_percentual: comissao } });
    } catch(e) {
      console.error('Set affiliate level error:', e.message);
      return res.status(500).json({ error: 'Erro ao alterar nível: ' + e.message });
    }
  }

  // ── AFFILIATE LEVEL HISTORY ─────────────────────────────────────────────
  if (req.method === 'GET' && action === 'affiliate_history') {
    const { affiliate_id } = req.query;
    if (!affiliate_id) return res.status(400).json({ error: 'affiliate_id obrigatório' });
    try {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/affiliate_nivel_historico?affiliate_id=eq.${affiliate_id}&select=*&order=created_at.desc&limit=20`, { headers });
      return res.status(200).json(r.ok ? await r.json() : []);
    } catch(e) { return res.status(200).json([]); }
  }

  // ── VERIFICAÇÃO DE CONTAS ─────────────────────────────────────────────
  if (req.method === 'GET' && action === 'list_verificacoes') {
    try {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/blue_verificacao_solicitacoes?status=eq.pendente&select=*&order=created_at.desc`, { headers });
      return res.status(200).json(r.ok ? await r.json() : []);
    } catch(e) { return res.status(200).json([]); }
  }

  if (req.method === 'POST' && action === 'aprovar_verificacao') {
    const { user_id: vUserId, solicitacao_id } = req.body;
    if (!vUserId) return res.status(400).json({ error: 'user_id obrigatório' });
    try {
      await Promise.all([
        fetch(`${SUPABASE_URL}/rest/v1/blue_profiles?user_id=eq.${vUserId}`, {
          method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
          body: JSON.stringify({ verificado: true, verificado_em: new Date().toISOString() })
        }),
        solicitacao_id ? fetch(`${SUPABASE_URL}/rest/v1/blue_verificacao_solicitacoes?id=eq.${solicitacao_id}`, {
          method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
          body: JSON.stringify({ status: 'aprovado' })
        }) : Promise.resolve(),
        fetch(`${SUPABASE_URL}/rest/v1/blue_notificacoes`, {
          method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
          body: JSON.stringify({ user_id: vUserId, tipo: 'verificacao', titulo: 'Conta verificada!', mensagem: 'Parabéns! Sua conta Blue foi verificada. O badge ✓ agora aparece no seu perfil.' })
        }),
      ]);
      return res.status(200).json({ ok: true });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  if (req.method === 'POST' && action === 'rejeitar_verificacao') {
    const { solicitacao_id } = req.body;
    if (!solicitacao_id) return res.status(400).json({ error: 'solicitacao_id obrigatório' });
    await fetch(`${SUPABASE_URL}/rest/v1/blue_verificacao_solicitacoes?id=eq.${solicitacao_id}`, {
      method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
      body: JSON.stringify({ status: 'rejeitado' })
    });
    return res.status(200).json({ ok: true });
  }

  // ── MODERATION ──────────────────────────────────────────────────────────
  if (req.method === 'GET' && action === 'moderation') {
    try {
      const [reportsRes, reviewRes] = await Promise.all([
        fetch(`${SUPABASE_URL}/rest/v1/blue_reports?order=created_at.desc&limit=50&select=*`, { headers }),
        fetch(`${SUPABASE_URL}/rest/v1/blue_videos?status=eq.under_review&select=id,title,user_id,video_url,created_at`, { headers }),
      ]);
      const reports = reportsRes.ok ? await reportsRes.json() : [];
      const underReview = reviewRes.ok ? await reviewRes.json() : [];
      return res.status(200).json({
        reports,
        under_review: underReview,
        pending_count: reports.filter(r => r.status === 'pending').length,
        total_count: reports.length,
        review_count: underReview.length
      });
    } catch(e) { return res.status(200).json({ reports: [], under_review: [], error: e.message }); }
  }

  // ── MODERATE VIDEO ─────────────────────────────────────────────────────
  if (req.method === 'POST' && action === 'moderate') {
    const { video_id, decision } = req.body; // decision: 'approve' | 'remove'
    if (!video_id || !decision) return res.status(400).json({ error: 'Missing fields' });
    const newStatus = decision === 'approve' ? 'active' : 'removed';
    await fetch(`${SUPABASE_URL}/rest/v1/blue_videos?id=eq.${video_id}`, {
      method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
      body: JSON.stringify({ status: newStatus, updated_at: new Date().toISOString() })
    });
    // Mark related reports as resolved
    await fetch(`${SUPABASE_URL}/rest/v1/blue_reports?video_id=eq.${video_id}`, {
      method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
      body: JSON.stringify({ status: decision === 'approve' ? 'dismissed' : 'actioned' })
    });
    return res.status(200).json({ success: true, video_id, status: newStatus });
  }

  // ── LEARNING STATS ────────────────────────────────────────────────────────
  if (req.method === 'GET' && action === 'learning_stats') {
    try {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/roteiro_exemplos?select=id,idioma,nicho,roteiro_casual,roteiro_apelativo,aprovacoes,reprovacoes,created_at&order=aprovacoes.desc&limit=50`, { headers });
      const data = await r.json();
      const arr = Array.isArray(data) ? data : [];
      const totalAprov = arr.reduce((s, r) => s + (r.aprovacoes || 0), 0);
      const totalReprov = arr.reduce((s, r) => s + (r.reprovacoes || 0), 0);
      const avgScore = arr.length > 0 && (totalAprov + totalReprov) > 0
        ? (totalAprov / (totalAprov + totalReprov)) * 100 : 0;
      return res.status(200).json({
        total: arr.length,
        total_aprovacoes: totalAprov,
        total_reprovacoes: totalReprov,
        avg_score: avgScore,
        top: arr.slice(0, 20)
      });
    } catch(e) {
      return res.status(200).json({ total: 0, top: [], error: e.message });
    }
  }

  // ── DELETE LEARNING EXAMPLE ──────────────────────────────────────────────
  if (req.method === 'POST' && action === 'delete_learning_example') {
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: 'Missing id' });
    await fetch(`${SUPABASE_URL}/rest/v1/roteiro_exemplos?id=eq.${id}`, { method: 'DELETE', headers });
    return res.status(200).json({ success: true });
  }

  // ── DELETE LOW-SCORE LEARNING EXAMPLES ──────────────────────────────────
  if (req.method === 'POST' && action === 'delete_low_score_examples') {
    const all = await fetch(`${SUPABASE_URL}/rest/v1/roteiro_exemplos?select=id,aprovacoes,reprovacoes`, { headers });
    let deleted = 0;
    if (all.ok) {
      for (const r of await all.json()) {
        const t = (r.aprovacoes||0) + (r.reprovacoes||0);
        const sc = t > 0 ? r.aprovacoes / t : 0;
        if (sc < 0.3 && t >= 3) {
          await fetch(`${SUPABASE_URL}/rest/v1/roteiro_exemplos?id=eq.${r.id}`, { method:'DELETE', headers });
          deleted++;
        }
      }
    }
    return res.status(200).json({ success: true, deleted });
  }

  // ── DELETE USER (LGPD) ─────────────────────────────────────────────────
  if (req.method === 'POST' && action === 'delete_user') {
    const { email: targetEmail } = req.body;
    if (!targetEmail) return res.status(400).json({ error: 'Missing email' });
    const h2 = { ...headers, 'Content-Type': 'application/json' };

    // Cancel Stripe if exists
    const subRes = await fetch(`${SUPABASE_URL}/rest/v1/subscribers?email=eq.${encodeURIComponent(targetEmail)}&select=stripe_customer_id,user_id`, { headers });
    const sub = subRes.ok ? (await subRes.json())[0] : null;
    const uid = sub?.user_id;
    const stripeId = sub?.stripe_customer_id;
    if (stripeId && process.env.STRIPE_SECRET_KEY) {
      try {
        const sr = await fetch(`https://api.stripe.com/v1/customers/${stripeId}/subscriptions?status=active`, {
          headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` }
        });
        if (sr.ok) { for (const s of (await sr.json()).data||[]) { await fetch(`https://api.stripe.com/v1/subscriptions/${s.id}`, { method:'DELETE', headers:{ Authorization:`Bearer ${process.env.STRIPE_SECRET_KEY}` }}); } }
      } catch(e) {}
    }

    // Delete from all tables
    const tables = ['subscribers','user_feedback','roteiro_exemplos','reactivation_emails'];
    for (const t of tables) { await fetch(`${SUPABASE_URL}/rest/v1/${t}?email=eq.${encodeURIComponent(targetEmail)}`, { method:'DELETE', headers }).catch(()=>{}); }
    if (uid) {
      const uidTables = ['blue_profiles','blue_videos','blue_comments','blue_interactions','blue_notifications','blue_reports'];
      for (const t of uidTables) { await fetch(`${SUPABASE_URL}/rest/v1/${t}?user_id=eq.${uid}`, { method:'DELETE', headers }).catch(()=>{}); }
    }

    // Log action
    await fetch(`${SUPABASE_URL}/rest/v1/admin_actions`, {
      method:'POST', headers:h2,
      body: JSON.stringify({ admin_email:'admin', action:'delete_user', target_email:targetEmail, details:{ stripe_cancelled:!!stripeId } })
    }).catch(()=>{});

    // Email notification
    const RESEND = process.env.RESEND_API_KEY;
    if (RESEND) {
      fetch('https://api.resend.com/emails', { method:'POST', headers:{'Content-Type':'application/json',Authorization:`Bearer ${RESEND}`},
        body:JSON.stringify({ from:'BlueTube <noreply@bluetubeviral.com>', to:[targetEmail], subject:'Sua conta BlueTube foi removida',
          html:`<div style="font-family:sans-serif;background:#0a1628;color:#e8f4ff;padding:24px;border-radius:12px"><p>Sua conta foi removida do BlueTube por um administrador.</p><p>Todos os seus dados foram excluídos.</p></div>`})
      }).catch(()=>{});
    }

    return res.status(200).json({ success: true, email: targetEmail });
  }

  // ── FEEDBACK ACTIONS ────────────────────────────────────────────────────
  if (req.method === 'POST' && action === 'delete_feedback') {
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: 'Missing id' });
    await fetch(`${SUPABASE_URL}/rest/v1/user_feedback?id=eq.${id}`, { method:'DELETE', headers });
    return res.status(200).json({ success: true });
  }
  if (req.method === 'POST' && action === 'delete_feedbacks_bulk') {
    const { ids } = req.body;
    if (!ids?.length) return res.status(400).json({ error: 'Missing ids' });
    for (const id of ids) { await fetch(`${SUPABASE_URL}/rest/v1/user_feedback?id=eq.${id}`, { method:'DELETE', headers }); }
    return res.status(200).json({ success: true, deleted: ids.length });
  }
  if (req.method === 'POST' && action === 'mark_feedback_read') {
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: 'Missing id' });
    await fetch(`${SUPABASE_URL}/rest/v1/user_feedback?id=eq.${id}`, {
      method:'PATCH', headers:{ ...headers,'Content-Type':'application/json','Prefer':'return=minimal' },
      body: JSON.stringify({ is_read: true })
    });
    return res.status(200).json({ success: true });
  }

  // ── AUDIT LOG (admin search + stats) ──────────────────────────────────────
  // GET ?action=audit_log&tabela=X&row_id=Y&acao=UPDATE&desde=2026-01-01&limit=50
  if (req.method === 'GET' && action === 'audit_log') {
    try {
      const { tabela, row_id, usuario_id, acao: auditAcao, desde, limit } = req.query;
      const body = {
        p_tabela: tabela || null,
        p_row_id: row_id || null,
        p_usuario_id: usuario_id || null,
        p_acao: auditAcao || null,
        p_desde: desde || null,
        p_limit: Math.min(parseInt(limit || 50), 500),
      };
      const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/audit_log_search`, {
        method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) return res.status(500).json({ error: 'rpc_error', detalhes: await r.text() });
      const rows = await r.json();

      // Stats rapidos — total por tabela nos ultimos 7d
      const diasAtras = new Date(Date.now() - 7 * 86400000).toISOString();
      const statsR = await fetch(
        `${SUPABASE_URL}/rest/v1/audit_log?created_at=gte.${diasAtras}&select=tabela,acao`,
        { headers }
      );
      const raw = statsR.ok ? await statsR.json() : [];
      const stats = {};
      raw.forEach(r => {
        stats[r.tabela] = stats[r.tabela] || { total: 0, INSERT: 0, UPDATE: 0, DELETE: 0 };
        stats[r.tabela].total++;
        stats[r.tabela][r.acao] = (stats[r.tabela][r.acao] || 0) + 1;
      });

      return res.status(200).json({ rows, stats, filters: { tabela, row_id, acao: auditAcao, desde, limit } });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── AI CACHE STATS (quanto economizamos) ──────────────────────────────────
  if (req.method === 'GET' && action === 'ai_cache_stats') {
    try {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/ai_cache_stats`, {
        method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const [stats] = r.ok ? await r.json() : [{}];
      return res.status(200).json({ stats: stats || {} });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── STRIPE WEBHOOKS (stats + lista recente) ──────────────────────────────
  // ── SEND_CANCELLATION_CONFIRMATION — envia email manual pro cliente ───────
  // Usado quando um cliente cancelou antes da feature de email automatico
  // existir, pra evitar chargeback/estorno. Busca plan_expires_at do banco.
  if (req.method === 'POST' && action === 'send_cancellation_confirmation') {
    try {
      const alvoEmail = (email || req.body?.email || '').toLowerCase().trim();
      if (!alvoEmail) return res.status(400).json({ error: 'email obrigatorio' });

      const subR = await fetch(
        `${SUPABASE_URL}/rest/v1/subscribers?email=ilike.${encodeURIComponent(alvoEmail)}&select=email,plan,plan_expires_at&limit=1`,
        { headers }
      );
      const subs = subR.ok ? await subR.json() : [];
      const sub = subs[0];
      if (!sub) return res.status(404).json({ error: 'subscriber nao encontrado' });
      if (!sub.plan_expires_at) return res.status(400).json({ error: 'usuario nao tem cancelamento agendado (sem plan_expires_at)' });
      if (!['full','master'].includes(sub.plan)) return res.status(400).json({ error: `plano atual e ${sub.plan}, email so faz sentido pra full/master` });

      const { sendCancellationEmail } = require('./_helpers/cancellationEmail.js');
      const result = await sendCancellationEmail(sub.email, sub.plan, sub.plan_expires_at);
      return res.status(200).json({ ok: result.sent, ...result, email_alvo: sub.email, plan: sub.plan, plan_expires_at: sub.plan_expires_at });
    } catch (e) {
      console.error('[admin send_cancellation_confirmation]', e.message);
      return res.status(500).json({ error: e.message });
    }
  }

  // ── CHECK_CANCELAMENTO — verifica estado completo de um email ─────────────
  // Retorna: subscriber, afiliado atribuido, comissoes, webhooks relacionados
  if (req.method === 'GET' && action === 'check_cancelamento') {
    try {
      const emailParam = (email || req.query.email || '').toLowerCase().trim();
      if (!emailParam) return res.status(400).json({ error: 'email obrigatorio' });
      const emailEnc = encodeURIComponent(emailParam);
      const hJson = { ...headers, 'Content-Type': 'application/json' };

      // 1) Subscriber (case-insensitive via ilike)
      const subR = await fetch(
        `${SUPABASE_URL}/rest/v1/subscribers?email=ilike.${emailEnc}&select=*`,
        { headers: hJson }
      );
      const subs = subR.ok ? await subR.json() : [];
      const subscriber = subs[0] || null;
      const customerId = subscriber?.stripe_customer_id || null;

      // 2) Conversions do afiliado
      const convR = await fetch(
        `${SUPABASE_URL}/rest/v1/affiliate_conversions?converted_email=ilike.${emailEnc}&select=*`,
        { headers: hJson }
      );
      const conversions = convR.ok ? await convR.json() : [];

      // 3) Commissions + nome do afiliado
      const comR = await fetch(
        `${SUPABASE_URL}/rest/v1/affiliate_commissions?subscriber_email=ilike.${emailEnc}&select=*`,
        { headers: hJson }
      );
      const commissions = comR.ok ? await comR.json() : [];

      // Enriquece commissions com email do afiliado
      const affIds = [...new Set(commissions.map(c => c.affiliate_id).filter(Boolean))];
      let affMap = {};
      if (affIds.length > 0) {
        const aR = await fetch(
          `${SUPABASE_URL}/rest/v1/affiliates?id=in.(${affIds.join(',')})&select=id,email`,
          { headers: hJson }
        );
        const affs = aR.ok ? await aR.json() : [];
        affMap = Object.fromEntries(affs.map(a => [a.id, a.email]));
      }
      const commissionsEnriched = commissions.map(c => ({ ...c, afiliado_email: affMap[c.affiliate_id] || null }));

      // 4) Stripe webhooks que mencionam o email ou customer_id (ultimos 90d)
      const desde90d = new Date(Date.now() - 90 * 86400000).toISOString();
      const searches = [`payload_json=ilike.*${emailEnc}*`];
      if (customerId) searches.push(`payload_json=ilike.*${encodeURIComponent(customerId)}*`);
      // Busca por email OU customer_id via OR
      const orFilter = encodeURIComponent(searches.map(s => s).join(','));
      let webhooks = [];
      try {
        const whR = await fetch(
          `${SUPABASE_URL}/rest/v1/stripe_webhook_log?or=(${orFilter})&created_at=gte.${desde90d}&select=id,stripe_event_id,tipo,status,tentativas,ultimo_erro,processado_em,created_at&order=created_at.desc&limit=50`,
          { headers: hJson }
        );
        webhooks = whR.ok ? await whR.json() : [];
      } catch(e) {
        // Fallback: busca simples so por customer_id se tiver
        if (customerId) {
          const whR2 = await fetch(
            `${SUPABASE_URL}/rest/v1/stripe_webhook_log?created_at=gte.${desde90d}&select=id,stripe_event_id,tipo,status,tentativas,ultimo_erro,processado_em,created_at&order=created_at.desc&limit=200`,
            { headers: hJson }
          );
          webhooks = whR2.ok ? await whR2.json() : [];
        }
      }

      // 5) Diagnostico agregado
      const agora = new Date();
      const planExpirou = subscriber?.plan_expires_at ? new Date(subscriber.plan_expires_at) < agora : null;
      const diag = {
        plano_atual: subscriber?.plan || null,
        e_pagante: subscriber && ['full','master'].includes(subscriber.plan),
        cancelamento_agendado: !!subscriber?.plan_expires_at && subscriber?.plan !== 'free',
        plano_ja_expirou: planExpirou,
        deveria_estar_free: planExpirou === true && subscriber?.plan !== 'free',
        tem_afiliado: conversions.length > 0,
        comissoes_ativas: commissionsEnriched.filter(c => c.status === 'pending' && !c.refunded_at).length,
        comissoes_pagas: commissionsEnriched.filter(c => c.status === 'paid').length,
        comissoes_refunded: commissionsEnriched.filter(c => c.refunded_at).length,
        webhooks_encontrados: webhooks.length,
        teve_subscription_deleted: webhooks.some(w => w.tipo === 'customer.subscription.deleted'),
        teve_subscription_updated: webhooks.some(w => w.tipo === 'customer.subscription.updated'),
        webhooks_com_erro: webhooks.filter(w => w.status === 'erro' || w.status === 'falha_permanente').length,
      };

      return res.status(200).json({
        email: emailParam,
        diagnostico: diag,
        subscriber,
        conversions,
        commissions: commissionsEnriched,
        webhooks,
      });
    } catch (e) {
      console.error('[admin check_cancelamento]', e.message);
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.method === 'GET' && action === 'stripe_webhooks') {
    try {
      const diaAtras = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

      // Ultimos 30 eventos (sem payload pra response enxuto)
      const listR = await fetch(
        `${SUPABASE_URL}/rest/v1/stripe_webhook_log?select=id,stripe_event_id,tipo,status,tentativas,ultimo_erro,processado_em,created_at&order=created_at.desc&limit=30`,
        { headers }
      );
      const list = listR.ok ? await listR.json() : [];

      // Counts
      async function count(query) {
        const r = await fetch(`${SUPABASE_URL}/rest/v1/stripe_webhook_log?select=id${query}`, {
          headers: { ...headers, Prefer: 'count=exact' },
        });
        const cr = r.headers.get('content-range') || '';
        return parseInt(cr.split('/')[1] || '0') || 0;
      }

      const [processados24h, concluidos24h, errosAtuais, processando, falhaPerm] = await Promise.all([
        count(`&created_at=gte.${diaAtras}`),
        count(`&created_at=gte.${diaAtras}&status=eq.concluido`),
        count(`&status=eq.erro`),
        count(`&status=eq.processando`),
        count(`&status=eq.falha_permanente`),
      ]);

      const ultimo = list[0];
      const agora = Date.now();
      const minutosUltimo = ultimo ? Math.round((agora - new Date(ultimo.created_at).getTime()) / 60000) : null;

      return res.status(200).json({
        stats: {
          processados_24h: processados24h,
          concluidos_24h: concluidos24h,
          erros_atuais: errosAtuais,
          processando: processando,
          falha_permanente: falhaPerm,
          ultimo_recebido_min: minutosUltimo,
        },
        events: list,
      });
    } catch (e) {
      console.error('[admin stripe_webhooks]', e.message);
      return res.status(500).json({ error: e.message });
    }
  }

  // ── TRIGGER REPROCESSAMENTO DE WEBHOOKS COM ERRO ─────────────────────────
  if (req.method === 'POST' && action === 'stripe_reprocess') {
    try {
      const SITE_URL = process.env.SITE_URL || 'https://bluetubeviral.com';
      const r = await fetch(`${SITE_URL}/api/webhook?action=reprocessar`, { method: 'GET' });
      const d = await r.json();
      return res.status(200).json({ ok: true, result: d });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── PAGINATED LIST SUBSCRIBERS ──────────────────────────────────────────
  if (req.method === 'GET' && action === 'list_subscribers') {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 10, 100);
    const search = req.query.search || '';
    const planFilter = req.query.plan || '';
    const offset = (page - 1) * limit;

    let url = `${SUPABASE_URL}/rest/v1/subscribers?select=*&order=created_at.desc&limit=${limit}&offset=${offset}`;
    if (search) url += `&email=ilike.*${encodeURIComponent(search)}*`;
    if (planFilter) url += `&plan=eq.${planFilter}`;

    const [dataRes, countRes] = await Promise.all([
      fetch(url, { headers }),
      fetch(`${SUPABASE_URL}/rest/v1/subscribers?select=id${search ? `&email=ilike.*${encodeURIComponent(search)}*` : ''}${planFilter ? `&plan=eq.${planFilter}` : ''}`, { headers: { ...headers, 'Prefer': 'count=exact' } })
    ]);

    const data = dataRes.ok ? await dataRes.json() : [];
    const totalHeader = countRes.headers?.get('content-range');
    const total = totalHeader ? parseInt(totalHeader.split('/')[1]) || data.length : data.length;

    return res.status(200).json({ data, total, page, pages: Math.ceil(total / limit), has_more: offset + limit < total });
  }

  // ── PAGINATED FEEDBACK ──────────────────────────────────────────────────
  if (req.method === 'GET' && action === 'list_feedback') {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 10, 50);
    const offset = (page - 1) * limit;
    const url = `${SUPABASE_URL}/rest/v1/user_feedback?select=*&order=created_at.desc&limit=${limit}&offset=${offset}`;
    const r = await fetch(url, { headers });
    const data = r.ok ? await r.json() : [];
    // Get total
    const cr = await fetch(`${SUPABASE_URL}/rest/v1/user_feedback?select=id`, { headers: { ...headers, 'Prefer': 'count=exact' } });
    const th = cr.headers?.get('content-range');
    const total = th ? parseInt(th.split('/')[1]) || 0 : data.length;
    return res.status(200).json({ data, total, page, pages: Math.ceil(total / limit), has_more: offset + limit < total });
  }

  // ── EMAIL MARKETING STATS ────────────────────────────────────────────────
  if (req.method === 'GET' && action === 'email_marketing_stats') {
    try {
      const [allRes, unsubRes] = await Promise.all([
        fetch(`${SUPABASE_URL}/rest/v1/email_marketing?select=email,total_sent,last_sent_at,unsubscribed,sequence_position&order=last_sent_at.desc.nullslast&limit=200`, { headers }),
        fetch(`${SUPABASE_URL}/rest/v1/email_marketing?unsubscribed=eq.true&select=email`, { headers }),
      ]);
      const all = allRes.ok ? await allRes.json() : [];
      const unsubs = unsubRes.ok ? await unsubRes.json() : [];
      const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
      const sentThisWeek = all.filter(e => e.last_sent_at && e.last_sent_at > weekAgo).length;
      const totalSent = all.reduce((s, e) => s + (e.total_sent || 0), 0);
      return res.status(200).json({
        total_list: all.length,
        total_unsubscribed: unsubs.length,
        unsub_rate: all.length > 0 ? ((unsubs.length / all.length) * 100).toFixed(1) : '0',
        sent_this_week: sentThisWeek,
        total_sent: totalSent,
        recent: all.filter(e => e.last_sent_at).slice(0, 10)
      });
    } catch (e) { return res.status(200).json({ error: e.message }); }
  }

  // ── REALTIME PULSE (lightweight, for 10s polling) ────────────────────────
  if (req.method === 'GET' && action === 'realtime_pulse') {
    try {
      const twoMinAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString();
      const [countRes, onlineRes, cancelRes, latestRes] = await Promise.all([
        fetch(`${SUPABASE_URL}/rest/v1/subscribers?select=id`, { headers: { ...headers, 'Prefer': 'count=exact' } }),
        fetch(`${SUPABASE_URL}/rest/v1/ip_online?pinged_at=gte.${twoMinAgo}&select=ip_address`, { headers }),
        fetch(`${SUPABASE_URL}/rest/v1/subscribers?plan=eq.free&stripe_customer_id=not.is.null&select=email,updated_at&order=updated_at.desc&limit=1`, { headers }),
        fetch(`${SUPABASE_URL}/rest/v1/subscribers?select=email&order=created_at.desc&limit=1`, { headers }),
      ]);
      const totalHeader = countRes.headers?.get('content-range');
      const total = totalHeader ? parseInt(totalHeader.split('/')[1]) || 0 : 0;
      const online = onlineRes.ok ? (await onlineRes.json()).length : 0;
      const cancel = cancelRes.ok ? (await cancelRes.json())[0] : null;
      const latest = latestRes.ok ? (await latestRes.json())[0] : null;
      return res.status(200).json({
        total,
        online_now: online,
        latest_email: latest?.email || null,
        latest_cancel_email: cancel?.email || null,
      });
    } catch(e) { return res.status(200).json({ total: 0, online_now: 0 }); }
  }

  // ── GET DASHBOARD DATA ────────────────────────────────────────────────────
  try {
    const today = new Date().toISOString().split('T')[0];
    const twoMinAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    // safeJson: always returns an array, never throws
    const safeJson = async (resPromise) => {
      try {
        const res = await resPromise;
        if (!res || !res.ok) return [];
        const data = await res.json();
        return Array.isArray(data) ? data : [];
      } catch(e) { return []; }
    };

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    // weeklyRaw saiu daqui — PostgREST cap server-side trunca em 1000 rows
    // ignorando &limit=10000. Substituido por 7 queries paralelas com
    // count=exact (Content-Range header), sem trazer rows. Bloco abaixo.
    const [subscribers, todayUsage, topVirals, feedbackRaw, visitsToday, onlineNow, bluescoreRaw, recentSubs] = await Promise.all([
      safeJson(fetch(`${SUPABASE_URL}/rest/v1/subscribers?select=*&order=created_at.desc`, { headers })),
      safeJson(fetch(`${SUPABASE_URL}/rest/v1/ip_usage?usage_date=eq.${today}&select=*&limit=10000`, { headers })),
      safeJson(fetch(`${SUPABASE_URL}/rest/v1/viral_shorts?select=video_id,copy_count,lang,processed_at&order=copy_count.desc&limit=10`, { headers })),
      safeJson(fetch(`${SUPABASE_URL}/rest/v1/user_feedback?select=*&order=created_at.desc&limit=50`, { headers })),
      safeJson(fetch(`${SUPABASE_URL}/rest/v1/ip_visits?visit_date=eq.${today}&select=ip_address&limit=10000`, { headers })),
      safeJson(fetch(`${SUPABASE_URL}/rest/v1/ip_online?pinged_at=gte.${twoMinAgo}&select=ip_address`, { headers })),
      safeJson(fetch(`${SUPABASE_URL}/rest/v1/bluescore_analyses?select=channel_name,score,classification,avg_views,analyzed_at&order=analyzed_at.desc&limit=20`, { headers })),
      safeJson(fetch(`${SUPABASE_URL}/rest/v1/subscribers?select=email,plan,created_at&order=created_at.desc&limit=10`, { headers })),
    ]);

    // Weekly visits — 7 queries paralelas count=exact (a prova de PostgREST cap)
    const _days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
      _days.push(d.toISOString().split('T')[0]);
    }
    const _countHeaders = { ...headers, 'Prefer': 'count=exact', 'Range': '0-0' };
    const weeklyVisits = await Promise.all(_days.map(async (date) => {
      try {
        const r = await fetch(`${SUPABASE_URL}/rest/v1/ip_visits?visit_date=eq.${date}&select=ip_address`, { headers: _countHeaders });
        const range = r.headers.get('content-range') || '';
        const total = parseInt(range.split('/')[1] || '0', 10);
        return { date, count: isNaN(total) ? 0 : total };
      } catch (e) { return { date, count: 0 }; }
    }));

    // Sort feedback
    const feedback = feedbackRaw.sort((a,b)=>{
      if(a.plan==='master'&&b.plan!=='master')return -1;
      if(b.plan==='master'&&a.plan!=='master')return 1;
      if(a.type==='support'&&b.type!=='support')return -1;
      if(b.type==='support'&&a.type!=='support')return 1;
      return new Date(b.created_at)-new Date(a.created_at);
    });

    const stats = {
      subscribers: {
        total: subscribers.length,
        free: subscribers.filter(s => s.plan === 'free').length,
        full: subscribers.filter(s => s.plan === 'full').length,
        master: subscribers.filter(s => s.plan === 'master').length,
        paying_full: subscribers.filter(s => s.plan === 'full' && !s.is_manual).length,
        paying_master: subscribers.filter(s => s.plan === 'master' && !s.is_manual).length,
        manual_full: subscribers.filter(s => s.plan === 'full' && s.is_manual).length,
        manual_master: subscribers.filter(s => s.plan === 'master' && s.is_manual).length,
        list: subscribers
      },
      revenue: await (async () => {
        // Stripe Brasil cartao de credito (padrao): 3.99% + R$ 0,39 por transacao mensal.
        // ASAAS R$ 1,99: taxa de SAQUE por afiliado que retira no dia 22 (uma vez por mes
        // por afiliado com saldo > 0), NAO por cada transacao de assinatura.
        const STRIPE_PCT = parseFloat(process.env.STRIPE_FEE_PCT || '0.0399');
        const STRIPE_FIXED = parseFloat(process.env.STRIPE_FEE_FIXED || '0.39');
        const ASAAS_WITHDRAW = parseFloat(process.env.ASAAS_FEE_FIXED || '1.99');

        const qtyFull = subscribers.filter(s => s.plan === 'full' && !s.is_manual).length;
        const qtyMaster = subscribers.filter(s => s.plan === 'master' && !s.is_manual).length;
        const qtyPaying = qtyFull + qtyMaster;
        const grossFull = +(qtyFull * 29.99).toFixed(2);
        const grossMaster = +(qtyMaster * 89.99).toFixed(2);
        const grossMrr = +(grossFull + grossMaster).toFixed(2);

        // Taxas Stripe: % + fixa por assinante
        const stripeFullFeePer = +(29.99 * STRIPE_PCT + STRIPE_FIXED).toFixed(2);
        const stripeMasterFeePer = +(89.99 * STRIPE_PCT + STRIPE_FIXED).toFixed(2);
        const stripeFees = +(qtyFull * stripeFullFeePer + qtyMaster * stripeMasterFeePer).toFixed(2);

        // ASAAS: 1 saque/mes por afiliado com saldo > 0.
        let activeAffiliates = 0;
        try {
          const rA = await fetch(
            `${SUPABASE_URL}/rest/v1/affiliates?select=id&or=(total_full.gt.0,total_master.gt.0)`,
            { headers: { ...supaHeaders, Prefer: 'count=exact', Range: '0-0' } }
          );
          if (rA.ok) {
            const m = (rA.headers.get('content-range') || '').match(/\/(\d+)$/);
            activeAffiliates = m ? parseInt(m[1], 10) : 0;
          }
        } catch(e) {}
        const asaasFees = +(activeAffiliates * ASAAS_WITHDRAW).toFixed(2);

        const totalFees = +(stripeFees + asaasFees).toFixed(2);
        const netMrr = +(grossMrr - totalFees).toFixed(2);
        const netFull = +(grossFull - (qtyFull * stripeFullFeePer)).toFixed(2);
        const netMaster = +(grossMaster - (qtyMaster * stripeMasterFeePer)).toFixed(2);

        return {
          // Bruto
          monthly_mrr: grossMrr,
          full_revenue: grossFull,
          master_revenue: grossMaster,
          // Liquido (apos taxas Stripe + ASAAS saques)
          net_monthly_mrr: netMrr,
          net_full_revenue: netFull,
          net_master_revenue: netMaster,
          // Breakdown das taxas
          stripe_fees: stripeFees,
          asaas_fees: asaasFees,
          total_fees: totalFees,
          active_affiliates: activeAffiliates,
          fees_config: {
            stripe_pct: STRIPE_PCT,
            stripe_fixed: STRIPE_FIXED,
            asaas_withdraw: ASAAS_WITHDRAW,
          },
        };
      })(),
      conversion: {
        total_free: subscribers.filter(s => s.plan === 'free').length,
        total_paying: subscribers.filter(s => s.plan !== 'free' && !s.is_manual).length,
        rate: subscribers.length > 0
          ? ((subscribers.filter(s => s.plan !== 'free' && !s.is_manual).length / subscribers.length) * 100).toFixed(1)
          : '0.0',
        // Churn: users who had a paid plan but are now free (have stripe_customer_id but plan=free)
        churned: subscribers.filter(s => s.plan === 'free' && s.stripe_customer_id).length,
        // Expired: paid plan but expired
        expired: subscribers.filter(s => s.plan !== 'free' && s.plan_expires_at && new Date(s.plan_expires_at) < new Date()).length,
      },
      today: {
        active_ips: todayUsage.length,
        total_scripts_generated: todayUsage.reduce((sum, r) => sum + (r.script_count || 0), 0),
        usage_breakdown: todayUsage
      },
      top_virals: topVirals,
      feedback,
      visits: {
        today_unique: visitsToday.length,
        online_now: onlineNow.length,
        weekly: weeklyVisits,
      },
      latest_subscriber: subscribers.filter(s => s.plan !== 'free' && !s.is_manual)[0] || null,
      latest_cancellation: (() => {
        try {
          return subscribers.filter(s => s.plan==='free' && s.stripe_customer_id && s.updated_at && s.created_at
            && (new Date(s.updated_at)-new Date(s.created_at)) > 3600000)
            .sort((a,b)=>new Date(b.updated_at||0)-new Date(a.updated_at||0))[0]||null;
        } catch(e){return null;}
      })(),
      latest_signup: recentSubs[0] || null, // último cadastro (qualquer plano)
      recent_signups: recentSubs, // últimos 10 cadastros
      bluescore: {
        total_analyses: bluescoreRaw.length,
        recent: bluescoreRaw,
        avg_score: bluescoreRaw.length > 0
          ? Math.round(bluescoreRaw.reduce((s,a) => s + (a.score||0), 0) / bluescoreRaw.length)
          : 0,
      },
    };

    return res.status(200).json(stats);
  } catch (err) {
    console.error('Admin error:', err);
    return res.status(500).json({ error: 'Failed to fetch admin data: ' + err.message });
  }
}

// ── SAQUES: painel admin + marcar pago manualmente ─────────────────────────
async function saquesPanelAction(req, res, { SUPABASE_URL, headers }) {
  // Fix 5 (Gap 3): chaves Pix em affiliate_saques sao encrypted at-rest.
  // Inline require pra seguir padrao existente em admin.js (linhas 77, 602, 1400).
  const { decryptSafe } = require('./_helpers/crypto.js');
  try {
    const VALOR_MINIMO = 50;
    const now = new Date();
    const mesStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

    // Commissions pending agrupadas por afiliado (pra calcular elegiveis + previsto)
    const cR = await fetch(
      `${SUPABASE_URL}/rest/v1/affiliate_commissions?status=eq.pending&select=affiliate_id,commission_amount`,
      { headers }
    );
    const pendings = cR.ok ? await cR.json() : [];
    const porAff = new Map();
    for (const p of pendings) {
      porAff.set(p.affiliate_id, (porAff.get(p.affiliate_id) || 0) + parseFloat(p.commission_amount || 0));
    }
    const elegiveis = Array.from(porAff.entries()).filter(([, v]) => v >= VALOR_MINIMO);
    const previsto = elegiveis.reduce((s, [, v]) => s + v, 0);

    // Saques deste mes
    const sR = await fetch(
      `${SUPABASE_URL}/rest/v1/affiliate_saques?solicitado_em=gte.${mesStart}&select=id,affiliate_id,valor,status,solicitado_em,pago_em,tipo_chave_pix,chave_pix,erro_mensagem&order=solicitado_em.desc&limit=200`,
      { headers }
    );
    const saques = sR.ok ? await sR.json() : [];
    const totalPago = saques.filter(s => s.status === 'pago').reduce((s, r) => s + parseFloat(r.valor || 0), 0);

    // Enriquece com email do afiliado
    const affIds = [...new Set(saques.map(s => s.affiliate_id))];
    let affByid = {};
    if (affIds.length) {
      const aR = await fetch(
        `${SUPABASE_URL}/rest/v1/affiliates?id=in.(${affIds.join(',')})&select=id,email,name,nivel`,
        { headers }
      );
      if (aR.ok) {
        (await aR.json()).forEach(a => { affByid[a.id] = a; });
      }
    }

    // Saldo ASAAS (se API key)
    let saldoAsaas = null, asaasStatus = 'nao_configurado';
    const ASAAS_KEY = process.env.ASAAS_API_KEY || '';
    if (ASAAS_KEY) {
      try {
        const ASAAS_URL = (process.env.ASAAS_ENVIRONMENT === 'production') ? 'https://api.asaas.com/v3' : 'https://sandbox.asaas.com/api/v3';
        const bR = await fetch(ASAAS_URL + '/finance/balance', { headers: { access_token: ASAAS_KEY } });
        if (bR.ok) {
          const bd = await bR.json();
          saldoAsaas = typeof bd.balance === 'number' ? bd.balance : null;
          asaasStatus = 'ok';
        } else { asaasStatus = 'erro'; }
      } catch (e) { asaasStatus = 'erro'; }
    }

    return res.status(200).json({
      total_mes: +totalPago.toFixed(2),
      afiliados_elegiveis: elegiveis.length,
      previsto_dia22: +previsto.toFixed(2),
      saldo_asaas: saldoAsaas,
      asaas_status: asaasStatus,
      alerta_saldo: (saldoAsaas !== null && saldoAsaas < previsto),
      saques: saques.map(s => ({
        id: s.id,
        valor: s.valor,
        status: s.status,
        solicitado_em: s.solicitado_em,
        pago_em: s.pago_em,
        erro: s.erro_mensagem,
        afiliado_email: affByid[s.affiliate_id]?.email || null,
        afiliado_nivel: affByid[s.affiliate_id]?.nivel || null,
        tipo_chave: s.tipo_chave_pix,
        // Fix 5: decrypt antes de retornar pro frontend admin (admin precisa
        // ver plaintext pra processar manualmente fora-de-banda quando ASAAS falha)
        chave: decryptSafe(s.chave_pix),
      })),
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

async function marcarSaquePagoAction(req, res, { SUPABASE_URL, headers }) {
  const { saque_id, asaas_transfer_id } = req.body || {};
  if (!saque_id) return res.status(400).json({ error: 'saque_id_obrigatorio' });
  try {
    // Busca saque + afiliado pra atualizar stats
    const sR = await fetch(`${SUPABASE_URL}/rest/v1/affiliate_saques?id=eq.${saque_id}&select=*&limit=1`, { headers });
    if (!sR.ok) return res.status(502).json({ error: 'erro_banco' });
    const [saque] = await sR.json();
    if (!saque) return res.status(404).json({ error: 'saque_nao_encontrado' });

    await fetch(`${SUPABASE_URL}/rest/v1/affiliate_saques?id=eq.${saque_id}`, {
      method: 'PATCH',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status: 'pago',
        asaas_transfer_id: asaas_transfer_id || saque.asaas_transfer_id || 'manual',
        pago_em: new Date().toISOString(),
      }),
    });

    // Atualiza afiliado
    const aR = await fetch(`${SUPABASE_URL}/rest/v1/affiliates?id=eq.${saque.affiliate_id}&select=*&limit=1`, { headers });
    const [afiliado] = aR.ok ? await aR.json() : [];
    if (afiliado) {
      await fetch(`${SUPABASE_URL}/rest/v1/affiliates?id=eq.${afiliado.id}`, {
        method: 'PATCH',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ultimo_saque_em: new Date().toISOString(),
          total_sacado: parseFloat(afiliado.total_sacado || 0) + parseFloat(saque.valor || 0),
          saldo_disponivel: 0,
          updated_at: new Date().toISOString(),
        }),
      });
      // Marca commissions pending como paid
      await fetch(`${SUPABASE_URL}/rest/v1/affiliate_commissions?affiliate_id=eq.${afiliado.id}&status=eq.pending`, {
        method: 'PATCH',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'paid' }),
      });
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

// ── DETECTAR COMMISSIONS DUPLICADAS ─────────────────────────────────────────
// Retorna grupos de commissions pending|paid que violam a regra:
// "1 commission por afiliado+subscriber+plan+mes".
// A constraint UNIQUE do banco agora impede novas duplicatas, mas esse
// endpoint serve pra auditar historico (pre-constraint) e confirmar saneamento.
async function detectarCommissionsDuplicadasAction(req, res, { SUPABASE_URL, headers }) {
  try {
    // Puxa todas as commissions pending/paid com info do afiliado
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/affiliate_commissions?status=in.(pending,paid)&select=id,affiliate_id,subscriber_email,plan,commission_amount,status,period_start,created_at&order=created_at.desc&limit=5000`,
      { headers }
    );
    if (!r.ok) return res.status(502).json({ error: 'erro_query_commissions' });
    const rows = await r.json();

    // Agrupa por (affiliate_id, subscriber_email, plan, ano-mes do period_start)
    const grupos = new Map();
    for (const c of rows) {
      const d = new Date(c.period_start);
      const mesKey = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
      const key = `${c.affiliate_id}|${(c.subscriber_email || '').toLowerCase()}|${c.plan}|${mesKey}`;
      if (!grupos.has(key)) grupos.set(key, []);
      grupos.get(key).push(c);
    }

    // Mantem so grupos com 2+ entries
    const duplicados = [];
    for (const [key, items] of grupos.entries()) {
      if (items.length < 2) continue;
      const [affiliate_id, subscriber_email, plan, mes] = key.split('|');
      duplicados.push({
        affiliate_id, subscriber_email, plan, mes,
        qtd: items.length,
        total_valor: +items.reduce((s, i) => s + parseFloat(i.commission_amount || 0), 0).toFixed(2),
        commissions: items.map(i => ({
          id: i.id, status: i.status, commission_amount: parseFloat(i.commission_amount),
          created_at: i.created_at,
        })),
      });
    }

    // Enriquece com email do afiliado
    const affIds = [...new Set(duplicados.map(d => d.affiliate_id))];
    if (affIds.length) {
      const ar = await fetch(
        `${SUPABASE_URL}/rest/v1/affiliates?id=in.(${affIds.join(',')})&select=id,email`,
        { headers }
      );
      if (ar.ok) {
        const byId = Object.fromEntries((await ar.json()).map(a => [a.id, a.email]));
        duplicados.forEach(d => { d.afiliado_email = byId[d.affiliate_id] || '(desconhecido)'; });
      }
    }

    return res.status(200).json({
      ok: true,
      total_grupos_duplicados: duplicados.length,
      total_commissions_excedentes: duplicados.reduce((s, d) => s + (d.qtd - 1), 0),
      duplicados: duplicados.sort((a, b) => b.qtd - a.qtd || b.total_valor - a.total_valor),
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

// ── CANCELAR COMMISSION (uso manual pra limpar duplicatas detectadas) ──────
async function cancelarCommissionAction(req, res, { SUPABASE_URL, headers }) {
  const { commission_id, motivo } = req.body || {};
  if (!commission_id) return res.status(400).json({ error: 'commission_id obrigatorio' });

  try {
    // Pega commission atual
    const cr = await fetch(
      `${SUPABASE_URL}/rest/v1/affiliate_commissions?id=eq.${commission_id}&select=*`,
      { headers }
    );
    if (!cr.ok) return res.status(502).json({ error: 'erro_buscar_commission' });
    const [commission] = await cr.json();
    if (!commission) return res.status(404).json({ error: 'commission_nao_encontrada' });

    if (commission.status === 'cancelled') {
      return res.status(200).json({ ok: true, ja_cancelada: true, commission_id });
    }

    const prevStatus = commission.status;
    const valor = parseFloat(commission.commission_amount || 0);

    // Append no history
    const history = Array.isArray(commission.commission_history) ? commission.commission_history : [];
    history.push({
      at: new Date().toISOString(),
      source: 'admin_cancel',
      prev_status: prevStatus,
      motivo: motivo || 'cancelamento manual pelo admin',
    });

    // PATCH commission -> cancelled
    const patchR = await fetch(
      `${SUPABASE_URL}/rest/v1/affiliate_commissions?id=eq.${commission_id}`,
      {
        method: 'PATCH',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: 'cancelled',
          commission_history: history,
        }),
      }
    );
    if (!patchR.ok) return res.status(502).json({ error: 'erro_cancelar' });

    // Se estava em pending/paid, decrementa total_earnings do afiliado
    if (prevStatus === 'pending' || prevStatus === 'paid') {
      const ar = await fetch(
        `${SUPABASE_URL}/rest/v1/affiliates?id=eq.${commission.affiliate_id}&select=total_earnings`,
        { headers }
      );
      if (ar.ok) {
        const [af] = await ar.json();
        if (af) {
          const novoEarnings = Math.max(0, parseFloat(af.total_earnings || 0) - valor);
          await fetch(
            `${SUPABASE_URL}/rest/v1/affiliates?id=eq.${commission.affiliate_id}`,
            {
              method: 'PATCH',
              headers: { ...headers, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                total_earnings: parseFloat(novoEarnings.toFixed(2)),
                updated_at: new Date().toISOString(),
              }),
            }
          );
        }
      }
    }

    return res.status(200).json({
      ok: true,
      commission_id,
      prev_status: prevStatus,
      valor_subtraido: prevStatus === 'pending' || prevStatus === 'paid' ? valor : 0,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

// ── RECUPERAR PAGAMENTO NAO ATIVADO ────────────────────────────────────────
// Busca na API Stripe POR EMAIL sem limite temporal, ativa o plano se achar
// session paid. Usado quando webhook falhou e o cron payment-monitor (que so
// cobre 15min) deixou o user ficar preso em free.
//
// Fluxo:
//   1. stripe.customers.list({ email }) — pega todos os customer_id desse email
//   2. Pra cada customer, stripe.checkout.sessions.list({ customer })
//   3. Filtra sessions com payment_status='paid' + metadata.plan != free
//   4. Pega a sessao mais recente, ativa no DB igual ao webhook faz
//   5. Dispara upgradeEmail (fire-and-forget)
async function recuperarPagamentoAction(req, res, { SUPABASE_URL, headers, email }) {
  const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY;
  if (!STRIPE_SECRET) return res.status(500).json({ error: 'STRIPE_SECRET_KEY nao configurado' });

  try {
    // 1. Procura customers com esse email no Stripe
    const custR = await fetch(
      `https://api.stripe.com/v1/customers?email=${encodeURIComponent(email)}&limit=10`,
      { headers: { Authorization: `Bearer ${STRIPE_SECRET}` } }
    );
    if (!custR.ok) {
      const t = await custR.text();
      return res.status(502).json({ error: 'stripe_customers_fail', detail: t.slice(0, 200) });
    }
    const custData = await custR.json();
    const customers = custData.data || [];
    if (!customers.length) {
      return res.status(404).json({ error: 'sem_customer_stripe', mensagem: 'Nao existe customer com esse email no Stripe.' });
    }

    // 2. Pra cada customer, busca sessions completadas
    const allSessions = [];
    for (const cust of customers) {
      const sR = await fetch(
        `https://api.stripe.com/v1/checkout/sessions?customer=${cust.id}&limit=20`,
        { headers: { Authorization: `Bearer ${STRIPE_SECRET}` } }
      );
      if (!sR.ok) continue;
      const sData = await sR.json();
      (sData.data || []).forEach((s) => allSessions.push({ ...s, _customer: cust }));
    }

    // 3. Filtra sessions pagas com plano valido
    const paidSessions = allSessions
      .filter((s) => s.payment_status === 'paid' && s.status === 'complete')
      .filter((s) => {
        const p = s.metadata?.plan;
        return p && p !== 'free';
      })
      .sort((a, b) => (b.created || 0) - (a.created || 0));

    if (!paidSessions.length) {
      return res.status(404).json({
        error: 'sem_session_paga',
        mensagem: 'Customers existem no Stripe mas nenhum tem session paga com plano nao-free.',
        customers_encontrados: customers.length,
        sessions_totais: allSessions.length,
      });
    }

    // 4. Pega a mais recente e ativa
    const session = paidSessions[0];
    const plan = session.metadata.plan;
    const billing = session.metadata.billing || 'monthly';
    const expiresAt = billing === 'annual'
      ? new Date(Date.now() + 366 * 24 * 60 * 60 * 1000).toISOString()
      : new Date(Date.now() + 37 * 24 * 60 * 60 * 1000).toISOString();

    const payload = {
      plan,
      is_manual: false, // NAO eh manual — foi pago de verdade
      stripe_customer_id: session.customer,
      stripe_subscription_id: session.subscription || null,
      plan_expires_at: expiresAt,
      updated_at: new Date().toISOString(),
    };

    // Tenta PATCH (existe) -> fallback POST (nao existe)
    const patchR = await fetch(
      `${SUPABASE_URL}/rest/v1/subscribers?email=eq.${encodeURIComponent(email)}`,
      { method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json', Prefer: 'return=representation' }, body: JSON.stringify(payload) }
    );
    const patchData = await patchR.json();
    let criado = false;
    if (Array.isArray(patchData) && patchData.length === 0) {
      await fetch(`${SUPABASE_URL}/rest/v1/subscribers`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({ email, ...payload, created_at: new Date().toISOString() }),
      });
      criado = true;
    }

    // 5. Dispara upgrade email (fire-and-forget)
    try {
      const { sendUpgradeEmail } = require('./_helpers/upgradeEmail.js');
      sendUpgradeEmail(email, plan, billing).catch((e) => console.error('upgradeEmail (recuperar):', e.message));
    } catch (e) { console.error('upgradeEmail import (recuperar):', e.message); }

    // Log da recuperacao pra auditoria
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/payment_logs`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({
          stripe_session_id: session.id,
          user_email: email,
          plan,
          amount: session.amount_total ? (session.amount_total / 100).toFixed(2) : null,
          status: 'recuperado_manual',
          note: `Recuperado via admin. Session paga em ${new Date(session.created * 1000).toISOString()}. Delay: ${Math.round((Date.now() - session.created * 1000) / 3600000)}h`,
          created_at: new Date().toISOString(),
        }),
      });
    } catch (e) {}

    return res.status(200).json({
      ok: true,
      email,
      plan,
      billing,
      criado_novo_registro: criado,
      session_id: session.id,
      session_paga_em: new Date(session.created * 1000).toISOString(),
      delay_horas: Math.round((Date.now() - session.created * 1000) / 3600000),
      plan_expires_at: expiresAt,
    });
  } catch (e) {
    console.error('[recuperar-pagamento]', e);
    return res.status(500).json({ error: e.message });
  }
}
