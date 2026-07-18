// api/_helpers/affiliate-comissao-email.js — email instantâneo de comissão pro
// afiliado (3 variações rotativas: gratidão/momentum/semente — parceiros BlueTube).
//
// FONTE ÚNICA chamada pelo caminho VIVO: webhook.js (checkout pago → auth.js
// cria a comissão → webhook dispara este email). O handler de conversion do
// affiliate.js é código MORTO pra conversões pagas (lição 2026-07-18: o email
// pendurado lá nunca disparou — caso guri/Luiz).
// CJS de propósito: webhook.js é CJS e affiliate.js (ESM) importa default.

function variacoes(nomeAff, valorFmt, planLabel) {
  return [
    {
      assunto: `💙 ${valorFmt} — obrigado por construir isso com a gente, ${nomeAff}`,
      badge: '💙 PARCEIRO BLUETUBE',
      titulo: `Isso aqui é obra sua, ${nomeAff}.`,
      texto: `Mais um criador acabou de entrar pro BlueTube <b style="color:#fff;">pela SUA indicação</b> — e a sua comissão de <b style="color:#10b981;">${valorFmt}</b> já está no seu saldo.<br/><br/>A gente só chega em quem confia em nós porque pessoas como você emprestam a própria credibilidade pra isso. Não é pouca coisa — é a parte mais valiosa que alguém pode dar. <b style="color:#fff;">Obrigado de verdade por fazer parte dos parceiros BlueTube.</b> 💙`,
    },
    {
      assunto: `🚀 +${valorFmt} — teu link tá trabalhando por você, ${nomeAff}`,
      badge: '🚀 SEU LINK EM AÇÃO',
      titulo: `Enquanto você vivia sua vida… caiu mais uma.`,
      texto: `É disso que a gente fala quando fala de renda que trabalha por você: <b style="color:#fff;">nova assinatura ${planLabel}</b> pelo seu link, <b style="color:#10b981;">${valorFmt}</b> de comissão no seu saldo.<br/><br/>Cada indicação tua é prova de que o seu público confia no que você recomenda — e essa confiança está virando resultado. Que orgulho ter você no time de parceiros BlueTube. <b style="color:#fff;">Segue o jogo, que o momentum é seu.</b> 🚀`,
    },
    {
      assunto: `🌱 ${valorFmt} plantados — sua rede tá crescendo, ${nomeAff}`,
      badge: '🌱 SEMENTE PLANTADA',
      titulo: `Cada indicação é uma semente. Essa germinou.`,
      texto: `Nova assinatura ${planLabel} pelo seu link — <b style="color:#10b981;">${valorFmt}</b> direto pro seu saldo.<br/><br/>O que você está construindo não é só comissão: é uma rede de criadores que entraram porque VOCÊ mostrou o caminho. Isso se acumula, mês após mês. A gente vê o seu trabalho, e é uma honra ter você como parceiro BlueTube. <b style="color:#fff;">Continua plantando — a colheita é sua.</b> 🌱`,
    },
  ];
}

async function enviarEmailComissao(affiliate, { subscriber, plan, commission_amount }) {
  const RESEND = process.env.RESEND_API_KEY;
  if (!RESEND || !affiliate?.email) return { ok: false, motivo: 'sem_resend_ou_email' };
  const maskEmail = (e) => {
    if (!e) return '';
    const [u, d] = String(e).split('@');
    return (u?.[0] || '') + '***@' + (d || '');
  };
  const planLabel = plan === 'master' ? '👑 Master' : '⚡ Full';
  const valorFmt = 'R$ ' + Number(commission_amount || 0).toFixed(2).replace('.', ',');
  const nomeAff = (affiliate.name || affiliate.email.split('@')[0]).split(' ')[0];
  const vars = variacoes(nomeAff, valorFmt, planLabel);
  const v = vars[((affiliate.total_full || 0) + (affiliate.total_master || 0)) % vars.length];
  const html = `
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:560px;margin:0 auto;background:#020817;color:#e8f4ff;padding:40px 28px;border-radius:14px">
    <div style="text-align:center;margin-bottom:28px">
      <div style="display:inline-block;background:linear-gradient(135deg,#10b981,#3b82f6);color:#fff;font-weight:800;padding:8px 20px;border-radius:20px;letter-spacing:1px;font-size:11px">${v.badge}</div>
    </div>
    <h1 style="font-size:24px;font-weight:800;margin:0 0 12px;color:#fff">${v.titulo}</h1>
    <p style="font-size:15px;line-height:1.6;color:rgba(200,220,240,.85);margin:0 0 24px">${v.texto}</p>
    <div style="background:rgba(16,185,129,.1);border:1px solid rgba(16,185,129,.3);border-radius:12px;padding:20px;margin:20px 0">
      <div style="font-size:11px;color:rgba(200,220,240,.6);letter-spacing:2px;margin-bottom:8px;font-family:monospace">COMISSÃO GERADA</div>
      <div style="font-size:32px;font-weight:800;color:#10b981">${valorFmt}</div>
    </div>
    <table style="width:100%;margin:20px 0;border-collapse:collapse">
      <tr><td style="padding:8px 0;color:rgba(200,220,240,.6);font-size:13px">Assinante:</td><td style="padding:8px 0;color:#fff;text-align:right;font-family:monospace;font-size:13px">${maskEmail(subscriber)}</td></tr>
      <tr><td style="padding:8px 0;color:rgba(200,220,240,.6);font-size:13px">Plano:</td><td style="padding:8px 0;color:#fff;text-align:right;font-size:13px">${planLabel}</td></tr>
      <tr><td style="padding:8px 0;color:rgba(200,220,240,.6);font-size:13px">Status:</td><td style="padding:8px 0;text-align:right"><span style="background:rgba(251,191,36,.15);color:#fbbf24;padding:3px 10px;border-radius:10px;font-size:11px;font-weight:700">PENDENTE</span></td></tr>
    </table>
    <div style="text-align:center;margin:28px 0">
      <a href="https://www.bluetubeviral.com/afiliado" style="display:inline-block;background:linear-gradient(135deg,#3b82f6,#00aaff);color:#fff;text-decoration:none;padding:14px 32px;border-radius:10px;font-weight:700;font-size:14px">Confere no seu painel →</a>
    </div>
    <p style="font-size:12px;color:rgba(200,220,240,.5);text-align:center;margin:24px 0 0;line-height:1.5">Pagamentos via Pix todo dia 22. Comissões ficam pendentes por 37 dias (garantia de reembolso) antes de liberar pra saque.</p>
  </div>`;
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + RESEND, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'BlueAfiliados <noreply@bluetubeviral.com>', to: [affiliate.email], subject: v.assunto, html }),
    });
    return { ok: r.ok, status: r.status };
  } catch (e) {
    console.error('[comissao-email]', e.message);
    return { ok: false, motivo: e.message.slice(0, 80) };
  }
}

module.exports = { enviarEmailComissao };
