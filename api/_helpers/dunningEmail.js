// api/_helpers/dunningEmail.js — Emails de cobrança falhada (dunning) pro CLIENTE.
// Antes desses emails, só o admin era notificado (notifyStripe) e o usuário
// descobria o rebaixamento sozinho, ao perder acesso.
//
// Fluxo real do sistema (webhook.js, invoice.payment_failed):
//   Tentativa 1 → Stripe agenda retry (~3 dias) → sendPaymentFailedWarning
//   Tentativa 2 → DOWNGRADE_AT=2: sub cancelada + DB vira free → sendAccessLost
//
// CTA do aviso: hosted_invoice_url (página oficial do Stripe da fatura em
// aberto) — cliente paga na hora com outro cartão e o payment_succeeded
// renova sozinho. Fallback: site.
// CommonJS, mesmo padrão de cancellationEmail.js.

const SITE = 'https://bluetubeviral.com';

const PLAN_META = {
  full:   { label: 'Full',   emoji: '⚡' },
  master: { label: 'Master', emoji: '👑' },
};

function dataBr(d) {
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric', timeZone: 'America/Sao_Paulo' });
}

function shell(inner) {
  return `<div style="font-family:-apple-system,'Segoe UI',sans-serif;max-width:600px;margin:0 auto;background:#020817;color:#e8f4ff">
    <div style="background:linear-gradient(135deg,#1a6bff,#00aaff);padding:32px 28px;text-align:center">
      <div style="font-size:30px;font-weight:900;color:#fff;letter-spacing:-1px">BlueTube</div>
      <div style="color:rgba(255,255,255,.85);font-size:12px;font-family:monospace;margin-top:6px;letter-spacing:.12em">CRIADOR VIRAL</div>
    </div>
    <div style="padding:32px 28px">${inner}</div>
    <div style="padding:20px 28px;border-top:1px solid rgba(0,170,255,.08);text-align:center">
      <div style="color:rgba(150,190,230,.4);font-size:11px;line-height:1.6">BlueTube — bluetubeviral.com<br>Dúvidas? Responda este email ou fale com o suporte no seu perfil.</div>
    </div>
  </div>`;
}

async function enviar(email, subject, html) {
  const RESEND_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_KEY || !email) return { sent: false, reason: 'config_missing' };
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${RESEND_KEY}` },
    body: JSON.stringify({ from: 'BlueTube <noreply@bluetubeviral.com>', to: [email], subject, html }),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    return { sent: false, reason: `resend_${r.status}`, detail: t.slice(0, 200) };
  }
  return { sent: true };
}

// ── Email 1: aviso na primeira falha ─────────────────────────────────────────
// nextRetryAt: Date|null (invoice.next_payment_attempt) — quando o Stripe vai
// tentar de novo. payUrl: hosted_invoice_url|null.
async function sendPaymentFailedWarning(email, plan, nextRetryAt, payUrl) {
  const meta = PLAN_META[plan];
  if (!meta) return { sent: false, reason: 'plano_nao_pago' };

  const retryTxt = nextRetryAt
    ? `em <b>${dataBr(nextRetryAt)}</b>`
    : 'nos próximos dias';
  const cta = payUrl || `${SITE}/#plansSection`;
  const ctaLabel = payUrl ? '💳 Pagar agora e manter meu acesso' : 'Ver planos no site';

  const subject = `⚠️ Não conseguimos renovar seu plano ${meta.label} — você pode perder o acesso`;
  const html = shell(`
      <div style="background:rgba(251,191,36,.08);border:1px solid rgba(251,191,36,.3);border-radius:12px;padding:16px 18px;margin-bottom:24px">
        <div style="font-size:11px;font-weight:700;color:#fbbf24;letter-spacing:.08em;text-transform:uppercase;margin-bottom:4px">⚠️ Pagamento recusado</div>
        <div style="color:#fff;font-size:15px;line-height:1.5">A renovação do seu plano <b>${meta.emoji} ${meta.label}</b> foi recusada pelo banco ou cartão.</div>
      </div>

      <h2 style="font-size:20px;color:#fff;margin:0 0 12px;line-height:1.3">Seu acesso ainda está ativo — mas por pouco tempo</h2>

      <p style="color:rgba(200,225,255,.8);font-size:14px;line-height:1.6;margin:0 0 18px">
        Vamos tentar cobrar de novo automaticamente ${retryTxt}.
        Se essa nova tentativa também falhar, <b style="color:#fbbf24">sua conta perde o acesso ao ${meta.label}</b> e volta pro plano Free.
      </p>

      <div style="background:rgba(10,22,40,.6);border:1px solid rgba(0,170,255,.15);border-radius:12px;padding:18px;margin:20px 0">
        <div style="font-size:13px;font-weight:700;color:#fff;margin-bottom:12px">Como resolver agora:</div>
        <div style="color:rgba(200,225,255,.75);font-size:13px;line-height:1.8">
          <div>💳 <b>Pague a fatura em aberto</b> no botão abaixo (aceita outro cartão) — resolve na hora</div>
          <div>🏦 Ou garanta <b>saldo/limite no cartão atual</b> antes da nova tentativa automática</div>
        </div>
      </div>

      <div style="text-align:center;margin:26px 0">
        <a href="${cta}" style="display:inline-block;background:linear-gradient(135deg,#1a6bff,#00aaff);color:#fff;font-size:15px;font-weight:800;padding:14px 28px;border-radius:12px;text-decoration:none">${ctaLabel}</a>
      </div>

      <p style="color:rgba(200,225,255,.6);font-size:13px;line-height:1.6;margin:20px 0 0">
        Se o pagamento for concluído, nada muda: seu ${meta.label} continua ativo normalmente e você não precisa fazer mais nada.
      </p>`);

  return enviar(email, subject, html);
}

