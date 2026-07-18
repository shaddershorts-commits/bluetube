// api/blueclean-email.js — Anúncio de lançamento da NOVA BlueClean (Master-only).
// Email único, empolgante e grato. NÃO revela bastidores/engines — narrativa é
// "nossa tecnologia deu um salto". Audiência: SÓ Master ativos (a feature é
// exclusiva Master; free/full ficam fora, respeitando a cota do Resend também).
//
// Actions (admin_secret obrigatório):
//   GET  ?action=preview
//   POST {action:'teste', email_teste}
//   GET/POST ?action=disparar  → envia pra todos os Master ativos
//            (guarda anti-reenvio via email_campanhas 'blueclean-lancamento')
//
// Espelha as proteções do blublu-emails.js: throttle 150ms (10/s do Resend),
// log em email_campanhas, unsubscribe, guarda de duplicação.

const SITE = 'https://www.bluetubeviral.com';
const unsub = (email) => `${SITE}/api/unsubscribe?token=${Buffer.from(email).toString('base64url')}`;

const ASSUNTO = 'A nova BlueClean chegou — e ela ficou de outro planeta 🎬';

function html(email) {
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#020817;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#020817;padding:32px 12px;">
<tr><td align="center">
<table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;background:linear-gradient(180deg,#081430,#040c1e);border:1px solid rgba(127,212,255,.25);border-radius:20px;overflow:hidden;">
  <tr><td align="center" style="padding:38px 28px 0;">
    <img src="${SITE}/chess-king-marble.png" alt="Master" width="88" style="display:block;filter:drop-shadow(0 0 16px rgba(0,190,255,.45));"/>
  </td></tr>
  <tr><td align="center" style="padding:16px 28px 0;">
    <div style="font-family:Arial,sans-serif;font-size:11px;letter-spacing:2px;color:#fbbf24;text-transform:uppercase;font-weight:bold;">👑 Exclusivo Master</div>
    <div style="font-family:Arial,sans-serif;font-size:27px;line-height:1.2;color:#eaf3ff;font-weight:800;padding-top:10px;">Sua BlueClean deu<br/>um salto gigante.</div>
  </td></tr>
  <tr><td style="padding:20px 32px 8px;">
    <div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.68;color:#c7d8f0;">
      Você pediu. A gente ouviu — e foi <b style="color:#eaf3ff;">muito</b> além.<br/><br/>
      A BlueClean está no ar completamente repaginada. Legenda queimada, seta, círculo, marca d'água: você marca o que quer tirar e a <b style="color:#eaf3ff;">nossa tecnologia remove</b> com uma qualidade que a gente nunca tinha alcançado — reconstruindo o fundo <b style="color:#eaf3ff;">sem deixar rastro</b>. Sem borrão, sem mancha estranha, sem aquele "buraco" no vídeo.<br/><br/>
      O que mudou? Tudo o que importa. A precisão deu um salto, o resultado ficou limpo <i>de verdade</i>, e agora <b style="color:#00d4ff;">você controla</b> exatamente o que sai e o que fica — até nos círculos, onde só a borda some e o que estava destacado continua lá, intacto.<br/><br/>
      E aqui vai o mais importante: <b style="color:#eaf3ff;">nada disso seria possível sem você</b>. É porque você é Master que a gente pode investir, testar e refinar até a qualidade chegar nesse nível. Cada assinatura vira tecnologia melhor nas suas mãos. Obrigado, de verdade. 💙<br/><br/>
      Sua cota Master inclui <b style="color:#fbbf24;">10 limpezas por mês</b>. Bora estrear?
    </div>
  </td></tr>
  <tr><td align="center" style="padding:24px 28px 34px;">
    <a href="${SITE}/blueClean" style="display:inline-block;background:linear-gradient(100deg,#00d4ff,#1a6bff);color:#021018;font-family:Arial,sans-serif;font-size:15px;font-weight:800;text-decoration:none;padding:15px 34px;border-radius:100px;">Testar a nova BlueClean →</a>
  </td></tr>
  <tr><td align="center" style="padding:0 28px 26px;">
    <div style="font-family:Arial,sans-serif;font-size:11px;color:#5b7099;">BlueTube · Criador Viral<br/><a href="${unsub(email)}" style="color:#5b7099;">descadastrar</a></div>
  </td></tr>
</table>
</td></tr></table></body></html>`;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const SU = process.env.SUPABASE_URL;
  const SK = process.env.SUPABASE_SERVICE_KEY;
  const ADMIN_SECRET = process.env.ADMIN_SECRET;
  const RESEND_KEY = process.env.RESEND_API_KEY;
  if (!SU || !SK) return res.status(500).json({ error: 'config' });
  const h = { apikey: SK, Authorization: `Bearer ${SK}`, 'Content-Type': 'application/json' };

  const src = req.method === 'POST' ? (req.body || {}) : (req.query || {});
  if (!ADMIN_SECRET || src.admin_secret !== ADMIN_SECRET) return res.status(403).json({ error: 'nao autorizado' });

  try {
    if (src.action === 'preview') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(200).send(html('preview@exemplo.com'));
    }

    if (src.action === 'teste') {
      if (!src.email_teste) return res.status(400).json({ error: 'email_teste obrigatorio' });
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST', headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: 'BlueTube <noreply@bluetubeviral.com>', to: [src.email_teste], subject: '[TESTE] ' + ASSUNTO, html: html(src.email_teste) }),
      });
      return res.status(200).json({ ok: r.ok, status: r.status });
    }

    if (src.action === 'disparar') {
      const nomeCampanha = 'blueclean-lancamento';
      const jaR = await fetch(`${SU}/rest/v1/email_campanhas?nome=eq.${encodeURIComponent(nomeCampanha)}&select=id`, { headers: h });
      const ja = jaR.ok ? await jaR.json() : [];
      if (ja.length) return res.status(200).json({ ok: true, pulado: 'campanha ja enviada', campanha: nomeCampanha });

      // audiência: SÓ Master ativos (feature exclusiva Master)
      const subsR = await fetch(`${SU}/rest/v1/subscribers?plan=eq.master&select=email,plan_expires_at,is_manual`, { headers: h });
      if (!subsR.ok) return res.status(502).json({ error: 'subscribers ' + subsR.status });
      const agora = new Date();
      const subs = (await subsR.json()).filter((s) => s.email && (s.is_manual || !s.plan_expires_at || new Date(s.plan_expires_at) > agora));

      let campanhaId = null;
      try {
        const insR = await fetch(`${SU}/rest/v1/email_campanhas`, {
          method: 'POST', headers: { ...h, Prefer: 'return=representation' },
          body: JSON.stringify({ nome: nomeCampanha, total_free: 0, total_full: 0, total_master: subs.length, status: 'enviando', iniciada_em: new Date().toISOString() }),
        });
        if (insR.ok) { const [row] = await insR.json(); campanhaId = row?.id || null; }
      } catch (e) {}

      const resultados = { enviados: 0, falhas: 0 };
      for (const s of subs) {
        try {
          const r = await fetch('https://api.resend.com/emails', {
            method: 'POST', headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ from: 'BlueTube <noreply@bluetubeviral.com>', to: [s.email], subject: ASSUNTO, html: html(s.email) }),
          });
          if (r.ok) resultados.enviados++; else { resultados.falhas++; if (r.status === 429) await new Promise((x) => setTimeout(x, 2000)); }
        } catch (e) { resultados.falhas++; }
        await new Promise((x) => setTimeout(x, 150)); // 10/s do Resend
      }
      if (campanhaId) {
        await fetch(`${SU}/rest/v1/email_campanhas?id=eq.${campanhaId}`, { method: 'PATCH', headers: { ...h, Prefer: 'return=minimal' }, body: JSON.stringify({ status: 'concluida', enviados: resultados.enviados, falhas: resultados.falhas, concluida_em: new Date().toISOString() }) }).catch(() => {});
      }
      return res.status(200).json({ ok: true, campanha: nomeCampanha, master_ativos: subs.length, ...resultados });
    }

    return res.status(400).json({ error: 'action invalida' });
  } catch (e) {
    console.error('[blueclean-email]', e.message);
    return res.status(500).json({ error: e.message.slice(0, 150) });
  }
};
