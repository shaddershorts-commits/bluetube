// api/send-blast.js — One-time email blast to all subscribers
// Protected by ADMIN_SECRET
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  // Auth: admin secret required for full blast, test_email allowed without
  const testEmail = req.body?.test_email;
  if (!testEmail) {
    const auth = req.headers['authorization'];
    const ADMIN_SECRET = process.env.ADMIN_SECRET;
    if (!ADMIN_SECRET || auth !== `Bearer ${ADMIN_SECRET}`) return res.status(401).json({ error: 'Unauthorized' });
  }

  const SU = process.env.SUPABASE_URL;
  const SK = process.env.SUPABASE_SERVICE_KEY;
  const RESEND = process.env.RESEND_API_KEY;
  if (!SU || !SK || !RESEND) return res.status(500).json({ error: 'Missing env' });

  const H = { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' };
  let sent = 0, errors = 0;

  try {
    // Test mode: send only to one email
    const testEmail = req.body?.test_email;
    let users;
    if (testEmail) {
      users = [{ email: testEmail }];
    } else {
      // Buscar direto de subscribers (mais confiável que email_marketing)
      const ur = await fetch(`${SU}/rest/v1/subscribers?select=email&limit=500`, { headers: H });
      users = ur.ok ? await ur.json() : [];
    }

    for (const u of users) {
      if (!u.email) continue;
      const unsubToken = Buffer.from(u.email).toString('base64url');

      try {
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + RESEND },
          body: JSON.stringify({
            from: 'BlueTube <noreply@bluetubeviral.com>',
            to: [u.email],
            subject: '🧹 Nova ferramenta: BlueClean — remova legendas e overlays com IA',
            html: `<div style="font-family:-apple-system,sans-serif;max-width:600px;margin:0 auto;background:#020817;color:#e8f4ff;border-radius:20px;overflow:hidden;border:1px solid rgba(0,170,255,.15)">
              <div style="text-align:center;padding:28px 24px 16px">
                <a href="https://bluetubeviral.com" style="text-decoration:none;font-size:22px;font-weight:800;color:#fff">Blue<span style="color:#00aaff">Tube</span></a>
                <div style="height:2px;background:linear-gradient(90deg,transparent,#00aaff,transparent);margin-top:16px"></div>
              </div>
              <div style="padding:0 28px 28px">
                <div style="font-size:22px;font-weight:800;margin-bottom:12px">🧹 Apresentamos o BlueClean</div>
                <div style="font-size:15px;color:rgba(200,225,255,.8);line-height:1.7;margin-bottom:20px">
                  Sua nova arma secreta: <strong>remova legendas, setas, marcas d'água e qualquer overlay</strong> de vídeos usando IA — em minutos.
                </div>

                <div style="background:rgba(0,170,255,.06);border:1px solid rgba(0,170,255,.15);border-radius:14px;padding:20px;margin-bottom:20px">
                  <div style="font-size:14px;font-weight:700;color:#00aaff;margin-bottom:10px">Como funciona:</div>
                  <div style="font-size:13px;color:rgba(200,225,255,.7);line-height:1.8">
                    <strong>1.</strong> Faça upload do vídeo com legendas/overlays<br>
                    <strong>2.</strong> Escolha modo Padrão (automático) ou Agressivo<br>
                    <strong>3.</strong> A IA detecta e remove tudo automaticamente<br>
                    <strong>4.</strong> Baixe o vídeo limpo em minutos
                  </div>
                </div>

                <div style="background:rgba(251,191,36,.06);border:1px solid rgba(251,191,36,.2);border-radius:12px;padding:16px;margin-bottom:20px">
                  <div style="font-size:13px;color:#fbbf24;font-weight:700;margin-bottom:4px">👑 Exclusivo Master</div>
                  <div style="font-size:12px;color:rgba(200,225,255,.6)">10 vídeos por mês · 2 modos de processamento · Download direto</div>
                </div>

                <div style="font-size:13px;color:rgba(200,225,255,.6);margin-bottom:20px">
                  <strong style="color:#e8f4ff">Outras novidades:</strong><br>
                  ✦ BlueVoice agora é <strong>ilimitado</strong> para Master<br>
                  ✦ Vozes clonadas compartilhadas entre Masters<br>
                  ✦ Busca de vídeos e pessoas na Blue<br>
                  ✦ Sistema de notificações de curtidas e comentários
                </div>

                <a href="https://bluetubeviral.com/blueClean" style="display:block;background:linear-gradient(135deg,#1a6bff,#00aaff);color:#fff;text-decoration:none;padding:16px;border-radius:12px;text-align:center;font-size:16px;font-weight:700;box-shadow:0 0 24px rgba(0,170,255,.3)">Experimentar BlueClean →</a>

                <a href="https://bluetubeviral.com" style="display:block;text-align:center;color:#00aaff;font-size:13px;text-decoration:none;margin-top:12px">Ver todas as novidades →</a>
              </div>
              <div style="padding:16px 28px;border-top:1px solid rgba(0,170,255,.08);text-align:center;font-size:11px;color:rgba(150,190,230,.3)">
                <a href="https://bluetubeviral.com/api/unsubscribe?token=${unsubToken}" style="color:rgba(150,190,230,.4)">Descadastrar</a> · © BlueTube
              </div>
            </div>`
          })
        });
        sent++;
      } catch (e) { errors++; }

      await new Promise(r => setTimeout(r, 100)); // Rate limit
    }

    return res.status(200).json({ ok: true, sent, errors, total: users.length });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message, sent, errors });
  }
};
