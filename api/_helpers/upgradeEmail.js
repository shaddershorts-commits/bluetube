// api/_helpers/upgradeEmail.js — Email motivacional pós-upgrade.
// Disparado por:
//   - webhook.js em checkout.session.completed (assinatura via Stripe)
//   - admin.js em action=set_plan (promoção manual)
// CommonJS.

async function sendUpgradeEmail(email, plan, billing) {
  const RESEND_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_KEY || !email) return;
  if (plan !== 'master' && plan !== 'full') return; // só pra upgrades pagos

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

  const featuresHtml = features.map((f) => `
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

  return fetch('https://api.resend.com/emails', {
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

module.exports = { sendUpgradeEmail };
