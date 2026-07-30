// api/plan-expiry-sweep.js — avisa quem vai perder o plano e rebaixa depois.
//
// POR QUE EXISTE (achado de 2026-07-30):
// varrendo o banco achamos 3 trials de 30 dias que acabaram EM SILÊNCIO — sem
// um único email — e 1 assinante paga (Ana) cuja assinatura foi cancelada por
// bug nosso. O acesso já era cortado corretamente (get-plan respeita a
// expiração), mas a coluna `plan` seguia marcando "full"/"master" pra sempre,
// contaminando contagem e relatório. E ninguém era avisado de nada.
//
// REGRA:
//   1. avisa quem vence em ate 3 dias (ou ja venceu) e ainda nao foi avisado
//   2. rebaixa pra free quem venceu E foi avisado ha 3+ dias
//   Ou seja: NINGUEM e rebaixado sem ter sido avisado antes.
//
// DOIS TEXTOS, porque as situacoes sao diferentes de verdade:
//   trial_origin preenchido  → "seu teste acabou" (nunca pagou nada)
//   trial_origin vazio       → "nao identificamos a renovacao" (era pagante)
//
// SEGURANCA:
//   • modo SIMULACAO por padrao. So dispara com ?executar=1
//   • is_manual=true nunca e tocado (presentes, parceiros, conta do dono)
//   • teto de emails por rodada — bug nao vira disparo em massa
//   • antes de rebaixar quem tem assinatura no Stripe, CONFERE no Stripe se
//     ela nao esta ativa. Data velha no banco nao pode derrubar pagante.

const LIMITE_EMAILS_RODADA = 40;
const CARENCIA_DIAS = 3;
const AVISO_ANTES_DIAS = 3;

// ── DETECTOR DE ANOMALIA ────────────────────────────────────────────────────
// O cron sozinho trata sintoma, não causa: pra ele, um pagante que perdeu a
// assinatura por bug NOSSO é idêntico a quem parou de pagar. Foi o caso da Ana
// (2026-06-23): automação cancelou as duas assinaturas dela no mesmo segundo, e
// sem este detector o cron mandaria "não identificamos a renovação" — ou seja,
// culparia a cliente pelo nosso erro.
//
// Assinatura de anomalia: pagou de verdade + NUNCA pediu cancelamento + o plano
// caiu mesmo assim, faz pouco tempo. Falha de cartão não cai aqui — essa é
// tratada pelo dunning, que roda antes.
const ANOMALIA_JANELA_DIAS = 45;

function ehAnomalia(s, agora) {
  if (s.trial_origin) return null;                    // trial não é pagante
  const pagou = Number(s.amount_paid) > 0;
  if (!pagou) return null;
  if (s.cancel_at_period_end === true) return null;   // ele PEDIU pra sair
  if (!s.plan_expires_at) return null;
  const venceuHa = (agora - new Date(s.plan_expires_at)) / 864e5;
  if (venceuHa < 0 || venceuHa > ANOMALIA_JANELA_DIAS) return null;
  return `pagou ${s.amount_paid} e nunca pediu cancelamento, mas o plano caiu ha ${Math.round(venceuHa)}d`;
}

const ASSINE = 'https://bluetubeviral.com/?upgrade=full';

// ── textos ──────────────────────────────────────────────────────────────────
function moldura(titulo, corpo, cta, ctaTexto) {
  return `<div style="max-width:520px;margin:0 auto;background:#020817;border:1px solid rgba(0,170,255,.15);border-radius:16px;overflow:hidden;font-family:-apple-system,Segoe UI,sans-serif">
    <div style="padding:28px 28px 8px">
      <div style="color:#e8f4ff;font-size:20px;font-weight:800;margin-bottom:14px">${titulo}</div>
      ${corpo}
      <a href="${cta}" style="display:inline-block;margin:22px 0 6px;background:linear-gradient(135deg,#1a6bff,#00aaff);color:#fff;text-decoration:none;padding:13px 26px;border-radius:10px;font-weight:700;font-size:14px">${ctaTexto}</a>
      <p style="color:rgba(200,225,255,.5);font-size:12px;line-height:1.6;margin:22px 0 0">
        Dúvida? Responde esse email ou escreve pra <a href="mailto:suporte@bluetubeviral.com" style="color:#00aaff;text-decoration:none">suporte@bluetubeviral.com</a>.
      </p>
    </div>
    <div style="padding:18px 28px;text-align:center;border-top:1px solid rgba(0,170,255,.08)">
      <div style="color:rgba(150,190,230,.4);font-size:11px;font-family:monospace;letter-spacing:.08em">BLUETUBE · CRIADOR VIRAL</div>
    </div>
  </div>`;
}

