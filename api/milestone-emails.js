// api/milestone-emails.js — Cron: 0 9 * * * (daily 9am)
// Sends milestone emails at 10, 50, 100 roteiros

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const SU = process.env.SUPABASE_URL;
  const SK = process.env.SUPABASE_SERVICE_KEY;
  const RESEND = process.env.RESEND_API_KEY;
  if (!SU || !SK || !RESEND) return res.status(200).json({ ok: false, error: 'Missing env' });

  const H = { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' };
  const results = { sent_10: 0, sent_50: 0, sent_100: 0 };

  try {
    const milestones = [
      { threshold: 10, field: 'milestone_10_sent', subject: '🎯 10 roteiros gerados — você está no caminho certo!', body: m10 },
      { threshold: 50, field: 'milestone_50_sent', subject: '🚀 50 roteiros! Você é um criador de verdade', body: m50 },
      { threshold: 100, field: 'milestone_100_sent', subject: '👑 100 roteiros — você é um dos nossos maiores criadores', body: m100 },
    ];

    for (const m of milestones) {
      const r = await fetch(
        `${SU}/rest/v1/subscribers?total_roteiros=gte.${m.threshold}&${m.field}=eq.false&select=email,total_roteiros,created_at&limit=50`,
        { headers: H }
      );
      if (!r.ok) continue;
      const users = await r.json();

      for (const u of users) {
        if (!u.email) continue;
        const daysSince = Math.round((Date.now() - new Date(u.created_at)) / 86400000);
        const perWeek = daysSince > 0 ? ((u.total_roteiros / daysSince) * 7).toFixed(1) : u.total_roteiros;
        const unsubToken = Buffer.from(u.email).toString('base64url');

        try {
          await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND}` },
            body: JSON.stringify({
              from: 'BlueTube <onboarding@resend.dev>', to: [u.email],
              subject: m.subject,
              html: emailWrap(m.body(u.total_roteiros, daysSince, perWeek), unsubToken)
            })
          });

          await fetch(`${SU}/rest/v1/subscribers?email=eq.${encodeURIComponent(u.email)}`, {
            method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' },
            body: JSON.stringify({ [m.field]: true })
          });

          results[`sent_${m.threshold}`]++;
        } catch (e) {}
        await new Promise(r => setTimeout(r, 100));
      }
    }

    return res.status(200).json({ ok: true, ...results });
  } catch (e) {
    return res.status(200).json({ ok: false, error: e.message });
  }
};

function m10(total, days, perWeek) {
  return `<div style="font-size:20px;font-weight:800;margin-bottom:16px">Parabéns! 🎉 Seu 10º roteiro!</div>
    <p>Você acaba de gerar seu <strong>10º roteiro</strong> no BlueTube.</p>
    <p>Criadores consistentes publicam pelo menos 3x por semana. Você já está na frente de 80% dos criadores iniciantes.</p>
    <div style="background:rgba(0,170,255,.06);border:1px solid rgba(0,170,255,.15);border-radius:12px;padding:16px;margin:20px 0">
      <div style="font-size:12px;color:rgba(150,190,230,.5);margin-bottom:8px">SEUS NÚMEROS</div>
      <div style="display:flex;gap:20px;flex-wrap:wrap">
        <div><div style="font-size:24px;font-weight:800;color:#00aaff">${total}</div><div style="font-size:11px;color:#888">roteiros</div></div>
        <div><div style="font-size:24px;font-weight:800;color:#fbbf24">${days}</div><div style="font-size:11px;color:#888">dias</div></div>
        <div><div style="font-size:24px;font-weight:800;color:#22c55e">${perWeek}</div><div style="font-size:11px;color:#888">por semana</div></div>
      </div>
    </div>
    <p style="color:#fbbf24"><strong>Dica:</strong> Criadores que usam BlueVoice junto com os roteiros têm resultados 3x melhores.</p>`;
}

function m50(total, days, perWeek) {
  const weeksContent = Math.round(total / 3);
  return `<div style="font-size:20px;font-weight:800;margin-bottom:16px">50 roteiros! 🚀 Você é consistente.</div>
    <p><strong>50 roteiros gerados.</strong> Isso não é pouca coisa. A maioria desiste antes de chegar aqui.</p>
    <p>Você provou que é consistente — agora é hora de escalar.</p>
    <div style="background:rgba(0,170,255,.06);border:1px solid rgba(0,170,255,.15);border-radius:12px;padding:16px;margin:20px 0">
      <div style="display:flex;gap:20px;flex-wrap:wrap">
        <div><div style="font-size:24px;font-weight:800;color:#00aaff">${total}</div><div style="font-size:11px;color:#888">roteiros</div></div>
        <div><div style="font-size:24px;font-weight:800;color:#fbbf24">${days} dias</div><div style="font-size:11px;color:#888">de jornada</div></div>
        <div><div style="font-size:24px;font-weight:800;color:#22c55e">~${weeksContent} semanas</div><div style="font-size:11px;color:#888">de conteúdo diário</div></div>
      </div>
    </div>
    <p>Que tal usar o <a href="https://bluetubeviral.com/blueEditor.html" style="color:#00aaff">BlueEditor</a> para produzir Shorts completos ainda mais rápido?</p>`;
}

function m100(total, days, perWeek) {
  const weeksContent = Math.round(total / 7);
  return `<div style="font-size:20px;font-weight:800;margin-bottom:16px">100 roteiros! 👑 Top 5% dos criadores</div>
    <p><strong>100 roteiros.</strong> Você está no top 5% dos criadores do BlueTube.</p>
    <p>Isso representa meses de consistência e dedicação.</p>
    <div style="background:linear-gradient(135deg,rgba(251,191,36,.08),rgba(0,170,255,.06));border:1px solid rgba(251,191,36,.2);border-radius:12px;padding:16px;margin:20px 0">
      <div style="display:flex;gap:20px;flex-wrap:wrap">
        <div><div style="font-size:28px;font-weight:800;color:#fbbf24">100</div><div style="font-size:11px;color:#888">roteiros</div></div>
        <div><div style="font-size:28px;font-weight:800;color:#00aaff">${days}</div><div style="font-size:11px;color:#888">dias de jornada</div></div>
        <div><div style="font-size:28px;font-weight:800;color:#22c55e">${weeksContent}+</div><div style="font-size:11px;color:#888">semanas de conteúdo</div></div>
      </div>
    </div>
    <div style="background:rgba(251,191,36,.08);border:1px solid rgba(251,191,36,.2);border-radius:10px;padding:14px;margin:16px 0">
      <div style="font-size:14px;font-weight:700;color:#fbbf24">🎁 Presente especial</div>
      <div style="font-size:13px;color:rgba(200,225,255,.7);margin-top:4px">Como agradecimento, suas narrações no BlueVoice são ilimitadas este mês!</div>
    </div>`;
}

function emailWrap(body, unsubToken) {
  return `<div style="font-family:-apple-system,sans-serif;max-width:600px;margin:0 auto;background:#020817;color:#e8f4ff;border-radius:20px;overflow:hidden;border:1px solid rgba(0,170,255,.15)">
    <div style="text-align:center;padding:28px 24px 16px"><a href="https://bluetubeviral.com" style="text-decoration:none;font-size:22px;font-weight:800;color:#fff">Blue<span style="color:#00aaff">Tube</span></a><div style="height:2px;background:linear-gradient(90deg,transparent,#00aaff,transparent);margin-top:16px"></div></div>
    <div style="padding:0 28px 28px;font-size:14px;color:rgba(200,225,255,.7);line-height:1.7">${body}
      <a href="https://bluetubeviral.com" style="display:block;background:linear-gradient(135deg,#1a6bff,#00aaff);color:#fff;text-decoration:none;padding:14px;border-radius:12px;text-align:center;font-size:15px;font-weight:700;margin:24px 0">Continuar criando →</a>
    </div>
    <div style="padding:16px 28px;border-top:1px solid rgba(0,170,255,.08);text-align:center;font-size:11px;color:rgba(150,190,230,.3)">
      <a href="https://bluetubeviral.com/api/unsubscribe?token=${unsubToken}" style="color:rgba(150,190,230,.4)">Descadastrar</a> · © BlueTube
    </div>
  </div>`;
}
