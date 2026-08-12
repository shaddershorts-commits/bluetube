// tests/unit/tiktok_virais_tikwm.test.mjs — node --test
//
// A fonte GRÁTIS dos virais do TikTok (TikWM), no lugar do TikAPI.
//
// ── POR QUE ESTE ARQUIVO EXISTE ─────────────────────────────────────────────
// Em 12/08/2026 foi medido que a coleta do TikTok estava MORTA havia 7 dias: a
// última inserção real foi 05/08 22:19, e desde 06/08 ~40 rodadas do cron
// devolveram "inseridos: 0" — TODAS verdes no GitHub Actions, porque o workflow
// só considerava erro quando o HTTP não era 200. Com a limpeza de 30 dias, a
// aba TikTok esvaziaria sozinha por volta de 04/09.
//
// A fonte nova tem EXATAMENTE o mesmo disfarce: o TikWM devolve o limite de
// vazão como **HTTP 200 com code:-1**. Trocar de fornecedor sem trocar o
// detector só mudaria a data do próximo enterro silencioso.
//
// Então o que este arquivo trava, em ordem de importância:
//   1. falha DISFARÇADA DE SUCESSO nunca mais passa (code:-1, e rodada vazia);
//   2. o TikAPI continua como RESERVA — remover fallback é regressão;
//   3. os 17 campos que o banco grava continuam saindo iguais (o front, o
//      Blublu e a limpeza não podem saber que a fonte mudou);
//   4. o piso de 800k likes, que é a régua do produto, não mudou.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const FONTE = readFileSync(new URL('../../api/tiktok-virais.js', import.meta.url), 'utf8');
const WF = readFileSync(new URL('../../.github/workflows/tiktok-coleta.yml', import.meta.url), 'utf8');
const BLUBLU = readFileSync(new URL('../../api/blublu-chat.js', import.meta.url), 'utf8');
const VIRAIS_HTML = readFileSync(new URL('../../public/virais.html', import.meta.url), 'utf8');

// ═══ 1 — FALHA DISFARÇADA DE SUCESSO ════════════════════════════════════

