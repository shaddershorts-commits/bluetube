// api/asaas-payment-status.js — Polling de status de pagamento Pix Asaas
// =====================================================================
// Frontend chama a cada 5s enquanto modal QR esta aberto.
// Quando status = RECEIVED ou CONFIRMED → frontend fecha modal e mostra
// "plano ativo" (o webhook ja ativou no Supabase em paralelo).
//
// Query: ?id=<payment_id>&token=<supabase_token>
//
// Auth: precisa de token Supabase do user (so o user dono pode ver status
// do proprio pagamento — externalReference[email] === userEmail).

const { getPayment } = require('./_helpers/asaas');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });

  const paymentId = req.query.id;
  const token = req.query.token;
  if (!paymentId) return res.status(400).json({ error: 'id_obrigatorio' });
  if (!token) return res.status(401).json({ error: 'token_obrigatorio' });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_KEY;

  // Resolve user via token Supabase
  let userEmail = null;
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { 'apikey': ANON_KEY, 'Authorization': `Bearer ${token}` },
    });
    if (r.ok) userEmail = (await r.json())?.email?.toLowerCase().trim() || null;
  } catch (e) {}
  if (!userEmail) return res.status(401).json({ error: 'token_invalido' });

  try {
    const payment = await getPayment(paymentId);
    if (!payment?.id) return res.status(404).json({ error: 'payment_nao_encontrado' });

    // Valida que o user que tá pedindo é mesmo o dono (via externalReference)
    let meta = {};
    try { meta = JSON.parse(payment.externalReference || '{}'); } catch(e) {}
    if (meta.email && meta.email !== userEmail) {
      return res.status(403).json({ error: 'forbidden' });
    }

    // Status Asaas: PENDING | RECEIVED | CONFIRMED | OVERDUE | REFUNDED | ...
    const paid = ['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH'].includes(payment.status);
    return res.status(200).json({
      status: payment.status,
      paid,
      value: payment.value,
    });
  } catch (e) {
    console.error('[asaas-payment-status] erro:', e.message);
    return res.status(500).json({ error: 'erro_consulta' });
  }
};
