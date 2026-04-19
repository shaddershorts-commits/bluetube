// api/editor-espera.js
// Captura de email pra lista de espera do BlueEditor + detecta plano do user logado.
//
// Actions:
//   POST { email, token? }        — salva na tabela email_espera_editor (upsert),
//                                   envia confirmacao silenciosa via Resend.
//   GET  ?action=plano&token=X    — retorna { plano, nome } do user logado
//                                   (guest | free | full | master). Usado pra
//                                   personalizar saudacao e esconder form.

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const SU = process.env.SUPABASE_URL;
  const SK = process.env.SUPABASE_SERVICE_KEY;
  const AK = process.env.SUPABASE_ANON_KEY || SK;
  const RESEND = process.env.RESEND_API_KEY;
  const h = { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' };

  // ── GET ?action=plano&token=X ────────────────────────────────────────
  if (req.method === 'GET' && (req.query?.action === 'plano')) {
    const token = req.query?.token;
    if (!token) return res.status(200).json({ plano: 'guest', nome: null });

    try {
      const uR = await fetch(`${SU}/auth/v1/user`, { headers: { apikey: AK, Authorization: 'Bearer ' + token } });
      if (!uR.ok) return res.status(200).json({ plano: 'guest', nome: null });
      const u = await uR.json();
      const email = u?.email;
      if (!email) return res.status(200).json({ plano: 'guest', nome: null });

      // Busca no subscribers pra descobrir plano real
      const sR = await fetch(
        `${SU}/rest/v1/subscribers?email=eq.${encodeURIComponent(email)}&select=plan,plan_expires_at,is_manual,nome`,
        { headers: h }
      );
      let plano = 'free';
      let nome = (u.user_metadata?.full_name || u.user_metadata?.name || '').split(' ')[0] || null;

      if (sR.ok) {
        const rows = await sR.json();
        const sub = rows?.[0];
        if (sub) {
          const ativo = !sub.plan_expires_at || new Date(sub.plan_expires_at) > new Date() || sub.is_manual;
          if (ativo && (sub.plan === 'master' || sub.plan === 'full')) {
            plano = sub.plan;
          }
          if (sub.nome) nome = sub.nome.split(' ')[0];
        }
      }
      return res.status(200).json({ plano, nome });
    } catch (e) {
      return res.status(200).json({ plano: 'guest', nome: null });
    }
  }

  // ── POST { email, token? } ───────────────────────────────────────────
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const email = String(req.body?.email || '').trim().toLowerCase();
  const token = req.body?.token || null;

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 140) {
    return res.status(400).json({ error: 'Email invalido' });
  }

  // Tenta identificar user_id + plano se tiver token
  let user_id = null;
  let plano_atual = null;
  if (token) {
    try {
      const uR = await fetch(`${SU}/auth/v1/user`, { headers: { apikey: AK, Authorization: 'Bearer ' + token } });
      if (uR.ok) {
        const u = await uR.json();
        user_id = u?.id || null;
        if (u?.email) {
          const sR = await fetch(
            `${SU}/rest/v1/subscribers?email=eq.${encodeURIComponent(u.email)}&select=plan,plan_expires_at,is_manual`,
            { headers: h }
          );
          if (sR.ok) {
            const sub = (await sR.json())?.[0];
            if (sub) {
              const ativo = !sub.plan_expires_at || new Date(sub.plan_expires_at) > new Date() || sub.is_manual;
              plano_atual = ativo ? sub.plan : 'free';
            } else {
              plano_atual = 'free';
            }
          }
        }
      }
    } catch (e) { /* ignora */ }
  }

  // Upsert na tabela (on_conflict=email)
  try {
    const upR = await fetch(`${SU}/rest/v1/email_espera_editor?on_conflict=email`, {
      method: 'POST',
      headers: { ...h, Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ email, plano_atual, user_id })
    });
    if (!upR.ok) {
      const t = await upR.text();
      console.error('[editor-espera] insert failed:', upR.status, t.slice(0, 200));
      return res.status(500).json({ error: 'Falha ao salvar. Tenta de novo em 1min.' });
    }
  } catch (e) {
    console.error('[editor-espera]', e.message);
    return res.status(500).json({ error: 'Erro de rede. Tenta de novo?' });
  }

  // Confirma silenciosamente via Resend (fire-and-forget, nao bloqueia resposta)
  if (RESEND) {
    fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + RESEND },
      body: JSON.stringify({
        from: 'Blublu <blublu@bluetubeviral.com>',
        to: [email],
        subject: 'Voce esta na lista do BlueEditor',
        html: `<div style="font-family:system-ui,-apple-system,sans-serif;max-width:520px;margin:0 auto;padding:40px 20px;background:#020817;color:#fff;border-radius:16px">
          <div style="text-align:center;margin-bottom:30px">
            <div style="font-size:14px;letter-spacing:.2em;color:#00AAFF;text-transform:uppercase;margin-bottom:8px">BlueEditor</div>
            <div style="font-size:28px;font-weight:900;letter-spacing:-.02em">Voce esta na lista.</div>
          </div>
          <div style="padding:20px;border-left:3px solid #00AAFF;font-style:italic;color:rgba(255,255,255,.85);line-height:1.7">
            Anotei seu email, criador.<br/><br/>
            Quando o BlueEditor estiver pronto pra mostrar, voce e um dos primeiros a saber.<br/><br/>
            Fica na sua. Eu volto.
            <div style="margin-top:16px;font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#00AAFF;font-style:normal">— Blublu</div>
          </div>
          <div style="margin-top:30px;text-align:center;font-size:11px;color:rgba(255,255,255,.4)">
            bluetubeviral.com · Sem spam. So novidade real.
          </div>
        </div>`
      })
    }).catch(e => console.warn('[editor-espera] resend fail (ignorado):', e.message));
  }

  return res.status(200).json({ ok: true });
};
