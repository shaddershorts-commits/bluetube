// api/_helpers/stripe.js — blindagem da integracao Stripe (CommonJS, raw fetch)
// Mantemos fetch cru em vez do SDK pra cold start rapido no Vercel.
// Fornece: verificacao de webhook, idempotency keys, transfers, checagem
// de assinatura ativa e listagem de eventos do log.

const crypto = require('crypto');

const STRIPE_API = 'https://api.stripe.com/v1';
const DEFAULT_TIMEOUT = 30000;
const MAX_RETRIES = 3;

// ── Idempotency ─────────────────────────────────────────────────────────────
function gerarIdempotencyKey(...parts) {
  const raw = parts.filter(Boolean).map(String).join('|');
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 64);
}

// ── Webhook signature ───────────────────────────────────────────────────────
// Reproduz stripe.webhooks.constructEvent em fetch puro
function verificarWebhook(rawBody, sigHeader, secret) {
  if (!rawBody || !sigHeader || !secret) {
    throw new Error('verificarWebhook: rawBody/sigHeader/secret obrigatorios');
  }
  const parts = {};
  sigHeader.split(',').forEach((p) => {
    const [k, v] = p.split('=');
    if (k && v) parts[k.trim()] = v.trim();
  });
  const ts = parts['t'];
  const received = parts['v1'];
  if (!ts || !received) throw new Error('Header stripe-signature mal formado');

  const bodyStr = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody);
  const payload = `${ts}.${bodyStr}`;
  const expected = crypto.createHmac('sha256', secret).update(payload, 'utf8').digest('hex');

  if (expected.length !== received.length ||
      !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(received))) {
    throw new Error('Assinatura invalida');
  }

  const ageSec = Math.abs(Date.now() / 1000 - Number(ts));
  if (ageSec > 300) throw new Error('Evento muito antigo (replay)');

  return JSON.parse(bodyStr);
}

// ── Fetch Stripe com retry em 5xx/429 ──────────────────────────────────────
async function stripeFetch(path, { method = 'GET', body, idempotencyKey, query } = {}) {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY nao configurada');

  const url = query
    ? `${STRIPE_API}${path}?${new URLSearchParams(query).toString()}`
    : `${STRIPE_API}${path}`;

  const headers = {
    Authorization: 'Bearer ' + key,
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

  const fetchOpts = {
    method,
    headers,
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT),
  };
  if (body) fetchOpts.body = typeof body === 'string' ? body : new URLSearchParams(body).toString();

  let lastErr;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const r = await fetch(url, fetchOpts);
      const data = await r.json().catch(() => ({}));
      if (r.ok) return data;
      // 5xx ou 429 → retry com backoff exponencial
      if ((r.status >= 500 || r.status === 429) && attempt < MAX_RETRIES - 1) {
        const wait = 300 * Math.pow(2, attempt);
        await new Promise((res) => setTimeout(res, wait));
        continue;
      }
      const err = new Error(data.error?.message || `Stripe ${r.status}`);
      err.status = r.status;
      err.code = data.error?.code;
      err.type = data.error?.type;
      throw err;
    } catch (e) {
      lastErr = e;
      if (e.status && e.status < 500 && e.status !== 429) throw e;
      if (attempt < MAX_RETRIES - 1) {
        await new Promise((res) => setTimeout(res, 300 * Math.pow(2, attempt)));
      }
    }
  }
  throw lastErr || new Error('Stripe fetch falhou');
}

// ── Transfer (Stripe Connect) ───────────────────────────────────────────────
async function criarTransfer({ amount, currency = 'brl', destination, metadata = {} }, customKey) {
  if (!destination) throw new Error('criarTransfer: destination obrigatorio');
  if (!amount || amount <= 0) throw new Error('criarTransfer: amount invalido');

  const key = customKey || gerarIdempotencyKey('transfer', destination, amount, metadata.pagamento_id || metadata.referencia || '');

  const body = {
    amount: String(Math.round(amount)),
    currency,
    destination,
  };
  for (const [k, v] of Object.entries(metadata)) {
    body[`metadata[${k}]`] = String(v);
  }

  return stripeFetch('/transfers', { method: 'POST', body, idempotencyKey: key });
}

// ── Cancelar subscription (cancel_at_period_end) ────────────────────────────
async function cancelarSubscriptionAtPeriodEnd(subscriptionId, customKey) {
  const key = customKey || gerarIdempotencyKey('cancel_subscription', subscriptionId);
  return stripeFetch(`/subscriptions/${encodeURIComponent(subscriptionId)}`, {
    method: 'POST',
    body: 'cancel_at_period_end=true',
    idempotencyKey: key,
  });
}

