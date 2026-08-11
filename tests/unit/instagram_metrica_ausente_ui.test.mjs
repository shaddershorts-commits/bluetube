// tests/unit/instagram_metrica_ausente_ui.test.mjs — node --test
// ============================================================================
// Prova nas DUAS telas que métrica ausente fica ausente.
// O card publicava "▶ 0 · medido em <hoje>" — afirmando que zero foi medido
// hoje — porque views null virava o DEFAULT 0 da coluna. E o selo do admin
// tinha só dois estados, então "não consegui ler" se disfarçava de "capturado".
//
// As funções são EXTRAÍDAS dos arquivos que vão pro ar (public/virais.html e
// public/admin.html), não de uma cópia: se alguém editar o HTML e reintroduzir
// o bug, o teste cai.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Recorta uma função do HTML por contagem de chaves (o arquivo é grande demais
// pra carregar inteiro num vm).
function recortarFuncao(arquivo, assinatura) {
  const src = fs.readFileSync(path.join(RAIZ, arquivo), 'utf8');
  const i = src.indexOf(assinatura);
  assert.notEqual(i, -1, `não achei "${assinatura}" em ${arquivo} — a função foi renomeada?`);
  let nivel = 0, dentro = false;
  for (let j = src.indexOf('{', i); j < src.length; j++) {
    const c = src[j];
    if (c === '{') { nivel++; dentro = true; }
    else if (c === '}') { nivel--; if (dentro && nivel === 0) return src.slice(i, j + 1); }
  }
  throw new Error(`chaves não fecharam em ${assinatura}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// DEFEITO 4 — o card da vitrine
// ═══════════════════════════════════════════════════════════════════════════

function montarCard(v, sort = 'views') {
  const ctx = {
    _igSort: sort,
    tkEsc: (s) => String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    tkFmt: (n) => String(parseInt(n, 10) || 0),
    tkTimeAgo: () => '1 dia',
    marcadorSalvar: () => '',
  };
  vm.createContext(ctx);
  vm.runInContext(
    recortarFuncao('public/virais.html', 'function igFmtBr(') + '\n'
    + recortarFuncao('public/virais.html', 'function igDataCurta(') + '\n'
    + recortarFuncao('public/virais.html', 'function igThumbNossa(') + '\n'
    + recortarFuncao('public/virais.html', 'function igMkCard('),
    ctx
  );
  ctx.__v = v;
  return vm.runInContext('igMkCard(__v, 1)', ctx);
}

const REPLICA_BASE = {
  shortcode: 'AAAA1',
  video_url: 'https://www.instagram.com/reel/AAAA1/',
  thumbnail_url: 'https://cdn.bluetubeviral.com/instagram-thumbs/AAAA1.jpg',
  caption: 'legenda de verdade',
  author_handle: 'canal_teste',
  author_name: 'Canal Teste',
  metrics_measured_at: '2026-08-11T12:00:00.000Z',
  collected_at: '2026-08-10T12:00:00.000Z',
};

test('DEFEITO 4: réplica sem views (0 no banco) NÃO publica "▶ 0 · medido em"', () => {
  const html = montarCard({ ...REPLICA_BASE, views_count: 0, likes_count: 184000, comments_count: 2310 });
  assert.equal(/▶\s*0\b/.test(html), false, 'o card publicou "▶ 0" — zero que ninguém mediu');
  // A data saiu do card em 11/08, então este padrão não pode mais aparecer de
  // jeito nenhum. O que a asserção abaixo protege é o essencial: o "▶ 0" não
  // pode voltar. Remover o selo NÃO podia ressuscitar o zero.
  assert.equal(/0\s*·\s*medido em/.test(html), false, 'afirmou que zero foi medido');
  assert.equal(/medido em/.test(html), false, 'a data de medição saiu do card');
  // Sobra a métrica que EXISTE: likes.
  assert.match(html, /❤\s*184 mil/, 'perdeu os likes, que foram medidos de verdade');
  assert.match(html, /medido em 11\/08/, 'likes medido perdeu a data da medição');
});

test('DEFEITO 4: réplica com views de verdade continua mostrando views', () => {
  const html = montarCard({ ...REPLICA_BASE, views_count: 12400000, likes_count: 184000, comments_count: 2310 });
  assert.match(html, /▶\s*12,4 mi/);
  assert.match(html, /medido em 11\/08/);
});

test('DEFEITO 4: réplica sem métrica NENHUMA sai sem selo de número', () => {
  const html = montarCard({ ...REPLICA_BASE, views_count: 0, likes_count: 0, comments_count: 0 });
  assert.equal(/▶\s*0|❤\s*0/.test(html), false, 'inventou zero na tela');
  assert.equal(/medido em/.test(html), false, '"medido em" sem nada medido é mentira');
  assert.match(html, /sem número medido/, 'não marcou o estado degradado');
});

test('DEFEITO 4: ordenando por views, réplica sem views mostra likes (não 0)', () => {
  const html = montarCard({ ...REPLICA_BASE, views_count: 0, likes_count: 184000, comments_count: 2310 }, 'views');
  assert.equal(/▶\s*0\b/.test(html), false);
  assert.match(html, /❤\s*184 mil/);
});

test('linha AO VIVO (sem metrics_measured_at) segue com o comportamento antigo', () => {
  // Coleta logada é outra história: lá 0 é um número que a API devolveu.
  const html = montarCard({ ...REPLICA_BASE, metrics_measured_at: null, views_count: 5000, likes_count: 120, comments_count: 3 });
  assert.match(html, /▶\s*5000/);
  assert.equal(/medido em/.test(html), false);
});

// ═══════════════════════════════════════════════════════════════════════════
// SELO DO ADMIN — três estados de verdade
// ═══════════════════════════════════════════════════════════════════════════

function montarPrevia(cap, d) {
  const box = { style: {}, innerHTML: '' };
  const ctx = {
    document: { getElementById: (id) => (id === 'igvRepPrevia' ? box : null) },
    escapeHtml: (s) => String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    igvFmt: (n) => String(parseInt(n, 10) || 0),
    Date,
  };
  vm.createContext(ctx);
  vm.runInContext(recortarFuncao('public/admin.html', 'function igvRepMostrarPrevia('), ctx);
  ctx.__cap = cap; ctx.__d = d;
  vm.runInContext('igvRepMostrarPrevia(__cap, __d)', ctx);
  return box.innerHTML;
}

test('ADMIN: o selo distingue os TRÊS estados (você / capturado / não consegui ler)', () => {
  const html = montarPrevia({
    titulo: null, autor: null, autor_nome: null, views: null, likes: 184000, comments: null,
    nicho: 'futebol', imagem_url: 'https://x/y.jpg', video_url: 'https://www.instagram.com/reel/AAAA1/',
    pagina_ilegivel: true,
    origem: { titulo: 'ilegivel', autor: 'ilegivel', views: 'ilegivel', likes: 'manual', comments: 'ilegivel', nicho: 'manual' },
  }, { medido_em: '2026-08-11T12:00:00.000Z' });
  assert.match(html, /não consegui ler/, 'o estado "não consegui ler" não aparece — segue disfarçado de vazio');
  assert.match(html, /você/, 'sumiu o estado "preenchido por você"');
  assert.match(html, /NÃO CONSEGUI LER ESSA PÁGINA/, 'faltou o aviso de topo sobre a parede de login');
  assert.match(html, /parede de login/i);
});

test('ADMIN: prévia sem views avisa que o card NÃO vai mostrar views', () => {
  const html = montarPrevia({
    titulo: 'legenda', autor: 'canal_teste', views: null, likes: 184000, comments: 2310,
    imagem_url: 'https://x/y.jpg', video_url: 'https://www.instagram.com/reel/AAAA1/',
    pagina_ilegivel: false,
    origem: { titulo: 'automatico', autor: 'automatico', views: 'vazio', likes: 'automatico', comments: 'automatico' },
  }, { medido_em: '2026-08-11T12:00:00.000Z' });
  assert.match(html, /sem views/i, 'não avisou que views vai faltar no card');
  assert.equal(/no card:\s*<b>▶\s*0/.test(html), false, 'a prévia prometeu "▶ 0"');
  assert.match(html, /❤ 184000/, 'a prévia devia mostrar a métrica que existe');
});

test('ADMIN: prévia sem métrica nenhuma não promete "medido em"', () => {
  const html = montarPrevia({
    titulo: 'legenda', autor: 'canal_teste', views: null, likes: null, comments: null,
    imagem_url: 'https://x/y.jpg', video_url: 'https://www.instagram.com/reel/AAAA1/',
    pagina_ilegivel: false,
    origem: { titulo: 'manual', autor: 'manual', views: 'vazio', likes: 'vazio', comments: 'vazio' },
  }, { medido_em: null });
  assert.equal(/medido em/.test(html), false, 'prometeu "medido em" sem nada medido');
  assert.match(html, /sem número nenhum/i);
  assert.match(html, /não publicamos 0/i);
});
