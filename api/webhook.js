// api/webhook.js
// Listens to Stripe webhook events and updates subscriber plans in Supabase.
// Must be set up in Stripe Dashboard → Webhooks → Add endpoint

export const config = { api: { bodyParser: false } };

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY;
  const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

  const rawBody = await getRawBody(req);
  const sig = req.headers['stripe-signature'];

  // Verify webhook signature
  let event;
  try {
    // HMAC verification — formato Stripe: t=timestamp,v1=signature
    const crypto = await import('crypto');
    // Extrai timestamp e assinatura do header
    const parts = {};
    sig.split(',').forEach(part => {
      const [k, v] = part.split('=');
      parts[k.trim()] = v?.trim();
    });
    const ts = parts['t'];
    const received = parts['v1'];
    if (!ts || !received) throw new Error('Malformed signature header');
    const payload = `${ts}.${rawBody.toString()}`;
    const expected = crypto.createHmac('sha256', WEBHOOK_SECRET)
      .update(payload, 'utf8').digest('hex');
    // Comparação segura contra timing attacks
    if (expected.length !== received.length || 
        !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(received))) {
      throw new Error('Invalid signature');
    }
    event = JSON.parse(rawBody.toString());
  } catch (err) {
    console.error('Webhook signature error:', err.message);
    return res.status(400).json({ error: 'Invalid signature' });
  }

  const supaHeaders = {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`
  };

  const RESEND_KEY = process.env.RESEND_API_KEY;
  const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
  const _now = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  const _prices = { full: 'R$29,99', master: 'R$89,99' };

  async function notifyStripe(subject, rows) {
    if (!RESEND_KEY || !ADMIN_EMAIL) return;
    const body = rows.map(([k, v]) => `<tr><td style="padding:8px 12px;color:rgba(150,190,230,.5);font-size:12px;white-space:nowrap">${k}</td><td style="padding:8px 12px;font-size:13px;font-weight:600">${v}</td></tr>`).join('');
    try {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${RESEND_KEY}` },
        body: JSON.stringify({
          from: 'BlueTube <noreply@bluetubeviral.com>',
          to: [ADMIN_EMAIL],
          subject,
          html: `<div style="font-family:-apple-system,sans-serif;max-width:520px;margin:0 auto;background:#0a1628;color:#e8f4ff;border-radius:16px;overflow:hidden;border:1px solid rgba(0,170,255,.2)">
            <div style="background:linear-gradient(135deg,#1a6bff,#00aaff);padding:18px 24px">
              <div style="font-size:16px;font-weight:800;color:#fff">${subject}</div>
              <div style="font-size:11px;color:rgba(255,255,255,.6);margin-top:4px">${_now}</div>
            </div>
            <table style="width:100%;border-collapse:collapse;padding:8px">${body}</table>
            <div style="padding:16px 24px;border-top:1px solid rgba(0,170,255,.08)">
              <a href="https://dashboard.stripe.com" style="color:#00aaff;font-size:12px;text-decoration:none">Abrir Stripe Dashboard →</a>
            </div>
          </div>`
        })
      });
    } catch (e) { console.error('Resend error:', e.message); }
  }

  try {

    // ── CHECKOUT CONCLUÍDO → Ativa plano ─────────────────────────────────────
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const plan = session.metadata?.plan || 'full';
      const billing = session.metadata?.billing || 'monthly';
      const email = session.customer_details?.email;
      const customerId = session.customer;
      const subscriptionId = session.subscription;

      if (!email) {
        console.error('❌ checkout.session.completed sem email:', session.id);
        return res.status(200).json({ received: true });
      }

      const expiresAt = billing === 'annual'
        ? new Date(Date.now() + 366 * 24 * 60 * 60 * 1000).toISOString()
        : new Date(Date.now() + 37 * 24 * 60 * 60 * 1000).toISOString(); // +5 dias de margem

      // Tenta PATCH primeiro (atualiza se existe), depois POST (cria se não existe)
      const patchR = await fetch(`${SUPABASE_URL}/rest/v1/subscribers?email=eq.${encodeURIComponent(email)}`, {
        method: 'PATCH',
        headers: { ...supaHeaders, 'Prefer': 'return=representation' },
        body: JSON.stringify({
          plan,
          is_manual: false,
          stripe_customer_id: customerId,
          stripe_subscription_id: subscriptionId,
          plan_expires_at: expiresAt,
          updated_at: new Date().toISOString()
        })
      });
      const patchData = await patchR.json();

      let r;
      if (Array.isArray(patchData) && patchData.length > 0) {
        // PATCH funcionou — subscriber existia
        r = patchR;
        console.log(`✅ Plan updated via PATCH: ${email} → ${plan}`);
      } else {
        // Subscriber não existe — cria
        r = await fetch(`${SUPABASE_URL}/rest/v1/subscribers`, {
          method: 'POST',
          headers: { ...supaHeaders, 'Prefer': 'return=representation' },
          body: JSON.stringify({
            email,
            plan,
            is_manual: false,
            stripe_customer_id: customerId,
            stripe_subscription_id: subscriptionId,
            plan_expires_at: expiresAt,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          })
        });
      }

      if (!r.ok) {
        const err = await r.text();
        console.error('❌ Supabase upsert error:', err);
        return res.status(500).json({ error: 'DB update failed' });
      }

      console.log(`✅ Plan activated: ${email} → ${plan} (${billing})`);

      // Email para admin
      notifyStripe(`💰 Nova assinatura — ${plan.toUpperCase()} — ${email}`, [
        ['Cliente', email],
        ['Plano', `${plan === 'master' ? '👑' : '⚡'} ${plan.toUpperCase()}`],
        ['Valor', _prices[plan] || 'N/A'],
        ['Billing', billing === 'annual' ? 'Anual' : 'Mensal'],
        ['Stripe ID', customerId || '—'],
      ]).catch(() => {});

      // Email motivacional pro usuário — fire-and-forget, não bloqueia webhook
      sendUpgradeEmail(email, plan, billing).catch(() => {});

      // Notifica sistema de afiliados — conversão paga
      const SITE_URL = process.env.SITE_URL || 'https://bluetubeviral.com';
      fetch(`${SITE_URL}/api/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'conversion', email, plan, stripe_customer_id: customerId, conversion_type: `upgrade_${plan}` })
      }).then(async () => {
        // Corrige comissão com o percentual real do nível (comissao_percentual do banco)
        try {
          const subRef = await fetch(`${SUPABASE_URL}/rest/v1/subscribers?email=eq.${encodeURIComponent(email)}&select=affiliate_ref`, { headers: supaHeaders });
          const refData = subRef.ok ? await subRef.json() : [];
          const refCode = refData?.[0]?.affiliate_ref;
          if (!refCode) return;
          const affRes = await fetch(`${SUPABASE_URL}/rest/v1/affiliates?ref_code=eq.${refCode}&select=id,comissao_percentual,nivel,email`, { headers: supaHeaders });
          const aff = affRes.ok ? (await affRes.json())?.[0] : null;
          if (!aff?.comissao_percentual) return;
          const rate = aff.comissao_percentual / 100;
          const planAmount = plan === 'master' ? 89.99 : 29.99;
          const correctedAmount = parseFloat((planAmount * rate).toFixed(2));
          await fetch(`${SUPABASE_URL}/rest/v1/affiliate_commissions?affiliate_id=eq.${aff.id}&subscriber_email=eq.${encodeURIComponent(email)}&order=created_at.desc&limit=1`, {
            method: 'PATCH',
            headers: supaHeaders,
            body: JSON.stringify({ commission_rate: rate, commission_amount: correctedAmount })
          });
          console.log(`💰 Commission corrected: ${aff.email} nivel=${aff.nivel} ${(rate*100).toFixed(0)}% = R$${correctedAmount} (${email})`);
        } catch(e) { console.error('Commission correction error:', e.message); }
      }).catch(() => {});

      // ── Programa Pioneiros: registra indicação se houver ref ────────────
      try {
        const pioRef = session.metadata?.ref || session.client_reference_id;
        if (pioRef) {
          const pioR = await fetch(`${SUPABASE_URL}/rest/v1/pioneiros_programa?link_ref=eq.${encodeURIComponent(pioRef)}&select=id,status&limit=1`, { headers: supaHeaders });
          const [pioneiro] = pioR.ok ? await pioR.json() : [];
          if (pioneiro && pioneiro.status !== 'bloqueado') {
            await fetch(`${SUPABASE_URL}/rest/v1/pioneiros_indicacoes`, {
              method: 'POST',
              headers: { ...supaHeaders, Prefer: 'return=minimal' },
              body: JSON.stringify({
                pioneiro_id: pioneiro.id,
                link_ref: pioRef,
                assinante_email: email,
                stripe_customer_id: customerId,
                stripe_subscription_id: subscriptionId,
                plano: plan,
                valor_mensal: plan === 'master' ? 89.99 : 29.99,
                meses_ativos: 1,
                primeira_cobranca_em: new Date().toISOString(),
                ultima_cobranca_em: new Date().toISOString(),
              }),
            });
            await fetch(`${SUPABASE_URL}/rest/v1/rpc/increment_pioneiro_indicados`, {
              method: 'POST',
              headers: { ...supaHeaders, Prefer: 'return=minimal' },
              body: JSON.stringify({ pid: pioneiro.id }),
            }).catch(async () => {
              // Fallback se a função RPC não existir — PATCH direto
              const cur = await fetch(`${SUPABASE_URL}/rest/v1/pioneiros_programa?id=eq.${pioneiro.id}&select=assinantes_indicados`, { headers: supaHeaders });
              const [row] = cur.ok ? await cur.json() : [{ assinantes_indicados: 0 }];
              await fetch(`${SUPABASE_URL}/rest/v1/pioneiros_programa?id=eq.${pioneiro.id}`, {
                method: 'PATCH',
                headers: supaHeaders,
                body: JSON.stringify({ assinantes_indicados: (row.assinantes_indicados || 0) + 1, updated_at: new Date().toISOString() }),
              });
            });
            console.log(`🏆 Pioneiros: indicação registrada para ref=${pioRef} (${email})`);
          }
        }
      } catch (e) { console.error('Pioneiros tracking error:', e.message); }
    }

    // ── RENOVAÇÃO → Atualiza plan_expires_at ─────────────────────────────────
    if (event.type === 'invoice.payment_succeeded') {
      const invoice = event.data.object;
      const customerId = invoice.customer;
      const subscriptionId = invoice.subscription;
      if (!subscriptionId) return res.status(200).json({ received: true });

      // Busca email pelo customer_id
      const subRes = await fetch(`${SUPABASE_URL}/rest/v1/subscribers?stripe_customer_id=eq.${customerId}&select=email,plan`, {
        headers: supaHeaders
      });
      const subs = await subRes.json();
      if (!subs?.length) return res.status(200).json({ received: true });

      const billing = invoice.lines?.data?.[0]?.plan?.interval === 'year' ? 'annual' : 'monthly';
      const expiresAt = billing === 'annual'
        ? new Date(Date.now() + 366 * 24 * 60 * 60 * 1000).toISOString()
        : new Date(Date.now() + 37 * 24 * 60 * 60 * 1000).toISOString();

      await fetch(`${SUPABASE_URL}/rest/v1/subscribers?stripe_customer_id=eq.${customerId}`, {
        method: 'PATCH',
        headers: supaHeaders,
        body: JSON.stringify({ plan_expires_at: expiresAt, updated_at: new Date().toISOString() })
      });

      console.log(`🔄 Renewal: ${subs[0].email} → expires ${expiresAt.split('T')[0]}`);

      // ── Programa Pioneiros: incrementa meses_ativos se for indicação ────
      try {
        const indR = await fetch(`${SUPABASE_URL}/rest/v1/pioneiros_indicacoes?stripe_subscription_id=eq.${subscriptionId}&select=id,meses_ativos,cancelado&limit=1`, { headers: supaHeaders });
        const [ind] = indR.ok ? await indR.json() : [];
        if (ind && !ind.cancelado) {
          await fetch(`${SUPABASE_URL}/rest/v1/pioneiros_indicacoes?id=eq.${ind.id}`, {
            method: 'PATCH',
            headers: supaHeaders,
            body: JSON.stringify({
              meses_ativos: (ind.meses_ativos || 0) + 1,
              ultima_cobranca_em: new Date().toISOString(),
            }),
          });
          console.log(`🏆 Pioneiros: indicação ${ind.id} cresceu pra ${(ind.meses_ativos || 0) + 1} mes(es)`);
        }
      } catch (e) { console.error('Pioneiros renewal tracking error:', e.message); }

      // Comissão recorrente do afiliado
      const SITE_URL_R = process.env.SITE_URL || 'https://bluetubeviral.com';
      const renewEmail = subs[0].email;
      const renewPlan = subs[0].plan;
      fetch(`${SITE_URL_R}/api/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'renewal', email: renewEmail, plan: renewPlan })
      }).then(async () => {
        // Corrige comissão com o percentual real do nível
        try {
          const subRef = await fetch(`${SUPABASE_URL}/rest/v1/subscribers?email=eq.${encodeURIComponent(renewEmail)}&select=affiliate_ref`, { headers: supaHeaders });
          const refData = subRef.ok ? await subRef.json() : [];
          const refCode = refData?.[0]?.affiliate_ref;
          if (!refCode) return;
          const affRes = await fetch(`${SUPABASE_URL}/rest/v1/affiliates?ref_code=eq.${refCode}&select=id,comissao_percentual,nivel`, { headers: supaHeaders });
          const aff = affRes.ok ? (await affRes.json())?.[0] : null;
          if (!aff?.comissao_percentual) return;
          const rate = aff.comissao_percentual / 100;
          const planAmount = renewPlan === 'master' ? 89.99 : 29.99;
          const correctedAmount = parseFloat((planAmount * rate).toFixed(2));
          await fetch(`${SUPABASE_URL}/rest/v1/affiliate_commissions?affiliate_id=eq.${aff.id}&subscriber_email=eq.${encodeURIComponent(renewEmail)}&order=created_at.desc&limit=1`, {
            method: 'PATCH',
            headers: supaHeaders,
            body: JSON.stringify({ commission_rate: rate, commission_amount: correctedAmount })
          });
          console.log(`🔄 Renewal commission corrected: nivel=${aff.nivel} ${(rate*100).toFixed(0)}% = R$${correctedAmount}`);
        } catch(e) { console.error('Renewal commission correction error:', e.message); }
      }).catch(() => {});
    }

    // ── FALHA DE PAGAMENTO → Loga para acompanhar ────────────────────────────
    if (event.type === 'invoice.payment_failed') {
      const invoice = event.data.object;
      const customerId = invoice.customer;
      const attemptCount = invoice.attempt_count;

      const subRes = await fetch(`${SUPABASE_URL}/rest/v1/subscribers?stripe_customer_id=eq.${customerId}&select=email,plan`, {
        headers: supaHeaders
      });
      const subs = await subRes.json();
      const email = subs?.[0]?.email || 'desconhecido';

      // Após 3 tentativas falhas o Stripe cancela automaticamente
      // Loga para visibilidade no admin
      console.log(`⚠️ Payment failed: ${email} — tentativa ${attemptCount}/3`);

      notifyStripe(`⚠️ Pagamento falhou — ${email}`, [
        ['Cliente', email],
        ['Plano', subs?.[0]?.plan?.toUpperCase() || '—'],
        ['Tentativa', `${attemptCount}/3`],
        ['Status', attemptCount >= 3 ? '🔴 Downgrade automático' : '🟡 Aguardando retry'],
        ['Stripe ID', customerId || '—'],
      ]).catch(() => {});

      // Na 3ª falha, faz downgrade preventivo
      if (attemptCount >= 3) {
        await fetch(`${SUPABASE_URL}/rest/v1/subscribers?stripe_customer_id=eq.${customerId}`, {
          method: 'PATCH',
          headers: supaHeaders,
          body: JSON.stringify({ plan: 'free', plan_expires_at: null, updated_at: new Date().toISOString() })
        });
        console.log(`⬇️ Downgrade por falha de pagamento: ${email}`);
      }
    }

    // ── CANCELAMENTO ─────────────────────────────────────────────────────────
    // customer.subscription.deleted = período atual expirou E cancelamento efetivado
    // Usa current_period_end para manter acesso até o final do período pago
    if (event.type === 'customer.subscription.deleted') {
      const sub = event.data.object;
      const customerId = sub.customer;

      // current_period_end = timestamp Unix de quando o período pago termina
      // Se já passou → rebaixa agora. Se ainda não passou → agenda expiração
      const periodEnd = sub.current_period_end
        ? new Date(sub.current_period_end * 1000)
        : new Date();
      const now = new Date();
      const expiresAt = periodEnd > now ? periodEnd : now;

      // Mantém o plano atual mas define expiração = fim do período pago
      // get-plan.js já respeita plan_expires_at para decidir se é premium
      const subRes = await fetch(
        `${SUPABASE_URL}/rest/v1/subscribers?stripe_customer_id=eq.${customerId}&select=email,plan`,
        { headers: supaHeaders }
      );
      const subs = await subRes.json();
      const cancelledEmail = subs?.[0]?.email;
      const currentPlan = subs?.[0]?.plan || 'free';

      // Se o período ainda não acabou, mantém o plano com data de expiração
      // Se já acabou, rebaixa para free imediatamente
      const stillActive = periodEnd > now;
      await fetch(`${SUPABASE_URL}/rest/v1/subscribers?stripe_customer_id=eq.${customerId}`, {
        method: 'PATCH',
        headers: supaHeaders,
        body: JSON.stringify({
          plan: stillActive ? currentPlan : 'free',
          plan_expires_at: stillActive ? expiresAt.toISOString() : null,
          updated_at: now.toISOString()
        })
      });

      console.log(`⬇️ Subscription cancelled: ${cancelledEmail || customerId} | Active until: ${expiresAt.toISOString()} | Still active: ${stillActive}`);

      // Programa Pioneiros: marca indicação como cancelada (perde qualificação)
      try {
        await fetch(`${SUPABASE_URL}/rest/v1/pioneiros_indicacoes?stripe_subscription_id=eq.${sub.id}`, {
          method: 'PATCH',
          headers: supaHeaders,
          body: JSON.stringify({ cancelado: true, qualificado: false }),
        });
      } catch(e) { console.error('Pioneiros cancel tracking:', e.message); }

      notifyStripe(`😢 Cancelamento — ${currentPlan.toUpperCase()} — ${cancelledEmail || customerId}`, [
        ['Cliente', cancelledEmail || customerId],
        ['Plano cancelado', `${currentPlan === 'master' ? '👑' : '⚡'} ${currentPlan.toUpperCase()}`],
        ['Acesso até', stillActive ? expiresAt.toLocaleDateString('pt-BR') : 'Imediato'],
        ['Status', stillActive ? '🟡 Ativo até fim do período' : '🔴 Rebaixado para Free'],
      ]).catch(() => {});

      // Cancela comissões do afiliado (apenas quando rebaixar de verdade)
      if (cancelledEmail && !stillActive) {
        const SITE_URL_C = process.env.SITE_URL || 'https://bluetubeviral.com';
        fetch(`${SITE_URL_C}/api/auth`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'cancel', email: cancelledEmail })
        }).catch(() => {});
      }
    }

    // ── ASSINATURA AGENDADA PARA CANCELAR (usuario pediu cancelamento mas período ativo) ──
    // customer.subscription.updated com cancel_at_period_end = true
    // Aproveitamos para registrar a data de expiração já no momento do pedido
    if (event.type === 'customer.subscription.updated') {
      const sub = event.data.object;
      if (sub.cancel_at_period_end === true) {
        const customerId = sub.customer;
        const periodEnd = sub.current_period_end
          ? new Date(sub.current_period_end * 1000)
          : null;

        if (periodEnd) {
          const subRes = await fetch(
            `${SUPABASE_URL}/rest/v1/subscribers?stripe_customer_id=eq.${customerId}&select=email,plan`,
            { headers: supaHeaders }
          );
          const subs = await subRes.json();
          const email = subs?.[0]?.email;
          const currentPlan = subs?.[0]?.plan;

          if (email && currentPlan && currentPlan !== 'free') {
            await fetch(`${SUPABASE_URL}/rest/v1/subscribers?stripe_customer_id=eq.${customerId}`, {
              method: 'PATCH',
              headers: supaHeaders,
              body: JSON.stringify({
                plan_expires_at: periodEnd.toISOString(),
                updated_at: new Date().toISOString()
              })
            });
            console.log(`📅 Cancel scheduled: ${email} — expires ${periodEnd.toISOString()}`);

            notifyStripe(`🔄 Cancelamento agendado — ${currentPlan.toUpperCase()} — ${email}`, [
              ['Cliente', email],
              ['Plano', `${currentPlan === 'master' ? '👑' : '⚡'} ${currentPlan.toUpperCase()}`],
              ['Acesso até', periodEnd.toLocaleDateString('pt-BR')],
              ['Status', '📅 Cancelamento agendado — acesso mantido até fim do período'],
            ]).catch(() => {});
          }
        }
      }
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('Webhook processing error:', err);
    // Retorna 200 para o Stripe não ficar tentando reenviar
    return res.status(200).json({ received: true, warning: err.message });
  }
}

