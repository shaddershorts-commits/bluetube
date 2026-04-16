// api/blue-shop.js — Blue Shop: produtos digitais + checkout
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

  // ── CRIAR PRODUTO ───────────────────────────────────────────────────────
  if (req.method === 'POST' && action === 'criar-produto') {
    const { token, nome, descricao, preco, tipo, imagens } = req.body;
    const user = await getUser(token);
    if (!user) return res.status(401).json({ error: 'Token inválido' });
    if (!nome || !preco) return res.status(400).json({ error: 'Nome e preço obrigatórios' });

    try {
      let stripePriceId = null;
      if (STRIPE_KEY) {
        const price = await stripePost('/prices', {
          'unit_amount': Math.round(parseFloat(preco) * 100),
          'currency': 'brl',
          'product_data[name]': nome,
          'product_data[metadata][creator_id]': user.id,
        });
        if (price.id) stripePriceId = price.id;
      }

      const pR = await fetch(`${SU}/rest/v1/blue_produtos`, {
        method: 'POST', headers: { ...h, 'Prefer': 'return=representation' },
        body: JSON.stringify({
          creator_id: user.id, nome, descricao: descricao || '',
          preco: parseFloat(preco), tipo: tipo || 'digital',
          imagens: imagens || [], stripe_price_id: stripePriceId
        })
      });
      const produto = pR.ok ? (await pR.json())[0] : null;
      return res.status(200).json({ ok: true, produto });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  // ── LOJA DO CRIADOR (pública) ───────────────────────────────────────────
  if (action === 'loja') {
    const { creator_id, username } = req.query;
    try {
      let cid = creator_id;
      if (!cid && username) {
        const pR = await fetch(`${SU}/rest/v1/blue_profiles?username=eq.${encodeURIComponent(username)}&select=user_id`, { headers: h });
        const p = pR.ok ? (await pR.json())[0] : null;
        cid = p?.user_id;
      }
      if (!cid) return res.status(200).json({ produtos: [] });
      const r = await fetch(`${SU}/rest/v1/blue_produtos?creator_id=eq.${cid}&ativo=eq.true&order=created_at.desc&select=*`, { headers: h });
      return res.status(200).json({ produtos: r.ok ? await r.json() : [] });
    } catch(e) { return res.status(200).json({ produtos: [] }); }
  }

  // ── COMPRAR PRODUTO ─────────────────────────────────────────────────────
  if (req.method === 'POST' && action === 'comprar') {
    const { token, produto_id } = req.body;
    const user = await getUser(token);
    if (!user) return res.status(401).json({ error: 'Token inválido' });
    if (!STRIPE_KEY) return res.status(500).json({ error: 'Stripe não configurado' });

    try {
      const pR = await fetch(`${SU}/rest/v1/blue_produtos?id=eq.${produto_id}&ativo=eq.true&select=*`, { headers: h });
      const produto = pR.ok ? (await pR.json())[0] : null;
      if (!produto) return res.status(404).json({ error: 'Produto não encontrado' });

      // Get creator's Stripe Connect account
      const aR = await fetch(`${SU}/rest/v1/blue_creator_accounts?user_id=eq.${produto.creator_id}&select=stripe_account_id`, { headers: h });
      const account = aR.ok ? (await aR.json())[0] : null;
      const destAccount = account?.stripe_account_id;

      const amount = Math.round(produto.preco * 100);
      const params = {
        amount: String(amount),
        currency: 'brl',
        'payment_method_types[]': 'card',
        'metadata[type]': 'blue_shop',
        'metadata[produto_id]': produto_id,
        'metadata[comprador_id]': user.id,
        'metadata[creator_id]': produto.creator_id,
      };
      // Transfer 70% to creator if they have Stripe Connect
      if (destAccount) {
        params.transfer_data_destination = destAccount;
        params['transfer_data[destination]'] = destAccount;
        params['transfer_data[amount]'] = String(Math.round(amount * 0.70));
      }

      const pi = await stripePost('/payment_intents', params);
      if (pi.error) return res.status(500).json({ error: 'Erro Stripe: ' + pi.error.message });

      // Create pending order
      await fetch(`${SU}/rest/v1/blue_pedidos`, {
        method: 'POST', headers: { ...h, 'Prefer': 'return=minimal' },
        body: JSON.stringify({ comprador_id: user.id, produto_id, valor: produto.preco, status: 'pendente', stripe_payment_id: pi.id })
      });

      return res.status(200).json({ client_secret: pi.client_secret, produto, valor: produto.preco });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  // ── CONFIRMAR COMPRA (chamado por webhook) ──────────────────────────────
  if (req.method === 'POST' && action === 'confirmar-compra') {
    const { payment_id, produto_id } = req.body;
    if (!payment_id) return res.status(400).json({ error: 'payment_id obrigatório' });
    try {
      await fetch(`${SU}/rest/v1/blue_pedidos?stripe_payment_id=eq.${payment_id}`, {
        method: 'PATCH', headers: { ...h, 'Prefer': 'return=minimal' },
        body: JSON.stringify({ status: 'pago' })
      });
      if (produto_id) {
        const pR = await fetch(`${SU}/rest/v1/blue_produtos?id=eq.${produto_id}&select=vendas`, { headers: h });
        const p = pR.ok ? (await pR.json())[0] : null;
        if (p) fetch(`${SU}/rest/v1/blue_produtos?id=eq.${produto_id}`, { method: 'PATCH', headers: { ...h, 'Prefer': 'return=minimal' },
          body: JSON.stringify({ vendas: (p.vendas || 0) + 1 }) }).catch(() => {});
      }
      return res.status(200).json({ ok: true });
    } catch(e) { return res.status(200).json({ ok: false }); }
  }

  // ── MEUS PRODUTOS (criador) ─────────────────────────────────────────────
  if (action === 'meus-produtos') {
    const user = await getUser(req.query.token);
    if (!user) return res.status(401).json({ error: 'Token inválido' });
    try {
      const r = await fetch(`${SU}/rest/v1/blue_produtos?creator_id=eq.${user.id}&order=created_at.desc&select=*`, { headers: h });
      return res.status(200).json({ produtos: r.ok ? await r.json() : [] });
    } catch(e) { return res.status(200).json({ produtos: [] }); }
  }

  // ── MINHAS COMPRAS ──────────────────────────────────────────────────────
  if (action === 'minhas-compras') {
    const user = await getUser(req.query.token);
    if (!user) return res.status(401).json({ error: 'Token inválido' });
    try {
      const oR = await fetch(`${SU}/rest/v1/blue_pedidos?comprador_id=eq.${user.id}&status=eq.pago&order=created_at.desc&limit=30&select=*`, { headers: h });
      const orders = oR.ok ? await oR.json() : [];
      if (!orders.length) return res.status(200).json({ compras: [] });
      const pIds = orders.map(o => o.produto_id);
      const pR = await fetch(`${SU}/rest/v1/blue_produtos?id=in.(${pIds.join(',')})&select=id,nome,descricao,preco,imagens,creator_id`, { headers: h });
      const prods = pR.ok ? await pR.json() : [];
      const prodMap = {}; prods.forEach(p => { prodMap[p.id] = p; });
      return res.status(200).json({ compras: orders.map(o => ({ ...o, produto: prodMap[o.produto_id] || null })) });
    } catch(e) { return res.status(200).json({ compras: [] }); }
  }

  return res.status(404).json({ error: 'Action não encontrada' });
};
