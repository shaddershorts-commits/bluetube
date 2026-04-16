// api/_helpers/checkBan.js — Verifica banimento ativo
// CommonJS

async function checkBan(userId, supabaseUrl, headers) {
  if (!userId) return null;
  try {
    const now = new Date().toISOString();
    const r = await fetch(
      `${supabaseUrl}/rest/v1/blue_banimentos?user_id=eq.${userId}&or=(expira_em.is.null,expira_em.gt.${now})&order=created_at.desc&limit=1&select=id,motivo,tipo,expira_em,created_at`,
      { headers }
    );
    if (!r.ok) return null;
    const rows = await r.json();
    return rows[0] || null;
  } catch(e) { return null; }
}

module.exports = { checkBan };
