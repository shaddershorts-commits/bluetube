// api/_helpers/bluescoreEmail.js — aviso de análise pronta
// ===========================================================================
// Sai UMA vez, quando o dono clica em "Enviar" no admin. É o único email desse
// fluxo: a fila em si não manda nada, senão vira spam de "estamos analisando".
//
// Falha de email NUNCA derruba a entrega — a análise já está no site e o
// sininho já avisou. Por isso todo mundo aqui devolve {ok:false} em vez de
// estourar.

const REMETENTE = 'BlueScore <noreply@bluetubeviral.com>';
const SITE = 'https://www.bluetubeviral.com';

const REDES = {
  youtube:   { nome: 'YouTube',   emoji: '▶️' },
  tiktok:    { nome: 'TikTok',    emoji: '🎵' },
  instagram: { nome: 'Instagram', emoji: '📸' },
};

// Faixa da nota → cor e rótulo. Mesmo critério da página, pra não dizer
// "boa performance" no email e "atenção" na tela.
function faixaDaNota(nota) {
  const n = Number(nota) || 0;
  if (n >= 80) return { cor: '#00aaff', rotulo: 'Alta confiança' };
  if (n >= 60) return { cor: '#22c55e', rotulo: 'Boa performance' };
  if (n >= 40) return { cor: '#fbbf24', rotulo: 'Atenção necessária' };
  return { cor: '#ef4444', rotulo: 'Precisa de ajuste' };
}

function esc(t) {
  return String(t == null ? '' : t)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function montarHtml(pedido) {
  const laudo = pedido.laudo || {};
  const rede = REDES[pedido.rede] || REDES.youtube;
  const f = faixaDaNota(laudo.nota);
  const primeiroNome = String(pedido.nome || '').trim().split(' ')[0];
  const canal = laudo.canal?.nome || pedido.perfil_handle || 'seu perfil';
  const resumo = String(laudo.resumo || '').slice(0, 320);

  return `<div style="background:#020817;padding:32px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <div style="max-width:560px;margin:0 auto;background:#0a1628;border:1px solid rgba(0,170,255,.18);border-radius:18px;padding:32px 28px">

    <div style="font-family:ui-monospace,monospace;font-size:11px;letter-spacing:.12em;color:#00aaff;text-transform:uppercase;margin-bottom:14px">BlueScore · análise concluída</div>

    <h1 style="margin:0 0 12px;font-size:24px;color:#e8f4ff;line-height:1.25">
      ${primeiroNome ? esc(primeiroNome) + ', a' : 'A'} análise de <span style="color:#00aaff">${esc(canal)}</span> ficou pronta
    </h1>

    <p style="margin:0 0 24px;font-size:14px;color:rgba(200,220,240,.72);line-height:1.6">
      Seu ${rede.emoji} ${rede.nome} foi avaliado à mão, sem robô: quem analisou foi um
      <strong style="color:#e8f4ff">ex-funcionário do suporte do YouTube</strong> que hoje faz parte do time BlueTube.
    </p>

    <div style="background:rgba(0,170,255,.05);border:1px solid rgba(0,170,255,.15);border-radius:14px;padding:22px;text-align:center;margin-bottom:22px">
      <div style="font-family:ui-monospace,monospace;font-size:10px;letter-spacing:.1em;color:rgba(150,190,230,.5);text-transform:uppercase;margin-bottom:8px">Sua nota</div>
      <div style="font-size:52px;font-weight:800;color:${f.cor};line-height:1">${esc(laudo.nota)}</div>
      <div style="font-size:13px;font-weight:700;color:${f.cor};margin-top:4px">${esc(laudo.classificacao_label || f.rotulo)}</div>
    </div>

    ${resumo ? `<div style="border-left:3px solid rgba(0,170,255,.4);padding:2px 0 2px 16px;margin-bottom:26px">
      <div style="font-size:14px;color:rgba(200,220,240,.85);line-height:1.65">${esc(resumo)}${String(laudo.resumo || '').length > 320 ? '…' : ''}</div>
    </div>` : ''}

    <div style="text-align:center;margin-bottom:26px">
      <a href="${SITE}/blueScore?pedido=${esc(pedido.id)}" style="display:inline-block;background:linear-gradient(135deg,#1a6bff,#00aaff);color:#fff;text-decoration:none;padding:15px 34px;border-radius:12px;font-weight:700;font-size:15px">Ver a análise completa →</a>
    </div>

    <p style="margin:0;font-size:12px;color:rgba(150,190,230,.45);text-align:center;line-height:1.6">
      Lá dentro tem o diagnóstico completo, as recomendações em ordem de impacto
      e os comentários vídeo a vídeo.<br>A análise fica guardada na sua conta.
    </p>
  </div>
</div>`;
}

async function enviarEmailAnalisePronta(pedido) {
  const RESEND = process.env.RESEND_API_KEY;
  if (!RESEND) return { ok: false, motivo: 'sem_resend' };
  if (!pedido?.email) return { ok: false, motivo: 'sem_email' };

  const canal = pedido.laudo?.canal?.nome || pedido.perfil_handle || 'seu perfil';
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + RESEND, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: REMETENTE,
        to: [pedido.email],
        subject: `Sua análise de ${canal} está pronta 📊`,
        html: montarHtml(pedido),
      }),
      signal: AbortSignal.timeout(10000),
    });
    return { ok: r.ok, status: r.status };
  } catch (e) {
    console.error('[bluescore-email]', e.message);
    return { ok: false, motivo: String(e.message).slice(0, 80) };
  }
}

module.exports = { enviarEmailAnalisePronta, faixaDaNota, montarHtml };
