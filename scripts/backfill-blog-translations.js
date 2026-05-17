#!/usr/bin/env node
// scripts/backfill-blog-translations.js
//
// Roda traducao AI dos posts de blog LOCALMENTE (Vercel Functions FS e
// efemero, nao persiste publish). Gera arquivos em public/{lang}/blog/.
// Depois Felipe roda git add/commit/push pra entregar.
//
// USO:
//   ANTHROPIC_API_KEY=sk-ant-... node scripts/backfill-blog-translations.js
//   # ou com targets especificos:
//   ANTHROPIC_API_KEY=sk-ant-... node scripts/backfill-blog-translations.js --targets=en
//   # ou um slug especifico:
//   ANTHROPIC_API_KEY=sk-ant-... node scripts/backfill-blog-translations.js --slug=quanto-youtube-paga-shorts
//
// SKIP EXISTENTES por default. --force pra retraduzir.

const fs = require('fs');
const path = require('path');
const { translatePostHtml, LANG_META } = require('../api/_helpers/blog-translate');

const ROOT = path.join(__dirname, '..');
const POSTS_DIR = path.join(ROOT, 'public', 'blog', 'posts');
const BLOG_INDEX = path.join(ROOT, 'public', 'blog', 'index.html');
const PUBLIC_DIR = path.join(ROOT, 'public');

// Parse args
const args = process.argv.slice(2);
function arg(name, def) {
  const m = args.find(a => a.startsWith('--' + name + '='));
  return m ? m.slice(name.length + 3) : def;
}
const TARGETS = (arg('targets', 'en,es')).split(',').map(s => s.trim()).filter(Boolean);
const ONLY_SLUG = arg('slug', null);
const FORCE = args.includes('--force');

console.log('═══ Backfill blog translations ═══');
console.log('Targets:', TARGETS.join(', '));
console.log('Only slug:', ONLY_SLUG || '(todos)');
console.log('Force re-translate:', FORCE);
console.log('');

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('❌ ANTHROPIC_API_KEY missing. Set env var first.');
  process.exit(1);
}

// Valida targets
for (const t of TARGETS) {
  if (!LANG_META[t] || t === 'pt') {
    console.error(`❌ Invalid target: ${t}`);
    process.exit(1);
  }
}

// Lista slugs (posts + index)
const slugs = [];
if (fs.existsSync(POSTS_DIR)) {
  for (const f of fs.readdirSync(POSTS_DIR)) {
    if (f.endsWith('.html')) {
      const slug = f.replace(/\.html$/, '');
      if (!ONLY_SLUG || slug === ONLY_SLUG) slugs.push(slug);
    }
  }
}
if (fs.existsSync(BLOG_INDEX) && (!ONLY_SLUG || ONLY_SLUG === 'index')) {
  slugs.push('index');
}

if (!slugs.length) {
  console.error('❌ No slugs found');
  process.exit(1);
}

console.log(`Encontrados ${slugs.length} slugs:`, slugs.join(', '));
console.log('');

function sourcePathFor(slug) {
  if (slug === 'index') return BLOG_INDEX;
  return path.join(POSTS_DIR, `${slug}.html`);
}

function outputPathFor(slug, target) {
  if (slug === 'index') return path.join(PUBLIC_DIR, target, 'blog', 'index.html');
  return path.join(PUBLIC_DIR, target, 'blog', 'posts', `${slug}.html`);
}

// Sleep entre traducoes pra respeitar rate limit Anthropic (8k output/min tier1).
// Posts grandes (20k+ tokens output) precisam ~2.5min de cooldown entre chamadas.
// Posts pequenos (<5k output) podem ser mais rapidos. Default 150s = 2.5min.
const SLEEP_BETWEEN_MS = parseInt(arg('sleep', '150000'), 10);

(async () => {
  const startOverall = Date.now();
  let totalSuccess = 0, totalSkipped = 0, totalErrors = 0;
  let chamadasReais = 0; // pra contar quantas vezes precisou sleep

  for (const slug of slugs) {
    const sourcePath = sourcePathFor(slug);
    if (!fs.existsSync(sourcePath)) {
      console.log(`  ⚠️  ${slug}: source nao existe (${sourcePath}). Skip.`);
      continue;
    }
    const html = fs.readFileSync(sourcePath, 'utf8');
    console.log(`📄 ${slug} (${html.length} chars source)`);

    for (const target of TARGETS) {
      const outPath = outputPathFor(slug, target);
      if (!FORCE && fs.existsSync(outPath)) {
        console.log(`  ⏭️  ${target}: ja existe (${outPath}). Skip. Use --force pra retraduzir.`);
        totalSkipped++;
        continue;
      }

      // Sleep ANTES de cada chamada real (exceto a primeira)
      if (chamadasReais > 0) {
        const sleepSec = (SLEEP_BETWEEN_MS / 1000).toFixed(0);
        console.log(`  ⏸️  Aguardando ${sleepSec}s pra respeitar rate limit Anthropic...`);
        await new Promise(r => setTimeout(r, SLEEP_BETWEEN_MS));
      }

      const start = Date.now();
      try {
        process.stdout.write(`  🌐 ${target}: traduzindo... `);
        const translated = await translatePostHtml(html, target, { slug });
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, translated, 'utf8');
        const dur = ((Date.now() - start) / 1000).toFixed(1);
        const relPath = outPath.replace(ROOT, '').replace(/\\/g, '/');
        console.log(`✅ ${translated.length} chars em ${dur}s → ${relPath}`);
        totalSuccess++;
        chamadasReais++;
      } catch (e) {
        const dur = ((Date.now() - start) / 1000).toFixed(1);
        console.log(`❌ falhou em ${dur}s: ${e.message.slice(0, 200)}`);
        totalErrors++;
        chamadasReais++; // mesmo falhando, gastou cota
      }
    }
    console.log('');
  }

  const totalDur = ((Date.now() - startOverall) / 1000 / 60).toFixed(1);
  console.log('═══ RESUMO ═══');
  console.log(`✅ Success: ${totalSuccess}`);
  console.log(`⏭️  Skipped: ${totalSkipped}`);
  console.log(`❌ Errors:  ${totalErrors}`);
  console.log(`Duracao total: ${totalDur}min`);
  console.log('');
  console.log('Proximos passos:');
  console.log('  1. git add public/en public/es');
  console.log('  2. git commit -m "feat(blog-i18n): backfill EN+ES dos 6 posts + index"');
  console.log('  3. Atualizar middleware.js: LANGS_WITH_BLOG = [\'en\', \'es\']');
  console.log('  4. git commit + push');
})();
