// middleware.js — Vercel Edge middleware (sem framework, Web API standard)
//
// Routing de idioma pro blog. PT canonica em /blog/..., outras lingua em
// /{lang}/blog/... Decisao em cascata:
//   1. Path ja tem /{lang}/ prefix → respeita
//   2. Cookie user_lang → respeita
//   3. Header Accept-Language → match com SUPPORTED
//   4. Header x-vercel-ip-country (Vercel injetado, FREE) → mapeia pra lang
//   5. Default: PT (mantem URL original, sem redirect)
//
// LIMITACAO INICIAL: middleware aplica SO em /blog/* (paths sem /{lang}/).
// Quando expandir pra site inteiro, ajustar matcher e logica.
//
// Vercel Edge Runtime: sem Node APIs (fs, child_process, etc). Pure Web API.

// Idiomas com tradução real disponivel
const SUPPORTED_LANGS = ['pt', 'en', 'es'];
// Idiomas onde JA temos versao /{lang}/blog/ traduzida e commitada
const LANGS_WITH_BLOG = ['en', 'es']; // PT eh canonica (sem prefixo)

// Mapeamento country (ISO 3166-1 alpha-2) → idioma
const COUNTRY_TO_LANG = {
  ES: 'es', MX: 'es', AR: 'es', CO: 'es', PE: 'es', CL: 'es', VE: 'es',
  EC: 'es', GT: 'es', CU: 'es', BO: 'es', DO: 'es', HN: 'es', PY: 'es',
  SV: 'es', NI: 'es', CR: 'es', PA: 'es', UY: 'es',
  US: 'en', GB: 'en', CA: 'en', AU: 'en', NZ: 'en', IE: 'en', ZA: 'en',
  IN: 'en', SG: 'en', PH: 'en', NG: 'en', KE: 'en',
  BR: 'pt', PT: 'pt', AO: 'pt', MZ: 'pt', CV: 'pt',
};

// Parse Accept-Language header → top language preferido suportado
function parseAcceptLanguage(header) {
  if (!header) return null;
  const langs = header.split(',').map(s => {
    const [code, q] = s.trim().split(';q=');
    return { code: (code || '').toLowerCase().split('-')[0], q: parseFloat(q || '1') };
  }).sort((a, b) => b.q - a.q);
  for (const l of langs) {
    if (SUPPORTED_LANGS.includes(l.code)) return l.code;
  }
  return null;
}

// Parse cookie header → object {name: value}
function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const pair of header.split(/;\s*/)) {
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    out[pair.slice(0, eq).trim()] = decodeURIComponent(pair.slice(eq + 1).trim());
  }
  return out;
}

export default function middleware(request) {
  const url = new URL(request.url);
  const pathname = url.pathname;

  // Skip pra requests que NAO devem ser tocadas (API, assets)
  // NOTA: .html NAO esta na lista — queremos que /blog/posts/X.html passe
  // pelo middleware pra eventual redirect pra /{lang}/blog/posts/X.html
  if (
    pathname.startsWith('/api/') ||
    pathname.startsWith('/_next/') ||
    pathname.startsWith('/blog/assets/') ||
    /\.(js|css|png|jpg|jpeg|svg|webp|ico|woff2?|ttf|map|xml|txt|json|pdf|gif)$/i.test(pathname)
  ) {
    return; // undefined = passa direto
  }

  // Path JA tem prefix de idioma /{lang}/ ? respeita
  const langPrefixMatch = pathname.match(/^\/([a-z]{2})(\/|$)/);
  if (langPrefixMatch && SUPPORTED_LANGS.includes(langPrefixMatch[1])) {
    return;
  }

  // Apenas /blog/* eh elegivel pra redirect por enquanto
  if (!pathname.startsWith('/blog')) {
    return;
  }

  // ── Decisao em cascata ──────────────────────────────────────────────────
  let targetLang = null;

  // 1. Cookie user_lang (preferencia manual persistente)
  const cookies = parseCookies(request.headers.get('cookie'));
  const cookieLang = cookies.user_lang;
  if (cookieLang && SUPPORTED_LANGS.includes(cookieLang)) {
    targetLang = cookieLang;
  }

  // 2. Accept-Language
  if (!targetLang) {
    targetLang = parseAcceptLanguage(request.headers.get('accept-language'));
  }

  // 3. Vercel injected geo header (FREE, instant)
  if (!targetLang) {
    const country = request.headers.get('x-vercel-ip-country');
    if (country && COUNTRY_TO_LANG[country]) {
      targetLang = COUNTRY_TO_LANG[country];
    }
  }

  // 4. Default PT — mantem URL original sem redirect
  if (!targetLang || targetLang === 'pt') {
    return;
  }

  // 5. Só redireciona pra idiomas com blog JA traduzido E commitado
  if (!LANGS_WITH_BLOG.includes(targetLang)) {
    return;
  }

  // Redirect 302 (preserva opcao do user via cookie depois)
  url.pathname = `/${targetLang}${pathname}`;
  return Response.redirect(url, 302);
}

// Matcher + runtime explicito (Vercel sem Next.js exige declaracao)
export const config = {
  runtime: 'edge',
  matcher: [
    '/blog',
    '/blog/:path*',
    '/:lang(en|es|fr|de|it|ja)/blog',
    '/:lang(en|es|fr|de|it|ja)/blog/:path*',
  ],
};
