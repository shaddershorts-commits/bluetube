// api/_helpers/cancellationEmail.js — Confirmacao de cancelamento agendado.
// Objetivo principal: evitar chargeback/estorno. Usuario cancela, sistema
// agenda fim no Stripe (cancel_at_period_end=true), e esse email confirma:
//   - Registramos seu cancelamento
//   - Voce mantem acesso ate DD/MM/AAAA (periodo ja pago)
//   - No dia, sua conta vira Free automaticamente, sem cobrancas
//
// Disparado por:
//   - cancel-subscription.js apos sucesso no Stripe (automatico)
//   - admin.js action=send_cancellation_confirmation (manual pra casos antigos)
// CommonJS.

async function sendCancellationEmail(email, plan, planExpiresAt) {
  const RESEND_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_KEY || !email) return { sent: false, reason: 'config_missing' };
  if (plan !== 'master' && plan !== 'full') return { sent: false, reason: 'plano_nao_pago' };
  if (!planExpiresAt) return { sent: false, reason: 'sem_data_expiracao' };

  const expira = new Date(planExpiresAt);
  const dataBr = expira.toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' });
  const diasRestantes = Math.max(0, Math.ceil((expira.getTime() - Date.now()) / 86400000));
  const planLabel = plan === 'master' ? 'Master' : 'Full';
  const planEmoji = plan === 'master' ? '👑' : '⚡';

  const subject = `Cancelamento confirmado — você mantém acesso até ${dataBr}`;

  const html = `<div style="font-family:-apple-system,'Segoe UI',sans-serif;max-width:600px;margin:0 auto;background:#020817;color:#e8f4ff">
    <div style="background:linear-gradient(135deg,#1a6bff,#00aaff);padding:32px 28px;text-align:center">
      <div style="font-size:30px;font-weight:900;color:#fff;letter-spacing:-1px">BlueTube</div>
      <div style="color:rgba(255,255,255,.85);font-size:12px;font-family:monospace;margin-top:6px;letter-spacing:.12em">CRIADOR VIRAL</div>
    </div>

    <div style="padding:32px 28px">
      <div style="background:rgba(0,170,255,.08);border:1px solid rgba(0,170,255,.25);border-radius:12px;padding:16px 18px;margin-bottom:24px">
        <div style="font-size:11px;font-weight:700;color:#00aaff;letter-spacing:.08em;text-transform:uppercase;margin-bottom:4px">✓ Cancelamento registrado</div>
        <div style="color:#fff;font-size:15px;line-height:1.5">Recebemos seu pedido de cancelamento do plano <b>${planEmoji} ${planLabel}</b>.</div>
      </div>

      <h2 style="font-size:20px;color:#fff;margin:0 0 12px;line-height:1.3">Você ainda tem acesso completo até <span style="color:#00aaff">${dataBr}</span></h2>

      <p style="color:rgba(200,225,255,.8);font-size:14px;line-height:1.6;margin:0 0 18px">
        Como você já pagou esse período, seu acesso ao <b>${planLabel}</b> continua ativo por mais <b>${diasRestantes} ${diasRestantes === 1 ? 'dia' : 'dias'}</b>.
        Use a vontade — todas as ferramentas do plano estão disponíveis.
      </p>

      <div style="background:rgba(10,22,40,.6);border:1px solid rgba(0,170,255,.15);border-radius:12px;padding:18px;margin:20px 0">
        <div style="font-size:13px;font-weight:700;color:#fff;margin-bottom:12px">O que acontece a seguir:</div>
        <div style="color:rgba(200,225,255,.75);font-size:13px;line-height:1.8">
          <div>📅 <b>Até ${dataBr}</b> → acesso normal ao ${planLabel}</div>
          <div>🔄 <b>Em ${dataBr}</b> → sua conta vira Free automaticamente</div>
          <div>💳 <b>Nenhuma cobrança futura</b> — a assinatura já foi cancelada no Stripe</div>
        </div>
      </div>

      <div style="background:linear-gradient(135deg,rgba(16,185,129,.08),rgba(0,170,255,.05));border:1px solid rgba(16,185,129,.25);border-radius:12px;padding:14px 16px;margin:20px 0">
        <div style="color:#10b981;font-size:13px;font-weight:700;margin-bottom:4px">✓ Nenhuma ação necessária</div>
        <div style="color:rgba(200,225,255,.8);font-size:13px;line-height:1.5">Você <b>não precisa</b> pedir estorno ao banco ou abrir reclamação — o valor já foi considerado e seu acesso está garantido até o fim do período.</div>
      </div>

      <p style="color:rgba(200,225,255,.6);font-size:13px;line-height:1.6;margin:20px 0 0">
        Mudou de ideia? Você pode reativar a qualquer momento antes de <b>${dataBr}</b> em <a href="https://bluetubeviral.com" style="color:#00aaff;text-decoration:none;font-weight:600">bluetubeviral.com</a>.
      </p>

      <p style="color:rgba(200,225,255,.5);font-size:12px;line-height:1.6;margin:24px 0 0">
        Alguma dúvida? Responde esse email ou escreve pra <a href="mailto:suporte@bluetubeviral.com" style="color:#00aaff;text-decoration:none">suporte@bluetubeviral.com</a>.
      </p>
    </div>

    <div style="padding:20px 28px;text-align:center;border-top:1px solid rgba(0,170,255,.08)">
      <div style="color:rgba(150,190,230,.4);font-size:11px;font-family:monospace;letter-spacing:.08em">BLUETUBE · CRIADOR VIRAL</div>
    </div>
  </div>`;

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'BlueTube <noreply@bluetubeviral.com>',
        to: [email],
        subject,
        html,
      }),
    });
    if (!r.ok) {
      const err = await r.text().catch(() => '');
      console.error('[cancellationEmail] resend falhou:', r.status, err.slice(0, 200));
      return { sent: false, reason: `resend_${r.status}` };
    }
    console.log(`[cancellationEmail] enviado pra ${email} (acesso ate ${dataBr})`);
    return { sent: true, data_expiracao: dataBr, dias_restantes: diasRestantes };
  } catch (e) {
    console.error('[cancellationEmail] exception:', e.message);
    return { sent: false, reason: 'exception', error: e.message };
  }
}

module.exports = { sendCancellationEmail };
