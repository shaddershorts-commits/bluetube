// api/unsubscribe.js — Email marketing unsubscribe endpoint
module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const SU = process.env.SUPABASE_URL;
  const SK = process.env.SUPABASE_SERVICE_KEY;
  const token = req.query.token;

  if (!token || !SU || !SK) {
    return res.status(400).send(page('Erro', 'Link inválido.'));
  }

  let email;
  try {
    email = Buffer.from(token, 'base64url').toString('utf-8');
    if (!email || !email.includes('@')) throw new Error('Invalid');
  } catch (e) {
    return res.status(400).send(page('Erro', 'Link inválido ou expirado.'));
  }

  try {
    await fetch(`${SU}/rest/v1/email_marketing?email=eq.${encodeURIComponent(email)}`, {
      method: 'PATCH',
      headers: { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ unsubscribed: true, unsubscribed_at: new Date().toISOString() })
    });

    return res.status(200).send(page(
      '✅ Descadastrado',
      `Você foi descadastrado com sucesso.<br>Não enviaremos mais emails de marketing.<br>Você ainda pode acessar o BlueTube normalmente.`
    ));
  } catch (e) {
    return res.status(500).send(page('Erro', 'Falha ao processar. Tente novamente.'));
  }
};

function page(title, message) {
  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='8' fill='%231a6bff'/><path d='M12 8l12 8-12 8V8z' fill='white'/></svg>"/>
<title>${title} — BlueTube</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{min-height:100vh;display:flex;align-items:center;justify-content:center;background:#020817;color:#e8f4ff;font-family:-apple-system,sans-serif;padding:20px}
.box{background:rgba(10,22,40,.9);border:1px solid rgba(0,170,255,.2);border-radius:20px;padding:40px;max-width:440px;text-align:center}
h1{font-size:24px;margin-bottom:12px}p{font-size:14px;color:rgba(150,190,230,.7);line-height:1.7;margin-bottom:24px}
a{display:inline-block;background:linear-gradient(135deg,#1a6bff,#00aaff);color:#fff;text-decoration:none;padding:12px 28px;border-radius:10px;font-weight:700;font-size:14px}</style></head>
<body><div class="box"><h1>${title}</h1><p>${message}</p><a href="https://bluetubeviral.com">Voltar ao BlueTube →</a></div></body></html>`;
}
