// api/ads-report.js
// Relatório de performance de campanha (Fase 2 = Supabase / fonte da verdade dos
// cadastros). Views futuras: view=meta (Marketing API) e view=unified (CPA real).
//
// Protegido por ADMIN_SECRET (Authorization: Bearer <ADMIN_SECRET>).
// SÓ AGREGADOS/CONTAGENS — nunca retorna email ou qualquer PII.
//
// GET /api/ads-report?view=signups&days=30
//   → total de cadastros, quantos de utm_source=facebook, série diária (BRT),
//     tendência 7/14/30d, ranking por criativo (utm_id estável + utm_content).

function safeEqual(a, b) {
  a = String(a || ''); b = String(b || '');
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// dia em BRT (UTC-3), mesmo fuso usado no resto do produto (limite diário etc.)
function diaBRT(iso) {
  return new Date(new Date(iso).getTime() - 3 * 3600 * 1000).toISOString().slice(0, 10);
}

// Busca paginada em subscribers (PostgREST corta em 1000 por page — pagina até
// esgotar). Retorna SÓ colunas de agregação, nunca email.
async function fetchSubscribers(SUPABASE_URL, headers, sinceIso) {
  const cols = 'created_at,utm_source,utm_medium,utm_campaign,utm_content,utm_id';
  const rows = [];
  const PAGE = 1000;
  for (let offset = 0; offset < 100000; offset += PAGE) {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/subscribers?created_at=gte.${encodeURIComponent(sinceIso)}&select=${cols}&order=created_at.asc`,
      { headers: { ...headers, Range: `${offset}-${offset + PAGE - 1}`, 'Range-Unit': 'items' } }
    );
    if (!r.ok) break;
    const batch = await r.json();
    if (!Array.isArray(batch) || !batch.length) break;
    rows.push(...batch);
    if (batch.length < PAGE) break;
  }
  return rows;
}

function relatorioSignups(rows, days) {
  const now = Date.now();
  const isFb = (s) => String(s || '').toLowerCase() === 'facebook';
  const dentro = (r, d) => (now - new Date(r.created_at).getTime()) <= d * 86400000;

  // série diária (BRT)
  const daily = {};
  for (const r of rows) {
    const d = diaBRT(r.created_at);
    daily[d] = daily[d] || { date: d, total: 0, facebook: 0 };
    daily[d].total++;
    if (isFb(r.utm_source)) daily[d].facebook++;
  }
  const serie = Object.values(daily).sort((a, b) => a.date.localeCompare(b.date));

  // tendência 7/14/30
  const janela = (d) => {
    const sub = rows.filter((r) => dentro(r, d));
    return { dias: d, total: sub.length, facebook: sub.filter((r) => isFb(r.utm_source)).length };
  };

  // ranking por criativo (só facebook). Chave = utm_id (estável); nome = utm_content.
  const crMap = {};
  for (const r of rows) {
    if (!isFb(r.utm_source)) continue;
    const key = r.utm_id || r.utm_content || '(sem utm_content/id)';
    crMap[key] = crMap[key] || { utm_id: r.utm_id || null, utm_content: r.utm_content || null, signups: 0 };
    crMap[key].signups++;
    if (!crMap[key].utm_content && r.utm_content) crMap[key].utm_content = r.utm_content;
  }
  const por_criativo = Object.values(crMap).sort((a, b) => b.signups - a.signups);

  const fbTotal = rows.filter((r) => isFb(r.utm_source)).length;
  return {
    janela_dias: days,
    total_cadastros: rows.length,
    de_facebook: fbTotal,
    de_facebook_pct: rows.length ? +(100 * fbTotal / rows.length).toFixed(1) : 0,
    tendencia: { ultimos_7: janela(7), ultimos_14: janela(14), ultimos_30: janela(30) },
    por_dia: serie,
    por_criativo,
    _nota: fbTotal === 0
      ? 'Zero cadastros com utm_source=facebook ainda. Após a Fase 1 (UTM único por criativo no Ads Manager) e cadastros novos rodarem, este relatório popula.'
      : undefined,
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const ADMIN_SECRET = process.env.ADMIN_SECRET;
  if (!ADMIN_SECRET || !safeEqual(req.headers['authorization'], `Bearer ${ADMIN_SECRET}`)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: 'not_configured' });
  const headers = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` };

  const view = (req.query.view || 'signups').toString();
  const days = Math.min(365, Math.max(1, parseInt(req.query.days) || 30));

  try {
    if (view === 'signups') {
      const sinceIso = new Date(Date.now() - days * 86400000).toISOString();
      const rows = await fetchSubscribers(SUPABASE_URL, headers, sinceIso);
      return res.status(200).json({ view: 'signups', gerado_em: new Date().toISOString(), ...relatorioSignups(rows, days) });
    }
    // views 'meta' (Fase 3) e 'unified' (Fase 4) entram aqui.
    return res.status(400).json({ error: 'view_desconhecida', disponiveis: ['signups'] });
  } catch (e) {
    console.error('[ads-report]', e.message);
    return res.status(500).json({ error: 'internal', detail: e.message });
  }
}
