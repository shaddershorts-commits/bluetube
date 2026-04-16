// api/blue-coins.js — Saldo, compra e histórico de BlueCoins
// CommonJS

const PACOTES = {
  starter:  { coins: 100,  preco: 499,  label: '100 coins' },
  popular:  { coins: 500,  preco: 1999, label: '500 coins' },
  premium:  { coins: 1200, preco: 3999, label: '1.200 coins' },
  elite:    { coins: 3000, preco: 8999, label: '3.000 coins' },
};

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

  // ── SALDO ───────────────────────────────────────────────────────────────
  if (action === 'saldo') {
    const user = await getUser(req.query.token);
    if (!user) return res.status(401).json({ error: 'Token inválido' });
    try {
      const r = await fetch(`${SU}/rest/v1/blue_bluecoins?user_id=eq.${user.id}&select=saldo,total_comprado,total_gasto`, { headers: h });
      const rows = r.ok ? await r.json() : [];
      if (!rows.length) {
        // Auto-create
        await fetch(`${SU}/rest/v1/blue_bluecoins`, { method: 'POST', headers: { ...h, 'Prefer': 'resolution=ignore,return=minimal' },
          body: JSON.stringify({ user_id: user.id, saldo: 0 })
        });
        return res.status(200).json({ saldo: 0, total_comprado: 0, total_gasto: 0 });
      }
      return res.status(200).json(rows[0]);
    } catch(e) { return res.status(200).json({ saldo: 0 }); }
  }

  // ── COMPRAR COINS ───────────────────────────────────────────────────────
  if (req.method === 'POST' && action === 'comprar') {
    const { token, pacote } = req.body;
    const user = await getUser(token);
    if (!user) return res.status(401).json({ error: 'Token inválido' });
    if (!STRIPE_KEY) return res.status(500).json({ error: 'Stripe não configurado' });

    const pkg = PACOTES[pacote];
    if (!pkg) return res.status(400).json({ error: 'Pacote inválido', pacotes: Object.keys(PACOTES) });

    try {
      const params = new URLSearchParams();
      params.append('amount', pkg.preco);
      params.append('currency', 'brl');
      params.append('payment_method_types[]', 'card');
      params.append('metadata[type]', 'bluecoins');
      params.append('metadata[user_id]', user.id);
      params.append('metadata[pacote]', pacote);
      params.append('metadata[coins]', pkg.coins);

      const r = await fetch('https://api.stripe.com/v1/payment_intents', {
        method: 'POST',
        headers: { Authorization: 'Basic ' + Buffer.from(STRIPE_KEY + ':').toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString()
      });
      const pi = await r.json();
      if (!r.ok) return res.status(500).json({ error: 'Erro Stripe: ' + (pi.error?.message || 'unknown') });

      return res.status(200).json({ client_secret: pi.client_secret, pacote, coins: pkg.coins, valor: (pkg.preco / 100).toFixed(2) });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  // ── CONFIRMAR COMPRA (chamado por webhook ou manualmente) ───────────────
  if (req.method === 'POST' && action === 'confirmar') {
    const { user_id, coins, pacote } = req.body;
    if (!user_id || !coins) return res.status(400).json({ error: 'user_id e coins obrigatórios' });
    try {
      const bR = await fetch(`${SU}/rest/v1/blue_bluecoins?user_id=eq.${user_id}&select=saldo,total_comprado`, { headers: h });
      const rows = bR.ok ? await bR.json() : [];
      if (rows.length) {
        await fetch(`${SU}/rest/v1/blue_bluecoins?user_id=eq.${user_id}`, { method: 'PATCH', headers: { ...h, 'Prefer': 'return=minimal' },
          body: JSON.stringify({ saldo: (rows[0].saldo || 0) + parseInt(coins), total_comprado: (rows[0].total_comprado || 0) + parseInt(coins), updated_at: new Date().toISOString() })
        });
      } else {
        await fetch(`${SU}/rest/v1/blue_bluecoins`, { method: 'POST', headers: { ...h, 'Prefer': 'return=minimal' },
          body: JSON.stringify({ user_id, saldo: parseInt(coins), total_comprado: parseInt(coins) })
        });
      }
      await fetch(`${SU}/rest/v1/blue_bluecoins_transacoes`, { method: 'POST', headers: { ...h, 'Prefer': 'return=minimal' },
        body: JSON.stringify({ user_id, tipo: 'compra', quantidade: parseInt(coins), descricao: `Compra: ${pacote || coins + ' coins'}` })
      });
      return res.status(200).json({ ok: true });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  // ── HISTÓRICO ───────────────────────────────────────────────────────────
  if (action === 'historico') {
    const user = await getUser(req.query.token);
    if (!user) return res.status(401).json({ error: 'Token inválido' });
    try {
      const r = await fetch(`${SU}/rest/v1/blue_bluecoins_transacoes?user_id=eq.${user.id}&order=created_at.desc&limit=20&select=*`, { headers: h });
      return res.status(200).json({ transacoes: r.ok ? await r.json() : [] });
    } catch(e) { return res.status(200).json({ transacoes: [] }); }
  }

  // ── PACOTES DISPONÍVEIS ─────────────────────────────────────────────────
  if (action === 'pacotes') {
    return res.status(200).json({ pacotes: Object.entries(PACOTES).map(([k, v]) => ({ id: k, ...v, preco_display: 'R$' + (v.preco / 100).toFixed(2).replace('.', ',') })) });
  }

  return res.status(404).json({ error: 'Action não encontrada' });
};