// ── Email motivacional pós-upgrade ─────────────────────────────────────────
// Disparado depois de checkout.session.completed. Mensagem muda por plano.
// Fire-and-forget — qualquer falha aqui não afeta a ativação do plano.
async function sendUpgradeEmail(email, plan, billing) {
  const RESEND_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_KEY || !email) return;

  const isMaster = plan === 'master';
  const isAnnual = billing === 'annual';
  const planLabel = isMaster ? 'Master 👑' : 'Full ⚡';
  const subject = isMaster
    ? '👑 Bem-vindo ao Master! Hora de dominar o algoritmo'
    : '⚡ Você ativou o Full! Vamos colocar isso pra rodar';

  const greeting = isMaster
    ? 'Você entrou no topo. Master é pra quem quer <b>viralizar em escala</b>.'
    : 'Agora você tem <b>9 roteiros por dia</b> e acesso total à máquina.';

  const features = isMaster ? [
    { icon: '♾️', title: 'Roteiros ilimitados', text: 'Sem mais fila. Gere quantos quiser, quando quiser.' },
    { icon: '🎙️', title: 'BlueVoice premium', text: 'Narração em IA com vozes profissionais em todos os idiomas.' },
    { icon: '⬇️', title: 'BaixaBlue HD', text: 'Download direto em 1080p sem marca d\'água.' },
    { icon: '🔥', title: 'Virais + BlueScore + BlueLens', text: 'Descubra tendências, pontue canais e detecte reposts.' },
  ] : [
    { icon: '✍️', title: '9 roteiros por dia', text: 'O triplo do plano Free. Suficiente pra alimentar 3 canais.' },
    { icon: '🌎', title: 'Todos os idiomas', text: 'Gere roteiros em PT, EN, ES, FR e mais 20 idiomas.' },
    { icon: '📊', title: 'BlueScore + BlueLens', text: 'Análise de canal + detector de reposts no seu nicho.' },
    { icon: '🔥', title: 'Buscador de Virais', text: 'Ache tendências antes que saturem.' },
  ];

  const featuresHtml = features.map(f => `
    <div style="display:flex;gap:14px;align-items:flex-start;padding:14px 0;border-bottom:1px solid rgba(0,170,255,.08)">
      <div style="font-size:22px;line-height:1;flex-shrink:0;width:32px;text-align:center">${f.icon}</div>
      <div style="flex:1"><div style="color:#fff;font-size:14px;font-weight:700;margin-bottom:2px">${f.title}</div><div style="color:rgba(200,225,255,.7);font-size:13px;line-height:1.5">${f.text}</div></div>
    </div>`).join('');

  const masterOnly = isMaster ? `
    <div style="margin-top:20px;padding:16px;background:linear-gradient(135deg,rgba(255,215,0,.08),rgba(245,158,11,.08));border:1px solid rgba(255,215,0,.25);border-radius:14px">
      <div style="font-size:11px;font-weight:700;color:#FFD700;letter-spacing:.08em;text-transform:uppercase;margin-bottom:6px">🏆 Exclusivo Master</div>
      <div style="color:#fff;font-size:14px;font-weight:700;margin-bottom:4px">Programa Pioneiros</div>
      <div style="color:rgba(200,225,255,.7);font-size:13px;line-height:1.5">Chegue a 1.000 seguidores no Blue e <b style="color:#FFD700">ganhe R$1.000</b> indicando 100 assinantes. <a href="https://bluetubeviral.com/pioneiros.html" style="color:#00aaff;text-decoration:none;font-weight:600">Ver programa →</a></div>
    </div>` : '';

  const html = `<div style="font-family:-apple-system,'Segoe UI',sans-serif;max-width:600px;margin:0 auto;background:#020817;color:#e8f4ff">
    <div style="background:linear-gradient(135deg,${isMaster ? '#FFD700,#f59e0b' : '#1a6bff,#00aaff'});padding:36px 28px;text-align:center">
      <div style="font-size:32px;font-weight:900;color:${isMaster ? '#020817' : '#fff'};letter-spacing:-1px">BlueTube</div>
      <div style="font-size:13px;color:${isMaster ? 'rgba(2,8,23,.7)' : 'rgba(255,255,255,.8)'};margin-top:4px;font-weight:600">Plano ${planLabel}${isAnnual ? ' · Anual' : ''}</div>
    </div>
    <div style="padding:32px 28px">
      <h1 style="font-size:26px;font-weight:900;margin:0 0 12px;color:#fff;letter-spacing:-.5px;line-height:1.2">${isMaster ? 'Bem-vindo ao topo.' : 'Bem-vindo ao Full.'}</h1>
      <p style="font-size:15px;color:rgba(200,225,255,.75);line-height:1.6;margin:0 0 24px">${greeting}</p>

      <p style="font-size:14px;color:rgba(200,225,255,.85);line-height:1.7;margin:0 0 20px">
        Você não assinou uma ferramenta. Você assinou uma <b>vantagem injusta</b> sobre quem ainda roteiriza na força do braço.
        Enquanto a maioria gasta 2h numa ideia, você vai gastar <b>2 minutos</b>. Essa diferença vai virar views. Views viram seguidores.
        Seguidores viram dinheiro.
      </p>

      <div style="background:rgba(0,170,255,.04);border:1px solid rgba(0,170,255,.12);border-radius:14px;padding:8px 18px;margin:24px 0">
        <div style="font-size:11px;font-weight:700;color:#00aaff;letter-spacing:.08em;text-transform:uppercase;padding:14px 0 6px">O que você liberou</div>
        ${featuresHtml}
      </div>

      ${masterOnly}

      <div style="margin:28px 0 8px">
        <a href="https://bluetubeviral.com" style="display:inline-block;background:linear-gradient(135deg,${isMaster ? '#FFD700,#f59e0b' : '#1a6bff,#00aaff'});color:${isMaster ? '#020817' : '#fff'};padding:16px 32px;border-radius:12px;text-decoration:none;font-size:15px;font-weight:800;letter-spacing:-.2px">Começar agora →</a>
      </div>

      <div style="margin-top:32px;padding-top:20px;border-top:1px solid rgba(0,170,255,.1);font-size:13px;color:rgba(200,225,255,.55);line-height:1.7">
        <b style="color:rgba(200,225,255,.8)">Dica de quem já usa:</b> os criadores que mais cresceram no BlueTube <b>postaram todo dia nos primeiros 30 dias</b>. Consistência vence algoritmo. Vence talento. Vence tudo.
        <br><br>
        Qualquer dúvida, responde esse email — um humano responde em até 24h.
      </div>

      <div style="margin-top:24px;text-align:center;font-size:11px;color:rgba(150,190,230,.4)">
        Você recebeu porque ativou o plano ${planLabel} em bluetubeviral.com
      </div>
    </div>
  </div>`;

  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + RESEND_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'Felipe (BlueTube) <felipe@bluetubeviral.com>',
      to: email,
      reply_to: 'felipe@bluetubeviral.com',
      subject,
      html,
    }),
  });
}