test('code:-1 com HTTP 200 é tratado como FALHA (é o disfarce que matou a coleta)', async () => {
  const original = global.fetch;
  const chamadas = [];
  global.fetch = async (url) => {
    chamadas.push(String(url));
    // O corpo REAL que o TikWM devolve quando barra por vazão:
    return { ok: true, status: 200, json: async () => ({ code: -1, msg: 'Free Api Limit: 1 request/second.' }) };
  };
  try {
    delete require.cache[require.resolve('../../api/tiktok-virais.js')];
    const mod = require('../../api/tiktok-virais.js');
    // A função é interna; o que dá pra provar sem exportá-la é que o CÓDIGO
    // testa `code !== 0` antes de usar os dados. Isso é garantia de linha, e
    // aqui ela vale: é a linha cuja ausência custou 7 dias.
    assert.ok(mod, 'o módulo carrega');
  } finally { global.fetch = original; }

  const fn = FONTE.slice(FONTE.indexOf('async function tikwmGet'), FONTE.indexOf('const pausa ='));
  assert.match(fn, /if \(d\.code !== 0\) return \{ ok: false/,
    'sem esta linha o rate limit vira lista vazia e a rodada reporta verde');
  assert.match(fn, /if \(!r\.ok\) return \{ ok: false/, 'e o erro de HTTP também');
  assert.match(fn, /AbortSignal\.timeout\(TIKWM_TIMEOUT_MS\)/,
    'o modo de falha lento do TikWM devolve 531 em 34-38s — sem timeout curto ele estoura o cron');
});

test('rodada que não grava NADA responde 503 (o cron precisa ficar vermelho)', () => {
  const fn = FONTE.slice(FONTE.indexOf('function responderColeta'), FONTE.indexOf('// ── FONTE RESERVA'));
  assert.match(fn, /if \(total > 0\) return res\.status\(200\)/);
  assert.match(fn, /return res\.status\(503\)/,
    'HTTP 200 com zero vídeo é exatamente o que fez ~40 rodadas mortas parecerem saudáveis');
  assert.match(fn, /coleta_vazia/);
});

test('o workflow ALÉM disso quebra quando inseriu 0 (cinto e suspensório)', () => {
  assert.match(WF, /if \[ "\$HTTP_CODE" != "200" \]/, 'a guarda de HTTP continua');
  assert.match(WF, /if \[ "\$INSERTED" = "0" \] \|\| \[ "\$INSERTED" = "\?" \]/,
    'foi aqui que 40 rodadas vazias passaram por verdes');
  assert.match(WF, /exit 1/);
  // O teto do curl tem que caber no teto interno da coleta, senão o cron mata
  // uma rodada que ia dar certo.
  // Ancora na CHAMADA, não em qualquer "--max-time" do arquivo: o comentário
  // logo acima cita o valor antigo, e a primeira versão deste teste leu ele.
  const maxTime = Number((WF.match(/curl -sS --max-time (\d+)/) || [])[1]);
  const tetoInterno = Number((FONTE.match(/const TIKWM_TETO_MS = (\d+)/) || [])[1]);
  assert.ok(maxTime * 1000 > tetoInterno + 60000,
    `curl espera ${maxTime}s e a coleta pode levar ${tetoInterno / 1000}s + cache/upsert`);
});

// ═══ 2 — O TIKAPI CONTINUA COMO RESERVA ═════════════════════════════════

test('o TikAPI NÃO foi removido — ele virou o 2º da cadeia', () => {
  assert.match(FONTE, /async function coletarViaTikAPI/, 'o caminho pago continua existindo');
  assert.match(FONTE, /api\.tikapi\.io\/public\/explore/, 'com o endpoint dele intacto');
  const orquestra = FONTE.slice(FONTE.indexOf('async function coletar(req, res'), FONTE.indexOf('function responderColeta'));
  assert.ok(orquestra.indexOf('coletarViaTikWM') < orquestra.indexOf('coletarViaTikAPI'),
    'a fonte grátis vem primeiro');
  assert.match(orquestra, /if \(\(!tikwm \|\| !tikwm\.inseridos\) && TIKAPI_KEY\)/,
    'a reserva só entra quando a grátis não trouxe nada');
});

test('sem TIKAPI_KEY a coleta NÃO quebra (é a operação normal depois de cancelar)', () => {
  const orquestra = FONTE.slice(FONTE.indexOf('async function coletar(req, res'), FONTE.indexOf('function responderColeta'));
  assert.equal(/TIKAPI_KEY_missing/.test(orquestra), false,
    'antes o endpoint devolvia 500 sem a chave — isso impediria cancelar a assinatura');
  assert.match(orquestra, /pulado: 'sem_chave'/, 'a ausência da chave é registrada, não é erro');
});

test('dá pra desligar a fonte grátis por env, sem deploy', () => {
  assert.match(FONTE, /process\.env\.TIKTOK_FONTE_TIKWM !== 'off'/,
    'se o TikWM cair de vez, o dono volta pro TikAPI mexendo numa variável');
});

// ═══ 3 — OS 17 CAMPOS CONTINUAM OS MESMOS ═══════════════════════════════

test('o mapeamento do TikWM cobre as MESMAS 17 colunas do caminho antigo', () => {
  const novo = FONTE.slice(FONTE.indexOf('function linhaDeTikwm'), FONTE.indexOf('async function coletarViaTikWM'));
  const colunas = [
    'tiktok_video_id', 'video_url', 'thumbnail_url', 'caption', 'author_handle',
    'author_name', 'author_avatar', 'likes_count', 'views_count', 'comments_count',
    'shares_count', 'country', 'duration_sec', 'tiktok_created_at', 'collected_at',
    'last_seen_at', 'status',
  ];
  for (const c of colunas) {
    assert.ok(novo.includes(c + ':'), `a coluna ${c} sumiu do mapeamento da fonte nova`);
  }
  // A URL do vídeo é MONTADA (o TikWM não devolve pronta) — mesmo formato de antes.
  assert.match(novo, /https:\/\/www\.tiktok\.com\/@\$\{handle \|\| 'tiktok'\}\/video\/\$\{id\}/);
});

test('tiktok_created_at é preenchido — o Blublu filtra o acervo por ela', () => {
  // O grid não usa essa coluna, então é fácil achar que ela é opcional. Não é:
  // vídeo com ela nula some das respostas do Blublu quando alguém pede janela
  // de tempo.
  assert.match(BLUBLU, /tiktok_created_at=gte\./, 'o Blublu ainda filtra por essa coluna');
  const novo = FONTE.slice(FONTE.indexOf('function linhaDeTikwm'), FONTE.indexOf('async function coletarViaTikWM'));
  assert.match(novo, /tiktok_created_at: v\.create_time \? new Date\(v\.create_time \* 1000\)\.toISOString\(\) : null/);
});

test('o país vem de CADA vídeo e em minúsculo (o filtro do front compara assim)', () => {
  const novo = FONTE.slice(FONTE.indexOf('function linhaDeTikwm'), FONTE.indexOf('async function coletarViaTikWM'));
  assert.match(novo, /country: String\(v\.region \|\| ''\)\.toLowerCase\(\)/,
    'region vem MAIÚSCULO do TikWM; sem o toLowerCase o filtro por país nunca casa');
  assert.match(VIRAIS_HTML, /country=/, 'o front continua filtrando por país');
});

test('a thumbnail continua sendo cacheada (a URL do TikTok vira 403 em dias)', () => {
  const fn = FONTE.slice(FONTE.indexOf('async function coletarViaTikWM'), FONTE.indexOf('// ── COLETAR'));
  assert.match(fn, /cacheThumbnail\(original/, 'sem cache a capa some do grid em 3-5 dias');
  assert.match(fn, /v\.cover \|\| v\.origin_cover \|\| v\.ai_dynamic_cover/, 'com as reservas que o TikWM oferece');
});

// ═══ 4 — A RÉGUA DO PRODUTO NÃO MUDOU ═══════════════════════════════════

test('o piso de 800 mil likes continua sendo o que define o que entra', () => {
  assert.match(FONTE, /const MIN_LIKES = 800_000;/);
  const fn = FONTE.slice(FONTE.indexOf('async function coletarViaTikWM'), FONTE.indexOf('// ── COLETAR'));
  assert.match(fn, /\(v\.digg_count \|\| 0\) >= MIN_LIKES/,
    'a fonte mudou, a régua não: quem entra é quem passa o piso');
  // E as hashtags são só ONDE procurar — não podem virar filtro de qualidade.
  assert.match(FONTE, /Isto NÃO é o filtro do que entra/);
});

test('as hashtags rotacionam entre rodadas (senão o volume DIÁRIO despenca)', () => {
  const fn = FONTE.slice(FONTE.indexOf('function fatiaDeHashtags'), FONTE.indexOf('function linhaDeTikwm'));
  assert.match(fn, /% TIKWM_HASHTAGS\.length/);
  // Duas rodadas consecutivas (3h de diferença) não podem repetir a fatia.
  const tags = (FONTE.match(/const TIKWM_HASHTAGS = \[([\s\S]*?)\]/) || [])[1] || '';
  const n = (tags.match(/'/g) || []).length / 2;
  const porRodada = Number((FONTE.match(/const TIKWM_TAGS_POR_RODADA = (\d+)/) || [])[1]);
  assert.ok(n >= porRodada * 3, `${n} hashtags pra ${porRodada} por rodada é pouco: a rotação daria a volta rápido demais`);
});

test('o ritmo respeita o limite de vazão medido do TikWM', () => {
  const pausa = Number((FONTE.match(/const TIKWM_PAUSA_MS = (\d+)/) || [])[1]);
  assert.ok(pausa >= 1000, `pausa de ${pausa}ms — o TikWM anuncia 1 req/s e a 1,2s mediu 45 requisições sem bloqueio`);
});

test('a coleta para pelo RELÓGIO, não por um número fixo de requisições', () => {
  // Quando o TikWM está lento, colher menos é melhor que estourar o cron.
  const fn = FONTE.slice(FONTE.indexOf('async function coletarViaTikWM'), FONTE.indexOf('// ── COLETAR'));
  assert.match(fn, /Date\.now\(\) - inicio > TIKWM_TETO_MS/);
  assert.match(fn, /parou_por = 'teto_de_tempo'/, 'e o motivo fica registrado na resposta');
});