// ── Assinatura ativa do customer ────────────────────────────────────────────
async function verificarAssinaturaAtiva(stripeCustomerId) {
  if (!stripeCustomerId) return null;
  try {
    const data = await stripeFetch('/subscriptions', {
      query: { customer: stripeCustomerId, status: 'active', limit: '1' },
    });
    const sub = data.data?.[0];
    if (!sub) return null;
    const item = sub.items?.data?.[0];
    const price = item?.price;
    return {
      ativa: true,
      stripe_subscription_id: sub.id,
      status: sub.status,
      cancel_at_period_end: sub.cancel_at_period_end,
      current_period_end: sub.current_period_end,
      expira_em: new Date(sub.current_period_end * 1000).toISOString(),
      price_id: price?.id || null,
      price_amount: price?.unit_amount || 0,
      price_interval: price?.recurring?.interval || null,
      metadata: sub.metadata || {},
    };
  } catch (e) {
    console.error('[stripe] verificarAssinaturaAtiva falhou:', e.message);
    return null;
  }
}

// ── Helpers Supabase (reuso local em vez de adicionar dep) ──────────────────
async function supaFetch(path, { method = 'GET', body, prefer } = {}) {
  const SU = process.env.SUPABASE_URL;
  const SK = process.env.SUPABASE_SERVICE_KEY;
  if (!SU || !SK) throw new Error('SUPABASE_URL/SERVICE_KEY nao configurados');

  const headers = {
    apikey: SK,
    Authorization: 'Bearer ' + SK,
    'Content-Type': 'application/json',
  };
  if (prefer) headers.Prefer = prefer;

  const r = await fetch(`${SU}/rest/v1${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) {
    const err = await r.text().catch(() => '');
    throw new Error(`Supabase ${r.status}: ${err.slice(0, 200)}`);
  }
  return r.json().catch(() => ({}));
}

// ── Log de webhook ──────────────────────────────────────────────────────────
async function buscarEvento(stripeEventId) {
  const rows = await supaFetch(`/stripe_webhook_log?stripe_event_id=eq.${encodeURIComponent(stripeEventId)}&select=id,status,tentativas&limit=1`);
  return rows[0] || null;
}

async function registrarEventoIniciando(event, tentativaAtual) {
  await supaFetch('/stripe_webhook_log?on_conflict=stripe_event_id', {
    method: 'POST',
    prefer: 'resolution=merge-duplicates,return=minimal',
    body: {
      stripe_event_id: event.id,
      tipo: event.type,
      status: 'processando',
      payload: event,
      tentativas: tentativaAtual,
      updated_at: new Date().toISOString(),
    },
  });
}

async function marcarEventoConcluido(stripeEventId) {
  const now = new Date().toISOString();
  await supaFetch(`/stripe_webhook_log?stripe_event_id=eq.${encodeURIComponent(stripeEventId)}`, {
    method: 'PATCH',
    prefer: 'return=minimal',
    body: { status: 'concluido', processado_em: now, updated_at: now, ultimo_erro: null },
  });
}

async function marcarEventoErro(stripeEventId, mensagem, tentativas) {
  const status = tentativas >= 5 ? 'falha_permanente' : 'erro';
  await supaFetch(`/stripe_webhook_log?stripe_event_id=eq.${encodeURIComponent(stripeEventId)}`, {
    method: 'PATCH',
    prefer: 'return=minimal',
    body: { status, ultimo_erro: String(mensagem || '').slice(0, 500), updated_at: new Date().toISOString() },
  });
  return status;
}

// ── Notificacao admin em falhas criticas ────────────────────────────────────
async function notificarAdminWebhookErro(event, error) {
  if (!process.env.RESEND_API_KEY || !process.env.ADMIN_EMAIL) return;
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + process.env.RESEND_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'monitor@bluetubeviral.com',
        to: process.env.ADMIN_EMAIL,
        subject: `🚨 Webhook Stripe FALHOU: ${event.type}`,
        html: `<h2>🚨 Erro critico no webhook Stripe</h2>
          <p><b>Evento:</b> ${event.type}</p>
          <p><b>ID:</b> ${event.id}</p>
          <p><b>Erro:</b> ${error.message}</p>
          <p><b>Dados:</b></p>
          <pre style="background:#f4f4f4;padding:10px;max-width:600px;overflow:auto">${JSON.stringify(event.data?.object || {}, null, 2).slice(0, 1500)}</pre>
          <p><a href="https://dashboard.stripe.com/webhooks">Stripe Dashboard →</a></p>`,
      }),
    });
  } catch {}
}

module.exports = {
  gerarIdempotencyKey,
  verificarWebhook,
  stripeFetch,
  criarTransfer,
  cancelarSubscriptionAtPeriodEnd,
  verificarAssinaturaAtiva,
  supaFetch,
  buscarEvento,
  registrarEventoIniciando,
  marcarEventoConcluido,
  marcarEventoErro,
  notificarAdminWebhookErro,
};
