// tests/unit/baixatudo_front.test.mjs — node --test
//
// EXECUTA o front do BaixaTudo num DOM mínimo. Checagem de sintaxe não pega
// erro de execução: o bug `jaFoi is not defined` (03/08) passou pelo
// node --check e teria quebrado a listagem inteira em produção.
// Aqui a gente chama as funções de verdade e vê se explodem.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const FONTE = readFileSync(new URL('../../public/baixatudo.js', import.meta.url), 'utf8');

// ── DOM mínimo ────────────────────────────────────────────────────────────
function montarAmbiente({ respostaListar, respostaLink, blobSize = 5_000_000 } = {}) {
  const cliques = [];
  const armazem = new Map();

  function novoEl(id) {
    const el = {
      id, _html: '', _texto: '', value: '', disabled: false, checked: true,
      style: {}, dataset: {}, children: [],
      classList: { add() {}, remove() {}, contains: () => false },
      addEventListener(ev, fn) { (this._ev = this._ev || {})[ev] = fn; },
      removeEventListener() {}, appendChild(c) { this.children.push(c); },
      removeChild() {}, remove() {}, click() { cliques.push(this); },
      setAttribute(k, v) { this.dataset[k] = v; }, getAttribute(k) { return this.dataset[k]; },
      querySelectorAll: () => [], querySelector: () => null,
      insertBefore() {}, get innerHTML() { return this._html; }, set innerHTML(v) { this._html = v; },
      get textContent() { return this._texto; }, set textContent(v) { this._texto = v; },
    };
    return el;
  }

  const elementos = new Map();
  const pegar = (id) => { if (!elementos.has(id)) elementos.set(id, novoEl(id)); return elementos.get(id); };

  const documento = {
    readyState: 'complete',
    body: novoEl('body'),
    getElementById: pegar,
    querySelector: () => null,
    querySelectorAll: (sel) => (sel === '.bt-check' ? [] : []),
    createElement: (t) => novoEl('novo_' + t),
    addEventListener: () => {},
  };

  const contexto = {
    document: documento,
    window: { location: { search: '', pathname: '/baixaBlue', hash: '' } },
    localStorage: {
      getItem: (k) => (armazem.has(k) ? armazem.get(k) : null),
      setItem: (k, v) => armazem.set(k, String(v)),
      removeItem: (k) => armazem.delete(k),
    },
    history: { replaceState: () => {} },
    URLSearchParams, URL: { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} },
    setTimeout: (fn) => { fn(); return 0; },          // sem esperas reais no teste
    clearTimeout: () => {}, console,
    Promise, JSON, Math, Date, String, Number, Array, Object, parseInt, parseFloat,
    encodeURIComponent, decodeURIComponent, isNaN,
    fetch: async (url) => {
      const u = String(url);
      if (u.includes('action=listar')) return { ok: true, status: 200, headers: { get: () => null }, json: async () => respostaListar };
      if (u.includes('action=link')) return { ok: true, status: 200, headers: { get: () => null }, json: async () => respostaLink };
      return { ok: true, status: 200, headers: { get: () => null }, blob: async () => ({ size: blobSize }) };
    },
  };
  contexto.globalThis = contexto;
  vm.createContext(contexto);
  vm.runInContext(FONTE, contexto);
  return { contexto, pegar, elementos, cliques, armazem };
}

const LISTA_OK = {
  plataforma: 'youtube', canal: 'Xiro Ranks', canal_url: 'https://www.youtube.com/@XiroRanks/shorts',
  total: 3, cache: false,
  shorts: [
    { id: 'aaaaaaaaaaa', titulo: 'Um', url: 'https://www.youtube.com/shorts/aaaaaaaaaaa', views: 1000, duracao: 30, thumb: 't' },
    { id: 'bbbbbbbbbbb', titulo: 'Dois', url: 'https://www.youtube.com/shorts/bbbbbbbbbbb', views: 2000, duracao: 40, thumb: 't' },
    { id: 'ccccccccccc', titulo: 'Três', url: 'https://www.youtube.com/shorts/ccccccccccc', views: 3000, duracao: 50, thumb: 't' },
  ],
};

test('o módulo carrega e monta sem explodir', () => {
  const { pegar } = montarAmbiente({ respostaListar: LISTA_OK });
  // montar() roda no load; se algo estourasse, o vm.runInContext já teria jogado
  assert.ok(pegar('btSwitch'), 'ambiente montado');
});

