// tests/unit/comunidade_menu.test.mjs — node --test
//
// O MENU ⋯ DA COMUNIDADE (post, comentário e perfil) e a DENÚNCIA.
//
// ── O QUE ESTE ARQUIVO EXISTE PRA TRAVAR ────────────────────────────────────
// O menu que existia antes tinha três defeitos, e todos eram de USO, não de
// sintaxe — o tipo que passa em revisão e aparece na mão de quem usa:
//
//   1) abrir tinha dono (`this.nextElementSibling.classList.toggle`), fechar
//      não tinha ninguém: dava pra deixar vários abertos ao mesmo tempo e
//      clicar fora não fechava nenhum;
//   2) o dropdown era absoluto DENTRO do card — no último post do feed ele
//      abria pra baixo e era cortado;
//   3) ele só existia pra AUTOR e MODERADOR. Quem visse algo errado não tinha
//      o que fazer além de fechar a aba.
//
// E a denúncia tem uma regra que vale mais que a tabela: **denúncia que
// ninguém lê é botão falso**. Por isso o teste do backend não se contenta com
// "gravou a linha" — ele exige a notificação no sininho do moderador, e exige
// que ela seja AGUARDADA (em serverless, promise solta some no return).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);

process.env.SUPABASE_URL = 'https://sb.test';
process.env.SUPABASE_SERVICE_KEY = 'service-key';
process.env.SUPABASE_ANON_KEY = 'anon-key';

const community = require('../../api/community.js');
const API = readFileSync(new URL('../../api/community.js', import.meta.url), 'utf8');
const MENU = readFileSync(new URL('../../public/comunidade-menu.js', import.meta.url), 'utf8');
const CBT = readFileSync(new URL('../../public/comunidade.js', import.meta.url), 'utf8');
const PERFIL = readFileSync(new URL('../../public/perfil-pagina.js', import.meta.url), 'utf8');
const SININHO = readFileSync(new URL('../../public/sininho.js', import.meta.url), 'utf8');
const SQL = readFileSync(new URL('../../sql/comunidade_denuncias.sql', import.meta.url), 'utf8');
const HTML_COM = readFileSync(new URL('../../public/comunidade.html', import.meta.url), 'utf8');
const HTML_PERF = readFileSync(new URL('../../public/perfil.html', import.meta.url), 'utf8');

const SU = 'https://sb.test';
const EU = '11111111-1111-4111-8111-111111111111';
const OUTRO = '22222222-2222-4222-8222-222222222222';
const MOD = '33333333-3333-4333-8333-333333333333';

// ─── Supabase falso, só o pedaço que a denúncia usa ────────────────────────
function ambiente(cfg) {
  cfg = cfg || {};
  const estado = {
    log: [],
    reports: [],
    notificacoes: [],
    posts: cfg.posts || [{ id: 'post-1', user_id: OUTRO, content: 'conteúdo denunciado aqui' }],
    comentarios: cfg.comentarios || [{ id: 'com-1', user_id: OUTRO, content: 'comentário ruim' }],
    perfis: cfg.perfis || [
      { user_id: EU, display_name: 'Ana', is_moderator: false, plan: 'master' },
      { user_id: OUTRO, display_name: 'Bruno', is_moderator: false, plan: 'full' },
      { user_id: MOD, display_name: 'shaddershorts', is_moderator: true, plan: 'master' },
    ],
    conflito: !!cfg.conflito,
    respondeu: false,
  };
  const resp = (corpo, status) => ({
    ok: (status || 200) < 400, status: status || 200,
    json: async () => corpo, text: async () => JSON.stringify(corpo),
    headers: { get: () => null },
  });
  const valor = (url, campo) => {
    const m = new RegExp('[?&]' + campo + '=([^&]*)').exec(url);
    return m ? decodeURIComponent(m[1]) : null;
  };

  global.fetch = async (url, opt) => {
    url = String(url);
    opt = opt || {};
    const metodo = opt.method || 'GET';
    const corpo = opt.body ? JSON.parse(opt.body) : null;

    if (url.startsWith(SU + '/auth/v1/user')) return resp({ id: EU, email: 'ana@test.com' });
    if (url.startsWith(SU + '/rest/v1/subscribers')) return resp([{ plan: 'master', plan_expires_at: null, is_manual: true }]);
    if (url.startsWith(SU + '/rest/v1/blue_banimentos')) return resp([]);
    if (url.startsWith(SU + '/rest/v1/community_profiles')) {
      const uid = valor(url, 'user_id');
      const nome = valor(url, 'display_name');
      if (url.indexOf('is_moderator=eq.true') >= 0) return resp(estado.perfis.filter((p) => p.is_moderator));
      if (nome) return resp(estado.perfis.filter((p) => p.display_name === nome.slice(3)));
      if (uid && uid.startsWith('eq.')) return resp(estado.perfis.filter((p) => p.user_id === uid.slice(3)));
      if (uid && uid.startsWith('in.')) {
        const ids = uid.slice(4, -1).split(',');
        return resp(estado.perfis.filter((p) => ids.indexOf(p.user_id) >= 0));
      }
      return resp(estado.perfis);
    }
    if (url.startsWith(SU + '/rest/v1/community_posts')) {
      const id = (valor(url, 'id') || '').slice(3);
      return resp(estado.posts.filter((p) => p.id === id));
    }
    if (url.startsWith(SU + '/rest/v1/community_comments')) {
      const id = (valor(url, 'id') || '').slice(3);
      return resp(estado.comentarios.filter((c) => c.id === id));
    }
    if (url.startsWith(SU + '/rest/v1/community_reports')) {
      estado.log.push('report:' + metodo);
      if (estado.conflito) return resp({ message: 'duplicate' }, 409);
      estado.reports.push(corpo);
      return resp({}, 201);
    }
    if (url.startsWith(SU + '/rest/v1/blue_notificacoes')) {
      estado.log.push('notificacao');
      // Se a resposta já saiu, esta escrita seria a que o serverless corta.
      if (estado.respondeu) estado.log.push('⚠️ NOTIFICAÇÃO DEPOIS DA RESPOSTA');
      estado.notificacoes.push(corpo);
      return resp({}, 201);
    }
    throw new Error('fetch não previsto: ' + url);
  };
  return estado;
}

