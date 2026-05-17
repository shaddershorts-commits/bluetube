// api/sitemap.js — Sitemap dinâmico com hreflang cross-link multi-idioma
//
// Gera sitemap.xml em runtime baseado em:
//   1. Páginas principais (lista fixa abaixo)
//   2. Posts do blog em /public/blog/posts/*.html (PT canonica)
//   3. Traduções em /public/{lang}/blog/posts/*.html (auto-detected)
//
// Cada URL tem <xhtml:link rel="alternate" hreflang="..."> cross-link pra
// TODAS as versões existentes (Google premia esse padrão).
//
// vercel.json deve ter rewrite: /sitemap.xml → /api/sitemap
//
// Cache: 1h (s-maxage). Google re-crawl raramente, não precisa instant.

const fs = require('fs');
const path = require('path');

const SITE = 'https://bluetubeviral.com';
const SUPPORTED_LANGS = ['pt', 'en', 'es']; // expandir conforme rolar backfill
const PUBLIC_DIR = path.join(process.cwd(), 'public');

// Páginas principais (PT canonica)
const MAIN_PAGES = [
  { path: '/',            lastmod: '2026-05-17', changefreq: 'daily',   priority: '1.0' },
  { path: '/blog/',       lastmod: '2026-05-17', changefreq: 'weekly',  priority: '0.9' },
  { path: '/blue',        lastmod: '2026-05-17', changefreq: 'weekly',  priority: '0.8' },
  { path: '/blueEditor',  lastmod: '2026-04-20', changefreq: 'monthly', priority: '0.7' },
  { path: '/baixaBlue',   lastmod: '2026-05-15', changefreq: 'monthly', priority: '0.7' },
  { path: '/desafio',     lastmod: '2026-05-17', changefreq: 'weekly',  priority: '0.7' },
  { path: '/afiliado',    lastmod: '2026-04-20', changefreq: 'monthly', priority: '0.7' },
  { path: '/pioneiros',   lastmod: '2026-04-20', changefreq: 'monthly', priority: '0.6' },
  { path: '/termos',      lastmod: '2026-04-20', changefreq: 'yearly',  priority: '0.3' },
  { path: '/privacidade', lastmod: '2026-04-20', changefreq: 'yearly',  priority: '0.3' },
];

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Helper: idiomas em que o post tem tradução (incluindo PT canonica)
function getPostLangs(slug) {
  const langs = [];
  // PT canonica em /blog/posts/
  if (fs.existsSync(path.join(PUBLIC_DIR, 'blog', 'posts', `${slug}.html`))) {
    langs.push('pt');
  }
  // Outras línguas em /{lang}/blog/posts/
  for (const lang of SUPPORTED_LANGS) {
    if (lang === 'pt') continue;
    if (fs.existsSync(path.join(PUBLIC_DIR, lang, 'blog', 'posts', `${slug}.html`))) {
      langs.push(lang);
    }
  }
  return langs;
}

// URL canonica de cada idioma pra um post
function postUrl(slug, lang) {
  if (lang === 'pt') return `${SITE}/blog/posts/${slug}.html`;
  return `${SITE}/${lang}/blog/posts/${slug}.html`;
}

// Gera bloco <url> com hreflang cross-link de TODAS as línguas existentes
function buildPostUrlBlock(slug, lang, allLangs, lastmod) {
  const loc = postUrl(slug, lang);
  const hreflang = allLangs.map(l => {
    const hflang = l === 'pt' ? 'pt-BR' : l;
    return `    <xhtml:link rel="alternate" hreflang="${hflang}" href="${postUrl(slug, l)}"/>`;
  }).join('\n');
  // x-default sempre aponta pra PT (canonica)
  const xdef = `    <xhtml:link rel="alternate" hreflang="x-default" href="${postUrl(slug, 'pt')}"/>`;

  return `  <url>
    <loc>${escapeXml(loc)}</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.8</priority>
${hreflang}
${xdef}
  </url>`;
}

// Gera bloco <url> simples pra paginas principais (sem hreflang por enquanto)
function buildMainUrlBlock(page) {
  return `  <url>
    <loc>${escapeXml(SITE + page.path)}</loc>
    <lastmod>${page.lastmod}</lastmod>
    <changefreq>${page.changefreq}</changefreq>
    <priority>${page.priority}</priority>
  </url>`;
}

module.exports = async function handler(req, res) {
  try {
    const postsDir = path.join(PUBLIC_DIR, 'blog', 'posts');
    let slugs = [];
    if (fs.existsSync(postsDir)) {
      slugs = fs.readdirSync(postsDir)
        .filter(f => f.endsWith('.html'))
        .map(f => f.replace(/\.html$/, ''));
    }

    // Lastmod: usa mtime do arquivo PT canonica (mais recente entre os 2 — mtime ou hoje)
    const today = new Date().toISOString().slice(0, 10);

    const blocks = [];
    blocks.push(...MAIN_PAGES.map(buildMainUrlBlock));

    for (const slug of slugs) {
      const allLangs = getPostLangs(slug);
      let lastmod = today;
      try {
        const stat = fs.statSync(path.join(postsDir, `${slug}.html`));
        lastmod = stat.mtime.toISOString().slice(0, 10);
      } catch {}
      // Adiciona entry pra CADA versão linguística existente
      for (const lang of allLangs) {
        blocks.push(buildPostUrlBlock(slug, lang, allLangs, lastmod));
      }
    }

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:xhtml="http://www.w3.org/1999/xhtml">
${blocks.join('\n')}
</urlset>`;

    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
    return res.status(200).send(xml);
  } catch (e) {
    console.error('[sitemap]', e.message);
    res.setHeader('Content-Type', 'text/plain');
    return res.status(500).send('sitemap_error: ' + e.message);
  }
};
