// api/blog-translate.js — Pipeline de tradução de posts de blog
//
// Actions:
//   POST ?action=translate
//     body: { slug, targets: ['en','es',...], mode: 'publish'|'dry-run' }
//     - Le public/blog/posts/{slug}.html
//     - Pra cada target, traduz e ESCREVE em public/{target}/blog/posts/{slug}.html
//     - mode='dry-run' retorna HTML sem escrever (smoke)
//
//   GET ?action=stats
//     - Lista posts em public/blog/posts/ + status de tradução por idioma
//
//   POST ?action=translate-all
//     body: { targets, mode }
//     - Roda translate em TODOS os posts existentes (backfill)
//
// AUTH: exige Bearer ADMIN_SECRET (escrita em filesystem + custo API).
//
// IMPORTANTE: este endpoint roda em runtime Vercel Functions Node (NAO Edge).
// Precisa de fs pra escrever arquivos. Custo: ~$0.50-2 por artigo por idioma
// via Claude Opus 4.7. mode='dry-run' nao gasta API SE retornar sem chamar
// (na verdade chama, so nao escreve — pra economizar, use sleep/cache).

const fs = require('fs');
const path = require('path');

const { translatePostHtml, hashHtml, LANG_META, SUPPORTED_LANGS } = require('./_helpers/blog-translate');

const POSTS_DIR = path.join(process.cwd(), 'public', 'blog', 'posts');
const BLOG_DIR = path.join(process.cwd(), 'public', 'blog');
const PUBLIC_DIR = path.join(process.cwd(), 'public');

// Slugs especiais que não estão em /posts/ (ex: 'index' = blog/index.html)
const SPECIAL_SOURCES = {
  index: { source: path.join(BLOG_DIR, 'index.html'), outSubpath: 'blog/index.html' },
};

function isValidSlug(s) {
  // Lowercase explicit + alphanumeric + dash/underscore (filesystem-safe)
  return typeof s === 'string' && (/^[a-z0-9_-]{1,80}$/.test(s) || SPECIAL_SOURCES[s]);
}

// Resolve path de origem dado um slug (post ou special)
function sourcePathFor(slug) {
  if (SPECIAL_SOURCES[slug]) return SPECIAL_SOURCES[slug].source;
  return path.join(POSTS_DIR, `${slug}.html`);
}

// Resolve path de output dado slug + target lang
function outputPathFor(slug, target) {
  if (SPECIAL_SOURCES[slug]) {
    return path.join(PUBLIC_DIR, target, SPECIAL_SOURCES[slug].outSubpath);
  }
  return path.join(PUBLIC_DIR, target, 'blog', 'posts', `${slug}.html`);
}