// ── Email 2: acesso encerrado (dia do rebaixamento) ──────────────────────────
async function sendAccessLost(email, plan) {
  const meta = PLAN_META[plan];
  if (!meta) return { sent: false, reason: 'plano_nao_pago' };

  const subject = `Seu acesso ao BlueTube ${meta.label} foi encerrado`;
  const html = shell(`
      <div style="background:rgba(248,113,113,.08);border:1px solid rgba(248,113,113,.3);border-radius:12px;padding:16px 18px;margin-bottom:24px">
        <div style="font-size:11px;font-weight:700;color:#f87171;letter-spacing:.08em;text-transform:uppercase;margin-bottom:4px">Acesso encerrado</div>
        <div style="color:#fff;font-size:15px;line-height:1.5">Não conseguimos renovar o pagamento do seu plano <b>${meta.emoji} ${meta.label}</b>, mesmo após nova tentativa.</div>
      </div>

      <h2 style="font-size:20px;color:#fff;margin:0 0 12px;line-height:1.3">Sua conta voltou pro plano Free hoje</h2>

      <p style="color:rgba(200,225,255,.8);font-size:14px;line-height:1.6;margin:0 0 18px">
        Por falta de pagamento, a assinatura foi cancelada e <b>não haverá mais cobranças</b>.
        Sua conta, seus roteiros e seus dados continuam salvos — você só perdeu as ferramentas exclusivas do ${meta.label}.
      </p>

      <div style="background:rgba(10,22,40,.6);border:1px solid rgba(0,170,255,.15);border-radius:12px;padding:18px;margin:20px 0">
        <div style="font-size:13px;font-weight:700;color:#fff;margin-bottom:12px">Pra voltar agora mesmo:</div>
        <div style="color:rgba(200,225,255,.75);font-size:13px;line-height:1.8">
          <div>1️⃣ Entre no site com sua conta de sempre</div>
          <div>2️⃣ Escolha seu plano e assine de novo (pode usar outro cartão ou Pix anual)</div>
          <div>3️⃣ O acesso volta na hora, com tudo no lugar</div>
        </div>
      </div>

      <div style="text-align:center;margin:26px 0">
        <a href="${SITE}/#plansSection" style="display:inline-block;background:linear-gradient(135deg,#1a6bff,#00aaff);color:#fff;font-size:15px;font-weight:800;padding:14px 28px;border-radius:12px;text-decoration:none">🚀 Assinar novamente</a>
      </div>

      <p style="color:rgba(200,225,255,.6);font-size:13px;line-height:1.6;margin:20px 0 0">
        Foi engano ou problema com o cartão? Sem estresse — assinando de novo você recupera tudo em menos de um minuto.
      </p>`);

  return enviar(email, subject, html);
}

module.exports = { sendPaymentFailedWarning, sendAccessLost };
