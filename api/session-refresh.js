// api/session-refresh.js — renova a sessão Supabase (access_token) a partir do
// refresh_token salvo no navegador. Endpoint ISOLADO de propósito: api/auth.js
// é intocável e NÃO tem action 'refresh' — o toolbar chamava lá e falhava em
// silêncio, deixando o token vencer com a aba aberta (sintoma: filtro 5h da
// Virais "sumia" até o usuário relogar).
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  const SU = process.env.SUPABASE_URL;
  const AK = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (!SU || !AK) return res.status(500).json({ error: 'config' });

  const rt = req.body?.refresh_token;
  if (!rt || typeof rt !== 'string') return res.status(400).json({ error: 'refresh_token_obrigatorio' });

  try {
    const r = await fetch(`${SU}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: { apikey: AK, 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: rt }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.access_token) return res.status(401).json({ error: 'refresh_invalido' });
    // Supabase ROTACIONA o refresh_token: devolve sempre o novo pro cliente salvar.
    return res.status(200).json({ session: { access_token: d.access_token, refresh_token: d.refresh_token || rt } });
  } catch (e) {
    return res.status(502).json({ error: 'supabase_indisponivel' });
  }
};
