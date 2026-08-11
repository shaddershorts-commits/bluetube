// tests/unit/seo_canonical_sitemap.test.mjs — node --test
// ============================================================================
// Sinais de SEO que já estavam errados em produção (medidos em 11/08/2026):
//   · o sitemap listava 28 URLs, TODAS sem www — mas o site vive no www
//     (bluetubeviral.com responde 307 e manda pra lá). Cada URL do sitemap
//     batia num redirecionamento antes do conteúdo.
//   · as 9 páginas de ferramenta não tinham canonical NENHUMA.
//   · a home tinha canonical, mas apontando pro apex que redireciona.
//   · o sitemap listava /blog/posts/x.html, que responde 308 pra /blog/posts/x.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const WWW = 'https://www.bluetubeviral.com';
const FERRAMENTAS = ['blueVoice', 'blueScore', 'blueLens', 'virais', 'baixaBlue',
  'blueClean', 'bluetendencias', 'blue', 'blueEditor'];

function ler(arq) { return readFileSync(new URL('../../public/' + arq, import.meta.url), 'utf8'); }

async function gerarSitemap() {
  const h = require('../../api/sitemap.js');
  const res = { setHeader() {}, status() { return this; }, send(x) { this.body = x; return this; }, end() {} };
  await h({ query: {} }, res);
  return res.body || '';
}

test('CANONICAL: toda ferramenta tem canonical auto-referente COM www', () => {
  for (const f of FERRAMENTAS) {
    const html = ler(f + '.html');
    const m = html.match(/<link rel="canonical" href="([^"]+)"/);
    assert.ok(m, `${f}.html sem canonical — o Google fica sem âncora de qual URL é a oficial`);
    assert.equal(m[1], WWW + '/' + f, `${f}.html: canonical aponta pra ${m[1]}`);
  }
});

test('CANONICAL: a home aponta pro www, não pro apex que redireciona', () => {
  const m = ler('index.html').match(/<link rel="canonical" href="([^"]+)"/);
  assert.ok(m, 'a home perdeu o canonical');
  assert.equal(m[1], WWW + '/',
    'canonical no apex manda o Google pro 307 — foi o conserto nº1 do diagnóstico');
});

test('SITEMAP: nenhuma URL sem www', async () => {
  const locs = [...(await gerarSitemap()).matchAll(/<loc>([^<]+)/g)].map((m) => m[1]);
  assert.ok(locs.length >= 30, `só ${locs.length} URLs — alguma coisa sumiu do sitemap`);
  const semWww = locs.filter((u) => !u.startsWith(WWW));
  assert.deepEqual(semWww, [], 'URLs fora do domínio canônico batem em redirecionamento');
});

test('SITEMAP: nenhuma URL .html (elas respondem 308)', async () => {
  const locs = [...(await gerarSitemap()).matchAll(/<loc>([^<]+)/g)].map((m) => m[1]);
  assert.deepEqual(locs.filter((u) => u.endsWith('.html')), [],
    'URL que redireciona no sitemap faz o Google gastar duas idas por post');
});

test('SITEMAP: as ferramentas que existem estão listadas', async () => {
  const xml = await gerarSitemap();
  const faltando = ['blueVoice', 'blueScore', 'blueLens', 'virais', 'blueClean', 'bluetendencias']
    .filter((f) => !xml.includes('<loc>' + WWW + '/' + f + '<'));
  assert.deepEqual(faltando, [],
    'ferramenta fora do sitemap é ferramenta que o Google não tem por onde descobrir');
});

test('SITEMAP: o hreflang dos posts continua de pé', async () => {
  const xml = await gerarSitemap();
  assert.ok((xml.match(/hreflang/g) || []).length >= 60,
    'os cross-links de idioma sumiram — as 3 versões voltam a parecer duplicata');
  assert.match(xml, /hreflang="x-default"/);
});

test('ROBOTS: a linha Sitemap aponta pro domínio canônico', () => {
  const r = readFileSync(new URL('../../public/robots.txt', import.meta.url), 'utf8');
  const m = r.match(/Sitemap:\s*(\S+)/i);
  assert.ok(m, 'robots.txt sem linha Sitemap');
  assert.ok(m[1].startsWith(WWW), `aponta pra ${m[1]}`);
});

test('ROBOTS: o Googlebot continua LIBERADO (não quebrar o que funciona)', () => {
  const r = readFileSync(new URL('../../public/robots.txt', import.meta.url), 'utf8');
  // O bloco "User-agent: *" do repo não pode ganhar um Disallow: / — os
  // Disallow: / que aparecem em produção são por-robô e vêm do Cloudflare.
  assert.equal(/User-agent:\s*\*[\s\S]{0,200}?Disallow:\s*\/\s*$/m.test(r), false,
    'alguém bloqueou o site inteiro no robots.txt');
  assert.match(r, /Disallow:\s*\/api\//, 'o bloqueio de /api/ sumiu');
});