const P = (t) => `<p style="color:rgba(200,225,255,.8);font-size:14px;line-height:1.65;margin:0 0 12px">${t}</p>`;

function emailTrial({ venceu, dias }) {
  const quando = venceu
    ? 'terminou'
    : (dias <= 1 ? 'termina <b>amanhã</b>' : `termina em <b>${dias} dias</b>`);
  return {
    subject: venceu ? 'Seu teste do BlueTube Full terminou' : `Seu teste do Full ${dias <= 1 ? 'termina amanhã' : `termina em ${dias} dias`}`,
    html: moldura(
      venceu ? 'Seu teste de 30 dias terminou' : 'Seu teste de 30 dias está acabando',
      P(`Seu período de teste do <b>Full</b> ${quando}.`) +
      P('Sem ele você perde a transcrição ilimitada, os roteiros Casual e Apelativo, a Tradução Fiel e o Blublu ajustando teu roteiro.') +
      P('Se te ajudou a produzir, é só assinar e continuar de onde parou — teus roteiros continuam salvos.'),
      ASSINE,
      venceu ? 'Assinar e voltar' : 'Continuar com o Full'
    ),
  };
}

function emailRenovacao({ venceu, dias }) {
  return {
    subject: venceu ? 'Não identificamos a renovação do seu plano' : `Seu plano vence em ${dias} dias`,
    html: moldura(
      venceu ? 'Não identificamos a renovação' : 'Seu plano está para vencer',
      P(venceu
        ? 'Não identificamos o pagamento de renovação do seu plano.'
        : `Seu plano vence em <b>${dias} dias</b> e não há renovação registrada.`) +
      P(`Se não houver a renovação, em <b>${CARENCIA_DIAS} dias</b> a conta passa automaticamente para o plano gratuito. Nada é apagado — teus roteiros e projetos continuam lá.`) +
      P('Se você já renovou nas últimas horas, pode ignorar este email.'),
      ASSINE,
      'Renovar agora'
    ),
  };
}