function isValidLang(l) {
  return SUPPORTED_LANGS.includes(l) && l !== 'pt';
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Auth: SEMPRE exige ADMIN_SECRET (escrita FS + custo API)
  const ADMIN_SECRET = process.env.ADMIN_SECRET;
  const auth = req.headers.authorization || '';
  if (!ADMIN_SECRET || auth !== `Bearer ${ADMIN_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const action = (req.query.action || (req.body && req.body.action) || '').toString();

  try {
    if (action === 'stats')          return await stats(req, res);
    if (action === 'translate')      return await translateOne(req, res);
    if (action === 'translate-all')  return await translateAll(req, res);
    return res.status(400).json({ error: 'action_invalida', valid: ['stats','translate','translate-all'] });
  } catch (e) {
    console.error('[blog-translate]', action, e.message);
    return res.status(500).json({ error: e.message });
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// ACTION: stats — lista posts + status de traducao por idioma
// ═══════════════════════════════════════════════════════════════════════════
async function stats(req, res) {
  if (!fs.existsSync(POSTS_DIR)) {
    return res.status(200).json({ ok: true, posts: [], total: 0 });
  }

  const ptFiles = fs.readdirSync(POSTS_DIR).filter(f => f.endsWith('.html'));
  const posts = ptFiles.map(filename => {
    const slug = filename.replace(/\.html$/, '');
    const entry = { slug, filename, pt: true };
    for (const lang of Object.keys(LANG_META)) {
      if (lang === 'pt') continue;
      const transPath = path.join(PUBLIC_DIR, lang, 'blog', 'posts', filename);
      entry[lang] = fs.existsSync(transPath);
    }
    return entry;
  });

  // Resumo agregado
  const summary = {};
  for (const lang of Object.keys(LANG_META)) {
    if (lang === 'pt') continue;
    summary[lang] = posts.filter(p => p[lang]).length;
  }

  return res.status(200).json({
    ok: true,
    total: posts.length,
    summary,
    supported_langs: SUPPORTED_LANGS,
    posts,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// ACTION: translate — traduz UM post pra um ou mais idiomas
// ═══════════════════════════════════════════════════════════════════════════
async function translateOne(req, res) {
  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const slug = (body.slug || req.query.slug || '').toString();
  const targetsRaw = body.targets || (req.query.targets ? String(req.query.targets).split(',') : []);
  const targets = Array.isArray(targetsRaw) ? targetsRaw : [];
  const mode = (body.mode || req.query.mode || 'publish').toString();

  if (!isValidSlug(slug)) return res.status(400).json({ error: 'slug_invalido' });
  if (!targets.length) return res.status(400).json({ error: 'targets_required' });
  for (const t of targets) {
    if (!isValidLang(t)) return res.status(400).json({ error: 'target_invalido: ' + t });
  }
  if (!['publish', 'dry-run'].includes(mode)) {
    return res.status(400).json({ error: 'mode_invalido', valid: ['publish', 'dry-run'] });
  }

  const sourcePath = sourcePathFor(slug);
  if (!fs.existsSync(sourcePath)) {
    return res.status(404).json({ error: 'post_nao_encontrado', path: sourcePath });
  }

  const htmlSource = fs.readFileSync(sourcePath, 'utf8');
  const sourceHash = await hashHtml(htmlSource);

  const results = [];
  for (const target of targets) {
    const startTs = Date.now();
    try {
      const html = await translatePostHtml(htmlSource, target, { slug });
      const out = {
        target,
        ok: true,
        size_chars: html.length,
        duration_ms: Date.now() - startTs,
        source_hash: sourceHash,
      };

      if (mode === 'publish') {
        const outPath = outputPathFor(slug, target);
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, html, 'utf8');
        out.written_to = outPath.replace(PUBLIC_DIR, '').replace(/\\/g, '/');
      } else {
        out.dry_run_preview = html.slice(0, 500) + '...';
      }
      results.push(out);
    } catch (e) {
      results.push({
        target,
        ok: false,
        error: e.message,
        duration_ms: Date.now() - startTs,
      });
    }
  }

  return res.status(200).json({
    ok: true,
    slug,
    mode,
    source_hash: sourceHash,
    results,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// ACTION: translate-all — backfill TODOS os posts existentes
// ═══════════════════════════════════════════════════════════════════════════
async function translateAll(req, res) {
  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const targetsRaw = body.targets || (req.query.targets ? String(req.query.targets).split(',') : []);
  const targets = Array.isArray(targetsRaw) ? targetsRaw : [];
  const mode = (body.mode || req.query.mode || 'publish').toString();
  const skipExisting = body.skip_existing !== false; // default true

  if (!targets.length) return res.status(400).json({ error: 'targets_required' });
  for (const t of targets) {
    if (!isValidLang(t)) return res.status(400).json({ error: 'target_invalido: ' + t });
  }

  // Lista TODOS os slugs: posts + 'index' (special)
  const slugs = [];
  if (fs.existsSync(POSTS_DIR)) {
    for (const f of fs.readdirSync(POSTS_DIR)) {
      if (f.endsWith('.html')) slugs.push(f.replace(/\.html$/, ''));
    }
  }
  // Adiciona 'index' (blog/index.html) ao backfill
  if (fs.existsSync(path.join(BLOG_DIR, 'index.html'))) {
    slugs.push('index');
  }

  if (!slugs.length) {
    return res.status(200).json({ ok: true, processed: 0, results: [] });
  }

  const overallStart = Date.now();
  const results = [];
  let totalSuccess = 0, totalSkipped = 0, totalErrors = 0;

  for (const slug of slugs) {
    const sourcePath = sourcePathFor(slug);
    const htmlSource = fs.readFileSync(sourcePath, 'utf8');

    for (const target of targets) {
      const startTs = Date.now();
      const outPath = outputPathFor(slug, target);

      // Skip se ja existe e skipExisting=true
      if (skipExisting && fs.existsSync(outPath) && mode === 'publish') {
        results.push({ slug, target, ok: true, skipped: 'already_exists' });
        totalSkipped++;
        continue;
      }

      try {
        const html = await translatePostHtml(htmlSource, target, { slug });
        if (mode === 'publish') {
          fs.mkdirSync(path.dirname(outPath), { recursive: true });
          fs.writeFileSync(outPath, html, 'utf8');
        }
        results.push({
          slug, target, ok: true,
          size_chars: html.length,
          duration_ms: Date.now() - startTs,
          written: mode === 'publish',
        });
        totalSuccess++;
      } catch (e) {
        results.push({ slug, target, ok: false, error: e.message });
        totalErrors++;
      }
    }
  }

  return res.status(200).json({
    ok: true,
    mode,
    total_slugs: slugs.length,
    total_targets: targets.length,
    total_combinations: slugs.length * targets.length,
    total_success: totalSuccess,
    total_skipped: totalSkipped,
    total_errors: totalErrors,
    duration_ms: Date.now() - overallStart,
    results,
  });
}