test('REGRESSÃO jaFoi: listar + render rodam de verdade e produzem a lista', async () => {
  const { contexto, pegar } = montarAmbiente({ respostaListar: LISTA_OK });
  pegar('btCanalUrl').value = 'https://www.youtube.com/@XiroRanks';

  // dispara o clique de "Procurar vídeos" como o usuário faria
  const botao = pegar('btListarBtn');
  assert.ok(botao._ev && botao._ev.click, 'o botão precisa ter handler ligado');
  await botao._ev.click();

  const html = pegar('btLista').innerHTML;
  assert.ok(html.length > 0, 'a lista não renderizou — foi exatamente o sintoma do bug jaFoi');
  assert.ok(html.includes('Um') && html.includes('Dois') && html.includes('Três'), 'faltou item na lista');
  assert.ok(html.includes('bt-check'), 'faltaram as caixas de seleção');
  assert.match(pegar('btStatus').innerHTML, /3 vídeos encontrados/);
});

test('o switch liga e desliga sem erro', () => {
  const { pegar } = montarAmbiente({ respostaListar: LISTA_OK });
  const sw = pegar('btSwitch');
  sw._ev.click();                                   // liga
  assert.equal(sw.getAttribute('data-on'), '1');
  assert.equal(pegar('btMode').style.display, '');
  sw._ev.click();                                   // desliga
  assert.equal(sw.getAttribute('data-on'), '0');
  assert.equal(pegar('btMode').style.display, 'none');
});

test('perfil sem vídeos avisa em vez de renderizar lista vazia', async () => {
  const { pegar } = montarAmbiente({ respostaListar: { ...LISTA_OK, shorts: [], total: 0 } });
  pegar('btCanalUrl').value = '@vazio';
  await pegar('btListarBtn')._ev.click();
  assert.match(pegar('btStatus').innerHTML, /não tem vídeos públicos/);
});

test('link vazio não dispara chamada nenhuma', async () => {
  const { pegar } = montarAmbiente({ respostaListar: LISTA_OK });
  pegar('btCanalUrl').value = '';
  await pegar('btListarBtn')._ev.click();
  assert.match(pegar('btStatus').innerHTML, /Cola o link/);
  assert.equal(pegar('btLista').innerHTML, '', 'não podia ter renderizado nada');
});

test('resposta vinda do cache é sinalizada pro usuário', async () => {
  const { pegar } = montarAmbiente({ respostaListar: { ...LISTA_OK, cache: true } });
  pegar('btCanalUrl').value = '@x';
  await pegar('btListarBtn')._ev.click();
  assert.match(pegar('btStatus').innerHTML, /da memória/);
});

test('retomada: item já baixado aparece marcado e desmarcado da seleção', async () => {
  const { pegar, armazem } = montarAmbiente({ respostaListar: LISTA_OK });
  // simula que o "Um" já foi baixado numa sessão anterior
  const chave = 'bt_feitos_' + 'https://www.youtube.com/@XiroRanks/shorts'.replace(/[^\w]+/g, '_').slice(0, 60);
  armazem.set(chave, JSON.stringify(['aaaaaaaaaaa']));

  pegar('btCanalUrl').value = 'https://www.youtube.com/@XiroRanks';
  await pegar('btListarBtn')._ev.click();

  const html = pegar('btLista').innerHTML;
  assert.ok(html.includes('já baixado'), 'o item repetido tem que aparecer marcado como feito');
  assert.match(pegar('btStatus').innerHTML, /Você já baixou 1/);
  // o primeiro checkbox não pode vir checked (recorta por <label>, não por
  // título — senão o recorte invade o item seguinte)
  const labels = html.split('<label').slice(1);
  assert.equal(labels.length, 3, 'deveria ter 3 itens');
  assert.ok(!labels[0].includes(' checked'), 'item já baixado não pode vir pré-selecionado');
  assert.ok(labels[1].includes(' checked') && labels[2].includes(' checked'), 'os que faltam continuam marcados');
});

test('erro do servidor vira mensagem legível, não código cru', async () => {
  const { contexto, pegar } = montarAmbiente({ respostaListar: LISTA_OK });
  contexto.fetch = async () => ({ ok: false, status: 429, headers: { get: () => '30' },
    json: async () => ({ error: 'cota_listagem', detail: 'Espera 5 min.' }) });
  pegar('btCanalUrl').value = '@x';
  await pegar('btListarBtn')._ev.click();
  const txt = pegar('btStatus').innerHTML;
  assert.ok(!/undefined|\[object/.test(txt), 'não pode vazar undefined pra tela: ' + txt);
  assert.ok(txt.length > 10);
});
