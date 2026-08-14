// tests/unit/longos.test.mjs — node --test
//
// A página /longos: virais longos de criadores dark.
//
// ── AS REGRAS SÃO TODAS MEDIDAS, E É POR ISSO QUE ELAS TÊM TESTE ───────────
// Nada aqui foi escolhido por intuição. Cada número veio de uma sonda rodada
// contra a API real em 13-14/08/2026, e o teste existe pra que a próxima
// pessoa não "melhore" a regra sem refazer a medição:
//
//   · `videoCategoryId` devolve ZERO na busca de vídeo (3 variações testadas,
//     todas com totalResults 0) → a descoberta TEM que ser por termo.
//   · order=viewCount → 1 canal pequeno de 24 (traz o gigante de sempre).
//     order=date      → 50 canais pequenos, mas só 2 acima de 30k views.
//     order=relevance → 6 acima de 30k, 2 acima de 300k. ← escolhido.
//   · O selo de verificado NÃO EXISTE na API do YouTube. O substituto é o
//     número que gera o selo (100 mil inscritos); o dono apertou pra 70 mil.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const API = readFileSync(new URL('../../api/longos.js', import.meta.url), 'utf8');
const HTML = readFileSync(new URL('../../public/longos.html', import.meta.url), 'utf8');
const SQL = readFileSync(new URL('../../sql/longos.sql', import.meta.url), 'utf8');
const WF = readFileSync(new URL('../../.github/workflows/longos-coleta.yml', import.meta.url), 'utf8');
const TOOLBAR = readFileSync(new URL('../../public/toolbar.js', import.meta.url), 'utf8');
const I = require('../../api/longos.js').__interno;
// Sem comentários: as regras abaixo são sobre CÓDIGO. A 1ª versão destes
// testes batia no arquivo inteiro e reprovava os próprios comentários que
// explicam por que a regra existe.
const CODIGO = API.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

// ═══ 1 — AS REGRAS MEDIDAS ══════════════════════════════════════════════

test('a busca usa TERMO e order=relevance (categoria devolve zero; medido)', () => {
  const busca = API.slice(API.indexOf('// ── 1) BUSCA'), API.indexOf('stat.candidatos'));
  assert.match(busca, /q: termos\[i\]/, 'sem termo a busca volta vazia — videoCategoryId não funciona');
  assert.match(busca, /order: 'relevance'/, 'viewCount traz o gigante; date traz quem ainda não tem views');
  assert.equal(/videoCategoryId/.test(CODIGO), false, 'a categoria foi medida devolvendo ZERO — não pode voltar');
  // A comparação medida fica escrita, senão a próxima pessoa refaz o erro.
  assert.match(API, /viewCount deu 1 canal pequeno de\s*\n\/\/\s*24/);
});

test('as duas faixas da API são pedidas — 15-50min cruza medium e long', () => {
  assert.equal(I.DUR_MIN_S, 15 * 60);
  assert.equal(I.DUR_MAX_S, 50 * 60);
  const busca = API.slice(API.indexOf('// ── 1) BUSCA'), API.indexOf('stat.candidatos'));
  assert.match(busca, /i % 2 === 0 \? 'long' : 'medium'/,
    'long é +20min e medium é 4-20min: pedir só uma perde metade da faixa');
  // E o corte fino é NOSSO, com a duração exata — o balde da API é grosso.
  assert.match(API, /d >= DUR_MIN_S && d <= DUR_MAX_S/);
});

test('o teto de inscritos é o substituto do selo, e canal que esconde não passa', () => {
  assert.equal(I.MAX_INSCRITOS, 70_000);
  assert.match(API, /c\.oculto \|\| c\.subs > MAX_INSCRITOS/,
    'canal que esconde a contagem não pode passar por engano — sem número, na dúvida fica fora');
  // O porquê do substituto fica escrito: o selo não existe na API.
  assert.match(API, /o selo NÃO\n\/\/\s*EXISTE na API/);
});

test('os três pisos são os pedidos, e o menor corta na coleta', () => {
  assert.deepEqual(I.PISOS, [30_000, 100_000, 300_000]);
  assert.match(API, /if \(views < PISOS\[0\]\) continue;/,
    'guardar vídeo abaixo do menor piso é encher a tabela com o que nenhum filtro mostra');
});

test('os termos rotacionam — senão as rodadas de 3h trazem os mesmos vídeos', () => {
  const a = I.fatiaDeTermos(8, 0).join(',');
  const b = I.fatiaDeTermos(8, 3 * 3600e3).join(',');
  assert.notEqual(a, b, 'duas rodadas seguidas não podem vasculhar os mesmos termos');
  assert.ok(I.TERMOS.length >= 24, `${I.TERMOS.length} termos é pouco pra 8 por rodada`);
  // Termo com nome de gente/marca traria justamente o canal famoso que o teto
  // de inscritos existe pra excluir.
  for (const proibido of ['mrbeast', 'netflix', 'globo']) {
    assert.equal(I.TERMOS.some((t) => t.toLowerCase().includes(proibido)), false);
  }
});

// ═══ 2 — AS LIÇÕES QUE JÁ CUSTARAM CARO NESTE PROJETO ═══════════════════

test('rodada que não grava NADA responde 503 (o cron precisa ficar vermelho)', () => {
  const fn = API.slice(API.indexOf('function responder(res, stat'), API.indexOf('// ── LISTAR'));
  assert.match(fn, /if \(stat\.gravados > 0\) return res\.status\(200\)/);
  assert.match(fn, /return res\.status\(503\)/,
    'HTTP 200 com zero vídeo foi o que deixou 7 dias de coleta morta do TikTok parecer saudável');
});

