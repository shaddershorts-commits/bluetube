// api/v1/unsubscribe.js — Email unsubscribe endpoint (Fix 4 - Gap 6)
//
// Tokens HMAC-signed via _helpers/unsub-token. Aceita tokens legacy (sem HMAC)
// ate 2026-05-25 pra cobrir emails ja na inbox dos users.
//
// Sem auth — tem que funcionar de inbox, sem login. Token HMAC garante que
// terceiros nao podem descadastrar usando email alheio.
//
// scope=marketing (default): bloqueia email-marketing, weekly-trends, milestones, send-blast
// scope=all: idem hoje (TODOS senders existentes ja sao gateados por email_marketing.unsubscribed
//            apos esse fix). Mensagem diferente declarando intencao mais ampla pra usuario.
//            Quando reactivation-emails for adicionado ao filtro (ver pendencias), scope=all
//            cobrira tambem.

const { verifyToken, secretFingerprint } = require('../_helpers/unsub-token');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).send(page('Erro', 'Metodo nao permitido.'));
  }

  const SU = process.env.SUPABASE_URL;
  const SK = process.env.SUPABASE_SERVICE_KEY;
  if (!SU || !SK) return res.status(500).send(page('Erro', 'Configuracao indisponivel.'));

  const token = req.query?.token || req.body?.token;
  const scope = String(req.query?.scope || req.body?.scope || 'marketing').toLowerCase();
  const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();

  let parsed;
  try { parsed = verifyToken(token); }
  catch (e) {
    // Helper joga se UNSUBSCRIBE_HMAC_SECRET nao tiver setado
    console.error(`[v1/unsubscribe] config_error ip=${ip} msg=${e.message}`);
    return res.status(500).send(page('Erro', 'Configuracao indisponivel.'));
  }
  const { email, valid, format } = parsed;
  if (!valid) {
    // DIAGNOSTIC TEMPORARIO (Fix 4 troubleshoot): inclui secret_fingerprint
    // pra diagnosticar se prod tem o secret correto. REMOVER quando concluido.
    const fp = secretFingerprint();
    console.log(`[v1/unsubscribe] invalid_token ip=${ip} token_len=${token?.length || 0} secret_fp=${JSON.stringify(fp)}`);
    return res.status(400).send(page('Erro', 'Link invalido ou expirado. Se o problema persistir, escreva pra bluetubeoficial@gmail.com.'));
  }

  const h = { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json', Prefer: 'return=minimal' };
  const now = new Date().toISOString();

  try {
    // PATCH (caso ja exista em email_marketing) — fire-and-forget logico
    await fetch(`${SU}/rest/v1/email_marketing?email=eq.${encodeURIComponent(email)}`, {
      method: 'PATCH',
      headers: h,
      body: JSON.stringify({ unsubscribed: true, unsubscribed_at: now })
    }).catch(() => {});

    // INSERT com resolution=ignore (caso email NAO esteja em email_marketing ainda)
    // Garante que mesmo emails fora da tabela ficam blockeados.
    await fetch(`${SU}/rest/v1/email_marketing`, {
      method: 'POST',
      headers: { ...h, Prefer: 'return=minimal,resolution=ignore' },
      body: JSON.stringify({
        email,
        unsubscribed: true,
        unsubscribed_at: now,
        sequence_position: 0,
        total_sent: 0,
      })
    }).catch(() => {});

    let scopeMessage;
    if (scope === 'all') {
      scopeMessage = 'Voce nao recebera mais emails de marketing.<br><br>Comunicacoes essenciais (cobranca, seguranca, exclusao de conta) ainda podem ser enviadas conforme exige a Lei.';
    } else {
      scopeMessage = 'Voce nao recebera mais emails de marketing.';
    }

    console.log(`[v1/unsubscribe] ok email=${email} scope=${scope} format=${format} ip=${ip}`);
    return res.status(200).send(page(
      'Descadastrado',
      `${scopeMessage}<br><br>Voce ainda pode usar o BlueTube normalmente.`
    ));
  } catch (e) {
    console.error(`[v1/unsubscribe] error email=${email} ip=${ip} msg=${e.message}`);
    return res.status(500).send(page('Erro', 'Falha ao processar. Tente novamente em alguns instantes.'));
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
