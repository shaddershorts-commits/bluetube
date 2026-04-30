// api/marketing-attribution.js
//
// Endpoint pra gravar atribuicao de marketing (UTM/fbclid/gclid) no
// subscriber recem-criado. Chamado pelo frontend LOGO APOS o signup OK
// (fire-and-forget, nao bloqueia UX).
//
// POST /api/marketing-attribution
//   Body: {
//     token:  string (Supabase access_token do user logado),
//     email:  string (email do subscriber),
//     attribution: {
//       utm_source, utm_medium, utm_campaign, utm_content, utm_term,
//       fbclid, gclid, referrer, landing_page,
//       first_visit_at, attribution_set_at
//     }
//   }
//
// AUTH: valida token via /auth/v1/user (mesmo padrao de outros endpoints).
//       Compara user.email === payload.email. Se divergir, silent fail.
//
// RESPOSTA: SEMPRE 200 (mesmo em erro/fraude). Frontend nao precisa retry.
//           Erros vao pra Vercel Logs com tag [marketing-attr] pra forensics.
//
// LIMITES sanity (defesa em profundidade):
//   - VARCHAR length conforme schema (utm_source 100, utm_campaign 200, etc)
//   - String tipo apenas; numbers/objects sao ignorados
//   - URL params longos (>500) sao truncados

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || SUPABASE_SERVICE_KEY;

const supaH = {
  apikey: SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
  'Content-Type': 'application/json',
};

// Limites por campo (alinhados com a migration)
const FIELD_LIMITS = {
  utm_source: 100,
  utm_medium: 100,
  utm_campaign: 200,
  utm_content: 200,
  utm_term: 200,
  fbclid: 500,
  gclid: 500,
  landing_page: 500,
  referrer: 2000, // TEXT no schema, mas truncamos por sanidade
};

function sanitize(value, maxLen) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, maxLen);
}

function sanitizeIso(value) {
  if (typeof value !== 'string') return null;
  // Formato esperado: ISO 8601 — valida via Date parse
  const t = Date.parse(value);
  if (isNaN(t)) return null;
  return new Date(t).toISOString();
}

module.exports = async function handler(req, res) {
  // Resposta defensiva: sempre 200 pra nao confundir frontend
  const ok = (extra) => res.status(200).json({ ok: true, ...(extra || {}) });

  try {
    if (req.method !== 'POST') {
      console.warn('[marketing-attr] method nao permitido:', req.method);
      return ok({ skipped: 'method_not_allowed' });
    }
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
      console.error('[marketing-attr] config_missing');
      return ok({ skipped: 'config_missing' });
    }

    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    const token = typeof body.token === 'string' ? body.token : '';
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const attribution = (body.attribution && typeof body.attribution === 'object') ? body.attribution : {};

    if (!token || !email) {
      console.warn('[marketing-attr] payload incompleto:', { hasToken: !!token, hasEmail: !!email });
      return ok({ skipped: 'missing_token_or_email' });
    }

    // 1. Valida token via Supabase Auth API
    const userR = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
    });
    if (!userR.ok) {
      console.warn('[marketing-attr] token invalido:', userR.status, 'email-claim:', email);
      return ok({ skipped: 'invalid_token' });
    }
    const user = await userR.json();
    const tokenEmail = String(user?.email || '').trim().toLowerCase();

    // 2. Token email DEVE bater com payload email (anti-fraude)
    if (!tokenEmail || tokenEmail !== email) {
      console.warn('[marketing-attr] email_mismatch — possivel fraude:', {
        token_email: tokenEmail, payload_email: email,
      });
      return ok({ skipped: 'email_mismatch' });
    }

    // 3. Sanitiza atribuicao
    const utm = {
      utm_source:   sanitize(attribution.utm_source,   FIELD_LIMITS.utm_source),
      utm_medium:   sanitize(attribution.utm_medium,   FIELD_LIMITS.utm_medium),
      utm_campaign: sanitize(attribution.utm_campaign, FIELD_LIMITS.utm_campaign),
      utm_content:  sanitize(attribution.utm_content,  FIELD_LIMITS.utm_content),
      utm_term:     sanitize(attribution.utm_term,     FIELD_LIMITS.utm_term),
      fbclid:       sanitize(attribution.fbclid,       FIELD_LIMITS.fbclid),
      gclid:        sanitize(attribution.gclid,        FIELD_LIMITS.gclid),
      landing_page: sanitize(attribution.landing_page, FIELD_LIMITS.landing_page),
      referrer:     sanitize(attribution.referrer,     FIELD_LIMITS.referrer),
      first_visit_at:    sanitizeIso(attribution.first_visit_at),
      attribution_set_at: sanitizeIso(attribution.attribution_set_at) || new Date().toISOString(),
    };

    // Se TODOS os campos sao null exceto attribution_set_at, nao vale persistir
    const temAlgo = Object.entries(utm).some(([k, v]) =>
      k !== 'attribution_set_at' && v !== null
    );
    if (!temAlgo) {
      return ok({ skipped: 'no_attribution_data' });
    }

    // 4. PATCH em subscribers (idempotente — sobrescreve com last-touch)
    const patchR = await fetch(
      `${SUPABASE_URL}/rest/v1/subscribers?email=eq.${encodeURIComponent(email)}`,
      {
        method: 'PATCH',
        headers: { ...supaH, Prefer: 'return=minimal' },
        body: JSON.stringify(utm),
      }
    );

    if (!patchR.ok) {
      const errTxt = await patchR.text().catch(() => '');
      console.error('[marketing-attr] patch_failed:', patchR.status, errTxt.slice(0, 200), 'email:', email);
      return ok({ skipped: 'patch_failed', status: patchR.status });
    }

    return ok({
      saved: true,
      fields_set: Object.keys(utm).filter(k => utm[k] !== null).length,
    });
  } catch (e) {
    console.error('[marketing-attr] erro inesperado:', e.message);
    return ok({ skipped: 'unexpected_error' });
  }
};