// ── Stripe: a assinatura está mesmo morta? ─────────────────────────────────
// Data velha no banco NÃO pode derrubar quem está pagando.
async function assinaturaViva(subId, chave) {
  if (!subId || !chave) return false;
  try {
    const r = await fetch('https://api.stripe.com/v1/subscriptions/' + subId, {
      headers: { Authorization: 'Bearer ' + chave }, signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return false;
    const s = await r.json();
    return s.status === 'active' || s.status === 'trialing' || s.status === 'past_due';
  } catch { return true; }   // na dúvida (Stripe fora), NÃO rebaixa
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const SEGREDO = process.env.ADMIN_SECRET;
  const dado = req.query?.admin_secret || (req.headers.authorization || '').replace('Bearer ', '');
  if (!SEGREDO || dado !== SEGREDO) return res.status(401).json({ error: 'nao autorizado' });

  const SU = process.env.SUPABASE_URL;
  const SK = process.env.SUPABASE_SERVICE_KEY;
  const RESEND = process.env.RESEND_API_KEY;
  const STRIPE = process.env.STRIPE_SECRET_KEY;
  if (!SU || !SK) return res.status(500).json({ error: 'supabase nao configurado' });
  const H = { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' };

  // TRAVA: sem ?executar=1 nada sai daqui. Email pra cliente real não pode
  // depender de eu não ter errado a query.
  const executar = req.query?.executar === '1';
  const agora = new Date();

  const relatorio = { modo: executar ? 'EXECUTADO' : 'SIMULACAO', avisados: [], rebaixados: [], anomalias: [], sem_expiracao: [], pulados: [], erros: [] };

  try {
    const limite = new Date(agora.getTime() + AVISO_ANTES_DIAS * 864e5).toISOString();
    const r = await fetch(
      `${SU}/rest/v1/subscribers?plan=neq.free&is_manual=eq.false&plan_expires_at=not.is.null&plan_expires_at=lt.${limite}` +
      // cancel_at_period_end é OBRIGATÓRIO aqui: o detector de anomalia usa. Sem
      // ele no select vira undefined e quem PEDIU cancelamento seria marcado
      // como anomalia. Campo fora do select = dado silenciosamente errado.
      `&select=email,plan,trial_origin,plan_expires_at,expiry_notice_sent_at,stripe_subscription_id,amount_paid,cancel_at_period_end&order=plan_expires_at.asc`,
      { headers: H }
    );
    if (!r.ok) return res.status(500).json({ error: 'consulta falhou', detalhe: (await r.text()).slice(0, 200) });
    const lista = await r.json();

    for (const s of lista) {
      const venceEm = new Date(s.plan_expires_at);
      const venceu = venceEm < agora;
      const dias = Math.max(0, Math.ceil((venceEm - agora) / 864e5));
      const avisadoEm = s.expiry_notice_sent_at ? new Date(s.expiry_notice_sent_at) : null;
      const ehTrial = !!s.trial_origin;

      // ANOMALIA: não manda email nem rebaixa. Isso é caso pra humano olhar —
      // pode ser bug nosso tendo derrubado alguém que estava pagando.
      const suspeita = ehAnomalia(s, agora);
      if (suspeita && !avisadoEm) {
        relatorio.anomalias.push({ email: s.email, plano: s.plan, pago: s.amount_paid, motivo: suspeita });
        continue;
      }

      // ── REBAIXAR: venceu E foi avisado há 3+ dias ──
      if (venceu && avisadoEm && (agora - avisadoEm) >= CARENCIA_DIAS * 864e5) {
        if (s.stripe_subscription_id && await assinaturaViva(s.stripe_subscription_id, STRIPE)) {
          relatorio.pulados.push({ email: s.email, motivo: 'assinatura VIVA no Stripe — data do banco estava velha' });
          continue;
        }
        if (executar) {
          await fetch(`${SU}/rest/v1/subscribers?email=eq.${encodeURIComponent(s.email)}`, {
            method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' },
            body: JSON.stringify({ plan: 'free', plan_expires_at: null, updated_at: agora.toISOString() }),
          });
        }
        relatorio.rebaixados.push({ email: s.email, de: s.plan, era_trial: ehTrial });
        continue;
      }

      // ── AVISAR: ainda não avisado ──
      if (!avisadoEm) {
        if (relatorio.avisados.length >= LIMITE_EMAILS_RODADA) {
          relatorio.pulados.push({ email: s.email, motivo: 'teto de emails da rodada' });
          continue;
        }
        const msg = ehTrial ? emailTrial({ venceu, dias }) : emailRenovacao({ venceu, dias });
        if (executar) {
          if (!RESEND) { relatorio.erros.push({ email: s.email, erro: 'RESEND_API_KEY ausente' }); continue; }
          const er = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + RESEND, 'Content-Type': 'application/json' },
            body: JSON.stringify({ from: 'BlueTube <noreply@bluetubeviral.com>', to: [s.email], subject: msg.subject, html: msg.html }),
          });
          if (!er.ok) { relatorio.erros.push({ email: s.email, erro: 'resend_' + er.status }); continue; }
          await fetch(`${SU}/rest/v1/subscribers?email=eq.${encodeURIComponent(s.email)}`, {
            method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' },
            body: JSON.stringify({ expiry_notice_sent_at: agora.toISOString() }),
          });
        }
        relatorio.avisados.push({ email: s.email, tipo: ehTrial ? 'trial' : 'renovacao', venceu, dias, assunto: msg.subject });
        continue;
      }

      relatorio.pulados.push({ email: s.email, motivo: venceu ? 'na carência de 3 dias' : 'já avisado' });
    }

    relatorio.total_analisados = lista.length;

    // ── ZONA CEGA: plano pago, não-manual e SEM data de expiração ───────────
    // Esses nunca entram na varredura acima (o filtro exige plan_expires_at),
    // então ficariam com plano pago pra sempre. Hoje são 0, mas "zero hoje" não
    // é "impossível amanhã". NÃO rebaixo automaticamente — pode ser concessão
    // legítima que esqueceram de marcar is_manual. Só alerto pra humano decidir.
    try {
      const cr = await fetch(
        `${SU}/rest/v1/subscribers?plan=neq.free&is_manual=eq.false&plan_expires_at=is.null&select=email,plan,amount_paid,trial_origin,created_at&limit=50`,
        { headers: H }
      );
      if (cr.ok) {
        for (const s of await cr.json()) {
          relatorio.sem_expiracao.push({ email: s.email, plano: s.plan, pago: s.amount_paid, desde: (s.created_at || '').slice(0, 10) });
        }
      }
    } catch (e) { relatorio.erros.push({ etapa: 'zona_cega', erro: (e.message || '').slice(0, 120) }); }

    // ── ALERTA PRO ADMIN ────────────────────────────────────────────────────
    // Anomalia e zona cega são casos pra humano olhar, não pra automação
    // resolver. Sem este alerta, fui EU que descobri a Ana — cinco semanas
    // depois, no olho.
    const precisaOlhar = relatorio.anomalias.length + relatorio.sem_expiracao.length;
    if (precisaOlhar > 0 && executar && RESEND && process.env.ADMIN_EMAIL) {
      const linha = (x) => `<li style="margin-bottom:6px"><b>${x.email}</b> (${x.plano}) — ${x.motivo || 'plano pago sem data de expiração desde ' + x.desde}</li>`;
      const corpo =
        (relatorio.anomalias.length
          ? `<p><b>${relatorio.anomalias.length} possível(is) vítima(s) de falha nossa</b> — pagaram, nunca pediram cancelamento, e mesmo assim o plano caiu. <b>Não receberam email</b> e não foram rebaixados.</p><ul>${relatorio.anomalias.map(linha).join('')}</ul>` : '')
        + (relatorio.sem_expiracao.length
          ? `<p><b>${relatorio.sem_expiracao.length} com plano pago e SEM data de expiração</b> — invisíveis à varredura. Ou marca is_manual=true (se for concessão), ou põe data.</p><ul>${relatorio.sem_expiracao.map(linha).join('')}</ul>` : '');
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + RESEND, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: 'BlueTube <noreply@bluetubeviral.com>',
          to: [process.env.ADMIN_EMAIL],
          subject: `[BlueTube] ${precisaOlhar} caso(s) de plano pra investigar`,
          html: `<div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:600px">${corpo}<p style="color:#888;font-size:12px">Varredura automática de planos — ${agora.toISOString().slice(0, 16)}</p></div>`,
        }),
      }).catch(() => {});
      relatorio.alerta_admin_enviado = true;
    }

    return res.status(200).json(relatorio);
  } catch (e) {
    return res.status(500).json({ error: 'excecao', detalhe: (e.message || '').slice(0, 200) });
  }
};

// exportado pro teste conferir os textos sem rede
module.exports.emailTrial = emailTrial;
module.exports.emailRenovacao = emailRenovacao;
module.exports.CARENCIA_DIAS = CARENCIA_DIAS;
module.exports.ehAnomalia = ehAnomalia;
module.exports.ANOMALIA_JANELA_DIAS = ANOMALIA_JANELA_DIAS;
