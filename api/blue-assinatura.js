// api/blue-assinatura.js — Assinatura de canal de criadores
// CommonJS

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const SU = process.env.SUPABASE_URL;
  const SK = process.env.SUPABASE_SERVICE_KEY;
  const AK = process.env.SUPABASE_ANON_KEY || SK;
  const STRIPE_KEY = process.env.STRIPE_SECRET_KEY;
  if (!SU || !SK) return res.status(500).json({ error: 'Config missing' });

  const h = { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' };
  const action = req.method === 'GET' ? req.query.action : (req.body && req.body.action);

  async function getUser(token) {
    if (!token) return null;
    const r = await fetch(`${SU}/auth/v1/user`, { headers: { apikey: AK, Authorization: 'Bearer ' + token } });
    return r.ok ? await r.json() : null;
  }

  async function stripePost(path, params) {
    if (!STRIPE_KEY) throw new Error('Stripe não configurado');
    const r = await fetch('https://api.stripe.com/v1' + path, {
      method: 'POST',
      headers: { Authorization: 'Basic ' + Buffer.from(STRIPE_KEY + ':').toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString()
    });
    return r.json();
  }

  // ── CRIAR PLANO ─────────────────────────────────────────────────────────
  if (req.method === 'POST' && action === 'criar-plano') {
    const { token, nome, preco, beneficios } = req.body;
    const user = await getUser(token);
    if (!user) return res.status(401).json({ error: 'Token inválido' });
    if (!nome || !preco) return res.status(400).json({ error: 'Nome e preço obrigatórios' });

    try {
      let stripePriceId = null;
      if (STRIPE_KEY) {
        // Check creator has Stripe Connect
        const aR = await fetch(`${SU}/rest/v1/blue_creator_accounts?user_id=eq.${user.id}&select=stripe_account_id,stripe_onboarding_completo`, { headers: h });
        const acc = aR.ok ? (await aR.json())[0] : null;
        if (!acc?.stripe_onboarding_completo) return res.status(400).json({ error: 'Configure sua conta de pagamento primeiro em Monetização' });

        const price = await stripePost('/prices', {
          'unit_amount': Math.round(parseFloat(preco) * 100),
          'currency': 'brl',
          'recurring[interval]': 'month',
          'product_data[name]': 'Assinatura: ' + nome,
          'product_data[metadata][creator_id]': user.id,
        });
        if (price.id) stripePriceId = price.id;
      }

      const pR = await fetch(`${SU}/rest/v1/blue_canal_planos`, {
        method: 'POST', headers: { ...h, 'Prefer': 'return=representation' },
        body: JSON.stringify({
          creator_id: user.id, nome, preco: parseFloat(preco),
          beneficios: beneficios || [], stripe_price_id: stripePriceId
        })
      });
      const plano = pR.ok ? (await pR.json())[0] : null;
      return res.status(200).json({ ok: true, plano });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  // ── PLANOS DO CANAL ─────────────────────────────────────────────────────
  if (action === 'planos-do-canal') {
    const { creator_id, username } = req.query;
    try {
      let cid = creator_id;
      if (!cid && username) {
        const pR = await fetch(`${SU}/rest/v1/blue_profiles?username=eq.${encodeURIComponent(username)}&select=user_id`, { headers: h });
        cid = pR.ok ? (await pR.json())[0]?.user_id : null;
      }
      if (!cid) return res.status(200).json({ planos: [] });
      const r = await fetch(`${SU}/rest/v1/blue_canal_planos?creator_id=eq.${cid}&order=preco.asc&select=*`, { headers: h });
      return res.status(200).json({ planos: r.ok ? await r.json() : [] });
    } catch(e) { return res.status(200).json({ planos: [] }); }
  }

  // ── ASSINAR CANAL ───────────────────────────────────────────────────────
  if (req.method === 'POST' && action === 'assinar') {
    const { token, plano_id } = req.body;
    const user = await getUser(token);
    if (!user) return res.status(401).json({ error: 'Token inválido' });
    if (!STRIPE_KEY) return res.status(500).json({ error: 'Stripe não configurado' });

    try {
      const plR = await fetch(`${SU}/rest/v1/blue_canal_planos?id=eq.${plano_id}&select=*`, { headers: h });
      const plano = plR.ok ? (await plR.json())[0] : null;
      if (!plano) return res.status(404).json({ error: 'Plano não encontrado' });

      // Check if already subscribed
      const eR = await fetch(`${SU}/rest/v1/blue_canal_assinaturas?plano_id=eq.${plano_id}&assinante_id=eq.${user.id}&status=eq.ativa&select=id`, { headers: h });
      if (eR.ok && (await eR.json()).length) return res.status(200).json({ ok: true, already: true });

      // Get creator's Stripe Connect
      const aR = await fetch(`${SU}/rest/v1/blue_creator_accounts?user_id=eq.${plano.creator_id}&select=stripe_account_id`, { headers: h });
      const acc = aR.ok ? (await aR.json())[0] : null;

      // Create PaymentIntent for first month
      const amount = Math.round(plano.preco * 100);
      const params = {
        amount: String(amount),
        currency: 'brl',
        'payment_method_types[]': 'card',
        'metadata[type]': 'blue_assinatura',
        'metadata[plano_id]': plano_id,
        'metadata[assinante_id]': user.id,
        'metadata[creator_id]': plano.creator_id,
      };
      if (acc?.stripe_account_id) {
        params['transfer_data[destination]'] = acc.stripe_account_id;
        params['transfer_data[amount]'] = String(Math.round(amount * 0.80)); // 80% to creator
      }
      const pi = await stripePost('/payment_intents', params);
      if (pi.error) return res.status(500).json({ error: 'Erro Stripe: ' + pi.error.message });

      // Create pending subscription
      await fetch(`${SU}/rest/v1/blue_canal_assinaturas`, {
        method: 'POST', headers: { ...h, 'Prefer': 'return=minimal' },
        body: JSON.stringify({ plano_id, assinante_id: user.id, stripe_subscription_id: pi.id, status: 'pendente' })
      });

      // Notify creator
      const uname = user.email?.split('@')[0] || 'Alguém';
      fetch(`${SU}/rest/v1/blue_notificacoes`, { method: 'POST', headers: { ...h, 'Prefer': 'return=minimal' },
        body: JSON.stringify({ user_id: plano.creator_id, tipo: 'assinatura', titulo: '⭐ Novo assinante!', mensagem: `@${uname} assinou seu canal!` })
      }).catch(() => {});

      return res.status(200).json({ client_secret: pi.client_secret, plano, valor: plano.preco });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  // ── CANCELAR ASSINATURA ─────────────────────────────────────────────────
  if (req.method === 'POST' && action === 'cancelar') {
    const { token, plano_id } = req.body;
    const user = await getUser(token);
    if (!user) return res.status(401).json({ error: 'Token inválido' });
    try {
      await fetch(`${SU}/rest/v1/blue_canal_assinaturas?plano_id=eq.${plano_id}&assinante_id=eq.${user.id}&status=eq.ativa`, {
        method: 'PATCH', headers: { ...h, 'Prefer': 'return=minimal' },
        body: JSON.stringify({ status: 'cancelada', cancelado_em: new Date().toISOString() })
      });
      // Decrement count
      const plR = await fetch(`${SU}/rest/v1/blue_canal_planos?id=eq.${plano_id}&select=assinantes`, { headers: h });
      const pl = plR.ok ? (await plR.json())[0] : null;
      if (pl) fetch(`${SU}/rest/v1/blue_canal_planos?id=eq.${plano_id}`, { method: 'PATCH', headers: { ...h, 'Prefer': 'return=minimal' },
        body: JSON.stringify({ assinantes: Math.max(0, (pl.assinantes || 0) - 1) }) }).catch(() => {});
      return res.status(200).json({ ok: true });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  // ── MEUS ASSINANTES (criador) ───────────────────────────────────────────
  if (action === 'meus-assinantes') {
    const user = await getUser(req.query.token);
    if (!user) return res.status(401).json({ error: 'Token inválido' });
    try {
      const plR = await fetch(`${SU}/rest/v1/blue_canal_planos?creator_id=eq.${user.id}&select=id,nome,preco,assinantes`, { headers: h });
      const planos = plR.ok ? await plR.json() : [];
      if (!planos.length) return res.status(200).json({ planos: [], assinantes: [] });
      const plIds = planos.map(p => p.id);
      const aR = await fetch(`${SU}/rest/v1/blue_canal_assinaturas?plano_id=in.(${plIds.join(',')})&status=eq.ativa&order=created_at.desc&select=*`, { headers: h });
      const assinaturas = aR.ok ? await aR.json() : [];
      const uIds = assinaturas.map(a => a.assinante_id);
      let profiles = {};
      if (uIds.length) {
        const pR = await fetch(`${SU}/rest/v1/blue_profiles?user_id=in.(${uIds.join(',')})&select=user_id,username,display_name,avatar_url`, { headers: h });
        if (pR.ok) (await pR.json()).forEach(p => { profiles[p.user_id] = p; });
      }
      return res.status(200).json({
        planos,
        assinantes: assinaturas.map(a => ({ ...a, profile: profiles[a.assinante_id] || null })),
        total_mrr: planos.reduce((s, p) => s + p.preco * (p.assinantes || 0), 0)
      });
    } catch(e) { return res.status(200).json({ planos: [], assinantes: [] }); }
  }

  // ── MINHAS ASSINATURAS ──────────────────────────────────────────────────
  if (action === 'minhas-assinaturas') {
    const user = await getUser(req.query.token);
    if (!user) return res.status(401).json({ error: 'Token inválido' });
    try {
      const aR = await fetch(`${SU}/rest/v1/blue_canal_assinaturas?assinante_id=eq.${user.id}&status=eq.ativa&select=*`, { headers: h });
      const subs = aR.ok ? await aR.json() : [];
      if (!subs.length) return res.status(200).json({ assinaturas: [] });
      const plIds = subs.map(s => s.plano_id);
      const plR = await fetch(`${SU}/rest/v1/blue_canal_planos?id=in.(${plIds.join(',')})&select=*`, { headers: h });
      const planos = plR.ok ? await plR.json() : [];
      const plMap = {}; planos.forEach(p => { plMap[p.id] = p; });
      return res.status(200).json({ assinaturas: subs.map(s => ({ ...s, plano: plMap[s.plano_id] || null })) });
    } catch(e) { return res.status(200).json({ assinaturas: [] }); }
  }

  return res.status(404).json({ error: 'Action não encontrada' });
};