function resFalso(estado) {
  const r = { code: 0, corpo: null };
  r.setHeader = () => r;
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.corpo = b; if (estado) estado.respondeu = true; return r; };
  r.end = () => r;
  return r;
}

async function denunciar(estado, body) {
  const res = resFalso(estado);
  await community({ method: 'POST', query: {}, body: Object.assign({ action: 'denunciar', token: 'tok' }, body) }, res);
  return res;
}

// ═══ 1 — A DENÚNCIA, no servidor ════════════════════════════════════════

test('denunciar um post grava a linha E avisa o moderador no sininho', async () => {
  const amb = ambiente();
  const r = await denunciar(amb, { tipo: 'post', alvo: 'post-1', motivo: 'ofensa' });
  assert.equal(r.code, 200);
  assert.equal(amb.reports.length, 1);
  assert.equal(amb.reports[0].alvo_user_id, OUTRO, 'o dono do conteúdo é resolvido no SERVIDOR');
  assert.equal(amb.reports[0].reporter_id, EU);

  assert.equal(amb.notificacoes.length, 1, 'denúncia que ninguém lê é botão falso');
  const n = amb.notificacoes[0];
  assert.equal(n.user_id, MOD);
  assert.equal(n.tipo, 'denuncia');
  assert.match(n.mensagem, /Bruno/, 'o moderador precisa saber QUEM foi denunciado');
  assert.match(n.mensagem, /conteúdo denunciado aqui/, 'e ver o começo do conteúdo sem sair do sino');
  assert.ok(n.dados && n.dados.url, 'sem url a notificação nasce como texto morto (sininho.js)');
});

test('a notificação sai ANTES da resposta (promise solta em serverless é descartada)', async () => {
  const amb = ambiente();
  await denunciar(amb, { tipo: 'post', alvo: 'post-1', motivo: 'spam' });
  assert.equal(amb.log.indexOf('⚠️ NOTIFICAÇÃO DEPOIS DA RESPOSTA'), -1,
    'foi assim que 28 notificações de amizade viraram zero neste projeto');
  assert.ok(amb.log.indexOf('notificacao') >= 0);
});

test('o dono do conteúdo NÃO vem do navegador — dá pra denunciar A dizendo que é B?', async () => {
  const amb = ambiente();
  // O cliente tenta carimbar outra vítima e outro autor.
  await denunciar(amb, { tipo: 'post', alvo: 'post-1', motivo: 'spam', alvo_user_id: MOD, reporter_id: MOD });
  assert.equal(amb.reports[0].alvo_user_id, OUTRO, 'o campo do cliente é ignorado; quem manda é a consulta');
  assert.equal(amb.reports[0].reporter_id, EU, 'e o denunciante é quem está logado, não quem o corpo disser');
});

