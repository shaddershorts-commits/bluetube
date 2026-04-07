// api/weekly-trends-email.js — Cron: 0 8 * * 1 (Monday 8am)
// Generates weekly trends via AI and emails all active users

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const SU = process.env.SUPABASE_URL;
  const SK = process.env.SUPABASE_SERVICE_KEY;
  const RESEND = process.env.RESEND_API_KEY;
  const GEMINI_KEY = process.env.GEMINI_KEY_1;
  if (!SU || !SK || !RESEND) return res.status(200).json({ ok: false, error: 'Missing env' });

  const H = { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' };
  const now = new Date();
  const weekStart = now.toISOString().split('T')[0];
  const results = { trends_generated: false, sent: 0, errors: 0 };

  try {
    // ── CHECK CACHE: already generated this week? ─────────────────────────
    let trends = null;
    const cacheR = await fetch(`${SU}/rest/v1/weekly_trends?week_start=eq.${weekStart}&select=trends&limit=1`, { headers: H });
    if (cacheR.ok) {
      const cached = await cacheR.json();
      if (cached?.[0]?.trends) trends = cached[0].trends;
    }

    // ── GENERATE TRENDS VIA AI ────────────────────────────────────────────
    if (!trends && GEMINI_KEY) {
      const month = now.toLocaleString('pt-BR', { month: 'long', year: 'numeric' });
      const prompt = `Liste os 3 nichos de YouTube Shorts que estão mais em alta nesta semana de ${month} no Brasil e no mundo.
Para cada nicho, forneça:
- nicho: nome curto do nicho
- motivo: por que está em alta agora (1-2 frases)
- tipo_conteudo: que tipo de vídeo está funcionando
- gancho_exemplo: um exemplo de gancho viral para esse nicho (1 frase impactante)
Responda APENAS com JSON array: [{"nicho":"...","motivo":"...","tipo_conteudo":"...","gancho_exemplo":"..."}]`;

      try {
        const aiR = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.7, maxOutputTokens: 1000 } })
        });
        if (aiR.ok) {
          const aiD = await aiR.json();
          const rawText = aiD.candidates?.[0]?.content?.parts?.[0]?.text || '';
          const jsonMatch = rawText.match(/\[[\s\S]*\]/);
          if (jsonMatch) {
            trends = JSON.parse(jsonMatch[0]);
            // Save to cache
            await fetch(`${SU}/rest/v1/weekly_trends`, {
              method: 'POST', headers: { ...H, Prefer: 'return=minimal' },
              body: JSON.stringify({ week_start: weekStart, trends, created_at: now.toISOString() })
            });
            results.trends_generated = true;
          }
        }
      } catch (e) { console.error('[weekly-trends] AI error:', e.message); }
    }

    // Fallback trends if AI fails
    if (!trends || !trends.length) {
      trends = [
        { nicho: 'Curiosidades Rápidas', motivo: 'Vídeos de "Você sabia?" continuam dominando o algoritmo', tipo_conteudo: 'Facts com narração rápida e visual impactante', gancho_exemplo: 'Isso vai mudar completamente a forma como você vê o mundo.' },
        { nicho: 'Motivação e Mindset', motivo: 'Início de semana impulsiona conteúdo motivacional', tipo_conteudo: 'Frases de impacto com música épica de fundo', gancho_exemplo: 'A maioria desiste exatamente aqui. Os que continuam mudam de vida.' },
        { nicho: 'Humor e Entretenimento', motivo: 'Conteúdo leve sempre tem alta retenção', tipo_conteudo: 'Situações do dia a dia com twist inesperado', gancho_exemplo: 'Ninguém esperava o que aconteceu no final.' },
      ];
    }

    // ── BUILD EMAIL ───────────────────────────────────────────────────────
    const trendsHTML = trends.slice(0, 3).map((t, i) => `
      <div style="background:rgba(0,170,255,.04);border:1px solid rgba(0,170,255,.12);border-radius:14px;padding:18px;margin-bottom:12px">
        <div style="font-size:16px;font-weight:800;margin-bottom:6px">🎯 ${t.nicho}</div>
        <div style="font-size:12px;color:rgba(150,190,230,.5);margin-bottom:8px">Por que está em alta: ${t.motivo}</div>
        <div style="font-size:13px;color:rgba(200,225,255,.7);margin-bottom:10px">O que funciona: ${t.tipo_conteudo}</div>
        <div style="background:rgba(0,170,255,.08);border-radius:8px;padding:10px 14px;font-size:14px;font-style:italic;color:#e8f4ff">"${t.gancho_exemplo}"</div>
      </div>`).join('');

    const dateLabel = now.toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' });

    // ── SEND TO ALL ACTIVE USERS ──────────────────────────────────────────
    const usersR = await fetch(`${SU}/rest/v1/email_marketing?unsubscribed=eq.false&select=email&limit=500`, { headers: H });
    const users = usersR.ok ? await usersR.json() : [];

    for (const u of users) {
      if (!u.email) continue;
      const unsubToken = Buffer.from(u.email).toString('base64url');

      try {
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND}` },
          body: JSON.stringify({
            from: 'BlueTube <onboarding@resend.dev>', to: [u.email],
            subject: '📈 Os 3 nichos que mais viralizaram essa semana',
            html: `<div style="font-family:-apple-system,sans-serif;max-width:600px;margin:0 auto;background:#020817;color:#e8f4ff;border-radius:20px;overflow:hidden;border:1px solid rgba(0,170,255,.15)">
              <div style="text-align:center;padding:28px 24px 16px"><a href="https://bluetubeviral.com" style="text-decoration:none;font-size:22px;font-weight:800;color:#fff">Blue<span style="color:#00aaff">Tube</span></a><div style="height:2px;background:linear-gradient(90deg,transparent,#00aaff,transparent);margin-top:16px"></div></div>
              <div style="padding:0 28px 28px">
                <div style="font-size:20px;font-weight:800;margin-bottom:4px">Seu resumo semanal de tendências 🔥</div>
                <div style="font-size:12px;color:rgba(150,190,230,.5);margin-bottom:20px">Semana de ${dateLabel}</div>
                ${trendsHTML}
                <div style="margin-top:20px;font-size:14px;color:rgba(200,225,255,.7)">
                  <p><strong>Encontrou um nicho que combina com você?</strong></p>
                  <p>Cole qualquer Short desse nicho no BlueTube e receba um roteiro viral em segundos.</p>
                </div>
                <a href="https://bluetubeviral.com" style="display:block;background:linear-gradient(135deg,#1a6bff,#00aaff);color:#fff;text-decoration:none;padding:14px;border-radius:12px;text-align:center;font-size:15px;font-weight:700;margin:24px 0">Criar roteiro viral agora →</a>
                <div style="font-size:12px;color:rgba(150,190,230,.5);line-height:1.8;margin-top:12px">
                  Ferramentas para aproveitar:<br>
                  <a href="https://bluetubeviral.com/virais.html" style="color:#00aaff;text-decoration:none">🔥 Buscador de Virais</a> ·
                  <a href="https://bluetubeviral.com/blueScore.html" style="color:#00aaff;text-decoration:none">📊 BlueScore</a> ·
                  <a href="https://bluetubeviral.com/blueEditor.html" style="color:#00aaff;text-decoration:none">✨ BlueEditor</a>
                </div>
              </div>
              <div style="padding:16px 28px;border-top:1px solid rgba(0,170,255,.08);text-align:center;font-size:11px;color:rgba(150,190,230,.3)">
                <a href="https://bluetubeviral.com/api/unsubscribe?token=${unsubToken}" style="color:rgba(150,190,230,.4)">Descadastrar</a> · © BlueTube
              </div>
            </div>`
          })
        });
        results.sent++;
      } catch (e) { results.errors++; }

      await new Promise(r => setTimeout(r, 100));
      if (results.sent >= 500) break;
    }

    return res.status(200).json({ ok: true, ...results, trends: trends?.length || 0, users: users.length });
  } catch (e) {
    return res.status(200).json({ ok: false, error: e.message, ...results });
  }
};
