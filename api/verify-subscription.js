// api/verify-subscription.js — verifica assinatura direto no Stripe (CommonJS)
// Chamado quando o usuario faz login ou quando o front quer confirmar que
// o plano esta em dia. Se houver divergencia entre Stripe e Supabase,
// sincroniza automaticamente usando o Stripe como fonte da verdade.

const { verificarAssinaturaAtiva, supaFetch } = require('./_helpers/stripe.js');

// Detecta plano a partir do unit_amount do preco da subscription.
// Tolera pequenas variacoes (cupons, planos anuais) por faixas de valor.
// Valores em centavos (BRL): Full mensal 2999, anual 26988 (~22.49/mes);
// Master mensal 8999, anual 80988 (~67.49/mes).
function determinarPlano(assinatura) {
  if (!assinatura) return 'free';
  // Se metadata.plan foi setado na subscription, prefere ele
  const metaPlan = assinatura.metadata?.plan;
  if (metaPlan === 'full' || metaPlan === 'master') return metaPlan;
  const amount = assinatura.price_amount || 0;
  const interval = assinatura.price_interval || 'month';
  if (interval === 'year') {
    if (amount >= 50000) return 'master'; // R$500+/ano
    if (amount >= 15000) return 'full';   // R$150+/ano
  } else {
    if (amount >= 6000) return 'master';  // R$60+/mes
    if (amount >= 2000) return 'full';    // R$20+/mes
  }
  return 'free';
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = req.query?.token || req.body?.token;
  if (!token) return res.status(401).json({ error: 'Token necessario' });

  const SU = process.env.SUPABASE_URL;
  const SK = process.env.SUPABASE_SERVICE_KEY;
  const AK = process.env.SUPABASE_ANON_KEY || SK;
  if (!SU || !SK) return res.status(500).json({ error: 'config_missing' });

  try {
    // 1. Resolve token -> email via Supabase Auth (nao ha coluna token em subscribers)
    const userRes = await fetch(`${SU}/auth/v1/user`, {
      headers: { apikey: AK, Authorization: 'Bearer ' + token },
    });
    if (!userRes.ok) return res.status(401).json({ error: 'token_invalido' });
    const user = await userRes.json();
    const email = user.email;
    if (!email) return res.status(401).json({ error: 'sem_email' });

    // 2. Busca subscriber pelo email
    const subs = await supaFetch(
      `/subscribers?email=eq.${encodeURIComponent(email)}&select=email,plan,is_manual,stripe_customer_id,stripe_subscription_id,plan_expires_at`
    );
    const subscriber = subs?.[0];

    // 3. Plano manual (admin liberou) — confia no banco
    if (subscriber?.is_manual) {
      return res.status(200).json({
        plano: subscriber.plan,
        ativa: subscriber.plan !== 'free',
        plan_expires_at: subscriber.plan_expires_at,
        verificado_em: new Date().toISOString(),
        fonte: 'manual',
      });
    }

    // 4. Sem customer Stripe — provavelmente free
    if (!subscriber?.stripe_customer_id) {
      return res.status(200).json({
        plano: subscriber?.plan || 'free',
        ativa: false,
        verificado_em: new Date().toISOString(),
        fonte: 'database',
      });
    }

    // 5. Consulta Stripe diretamente
    const assinatura = await verificarAssinaturaAtiva(subscriber.stripe_customer_id);

    if (!assinatura) {
      // Stripe nao tem assinatura ativa — respeita plan_expires_at se ainda no prazo
      const aindaAtivo = subscriber.plan_expires_at
        && new Date(subscriber.plan_expires_at) > new Date();
      return res.status(200).json({
        plano: aindaAtivo ? subscriber.plan : 'free',
        ativa: !!aindaAtivo,
        plan_expires_at: subscriber.plan_expires_at,
        verificado_em: new Date().toISOString(),
        fonte: aindaAtivo ? 'database_ate_expiracao' : 'stripe_sem_assinatura',
      });
    }

    // 6. Stripe confirma assinatura ativa — determina plano e sincroniza se divergir
    const planoCorrreto = determinarPlano(assinatura);
    const precisaSync = subscriber.plan !== planoCorrreto
      || subscriber.stripe_subscription_id !== assinatura.stripe_subscription_id
      || !subscriber.plan_expires_at
      || new Date(subscriber.plan_expires_at).getTime() !== new Date(assinatura.expira_em).getTime();

    if (precisaSync) {
      console.log(`[verify-sub] sincronizando ${email}: ${subscriber.plan} -> ${planoCorrreto}`);
      await supaFetch(`/subscribers?email=eq.${encodeURIComponent(email)}`, {
        method: 'PATCH',
        prefer: 'return=minimal',
        body: {
          plan: planoCorrreto,
          stripe_subscription_id: assinatura.stripe_subscription_id,
          plan_expires_at: assinatura.expira_em,
          updated_at: new Date().toISOString(),
        },
      }).catch((e) => console.error('[verify-sub] sync falhou:', e.message));
    }

    return res.status(200).json({
      plano: planoCorrreto,
      ativa: true,
      plan_expires_at: assinatura.expira_em,
      cancel_at_period_end: assinatura.cancel_at_period_end,
      stripe_subscription_id: assinatura.stripe_subscription_id,
      sincronizado: precisaSync,
      verificado_em: new Date().toISOString(),
      fonte: 'stripe_direct',
    });
  } catch (err) {
    console.error('[verify-subscription] erro:', err.message);
    // Fail open — nao bloqueia usuario se verificacao falhar
    return res.status(200).json({
      plano: 'free',
      erro: 'Nao foi possivel verificar',
      verificado_em: new Date().toISOString(),
      fonte: 'fallback',
    });
  }
};
