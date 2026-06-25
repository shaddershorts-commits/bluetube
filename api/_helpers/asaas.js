// api/_helpers/asaas.js — Helper compartilhado pra Asaas API (Pix in/out)
// =====================================================================
// Extraido de affiliate-saques.js em 2026-06-25 quando comecei a usar Asaas
// pra cobranca Pix de assinatura (in) — antes era so /transfers (out).
//
// Env vars:
//   ASAAS_API_KEY        — chave da API (obrigatorio)
//   ASAAS_ENVIRONMENT    — 'production' | 'sandbox' (default sandbox)
//
// Endpoints usados:
//   - /customers  — cria/busca customer pra anexar payments
//   - /payments   — cria cobranca (suporta billingType=PIX/BOLETO/CREDIT_CARD)
//   - /transfers  — envia Pix OUT (usado por affiliate-saques.js)
//   - /finance/balance — checa saldo

const ASAAS_KEY = process.env.ASAAS_API_KEY || '';
const ASAAS_URL = (process.env.ASAAS_ENVIRONMENT === 'production')
  ? 'https://api.asaas.com/v3'
  : 'https://sandbox.asaas.com/api/v3';

async function asaasCall(path, opts = {}) {
  if (!ASAAS_KEY) throw new Error('ASAAS_API_KEY_MISSING');
  const r = await fetch(ASAAS_URL + path, {
    ...opts,
    headers: {
      'access_token': ASAAS_KEY,
      'Content-Type': 'application/json',
      'User-Agent': 'BlueTube/1.0',
      ...(opts.headers || {}),
    },
  });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = { raw: text }; }
  if (!r.ok) {
    const err = new Error(data?.errors?.[0]?.description || data?.error || `asaas_${r.status}`);
    err.asaas = data;
    err.status = r.status;
    throw err;
  }
  return data;
}

// Busca ou cria customer Asaas pra um email
// Asaas exige customer pra anexar payment. Idempotente: se ja existe email,
// reusa o ID via /customers?email=
async function findOrCreateCustomer({ email, name, cpfCnpj }) {
  if (!email) throw new Error('email_obrigatorio');
  const emailLower = String(email).toLowerCase().trim();

  // Busca existente
  try {
    const existing = await asaasCall(`/customers?email=${encodeURIComponent(emailLower)}&limit=1`);
    if (existing?.data?.length > 0) {
      return existing.data[0];
    }
  } catch (e) { /* fall through pra criar */ }

  // Cria novo
  const payload = { email: emailLower, name: name || emailLower.split('@')[0] };
  if (cpfCnpj) payload.cpfCnpj = String(cpfCnpj).replace(/\D/g, '');
  return await asaasCall('/customers', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

// Cria cobranca Pix one-time
// Retorna { id, invoiceUrl, status, value, dueDate, ... }
// invoiceUrl = pagina Asaas hospedada com QR code (redirect pra la)
async function createPixPayment({ customerId, value, description, externalReference, dueDate, callback }) {
  if (!customerId) throw new Error('customer_obrigatorio');
  if (!value || value <= 0) throw new Error('valor_invalido');

  const payload = {
    customer: customerId,
    billingType: 'PIX',
    value: Number(value),
    dueDate: dueDate || new Date(Date.now() + 24*60*60*1000).toISOString().slice(0,10), // amanha
    description: description || 'BlueTube — Assinatura',
    externalReference: externalReference || null,
  };
  // callback: { successUrl, autoRedirect } — Asaas redireciona apos pagamento
  if (callback?.successUrl) {
    payload.callback = {
      successUrl: callback.successUrl,
      autoRedirect: callback.autoRedirect !== false,
    };
  }
  return await asaasCall('/payments', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

// Busca QR code estatico pra um payment (alternativa ao invoiceUrl)
// Retorna { encodedImage (base64), payload (copy-paste), expirationDate }
async function getPixQrCode(paymentId) {
  return await asaasCall(`/payments/${paymentId}/pixQrCode`);
}

// Busca payment por ID (pra checar status)
async function getPayment(paymentId) {
  return await asaasCall(`/payments/${paymentId}`);
}

module.exports = {
  asaasCall,
  findOrCreateCustomer,
  createPixPayment,
  getPixQrCode,
  getPayment,
  ASAAS_KEY,
  ASAAS_URL,
};