test('denúncia repetida responde igual à primeira (o botão não pode virar sonda)', async () => {
  const amb = ambiente({ conflito: true });
  const r = await denunciar(amb, { tipo: 'post', alvo: 'post-1', motivo: 'spam' });
  assert.equal(r.code, 200);
  assert.equal(r.corpo.ok, true);
  assert.equal(amb.notificacoes.length, 0,
    'repetir o aviso ensina o moderador a ignorar o sino — que é o pior resultado possível');
});

test('tipo e motivo fora da lista são recusados (nada de campo livre virando texto no sino)', async () => {
  const amb = ambiente();
  assert.equal((await denunciar(amb, { tipo: 'outro-tipo', alvo: 'post-1', motivo: 'spam' })).code, 400);
  assert.equal((await denunciar(amb, { tipo: 'post', alvo: 'post-1', motivo: '<script>' })).code, 400);
  assert.equal((await denunciar(amb, { tipo: 'post', alvo: '', motivo: 'spam' })).code, 400);
  assert.equal(amb.reports.length, 0);
});

test('não dá pra denunciar o que é meu, nem o que não existe', async () => {
  const meu = ambiente({ posts: [{ id: 'post-1', user_id: EU, content: 'meu post' }] });
  const a = await denunciar(meu, { tipo: 'post', alvo: 'post-1', motivo: 'spam' });
  assert.equal(a.code, 400);
  assert.match(a.corpo.error, /é seu/);

  const vazio = ambiente({ posts: [] });
  const b = await denunciar(vazio, { tipo: 'post', alvo: 'sumiu', motivo: 'spam' });
  assert.equal(b.code, 404);
});

test('denunciar perfil e comentário funcionam pelo mesmo caminho', async () => {
  const amb = ambiente();
  const p = await denunciar(amb, { tipo: 'perfil', alvo: 'Bruno', motivo: 'improprio' });
  assert.equal(p.code, 200);
  assert.equal(amb.reports[0].alvo_user_id, OUTRO, 'perfil é achado pelo display_name (a UI nunca vê uuid)');

  const amb2 = ambiente();
  const c = await denunciar(amb2, { tipo: 'comentario', alvo: 'com-1', motivo: 'ofensa' });
  assert.equal(c.code, 200);
  assert.match(amb2.notificacoes[0].mensagem, /comentário ruim/);
});

test('o ícone 🚩 existe no sininho (senão a denúncia chega como 🔔 genérico)', () => {
  assert.match(SININHO, /denuncia: '🚩'/);
});

// ═══ 2 — O MENU, no navegador ═══════════════════════════════════════════