test('o workflow ALÉM disso quebra quando gravou 0 (cinto e suspensório)', () => {
  assert.match(WF, /if \[ "\$GRAVADOS" = "0" \] \|\| \[ "\$GRAVADOS" = "\?" \]/);
  assert.match(WF, /exit 1/);
  // E ele informa quanta cota gastou — a conta que já custou 28 chaves aqui.
  assert.match(WF, /buscas gastas \(cota YouTube\)/i);
});

test('emoji partido ao meio não derruba o lote (a lição de 12/08)', () => {
  const emoji = 'a'.repeat(299) + '👹';
  const saida = I.textoSeguro(emoji, 300);
  assert.equal(/[\uD800-\uDFFF]/.test(saida), false,
    'meia metade de emoji faz o PostgREST recusar o LOTE inteiro com "Empty or invalid json"');
  assert.doesNotThrow(() => JSON.parse(JSON.stringify({ t: saida })));
  assert.equal(I.textoSeguro('vídeo normal 🎬', 300), 'vídeo normal 🎬');
});

test('a gravação vai em blocos — uma linha ruim custa o bloco, não a rodada', () => {
  assert.match(API, /for \(let i = 0; i < linhas\.length; i \+= 50\)/);
  assert.match(API, /if \(r\.ok\) n \+= bloco\.length;/);
});

test('a capa morta do YouTube é detectada por DIMENSÃO, não por onerror', () => {
  // Vídeo removido devolve 404 com um JPEG cinza de 120x90 DENTRO: o navegador
  // decodifica e o onerror nunca dispara. Medido em 12/08.
  assert.match(HTML, /img\.naturalWidth <= 120 && img\.naturalHeight <= 90/);
  assert.match(HTML, /onload="capa\(this\)"/, 'a checagem tem que ser no onload');
  assert.equal(/onerror="this\.style\.display='none'"/.test(HTML), false);
});

// ═══ 3 — A PÁGINA ══════════════════════════════════════════════════════

test('as duas abas existem, e a de Canais já está no ar', () => {
  assert.match(HTML, /id="abaVirais"/);
  assert.match(HTML, /id="abaCanais"/, 'o dono pediu o botão de Canais já criado');
  assert.match(HTML, /action=canais/, 'e ele precisa chamar algo de verdade, não ser enfeite');
  assert.match(API, /if \(action === 'canais'\)/);
});

test('os filtros são exatamente os três pisos pedidos', () => {
  for (const p of ['30000', '100000', '300000']) {
    assert.ok(HTML.includes('data-piso="' + p + '"'), `faltou o filtro de ${p} views`);
  }
  // E o backend só aceita esses três — parâmetro de fora vira o menor.
  assert.match(API, /PISOS\.includes\(parseInt\(req\.query\.piso, 10\)\)/);
});

test('o card é 16:9 — vídeo longo não é Short', () => {
  assert.match(HTML, /\.thumb-wrap\{position:relative;aspect-ratio:16\/9/,
    '9:16 cortaria a capa de vídeo longo no meio');
});

test('a proporção views/inscritos aparece no card (o número que separa dark de pequeno)', () => {
  assert.match(API, /views_por_inscrito: c\.subs \? \+\(views \/ c\.subs\)\.toFixed\(2\) : null/);
  assert.match(HTML, /class="ratio/);
  assert.match(HTML, /var quente = r >= 5;/, 'e há um corte visual entre "postou" e "estourou"');
  // Dá pra ordenar por ela — foi o achado mais forte da sonda.
  assert.match(API, /req\.query\.ordem === 'ratio' \? 'views_por_inscrito'/);
  assert.match(HTML, /data-ordem="ratio"/);
});

test('a página escapa tudo que vem do banco', () => {
  assert.match(HTML, /function esc\(s\)/);
  for (const campo of ['v.titulo', 'v.canal_nome', 'c.nome', 'c.melhor_titulo']) {
    assert.ok(HTML.includes('esc(' + campo + ')') || HTML.includes("esc(" + campo + "||'')"),
      `${campo} entra no HTML sem escapar`);
  }
});

test('a página entrou na barra de ferramentas', () => {
  assert.match(TOOLBAR, /id:'longos'[\s\S]{0,80}href:'\/longos'/);
});

test('NÃO toca em nada da Virais de Shorts', () => {
  // O produto antigo não pode ser afetado: fonte diferente, tabela diferente.
  for (const proibido of ['virais_banco', 'virais_canais_curados', 'canal_curado']) {
    assert.equal(CODIGO.includes(proibido), false, `api/longos.js mexe em ${proibido} — são produtos separados`);
  }
});

// ═══ 4 — O SQL ═════════════════════════════════════════════════════════

test('SQL: RLS colada na criação nas duas tabelas', () => {
  for (const t of ['longos_virais', 'longos_canais']) {
    const iCria = SQL.indexOf('create table if not exists ' + t);
    const iRls = SQL.indexOf('alter table ' + t + ' enable row level security');
    assert.ok(iCria >= 0 && iRls > iCria, t + ': faltou ligar a RLS');
    assert.ok(SQL.slice(iCria, iRls).split(';').length < 4, t + ': a RLS ficou longe da criação');
    assert.match(SQL, new RegExp('alter table ' + t + ' force  ?row level security'));
  }
});

test('SQL: a regra central (canal pequeno) tem rede no banco também', () => {
  assert.match(SQL, /longos_virais_canal_pequeno check \(canal_inscritos <= 200000\)/,
    'se alguém afrouxar a API sem pensar, o insert estoura em vez de encher a página de canal grande');
  assert.match(SQL, /longos_virais_duracao check \(duracao_segundos between/);
});
