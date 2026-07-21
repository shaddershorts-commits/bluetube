// api/_helpers/affiliate-mrr.js
// FONTE ÚNICA da comissão do afiliado — modelo MRR mensal recorrente, TEMPO REAL.
//
// Regra (decisão do user 2026-07-21, Opção A): a comissão é a soma dos assinantes
// ATIVOS AGORA indicados pelo afiliado × preço do plano × taxa dele. Recorrente
// enquanto ativos; se um cancela, cai NA HORA (o webhook faz plan→free → ele sai
// da contagem). NÃO é soma de linhas `affiliate_commissions` pending (modelo antigo
// que divergia — essas linhas viram só histórico/auditoria).
//
// Conta AO VIVO de `subscribers` por `affiliate_ref` (não do contador em cache) →
// zero drift, imune a case-sensitivity de email (casa por ref_code, não por email).
// Usado por: dashboard do afiliado, card/pedido de saque, e botão Pix do admin —
// os 3 SEMPRE mostram/pagam o mesmo número.

const PLAN_AMOUNTS_MRR = { full: 29.99, master: 89.99 };

// Taxa efetiva: override manual do admin (comissao_percentual) tem prioridade;
// senão, nível por total de pagantes (espelha getEffectiveRate do affiliate.js).
function effectiveRate(affiliate) {
  if (affiliate && typeof affiliate.comissao_percentual === 'number' && affiliate.comissao_percentual > 0) {
    return affiliate.comissao_percentual / 100;
  }
  const tp = (affiliate && (affiliate.total_full || 0) + (affiliate.total_master || 0)) || 0;
  return tp >= 1000 ? 0.58 : tp >= 380 ? 0.40 : 0.35;
}

// Retorna { activeFull, activeMaster, rate, mrr }. Fail-safe: erro de infra → 0
// (nunca paga um número inventado; melhor R$0 do que valor errado).
async function computeAffiliateMRR(SUPA_URL, headers, affiliate) {
  const rate = effectiveRate(affiliate);
  const refCode = affiliate && affiliate.ref_code;
  if (!refCode) return { activeFull: 0, activeMaster: 0, rate, mrr: 0 };
  let activeFull = 0, activeMaster = 0;
  try {
    const url = `${SUPA_URL}/rest/v1/subscribers?affiliate_ref=eq.${encodeURIComponent(refCode)}&plan=in.(full,master)&select=plan,plan_expires_at,is_manual&limit=20000`;
    const r = await fetch(url, { headers });
    if (r.ok) {
      const subs = await r.json();
      if (Array.isArray(subs)) {
        for (const s of subs) {
          const ativo = s.is_manual || !s.plan_expires_at || new Date(s.plan_expires_at) > new Date();
          if (!ativo) continue;
          if (s.plan === 'full') activeFull++;
          else if (s.plan === 'master') activeMaster++;
        }
      }
    }
  } catch (e) { /* fail-safe → 0 */ }
  const mrr = +(activeFull * PLAN_AMOUNTS_MRR.full * rate + activeMaster * PLAN_AMOUNTS_MRR.master * rate).toFixed(2);
  return { activeFull, activeMaster, rate, mrr };
}

module.exports = { computeAffiliateMRR, effectiveRate, PLAN_AMOUNTS_MRR };
