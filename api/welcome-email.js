// api/welcome-email.js — Send welcome email after signup
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const RESEND_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_KEY) return res.status(200).json({ ok: false, error: 'Resend not configured' });

  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: 'Email required' });

  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_KEY}` },
      body: JSON.stringify({
        from: 'BlueTube <noreply@bluetubeviral.com>',
        to: [email],
        subject: 'Bem-vindo ao BlueTube! Aqui está como começar 🚀',
        html: `<div style="font-family:-apple-system,sans-serif;max-width:560px;margin:0 auto;background:#020817;color:#e8f4ff;border-radius:20px;overflow:hidden;border:1px solid rgba(0,170,255,.2)">
          <div style="background:linear-gradient(135deg,#1a6bff,#00aaff);padding:32px 28px;text-align:center">
            <div style="font-size:28px;font-weight:800;color:#fff">Blue<span style="opacity:.7">Tube</span></div>
            <div style="font-size:14px;color:rgba(255,255,255,.7);margin-top:8px">Criador Viral</div>
          </div>
          <div style="padding:28px">
            <h2 style="font-size:20px;font-weight:800;margin:0 0 12px;color:#fff">Bem-vindo! 🎉</h2>
            <p style="font-size:14px;color:rgba(150,190,230,.7);line-height:1.7;margin:0 0 24px">Você acaba de ganhar acesso à ferramenta que os maiores criadores de Shorts do Brasil estão usando.</p>

            <div style="background:rgba(0,170,255,.06);border:1px solid rgba(0,170,255,.15);border-radius:14px;padding:20px;margin-bottom:24px">
              <div style="font-size:13px;font-weight:700;color:#00aaff;margin-bottom:12px">3 PASSOS PARA SEU PRIMEIRO ROTEIRO:</div>
              <div style="font-size:13px;color:rgba(200,225,255,.7);line-height:1.8">
                <strong>1.</strong> Cole o link de qualquer YouTube Shorts<br>
                <strong>2.</strong> Escolha entre versão casual ou apelativa<br>
                <strong>3.</strong> Use o BlueVoice para narrar com voz IA
              </div>
            </div>

            <div style="font-size:12px;color:rgba(150,190,230,.5);margin-bottom:20px">
              ✦ <strong>BlueScore</strong> — analise qualquer canal<br>
              ✦ <strong>BlueLens</strong> — detecte reposts<br>
              ✦ <strong>Buscador de Virais</strong> — encontre tendências
            </div>

            <a href="https://bluetubeviral.com" style="display:block;background:linear-gradient(135deg,#1a6bff,#00aaff);color:#fff;text-decoration:none;padding:16px;border-radius:12px;text-align:center;font-size:15px;font-weight:700;box-shadow:0 0 24px rgba(0,170,255,.3)">Criar meu primeiro roteiro →</a>
          </div>
          <div style="padding:16px 28px;border-top:1px solid rgba(0,170,255,.08);font-size:11px;color:rgba(150,190,230,.3);text-align:center">
            BlueTube · <a href="https://bluetubeviral.com/privacidade" style="color:rgba(150,190,230,.4)">Privacidade</a> · <a href="https://bluetubeviral.com/termos" style="color:rgba(150,190,230,.4)">Termos</a>
          </div>
        </div>`
      })
    });
    return res.status(200).json({ ok: true });
  } catch(e) {
    return res.status(200).json({ ok: false, error: e.message });
  }
};
