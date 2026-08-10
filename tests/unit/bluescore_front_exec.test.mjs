// tests/unit/bluescore_front_exec.test.mjs — node --test
//
// LEITURA DE CÓDIGO NÃO BASTA. Já aconteceu de uma página passar no
// `node --check`, passar em teste de regex, e quebrar no navegador com
// "jaFoi is not defined" — variável usada e nunca declarada. `node --check` só
// vê sintaxe; erro de referência só aparece EXECUTANDO.
//
// Aqui a gente executa o <script> real do blueScore.html contra um DOM de
// mentira e roda o caminho que o usuário vê: abrir um laudo entregue.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const PAGINA = readFileSync(new URL('../../public/blueScore.html', import.meta.url), 'utf8');

// ── DOM de mentira, só o que a página usa ────────────────────────────────
function elementoFalso(id) {
  const el = {
    id, textContent: '', innerHTML: '', outerHTML: '', value: '',
    dataset: {}, style: {}, className: '',
    classList: { add() {}, remove() {}, toggle() {} },
    querySelector: () => elementoFalso('q'),
    querySelectorAll: () => [],
    addEventListener() {},
    insertAdjacentHTML() {},
    scrollIntoView() {},
    closest: () => null,
    remove() {},
  };
  return el;
}

function ambiente() {
  const elementos = new Map();
  const pegar = (id) => {
    if (!elementos.has(id)) elementos.set(id, elementoFalso(id));
    return elementos.get(id);
  };
  const doc = {
    _els: elementos,
    getElementById: pegar,
    querySelector: () => elementoFalso('q'),
    querySelectorAll: () => [],
    addEventListener() {},
    readyState: 'complete',
    head: { appendChild() {} },
    body: { appendChild() {} },
    createElement: () => elementoFalso('novo'),
  };
  const chamadas = [];
  return {
    document: doc,
    chamadas,
    localStorage: {
      _d: { bt_token: 'tok-teste', bt_plan: 'master' },
      getItem(k) { return this._d[k] ?? null; },
      setItem(k, v) { this._d[k] = v; },
    },
    location: { search: '', href: '' },
    window: { scrollTo() {} },
    URLSearchParams,
    setTimeout: (fn) => { try { fn(); } catch (e) { chamadas.push({ erro: e.message }); } return 0; },
    setInterval: () => 0,
    clearInterval: () => {},
    console: { warn() {}, log() {}, error() {} },
    fetch: async (url, opts) => {
      const corpo = JSON.parse(opts.body);
      chamadas.push(corpo);
      if (corpo.action === 'meus') {
        return { ok: true, json: async () => ({
          ok: true, limite_dia: 2, usadas_hoje: 1,
          pedidos: [
            { id: 'p1', rede: 'youtube', perfil_url: 'https://youtube.com/@x', perfil_handle: '@x',
              status: 'entregue', salvo: false, criado_em: '2026-08-05T10:00:00Z',
              entregue_em: '2026-08-06T10:00:00Z', nota: 78, canal_nome: 'Canal X' },
            { id: 'p2', rede: 'tiktok', perfil_url: 'https://tiktok.com/@y', perfil_handle: '@y',
              status: 'na_fila', salvo: false, criado_em: '2026-08-06T09:00:00Z', nota: null },
            { id: 'p3', rede: 'instagram', perfil_url: 'https://instagram.com/z', perfil_handle: '@z',
              status: 'recusado', motivo_recusa: 'Perfil privado.', salvo: false, criado_em: '2026-08-04T09:00:00Z' },
          ],
        }) };
      }
      if (corpo.action === 'ver') {
        return { ok: true, json: async () => ({ ok: true, pedido: LAUDO_COMPLETO }) };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    },
  };
}

const LAUDO_COMPLETO = {
  id: 'p1', rede: 'youtube', perfil_url: 'https://youtube.com/@x', perfil_handle: '@x',
  status: 'entregue', salvo: false, entregue_em: '2026-08-06T10:00:00Z',
  laudo: {
    nota: 78, classificacao: 'good', classificacao_label: '✅ Boa performance',
    canal: { nome: 'Canal X', seguidores: '412 mil', publicacoes: '318', foto: 'https://img/x.jpg' },
    metricas: { media_views: '412K', engajamento: '3,1%', consistencia: 'Alta', tendencia: 'Crescendo' },
    pilares: { performance: 82, performance_desc: 'boa', risco: 70, risco_desc: 'ok', comportamento: 65, comportamento_desc: 'regular' },
    resumo: 'Diagnóstico executivo do canal.',
    pontos: [{ tipo: 'pos', titulo: 'Gancho forte', texto: 'os 2 primeiros segundos seguram' }],
    recomendacoes: [{ acao: 'Corta a intro', porque: 'ganha retenção', impacto: 'alto' }],
    videos: [{ url: 'https://youtu.be/1', titulo: 'Vídeo 1', observacao: 'corta 3s do começo' }],
  },
};

function carregar(env) {
  const i = PAGINA.lastIndexOf('<script>');
  const f = PAGINA.indexOf('</script>', i);
  assert.ok(i > 0 && f > i, 'não achei o <script> da página');
  const codigo = PAGINA.slice(i + 8, f);

  const nomes = Object.keys(env).filter((k) => k !== 'chamadas');
  // devolve as funções que os onclick da página chamam
  const fn = new Function(...nomes, codigo + `
    ; return { pedirAnalise, carregarMinhas, abrirAnalise, renderizar, voltarPraLista,
               alternarSalvo, alternarSalvoAtual, abrirPrevia, esc, erro };`);
  return fn(...nomes.map((n) => env[n]));
}

test('o script da página executa sem referência quebrada', () => {
  const env = ambiente();
  const api = carregar(env);
  assert.equal(typeof api.renderizar, 'function');
  assert.equal(typeof api.pedirAnalise, 'function');
});

test('renderizar um laudo completo não estoura', () => {
  const env = ambiente();
  const api = carregar(env);
  api.renderizar(LAUDO_COMPLETO);
  const nome = env.document._els.get('channelName');
  assert.equal(nome.textContent, 'Canal X');
  assert.match(env.document._els.get('channelMeta').textContent, /412 mil seguidores/);
  assert.equal(env.document._els.get('summaryText').textContent, 'Diagnóstico executivo do canal.');
  assert.match(env.document._els.get('videosList').innerHTML, /corta 3s do começo/);
});

test('laudo mínimo (só nota e diagnóstico) esconde os blocos vazios', () => {
  const env = ambiente();
  const api = carregar(env);
  api.renderizar({ id: 'p9', rede: 'tiktok', status: 'entregue',
    laudo: { nota: 40, classificacao: 'moderate', classificacao_label: '⚠ Atenção', resumo: 'só isso' } });
  assert.equal(env.document._els.get('metricsGrid').style.display, 'none', 'grade de métricas vazia tem que sumir');
  assert.equal(env.document._els.get('pillarsSection').style.display, 'none');
  assert.equal(env.document._els.get('videosSection').style.display, 'none');
  assert.equal(env.document._els.get('summarySection').style.display, 'block');
});

test('a lista de análises desenha os três estados sem quebrar', async () => {
  const env = ambiente();
  const api = carregar(env);
  await api.carregarMinhas();
  const html = env.document._els.get('historyList').innerHTML;
  assert.match(html, /Na fila/);
  assert.match(html, /Pronta/);
  assert.match(html, /Perfil privado/, 'o motivo da recusa precisa aparecer pro usuário');
  assert.match(html, /abrirAnalise\('p1'\)/, 'só a entregue abre');
  assert.ok(!/abrirAnalise\('p2'\)/.test(html), 'pedido na fila não pode ser clicável');
  assert.match(env.document._els.get('cotaHint').textContent, /1 de 2/);
});

test('conteúdo do laudo é escapado — aspas e tag não viram HTML', () => {
  const env = ambiente();
  const api = carregar(env);
  api.renderizar({ id: 'x', rede: 'youtube', status: 'entregue',
    laudo: { nota: 50, resumo: 'ok',
      videos: [{ url: 'https://y/1', titulo: '<img src=x onerror=alert(1)>', observacao: 'nota "10"' }] } });
  const html = env.document._els.get('videosList').innerHTML;
  assert.ok(!html.includes('<img src=x'), 'tag do laudo não pode virar elemento');
  assert.match(html, /&lt;img/);
  assert.match(html, /&quot;10&quot;/);
});

test('a prévia do admin usa a MESMA renderização da página do usuário', () => {
  const env = ambiente();
  env.localStorage._d.bs_previa = JSON.stringify({
    laudo: LAUDO_COMPLETO.laudo, rede: 'youtube', perfil_handle: '@x',
  });
  const api = carregar(env);
  api.abrirPrevia();
  // se caísse num renderizador próprio, o dia que alguém mexesse na página
  // real a prévia passaria a mentir
  assert.equal(env.document._els.get('channelName').textContent, 'Canal X');
  assert.match(env.document._els.get('videosList').innerHTML, /corta 3s do começo/);
  assert.match(env.document._els.get('previaAviso').innerHTML, /PRÉVIA/);
  assert.match(env.document._els.get('previaAviso').innerHTML, /Nada foi enviado ainda/);
  assert.equal(env.document._els.get('btnSalvarResultado').style.display, 'none',
    'botão de salvar é do usuário, não faz sentido na prévia');
});

test('prévia de análise JÁ ENTREGUE não diz que nada foi enviado', () => {
  const env = ambiente();
  env.localStorage._d.bs_previa = JSON.stringify({
    laudo: LAUDO_COMPLETO.laudo, rede: 'youtube', entregue: true,
  });
  const api = carregar(env);
  api.abrirPrevia();
  const aviso = env.document._els.get('previaAviso').innerHTML;
  assert.match(aviso, /já foi entregue/);
  assert.ok(!/Nada foi enviado ainda/.test(aviso), 'seria mentira: o usuário já recebeu');
});

test('prévia avisa quando o laudo ainda não pode ser enviado', () => {
  const env = ambiente();
  env.localStorage._d.bs_previa = JSON.stringify({
    laudo: { nota: 40, resumo: '' }, falta: 'falta o diagnóstico', rede: 'tiktok',
  });
  const api = carregar(env);
  api.abrirPrevia();
  assert.match(env.document._els.get('previaAviso').innerHTML, /falta o diagnóstico/);
});

test('prévia sem dados no localStorage não quebra a página', () => {
  const env = ambiente();
  const api = carregar(env);
  api.abrirPrevia();
  assert.match(env.document._els.get('inputSection').innerHTML, /Prévia não encontrada/);
});

test('?pedido=<id> do email abre o laudo direto', async () => {
  const env = ambiente();
  env.location.search = '?pedido=p1';
  carregar(env);
  await new Promise((r) => setImmediate(r));
  assert.ok(env.chamadas.some((c) => c.action === 'ver' && c.id === 'p1'),
    'o link do email tem que abrir a análise sem a pessoa procurar');
});