function carregarMenu() {
  const nos = new Map();
  const criar = (tag) => {
    const el = {
      tagName: String(tag).toUpperCase(), children: [], style: {}, _attrs: {}, _html: '',
      _classes: new Set(), textContent: '', value: '', offsetWidth: 196, offsetHeight: 180,
      _ouvintes: {},
      addEventListener(ev, fn) { (this._ouvintes[ev] = this._ouvintes[ev] || []).push(fn); },
      removeEventListener() {},
      remove() { nos.delete(this._attrs.id); },
      focus() {}, select() {},
      contains(x) { return x === this; },
      appendChild(c) { this.children.push(c); return c; },
      querySelector: () => null,
      querySelectorAll: () => [],
      getBoundingClientRect: () => ({ left: 10, top: 100, right: 200, bottom: 120 }),
      closest: () => null,
      setAttribute(k, v) { this._attrs[k] = v; if (k === 'id') nos.set(v, this); },
      getAttribute(k) { return this._attrs[k] === undefined ? null : this._attrs[k]; },
    };
    el.classList = {
      add: (c) => el._classes.add(c), remove: (c) => el._classes.delete(c),
      toggle: (c, v) => (v ? el._classes.add(c) : el._classes.delete(c)),
      contains: (c) => el._classes.has(c),
    };
    Object.defineProperty(el, 'innerHTML', { get() { return el._html; }, set(v) { el._html = String(v); } });
    Object.defineProperty(el, 'id', {
      get() { return el._attrs.id || ''; },
      set(v) { el._attrs.id = v; nos.set(v, el); }, configurable: true,
    });
    return el;
  };
  const doc = {
    readyState: 'complete', head: criar('head'), body: criar('body'), documentElement: criar('html'),
    createElement: criar,
    getElementById: (id) => nos.get(id) || null,
    querySelector: () => null,
    querySelectorAll: (sel) => {
      const saida = [];
      nos.forEach((el) => { if (sel.indexOf('cmn-b') >= 0 && el._classes.has('cmn-b') && el._classes.has('on')) saida.push(el); });
      return saida;
    },
    _ouvintes: {},
    addEventListener(ev, fn) { (this._ouvintes[ev] = this._ouvintes[ev] || []).push(fn); },
    _disparar(ev, e) { (this._ouvintes[ev] || []).forEach((f) => f(e)); },
  };
  const ctx = {
    window: { addEventListener() {}, innerWidth: 900, innerHeight: 700, location: { origin: 'https://bt.test' } },
    document: doc, console, navigator: {}, localStorage: { getItem: () => 'tok' },
    fetch: async () => ({ json: async () => ({ ok: true }) }),
    setTimeout, clearTimeout, Promise, Map, Set, Array, Object, String, Number, JSON, Math, Date, Boolean, RegExp,
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInNewContext(MENU, ctx, { filename: 'comunidade-menu.js' });
  return { CM: ctx.window.ComunidadeMenu, doc, nos, ctx, criar };
}

test('MENU: quem NÃO é autor nem moderador agora tem opções (era o buraco)', () => {
  const { CM } = carregarMenu();
  // `join`, e não deepEqual: o array nasce DENTRO do vm, então o protótipo
  // dele é de outro realm e o deepStrictEqual reprova dois arrays idênticos.
  const o = CM._interno.opcoes({ tipo: 'post', id: 'p1', meu: false, mod: false, link: '/comunidade#post-p1' })
    .map((x) => x.acao).join(',');
  assert.equal(o, 'copiar,denunciar',
    'antes o menu nem aparecia pra essa pessoa — que é a maioria de quem lê o feed');
});

test('MENU: autor vê editar/apagar; moderador vê fixar e banir; ninguém se denuncia', () => {
  const { CM } = carregarMenu();
  const meu = CM._interno.opcoes({ tipo: 'post', id: 'p1', meu: true, mod: false, link: '/x' }).map((x) => x.acao);
  assert.equal(meu.join(','), 'editar,copiar,apagar');
  assert.equal(meu.indexOf('denunciar'), -1, 'denunciar o próprio post não faz sentido nenhum');

  const mod = CM._interno.opcoes({ tipo: 'post', id: 'p1', meu: false, mod: true, autorId: OUTRO, link: '/x' }).map((x) => x.acao);
  assert.equal(mod.join(','), 'editar,fixar,copiar,denunciar,apagar,banir');
});

test('MENU: banir só aparece quando o uuid do autor existe (o feed de comentário não tem)', () => {
  const { CM } = carregarMenu();
  const semId = CM._interno.opcoes({ tipo: 'comentario', id: 'c1', meu: false, mod: true, link: '/x' }).map((x) => x.acao);
  assert.equal(semId.indexOf('banir'), -1, 'botão que falha por falta de dado é pior que botão ausente');
  assert.equal(semId.indexOf('editar'), -1, 'comentário nunca teve editor na tela');
  assert.ok(semId.indexOf('fixar') >= 0);
});

test('MENU: resposta de comentário não oferece fixar (só o comentário-raiz é fixável)', () => {
  const { CM } = carregarMenu();
  const o = CM._interno.opcoes({ tipo: 'comentario', id: 'c1', meu: false, mod: true, podeFixar: false, link: '/x' }).map((x) => x.acao);
  assert.equal(o.indexOf('fixar'), -1);
});

test('MENU: o perfil ganhou menu — copiar link e denunciar', () => {
  const { CM } = carregarMenu();
  const o = CM._interno.opcoes({ tipo: 'perfil', id: 'Bruno', meu: false, link: '/Bruno' }).map((x) => x.acao);
  assert.equal(o.join(','), 'copiar,denunciar');
  // Desfazer amizade fica FORA: o botão de amigo já faz isso, com a
  // confirmação dele. Duas portas pra mesma ação destrutiva é como se clica
  // na errada.
  assert.equal(o.indexOf('desamigo'), -1);
  assert.equal(CM._interno.opcoes({ tipo: 'perfil', id: 'Ana', meu: true, link: '/Ana' }).map((x) => x.acao).join(','), 'copiar');
});

test('MENU: o nome de quem postou é escapado no cabeçalho do menu', () => {
  const { CM } = carregarMenu();
  const h = CM._interno.html({ tipo: 'post', id: 'p1', nome: '<img src=x onerror=alert(1)>', meu: false, link: '/x' }, false);
  assert.equal(h.includes('<img'), false);
  assert.match(h, /&lt;img/);
});

test('MENU: o botão carrega só uma CHAVE — nada de JSON dentro de atributo HTML', () => {
  const { CM } = carregarMenu();
  const b = CM.botao({ tipo: 'post', id: 'p1', nome: 'Ana "aspas" <tag>', meu: false, link: '/x' });
  assert.match(b, /data-cmn="m\d+"/);
  assert.equal(b.includes('{'), false, 'JSON em atributo é onde essas coisas quebram');
  assert.equal(b.includes('<tag>'), false, 'e o aria-label vai escapado');
});

test('MENU: abre UM por vez e fecha em clique fora, Esc e rolagem', () => {
  const { CM, doc, criar } = carregarMenu();
  const b1 = criar('button'); b1.classList.add('cmn-b'); b1.setAttribute('data-cmn', 'x');
  b1.closest = (sel) => (sel === '[data-cmn]' ? b1 : null);
  const chave = /data-cmn="(m\d+)"/.exec(CM.botao({ tipo: 'post', id: 'p1', meu: false, link: '/x' }))[1];
  b1.setAttribute('data-cmn', chave);

  doc._disparar('click', { target: b1, preventDefault() {}, stopPropagation() {} });
  assert.ok(doc.getElementById('cmnDD'), 'o menu abriu');
  assert.equal(b1.classList.contains('on'), true);

  // Clique fora fecha — era exatamente isto que o menu antigo não fazia.
  const solto = criar('div');
  solto.closest = () => null;
  doc._disparar('click', { target: solto, preventDefault() {}, stopPropagation() {} });
  assert.equal(doc.getElementById('cmnDD'), null, 'clicar fora não fechava nada na versão antiga');

  // Segundo toque no mesmo botão também fecha.
  doc._disparar('click', { target: b1, preventDefault() {}, stopPropagation() {} });
  assert.ok(doc.getElementById('cmnDD'));
  doc._disparar('click', { target: b1, preventDefault() {}, stopPropagation() {} });
  assert.equal(doc.getElementById('cmnDD'), null);

  // Esc fecha.
  doc._disparar('click', { target: b1, preventDefault() {}, stopPropagation() {} });
  doc._disparar('keydown', { key: 'Escape', preventDefault() {} });
  assert.equal(doc.getElementById('cmnDD'), null);
});

test('MENU: o dropdown é fixed (o do último post do feed era cortado)', () => {
  assert.match(MENU, /\.cmn-dd\{position:fixed/);
  assert.match(MENU, /window\.addEventListener\('scroll'/, 'fixed sem fechar na rolagem flutuaria longe do botão');
  assert.match(MENU, /Math\.max\(8, x\)/, 'e ele nunca pode sair pela borda da tela no celular');
});

test('MENU: o CSS é injetado no ARRANQUE, não ao abrir o menu', () => {
  // Foi assim que a pílula "+ Amigo" nasceu crua no feed: CSS dentro da função
  // que monta o painel só chegava depois de alguém abrir o painel.
  const arranque = MENU.slice(MENU.indexOf('function ligar()'));
  assert.match(arranque, /estilo\(\);/);
  assert.match(MENU, /if \(document\.readyState === 'loading'\) document\.addEventListener\('DOMContentLoaded', ligar\)/);
});

test('MENU: copiar link tem reserva pra navegador sem clipboard API', () => {
  assert.match(MENU, /function copiarNaMarra/,
    'sem reserva, "Copiar link" é um botão que não faz nada em silêncio no Safari antigo');
  assert.match(MENU, /navigator\.clipboard\.writeText\(url\)\.then\(pronto\)\.catch/);
});

test('MENU: denunciar pede o MOTIVO antes de mandar (um toque só seria acidente)', () => {
  const { CM } = carregarMenu();
  const h = CM._interno.html({ tipo: 'post', id: 'p1', meu: false, link: '/x' }, true);
  assert.match(h, /data-cmn-motivo="spam"/);
  assert.match(h, /data-cmn-motivo="ofensa"/);
  assert.match(h, /data-cmn-acao="voltar"/, 'e dá pra desistir sem fechar o menu inteiro');
  assert.equal(CM._interno.MOTIVOS.length, 4);
});

// ═══ 3 — A FIAÇÃO nas telas ═════════════════════════════════════════════

test('FEED: o menu inline com onclick sumiu, e a ponte tolera o script não carregar', () => {
  assert.equal(/this\.nextElementSibling\.classList\.toggle/.test(CBT), false,
    'era o abre-mas-não-fecha; não pode voltar');
  assert.match(CBT, /function menuDe\(item\) \{[\s\S]{0,220}catch \(e\) \{ return ''; \}/,
    'script que não carregou pode custar o menu, nunca o feed');
  assert.match(CBT, /menuDe\(\{\s*tipo: 'post'/);
  assert.match(CBT, /tipo: 'comentario'/);
});

test('FEED: comentário não ficou com botão duplicado (fixar/apagar foram pro ⋯)', () => {
  // O recorte mira a MARCAÇÃO: `.cbt-replybox` aparece primeiro no bloco de
  // CSS lá no topo do arquivo, e ancorar nele daria um pedaço vazio.
  const acoes = CBT.slice(CBT.indexOf('<div class="cbt-cact">'), CBT.indexOf('id="rb-'));
  assert.match(acoes, /likeComment/);
  assert.match(acoes, /toggleReply/);
  assert.equal(acoes.includes('pinComment'), false, 'duas portas pra mesma ação é como se clica na errada');
  assert.equal(acoes.includes('delComment'), false);
});

test('FEED: os handlers do ⋯ são registrados na ABERTURA (o script pode chegar depois)', () => {
  assert.match(CBT, /ligarMenu\(\);/);
  const lig = CBT.slice(CBT.indexOf('function ligarMenu'), CBT.indexOf('function cardHtml'));
  assert.match(lig, /editar:/); assert.match(lig, /apagar:/);
  assert.match(lig, /fixar:/); assert.match(lig, /banir:/);
  assert.match(lig, /delComment\(i\.postId, i\.id\)/, 'delComment pede o post junto — passar só o id não apagaria nada');
  assert.match(lig, /pinComment\(i\.postId, i\.id\)/);
});

test('PERFIL: a página ganhou o ⋯ (antes só existia "adicionar")', () => {
  assert.match(PERFIL, /ComunidadeMenu\.botao\(\{[\s\S]{0,200}tipo: 'perfil'/);
  assert.match(PERFIL, /try \{[\s\S]{0,300}\} catch \(e\) \{\}/, 'e a ausência do script não pode derrubar o perfil');
});

test('as duas páginas carregam o menu, e as versões subiram (Vercel cacheia .js por 4h)', () => {
  for (const [nome, html] of [['comunidade.html', HTML_COM], ['perfil.html', HTML_PERF]]) {
    assert.match(html, /comunidade-menu\.js\?v=/, nome + ' não carrega o menu');
    assert.match(html, /comunidade\.js\?v=11/, nome + ': o comunidade.js mudou e a versão tem que subir junto');
  }
  assert.match(HTML_PERF, /perfil-pagina\.js\?v=4/);
  // O menu vem ANTES do open(), senão o primeiro render do feed sai sem o ⋯.
  assert.ok(HTML_COM.indexOf('comunidade-menu.js') < HTML_COM.indexOf('ComunidadeBT.open'));
});

// ═══ 4 — O SQL ═══════════════════════════════════════════════════════════

test('SQL: RLS colada na criação, e uma denúncia por pessoa por alvo', () => {
  const iCria = SQL.indexOf('create table if not exists community_reports');
  const iRls = SQL.indexOf('alter table community_reports enable row level security');
  assert.ok(iCria >= 0 && iRls > iCria);
  assert.ok(SQL.slice(iCria, iRls).split(';').length < 4,
    'a tabela guarda quem denunciou quem — não pode ficar nem um segundo aberta pro anon');
  assert.match(SQL, /alter table community_reports force  ?row level security/);
  assert.match(SQL, /create unique index if not exists uq_creport_uma_por_alvo[\s\S]{0,120}\(reporter_id, alvo_tipo, alvo_id\)/);
});

test('SQL: o banco recusa tipo e motivo fora da lista (não só a API)', () => {
  assert.match(SQL, /alvo_tipo in \('post', 'comentario', 'perfil'\)/);
  assert.match(SQL, /motivo in \('spam', 'ofensa', 'improprio', 'outro'\)/);
});
