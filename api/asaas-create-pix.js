// api/asaas-create-pix.js — Cria cobranca Pix anual via Asaas
// =====================================================================
// Substitui o Pix Stripe (que precisa de ativacao manual no dashboard).
// User clica botao Pix → POST aqui → backend cria customer+payment Asaas
// → retorna invoiceUrl pro frontend redirecionar.
//
// Quando user paga, Asaas dispara webhook em /api/asaas-webhook que ativa
// o plano por 396 dias (13 meses bonus).
//
// Body esperado: { plan, token, ref? }
//   plan:  'full' | 'master'
//   token: token Supabase do user logado
//   ref:   ref de afiliado (opcional)
//
// Resposta: { url } pra redirect, ou { error }

const { findOrCreateCustomer, createPixPayment } = require('./_helpers/asaas');

// Valores Pix anual em REAIS (não centavos, Asaas trabalha em reais decimais)
const PIX_AMOUNTS = {
  full:   269.88,
  master: 809.88,
};

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  const { plan, token, ref } = req.body || {};
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const ANON_KEY     = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_KEY;
  const SITE_URL     = process.env.SITE_URL || 'https://bluetubeviral.com';

  if (!PIX_AMOUNTS[plan]) return res.status(400).json({ error: 'plano_invalido' });
  if (!token || !SUPABASE_URL) return res.status(401).json({ error: 'login_obrigatorio' });

  // Resolve email via token Supabase
  let userEmail = null;
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { 'apikey': ANON_KEY, 'Authorization': `Bearer ${token}` },
    });
    if (r.ok) userEmail = (await r.json())?.email || null;
  } catch (e) {}
  if (!userEmail) return res.status(401).json({ error: 'token_invalido' });

  try {
    // 1. Cria/busca customer Asaas
    const customer = await findOrCreateCustomer({ email: userEmail });
    if (!customer?.id) return res.status(502).json({ error: 'customer_falhou' });

    // 2. Cria cobranca Pix
    // externalReference codifica metadata pro webhook: plan + email + ref
    const externalRef = JSON.stringify({
      plan,
      email: userEmail.toLowerCase().trim(),
      ref: ref || null,
      kind: 'pix_annual',
    });

    const description = plan === 'master'
      ? 'BlueTube Master — Assinatura Anual (13 meses)'
      : 'BlueTube Full — Assinatura Anual (13 meses)';

    const payment = await createPixPayment({
      customerId: customer.id,
      value: PIX_AMOUNTS[plan],
      description,
      externalReference: externalRef,
      // dueDate default = amanhã. Pix expira em 24h se nao pago.
      callback: {
        successUrl: `${SITE_URL}?payment=success&plan=${plan}&via=pix`,
        autoRedirect: true,
      },
    });

    if (!payment?.invoiceUrl) {
      console.error('[asaas-create-pix] payment sem invoiceUrl:', JSON.stringify(payment).slice(0, 300));
      return res.status(502).json({ error: 'invoice_url_ausente' });
    }

    return res.status(200).json({
      url: payment.invoiceUrl,
      payment_id: payment.id,
    });
  } catch (e) {
    console.error('[asaas-create-pix] erro:', e.message, e.asaas || '');
    const msg = e.message === 'ASAAS_API_KEY_MISSING'
      ? 'Pix temporariamente indisponivel. Tente cartao.'
      : (e.asaas?.errors?.[0]?.description || 'Erro ao gerar Pix. Tente novamente.');
    return res.status(500).json({ error: msg });
  }
};
