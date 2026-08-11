// tests/unit/comunidade_amizade.test.mjs — node --test
// ============================================================================
// POR QUE ESTE ARQUIVO EXISTE
// Amizade é a feature que mais apodrece em silêncio. Os quatro modos de falha
// clássicos são:
//   1. DUAS linhas por par (uma por sentido) → "ele é meu amigo mas eu não sou
//      dele". É exatamente o que `blue_contatos` faz hoje (blue-chat.js insere
//      a linha inversa no aceite): se o 2º INSERT falhar, ninguém percebe.
//   2. Pedido duplicado criando linha nova → contador e caixa de pedidos
//      explodem, e a vítima recebe o mesmo aviso N vezes.
//   3. Pedidos cruzados (A pede pra B enquanto B pede pra A) virando DOIS
//      pendentes que nunca se resolvem.
//   4. Recusar/desfazer APAGANDO a linha → o histórico some, a carência
//      "reseta" e o spam vira infinito: pede → recusa → pede → recusa…
//
// Os testes abaixo rodam as decisões contra um banco em memória que se recusa
// a aceitar duas linhas pro mesmo par (igual à PK real), então cada cenário é
// jogado de ponta a ponta, não só na unidade.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const AM = require('../../api/_helpers/amizade.js');

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ler = (rel) => readFileSync(join(RAIZ, rel), 'utf8');

const {
  STATUS, CARENCIA_RECUSA_DIAS, MAX_STRIKES, DIA_MS,
  parCanonico, estadoParaMim, decidirPedido, decidirAceite, decidirRecusa,
  decidirCancelamento, decidirDesfazer, notificacao, deveNotificar, limparNome,
} = AM;

// ── Elenco (uuids válidos e em ordem conhecida: ANA < BRUNO < CARLA) ────────
const ANA   = '11111111-1111-4111-8111-111111111111';
const BRUNO = '22222222-2222-4222-8222-222222222222';
const CARLA = 'aaaaaaaa-3333-4333-8333-333333333333';

const T0 = new Date('2026-08-11T12:00:00.000Z');
const mais = (dias, base = T0) => new Date(base.getTime() + dias * DIA_MS);

// ═══════════════════════════════════════════════════════════════════════════
// BANCO EM MEMÓRIA — reproduz a PK (user_a, user_b) e o CHECK user_a < user_b
// ═══════════════════════════════════════════════════════════════════════════
function novoBanco() {
  const linhas = new Map();
  const chave = (x, y) => {
    const par = parCanonico(x, y);
    if (!par) throw new Error('par inválido (self-amizade ou uuid ruim)');
    // O CHECK do SQL: user_a < user_b. Se a ordem canônica falhar, o banco
    // real recusaria a linha — aqui também.
    assert.ok(par.user_a < par.user_b, 'ordem canônica quebrada');
    return par.user_a + '|' + par.user_b;
  };
  return {
    ler: (x, y) => linhas.get(chave(x, y)) || null,
    aplicar(dec, x, y) {
      const k = chave(x, y);
      if (dec.acao === 'criar') {
        if (linhas.has(k)) throw new Error('409: a PK do banco recusaria essa 2ª linha');
        linhas.set(k, { ...dec.linha });
      } else if (dec.acao === 'atualizar') {
        linhas.set(k, { ...linhas.get(k), ...dec.patch });
      }
    },
    total: () => linhas.size,
    tudo: () => [...linhas.values()],
  };
}

const rodar = (banco, decisor, eu, outro) => {
  const linha = banco.ler(eu, outro);
  const dec = decisor(linha);
  if (dec.ok) banco.aplicar(dec, eu, outro);
  return dec;
};
const pedir     = (b, eu, alvo, agora = T0) => rodar(b, (l) => decidirPedido({ eu, alvo, linha: l, agora }), eu, alvo);
const aceitar   = (b, eu, outro, agora = T0) => rodar(b, (l) => decidirAceite({ eu, linha: l, agora }), eu, outro);
const recusar   = (b, eu, outro, agora = T0) => rodar(b, (l) => decidirRecusa({ eu, linha: l, agora }), eu, outro);
const cancelar  = (b, eu, outro, agora = T0) => rodar(b, (l) => decidirCancelamento({ eu, linha: l, agora }), eu, outro);
const desfazer  = (b, eu, outro, agora = T0) => rodar(b, (l) => decidirDesfazer({ eu, linha: l, agora }), eu, outro);
const estado    = (b, eu, outro, agora = T0) => estadoParaMim(b.ler(eu, outro), eu, agora).estado;

// ═══════════════════════════════════════════════════════════════════════════
// CUIDADO 1 — não dá pra pedir amizade pra si mesmo
// ═══════════════════════════════════════════════════════════════════════════

test('CUIDADO 1: pedir amizade pra si mesmo é 400, em qualquer caixa/espaço', () => {
  for (const eu of [ANA, ANA.toUpperCase(), '  ' + ANA + '  ']) {
    const d = decidirPedido({ eu, alvo: ANA, linha: null, agora: T0 });
    assert.equal(d.ok, false, 'aceitou auto-amizade com eu=' + JSON.stringify(eu));
    assert.equal(d.http, 400);
    assert.match(d.erro, /si mesmo/i, 'a mensagem não explica o motivo: ' + d.erro);
  }
});

test('CUIDADO 1: a ordem canônica torna a auto-amizade IMPOSSÍVEL de representar', () => {
  // parCanonico devolve null (a === b), então nem existe chave pra gravar.
  assert.equal(parCanonico(ANA, ANA), null);
  // E no banco o CHECK (user_a < user_b) é falso pra a = a — a regra está nos
  // DOIS lados, não só no código.
  const sql = ler('sql/comunidade_amizades.sql');
  assert.match(sql, /check\s*\(\s*user_a\s*<\s*user_b\s*\)/i, 'o CHECK user_a < user_b sumiu do SQL');
});

test('uuid inválido não vira amizade (nem cria linha órfã)', () => {
  for (const lixo of ['', null, 'não-é-uuid', '11111111-1111-4111-8111', 42]) {
    assert.equal(parCanonico(ANA, lixo), null, 'aceitou alvo inválido: ' + String(lixo));
    const d = decidirPedido({ eu: ANA, alvo: lixo, linha: null, agora: T0 });
    assert.equal(d.ok, false);
    assert.equal(d.http, 400);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// CUIDADO 2 — UMA linha por par; pedido duplicado devolve o estado existente
// ═══════════════════════════════════════════════════════════════════════════

test('CUIDADO 2: 5 pedidos seguidos = 1 linha só e nenhuma notificação repetida', () => {
  const b = novoBanco();
  const primeiro = pedir(b, ANA, BRUNO);
  assert.equal(primeiro.acao, 'criar');
  assert.equal(primeiro.notificar, 'pedido', 'o 1º pedido tem que avisar o outro');

  for (let i = 0; i < 4; i++) {
    const d = pedir(b, ANA, BRUNO, mais(i + 1));
    assert.equal(d.ok, true, 'pedido duplicado virou erro em vez de devolver o estado');
    assert.equal(d.acao, 'nenhuma', 'pedido duplicado escreveu no banco');
    assert.equal(d.estado, 'pendente_enviado', 'não devolveu o estado existente');
    assert.equal(d.ja_existia, true);
    assert.equal(d.notificar, null, 'metralhou o sininho do outro com o mesmo aviso');
  }
  assert.equal(b.total(), 1, 'criou linha nova em pedido duplicado');
});

test('CUIDADO 2: pedir pra quem JÁ é amigo é idempotente (nem escreve, nem erra)', () => {
  const b = novoBanco();
  pedir(b, ANA, BRUNO);
  aceitar(b, BRUNO, ANA);
  const d = pedir(b, ANA, BRUNO, mais(1));
  assert.equal(d.ok, true);
  assert.equal(d.acao, 'nenhuma');
  assert.equal(d.estado, 'amigos');
  assert.equal(b.total(), 1);
});

test('CUIDADO 2: a linha é a MESMA venha o pedido de que lado vier', () => {
  const b1 = novoBanco(); pedir(b1, ANA, BRUNO);
  const b2 = novoBanco(); pedir(b2, BRUNO, ANA);
  const l1 = b1.tudo()[0], l2 = b2.tudo()[0];
  assert.equal(l1.user_a, l2.user_a, 'a ordem canônica depende de quem pediu — dá linha duplicada');
  assert.equal(l1.user_b, l2.user_b);
  assert.equal(l1.user_a, ANA); assert.equal(l1.user_b, BRUNO);
  assert.equal(l1.requested_by, ANA);
  assert.equal(l2.requested_by, BRUNO, 'perdeu quem foi que pediu');
});

// ═══════════════════════════════════════════════════════════════════════════
// CUIDADO 3 — pedidos cruzados viram amizade aceita, nunca dois pendentes
// ═══════════════════════════════════════════════════════════════════════════

test('CUIDADO 3: A pede pra B e B pede pra A ⇒ AMIGOS (não dois pendentes)', () => {
  const b = novoBanco();
  pedir(b, ANA, BRUNO);
  const cruzado = pedir(b, BRUNO, ANA, mais(0.01));
  assert.equal(cruzado.ok, true);
  assert.equal(cruzado.acao, 'atualizar');
  assert.equal(cruzado.estado, 'amigos', 'ficou pendente dos dois lados — o clássico deadlock');
  assert.equal(cruzado.cruzado, true);
  assert.equal(cruzado.notificar, 'aceite', 'quem pediu primeiro não soube que virou amizade');
  assert.equal(cruzado.para, ANA, 'o aviso de aceite foi pro dono errado');
  assert.equal(b.total(), 1);
  assert.equal(b.tudo()[0].status, STATUS.ACEITO);
});

test('CUIDADO 3: nenhuma das duas pessoas fica "amigo de um lado só"', () => {
  const b = novoBanco();
  pedir(b, ANA, BRUNO);
  pedir(b, BRUNO, ANA, mais(0.01));
  // O teste que `blue_contatos` não passaria se um dos INSERTs falhasse:
  assert.equal(estado(b, ANA, BRUNO), 'amigos');
  assert.equal(estado(b, BRUNO, ANA), 'amigos');
});

test('os dois lados SEMPRE enxergam estados coerentes durante o pendente', () => {
  const b = novoBanco();
  pedir(b, ANA, BRUNO);
  assert.equal(estado(b, ANA, BRUNO), 'pendente_enviado');
  assert.equal(estado(b, BRUNO, ANA), 'pendente_recebido', 'o destinatário não vê o pedido na caixa dele');
});

test('quem não é do par não recebe estado nenhum (nem consegue mexer)', () => {
  const b = novoBanco();
  pedir(b, ANA, BRUNO);
  const linhaDeOutros = b.ler(ANA, BRUNO);
  assert.equal(estadoParaMim(linhaDeOutros, CARLA, T0).estado, 'nenhum');
  assert.equal(decidirAceite({ eu: CARLA, linha: linhaDeOutros, agora: T0 }).http, 404,
    'um terceiro conseguiu aceitar pedido alheio');
  assert.equal(decidirDesfazer({ eu: CARLA, linha: linhaDeOutros, agora: T0 }).http, 404);
});

test('ninguém aceita o próprio pedido, e quem pediu não "recusa" (cancela)', () => {
  const b = novoBanco();
  pedir(b, ANA, BRUNO);
  const auto = aceitar(b, ANA, BRUNO);
  assert.equal(auto.ok, false); assert.equal(auto.http, 400);
  assert.match(auto.erro, /próprio pedido/i);
  const rec = recusar(b, ANA, BRUNO);
  assert.equal(rec.ok, false); assert.equal(rec.http, 400);
  assert.match(rec.erro, /cancelar/i, 'não aponta o caminho certo');
  assert.equal(b.ler(ANA, BRUNO).status, STATUS.PENDENTE, 'a linha mudou numa ação inválida');
});

// ═══════════════════════════════════════════════════════════════════════════
// CUIDADO 4 — quem recusou não pode ser spammado (carência + histórico)
// ═══════════════════════════════════════════════════════════════════════════

test('CUIDADO 4: recusar NÃO apaga a linha — o histórico é o que segura o spam', () => {
  const b = novoBanco();
  pedir(b, ANA, BRUNO);
  recusar(b, BRUNO, ANA);
  assert.equal(b.total(), 1, 'a linha sumiu — a carência seria zerada no próximo pedido');
  const l = b.ler(ANA, BRUNO);
  assert.equal(l.status, STATUS.RECUSADO);
  assert.equal(l.strikes_a, 1, 'quem foi recusado não recebeu strike');
  assert.equal(l.strikes_b, 0, 'quem recusou levou strike — está punindo a vítima');
  assert.ok(l.cooldown_a, 'sem carência: dá pra pedir de novo no segundo seguinte');
  assert.equal(l.cooldown_b, undefined, 'quem recusou ficou impedido de pedir — errado');
});

test('CUIDADO 4: repedir no dia seguinte é 429 com o prazo explícito', () => {
  const b = novoBanco();
  pedir(b, ANA, BRUNO);
  recusar(b, BRUNO, ANA);
  const d = pedir(b, ANA, BRUNO, mais(1));
  assert.equal(d.ok, false);
  assert.equal(d.http, 429, 'deixou pedir de novo no dia seguinte = spam liberado');
  assert.match(d.erro, /\d+\s*dias?/i, 'não diz quanto falta: ' + d.erro);
  assert.ok(d.espera_ate, 'sem espera_ate a UI não consegue mostrar o prazo');
  assert.equal(b.ler(ANA, BRUNO).status, STATUS.RECUSADO, 'o 429 mesmo assim escreveu no banco');
});

test('CUIDADO 4: passada a carência dá pra pedir de novo, e os strikes NÃO zeram', () => {
  const b = novoBanco();
  pedir(b, ANA, BRUNO);
  recusar(b, BRUNO, ANA);
  const d = pedir(b, ANA, BRUNO, mais(CARENCIA_RECUSA_DIAS + 1));
  assert.equal(d.ok, true, 'a carência virou banimento permanente no 1º strike');
  assert.equal(d.acao, 'atualizar');
  assert.equal(Object.keys(d.patch).some((k) => /^strikes_|^cooldown_/.test(k)), false,
    'o patch de repedido mexe em strikes/cooldown — isso reabriria o loop de spam');
  assert.equal(b.ler(ANA, BRUNO).strikes_a, 1, 'o histórico foi zerado no repedido');
  assert.equal(b.total(), 1);
});

test('CUIDADO 4: a carência ESCALA e no 3º strike o pedido é bloqueado de vez', () => {
  const b = novoBanco();
  let t = T0;
  // 1ª recusa → 7 dias
  pedir(b, ANA, BRUNO, t); recusar(b, BRUNO, ANA, t);
  assert.equal(b.ler(ANA, BRUNO).strikes_a, 1);
  assert.equal(pedir(b, ANA, BRUNO, mais(6, t)).http, 429);

  // 2ª recusa → 14 dias (dobro): insistir custa mais caro
  t = mais(8, t);
  assert.equal(pedir(b, ANA, BRUNO, t).ok, true);
  recusar(b, BRUNO, ANA, t);
  assert.equal(b.ler(ANA, BRUNO).strikes_a, 2);
  assert.equal(pedir(b, ANA, BRUNO, mais(10, t)).http, 429, 'a 2ª carência não escalou');

  // 3ª recusa → bloqueio definitivo
  t = mais(15, t);
  assert.equal(pedir(b, ANA, BRUNO, t).ok, true);
  recusar(b, BRUNO, ANA, t);
  assert.equal(b.ler(ANA, BRUNO).strikes_a, MAX_STRIKES);
  const bloq = pedir(b, ANA, BRUNO, mais(3650, t)); // 10 anos depois
  assert.equal(bloq.ok, false);
  assert.equal(bloq.http, 403);
  assert.equal(bloq.bloqueado, true, 'depois de 3 recusas ainda dá pra insistir pra sempre');
});

test('CUIDADO 4: quem RECUSOU pode mudar de ideia na hora (a carência não é dele)', () => {
  const b = novoBanco();
  pedir(b, ANA, BRUNO);
  recusar(b, BRUNO, ANA);
  const d = pedir(b, BRUNO, ANA, mais(0.01)); // o próprio recusador agora pede
  assert.equal(d.ok, true, 'quem recusou ficou de castigo junto com quem foi recusado');
  assert.equal(d.estado, 'pendente_enviado');
  assert.equal(b.ler(ANA, BRUNO).requested_by, BRUNO, 'não trocou o autor do pedido');
});

test('CUIDADO 4: a UI não oferece botão fadado ao 429 (pode_pedir já vem falso)', () => {
  const b = novoBanco();
  pedir(b, ANA, BRUNO);
  recusar(b, BRUNO, ANA);
  const meu = estadoParaMim(b.ler(ANA, BRUNO), ANA, mais(1));
  assert.equal(meu.estado, 'nenhum');
  assert.equal(meu.pode_pedir, false, 'o botão "+ Amigo" apareceria e daria erro no clique');
  assert.ok(meu.dias_espera >= 1, 'sem dias_espera a UI não tem o que mostrar');
  // já do lado de quem recusou, o botão pode aparecer normalmente
  assert.equal(estadoParaMim(b.ler(ANA, BRUNO), BRUNO, mais(1)).pode_pedir, true);
});

// ═══════════════════════════════════════════════════════════════════════════
// CUIDADO 5 — desfazer não pode apagar histórico de forma que permita spam
// ═══════════════════════════════════════════════════════════════════════════

test('CUIDADO 5: desfazer amizade PRESERVA a linha e o histórico de strikes', () => {
  const b = novoBanco();
  // histórico anterior: ANA já tinha sido recusada uma vez
  pedir(b, ANA, BRUNO); recusar(b, BRUNO, ANA);
  let t = mais(CARENCIA_RECUSA_DIAS + 1);
  pedir(b, ANA, BRUNO, t); aceitar(b, BRUNO, ANA, t);
  assert.equal(estado(b, ANA, BRUNO), 'amigos');

  t = mais(1, t);
  desfazer(b, BRUNO, ANA, t);
  const l = b.ler(ANA, BRUNO);
  assert.equal(b.total(), 1, 'apagou a linha — ANA voltaria a ter 0 strikes');
  assert.equal(l.status, STATUS.DESFEITO);
  assert.equal(l.removed_by, BRUNO);
  assert.equal(l.strikes_a, 2, 'o strike antigo foi perdido no desfazer (histórico zerado = spam liberado)');
});

test('CUIDADO 5: quem foi desfeito NÃO consegue repedir na hora', () => {
  const b = novoBanco();
  pedir(b, ANA, BRUNO); aceitar(b, BRUNO, ANA);
  desfazer(b, BRUNO, ANA, mais(1));
  const d = pedir(b, ANA, BRUNO, mais(1.001));
  assert.equal(d.ok, false);
  assert.equal(d.http, 429, 'desfazer virou porta giratória: remove → pede de novo → remove…');
});

test('CUIDADO 5: quem DESFEZ pode readicionar quando quiser (não se pune sozinho)', () => {
  const b = novoBanco();
  pedir(b, ANA, BRUNO); aceitar(b, BRUNO, ANA);
  desfazer(b, BRUNO, ANA, mais(1));
  const d = pedir(b, BRUNO, ANA, mais(1.001));
  assert.equal(d.ok, true, 'quem desfez ficou impedido de voltar atrás');
  assert.equal(d.estado, 'pendente_enviado');
  assert.equal(b.total(), 1);
});

test('CUIDADO 5: ciclo amigos → desfaz → repede → desfaz esgota em bloqueio', () => {
  const b = novoBanco();
  let t = T0;
  for (let volta = 1; volta <= MAX_STRIKES; volta++) {
    const p = pedir(b, ANA, BRUNO, t);
    assert.equal(p.ok, true, 'volta ' + volta + ' deveria poder pedir');
    aceitar(b, BRUNO, ANA, t);
    desfazer(b, BRUNO, ANA, t);
    assert.equal(b.ler(ANA, BRUNO).strikes_a, volta);
    t = mais(CARENCIA_RECUSA_DIAS * volta + 1, t);
  }
  const fim = pedir(b, ANA, BRUNO, t);
  assert.equal(fim.ok, false);
  assert.equal(fim.bloqueado, true, 'o ciclo de adicionar/remover é infinito');
  assert.equal(b.total(), 1);
});

test('desfazer quem não é amigo é 404 (e não inventa strike)', () => {
  const b = novoBanco();
  assert.equal(desfazer(b, ANA, BRUNO).http, 404);
  pedir(b, ANA, BRUNO);
  const d = desfazer(b, ANA, BRUNO);
  assert.equal(d.http, 404, 'desfez uma amizade que ainda era só pedido');
  assert.equal(b.ler(ANA, BRUNO).status, STATUS.PENDENTE);
  assert.equal(b.ler(ANA, BRUNO).strikes_b || 0, 0);
});

test('cancelar o PRÓPRIO pedido não pune ninguém (desistir não é ofensa)', () => {
  const b = novoBanco();
  pedir(b, ANA, BRUNO);
  const d = cancelar(b, ANA, BRUNO);
  assert.equal(d.ok, true);
  const l = b.ler(ANA, BRUNO);
  assert.equal(l.status, STATUS.DESFEITO);
  assert.equal(l.strikes_a || 0, 0, 'o próprio autor levou strike ao desistir');
  assert.equal(l.strikes_b || 0, 0, 'o destinatário levou strike sem ter feito nada');
  assert.equal(estado(b, BRUNO, ANA), 'nenhum', 'o pedido cancelado continua na caixa do outro');
  assert.equal(pedir(b, ANA, BRUNO, mais(0.01)).ok, true, 'desistir travou o autor');
});

test('quem NÃO mandou o pedido não consegue "cancelar" (isso é recusar)', () => {
  const b = novoBanco();
  pedir(b, ANA, BRUNO);
  const d = cancelar(b, BRUNO, ANA);
  assert.equal(d.ok, false); assert.equal(d.http, 400);
  assert.match(d.erro, /recusar/i);
  // …e o caminho certo funciona, com a penalidade indo pro lado certo
  const r = recusar(b, BRUNO, ANA);
  assert.equal(r.ok, true);
  assert.equal(b.ler(ANA, BRUNO).strikes_a, 1);
});

test('aceitar/recusar um pedido que já foi respondido é 404, não sobrescrita', () => {
  const b = novoBanco();
  pedir(b, ANA, BRUNO); recusar(b, BRUNO, ANA);
  assert.equal(aceitar(b, BRUNO, ANA, mais(1)).http, 404, 'ressuscitou um pedido recusado');
  assert.equal(recusar(b, BRUNO, ANA, mais(1)).http, 404, 'recusou de novo e daria strike duplo');
  assert.equal(b.ler(ANA, BRUNO).strikes_a, 1, 'strike aplicado duas vezes pela mesma recusa');
});

test('aceitar duas vezes é idempotente (clique duplo não quebra nada)', () => {
  const b = novoBanco();
  pedir(b, ANA, BRUNO);
  assert.equal(aceitar(b, BRUNO, ANA).estado, 'amigos');
  const dobro = aceitar(b, BRUNO, ANA, mais(0.001));
  assert.equal(dobro.ok, true);
  assert.equal(dobro.acao, 'nenhuma');
  assert.equal(dobro.notificar, null, 'notificou "aceitou seu pedido" duas vezes');
});

test('amizades são independentes entre pares (CARLA não herda nada)', () => {
  const b = novoBanco();
  pedir(b, ANA, BRUNO); recusar(b, BRUNO, ANA);
  const d = pedir(b, ANA, CARLA, mais(1));
  assert.equal(d.ok, true, 'a carência com BRUNO vazou pro par com CARLA');
  assert.equal(b.total(), 2);
});

// ═══════════════════════════════════════════════════════════════════════════
// NOTIFICAÇÕES — tipo 'amizade', clicável, e sem virar metralhadora
// ═══════════════════════════════════════════════════════════════════════════

test('a notificação de amizade é do tipo que o sininho SABE desenhar', () => {
  const n = notificacao('pedido', { deId: ANA, deNome: 'ana.silva', paraId: BRUNO });
  assert.equal(n.tipo, 'amizade');
  const sino = ler('public/sininho.js');
  const icones = /var ICONES = \{([\s\S]*?)\};/.exec(sino);
  assert.ok(icones, 'não achei o mapa ICONES em public/sininho.js');
  assert.match(icones[1], /amizade\s*:/, "tipo 'amizade' não está no ICONES — cairia no 🔔 genérico");
});

test('a notificação é CLICÁVEL: sem dados.url o sininho renderiza texto morto', () => {
  // sininho.js só põe a classe .link (e o cursor) quando existe dados.url —
  // foi assim que "novo seguidor" (blue-follow.js) nasceu inerte.
  for (const kind of ['pedido', 'aceite']) {
    const n = notificacao(kind, { deId: ANA, deNome: 'ana', paraId: BRUNO });
    assert.ok(n.dados && n.dados.url, kind + ': sem dados.url a notificação não abre nada');
    assert.match(n.dados.url, /^\/comunidade/, 'a url não leva pra Comunidade: ' + n.dados.url);
    assert.equal(n.dados.from_user_id, ANA, 'sem from_user_id não há dedupe possível');
    assert.equal(n.user_id, BRUNO, 'a notificação foi endereçada pra pessoa errada');
    assert.ok(n.titulo && n.mensagem);
  }
  const sino = ler('public/sininho.js');
  assert.match(sino, /dados\s*(&&|\?\.)\s*/, 'sininho.js não lê dados — checar o contrato');
});

test('o nome de quem pediu é limpo antes de virar texto de notificação', () => {
  const veneno = '<img src=x onerror=alert(1)>';
  const n = notificacao('pedido', { deId: ANA, deNome: veneno, paraId: BRUNO });
  assert.equal(/[<>]/.test(n.mensagem), false, 'HTML de outro usuário entrou na notificação');
  assert.equal(limparNome(''), 'Alguém', 'nome vazio vira "undefined" no texto');
  assert.equal(limparNome(null), 'Alguém');
  assert.ok(limparNome('a'.repeat(500)).length <= 40, 'nome gigante não é truncado');
});

test('dedupe de 24h impede cancelar→pedir→cancelar de virar spam de sininho', () => {
  const agora = new Date('2026-08-11T12:00:00.000Z');
  assert.equal(deveNotificar(null, agora), true, 'a primeira notificação tem que sair');
  assert.equal(deveNotificar('2026-08-11T11:00:00.000Z', agora), false, 'notificou de novo 1h depois');
  assert.equal(deveNotificar('2026-08-10T11:00:00.000Z', agora), true, 'travou pra sempre depois da 1ª');
  assert.equal(deveNotificar('lixo-não-parseável', agora), true, 'data corrompida calou a notificação');
});

test('recusar não notifica ninguém (não é canal de mensagem pra quem foi recusado)', () => {
  const b = novoBanco();
  pedir(b, ANA, BRUNO);
  assert.equal(recusar(b, BRUNO, ANA).notificar, null);
  const b2 = novoBanco();
  pedir(b2, ANA, BRUNO); aceitar(b2, BRUNO, ANA);
  assert.equal(desfazer(b2, BRUNO, ANA, mais(1)).notificar, null, 'avisou "fulano te removeu"');
});

test('o aceite avisa QUEM PEDIU (não quem aceitou)', () => {
  const b = novoBanco();
  pedir(b, ANA, BRUNO);
  const d = aceitar(b, BRUNO, ANA);
  assert.equal(d.notificar, 'aceite');
  assert.equal(d.para, ANA, 'o aviso de aceite foi pra própria pessoa que aceitou');
});

// ═══════════════════════════════════════════════════════════════════════════
// SQL — idempotente, comentado e com RLS
// ═══════════════════════════════════════════════════════════════════════════

const SQL = ler('sql/comunidade_amizades.sql');

test('SQL: roda duas vezes sem quebrar (tudo com IF NOT EXISTS / DO $$)', () => {
  assert.match(SQL, /create table if not exists community_friendships/i);
  for (const m of SQL.match(/create\s+index[^;]*/gi) || []) {
    assert.match(m, /if not exists/i, 'índice sem IF NOT EXISTS: ' + m.slice(0, 60));
  }
  for (const m of SQL.match(/alter table[^;]*add column[^;]*/gi) || []) {
    assert.match(m, /add column if not exists/i, 'add column sem IF NOT EXISTS: ' + m.slice(0, 70));
  }
  // Constraints não aceitam IF NOT EXISTS no Postgres → têm que vir em DO $$
  const constraints = SQL.match(/add constraint/gi) || [];
  const guardas = SQL.match(/exception when duplicate_object/gi) || [];
  assert.ok(constraints.length > 0, 'nenhuma constraint declarada');
  assert.equal(guardas.length, constraints.length,
    'constraint sem guarda de duplicate_object — a 2ª execução do arquivo falharia');
});

test('SQL: uma linha por par, ordem canônica e status fechado', () => {
  assert.match(SQL, /primary key\s*\(\s*user_a\s*,\s*user_b\s*\)/i, 'sem PK do par dá pra ter 2 linhas');
  assert.match(SQL, /check\s*\(\s*user_a\s*<\s*user_b\s*\)/i);
  assert.match(SQL, /check\s*\(\s*status in \('pending',\s*'accepted',\s*'rejected',\s*'removed'\)\s*\)/i);
  assert.match(SQL, /requested_by\s*=\s*user_a\s*or\s*requested_by\s*=\s*user_b/i,
    'sem esse CHECK um terceiro poderia constar como autor do pedido');
});

test('SQL: RLS ligada e SEM policy (todo acesso pela service key da API)', () => {
  assert.match(SQL, /alter table community_friendships enable row level security/i);
  assert.equal(/create policy/i.test(SQL), false,
    'criou policy: a anon key passaria a listar amizade dos outros por fora do portão Full/Master');
});

test('SQL: índice nas DUAS pontas (senão metade das buscas faz seq scan)', () => {
  assert.match(SQL, /create index if not exists \w+ on community_friendships \(user_a/i);
  assert.match(SQL, /create index if not exists \w+ on community_friendships \(user_b/i);
});

test('SQL: está comentado explicando o porquê, não só o quê', () => {
  const comentarios = (SQL.match(/^\s*--/gm) || []).length;
  assert.ok(comentarios >= 20, 'só ' + comentarios + ' linhas de comentário num schema com regra de anti-spam');
  assert.match(SQL, /spam/i, 'não explica a razão dos strikes/carência');
});

// ═══════════════════════════════════════════════════════════════════════════
// PORTÃO Full/Master — no BACKEND (o do front é só espelho)
// ═══════════════════════════════════════════════════════════════════════════

const APICOM = ler('api/community.js');

test('PORTÃO: nenhuma ação de amizade escapa do gate de assinante', () => {
  const gate = APICOM.indexOf('upgrade: true');
  assert.ok(gate > 0, 'sumiu o gate 403 upgrade de api/community.js');
  // Só os HANDLERS importam (o require do topo é definição, não execução).
  // Cada ponto onde uma ação de amizade é ATENDIDA tem que vir depois do 403.
  const handlers = [
    "action === 'amizades'",
    "action === 'amizade-estado'",
    'AMIZADE_WRITE.includes(action)',
  ];
  for (const h of handlers) {
    const i = APICOM.indexOf(h);
    assert.ok(i > 0, 'handler sumiu: ' + h);
    assert.ok(i > gate, h + ' é atendido ANTES do portão Full/Master — free entraria');
  }
  // E o 401 de login vem antes de tudo (inclusive do 403)
  assert.ok(APICOM.indexOf('login: true') < gate, 'o gate de login saiu de ordem');
});

test('PORTÃO: as escritas de amizade entram na lista WRITE (ban + perfil)', () => {
  assert.match(APICOM, /const AMIZADE_WRITE = \[[^\]]*'amizade-pedir'[^\]]*'amizade-aceitar'[^\]]*'amizade-recusar'[^\]]*'amizade-cancelar'[^\]]*'amizade-desfazer'[^\]]*\]/);
  assert.match(APICOM, /const WRITE = \[[^\]]*\.\.\.AMIZADE_WRITE\]/,
    'AMIZADE_WRITE ficou de fora do WRITE → sem checkBan e sem exigir POST');
  const gateBan = APICOM.indexOf('checkBan(userId, SU, H)');
  const handler = APICOM.indexOf('AMIZADE_WRITE.includes(action)');
  assert.ok(gateBan > 0 && handler > gateBan, 'o handler de amizade roda antes do checkBan');
});

test('PORTÃO: o alvo é resolvido por display_name — nenhum uuid vaza pro front', () => {
  assert.match(APICOM, /acharPorNome\(b\.name\)/, 'a ação de amizade aceita id cru do cliente');
  // author_id continua exclusivo do moderador (contrato antigo intacto)
  assert.match(APICOM, /author_id: isMod \? p\.user_id : undefined/);
  assert.match(APICOM, /author_id: isMod \? c\.user_id : undefined/);
  // e o que sai no lugar é só o perfil público
  assert.match(APICOM, /const pubPerfil =/);
});

test('a notificação é gravada com AWAIT (serverless descarta promise solta)', () => {
  const bloco = APICOM.slice(APICOM.indexOf('const notificarAmizade'), APICOM.indexOf('const aplicarDecisao'));
  assert.match(bloco, /await fetch\(`\$\{SU\}\/rest\/v1\/blue_notificacoes`/,
    'insert de notificação sem await = 0 notificações em produção (bug dos 28 follows)');
  assert.match(bloco, /await sendPushToUser\(/, 'push mobile sem await tem o mesmo destino');
  assert.match(bloco, /deveNotificar\(/, 'sem dedupe o loop pedir/cancelar vira spam de sino');
});

test('o PATCH tem guarda de corrida (status lido) e retenta uma vez', () => {
  assert.match(APICOM, /status=eq\.\$\{statusLido\}/,
    'PATCH sem guarda: dois cliques simultâneos sobrescrevem um ao outro');
  assert.match(APICOM, /tentativa < 2/, 'sem retentativa, a corrida vira erro pro usuário');
});

// ═══════════════════════════════════════════════════════════════════════════
// FRONT — escape, ?v= no src e portão espelhado
// ═══════════════════════════════════════════════════════════════════════════

const FRONT = ler('public/comunidade-amigos.js');
const HTML = ler('public/comunidade.html');
const COMUN = ler('public/comunidade.js');

test('FRONT: script novo entra com ?v= (senão o CDN serve a versão velha)', () => {
  assert.match(HTML, /<script src="\/comunidade-amigos\.js\?v=\d+[a-z]*"><\/script>/,
    'comunidade-amigos.js sem ?v= no src');
  // e o comunidade.js, que mudou, teve o v bumpado junto
  const v = /comunidade\.js\?v=(\d+)/.exec(HTML);
  assert.ok(v && Number(v[1]) >= 9, 'comunidade.js mudou mas o ?v= não subiu (ficaria cache velho)');
});

// ── O módulo do front, RODANDO de verdade num DOM de mentira ───────────────
// Vale muito mais que grep: o HTML abaixo é o que o navegador receberia.
function carregarFront({ paying = true, is_moderator = false } = {}) {
  const win = {
    URLSearchParams, setTimeout, clearTimeout, console,
    setInterval: () => 0, clearInterval: () => {},
    location: { search: '' },
    confirm: () => true,
    ComunidadeBT: {
      me: () => ({ paying, is_moderator, profile: { display_name: 'eu' } }),
      call: async () => ({ ok: true, status: 200, d: {} }),
      toast: () => {},
    },
  };
  win.window = win;
  win.document = {
    readyState: 'complete',
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
    createElement: () => ({ style: {}, setAttribute: () => {}, appendChild: () => {} }),
    body: { appendChild: () => {} },
    head: { appendChild: () => {} },
  };
  vm.runInContext(FRONT, vm.createContext(win), { filename: 'comunidade-amigos.js' });
  return win.ComunidadeAmigos;
}

const VENENO = '"><img src=x onerror=alert(1)><script>alert(2)</script>';

test('FRONT: nome malicioso de outro usuário NÃO vira HTML (execução real)', () => {
  const CA = carregarFront();
  assert.ok(CA && typeof CA.botao === 'function', 'o módulo não expôs botao()');
  for (const estado of ['nenhum', 'amigos', 'pendente_enviado', 'pendente_recebido']) {
    const html = CA.botao({
      name: VENENO, mine: false,
      amizade: { estado, pode_pedir: estado === 'nenhum', bloqueado: false, dias_espera: 0 },
    });
    assert.ok(html, 'estado ' + estado + ' não renderizou botão');
    assert.equal(html.includes('<img'), false, estado + ': tag do atacante entrou no markup');
    assert.equal(html.includes('<script'), false, estado + ': <script> do atacante entrou no markup');
    // O nome vai DENTRO de um atributo entre aspas duplas: a aspa tem que sair
    // escapada, senão ele fecha o atributo e injeta o que quiser depois dela.
    const attr = /data-cba-name="([^"]*)"/.exec(html);
    assert.ok(attr, estado + ': o data-cba-name não fechou direito (aspa vazou)');
    assert.equal(/["<>]/.test(attr[1]), false,
      estado + ': sobrou aspa/sinal de tag CRU dentro do atributo → escapa do atributo');
    // Round-trip: escapou sem perder nem inventar caractere
    const decodificado = attr[1]
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
    assert.equal(decodificado, VENENO, estado + ': o escape corrompeu o nome');
    // Fora do atributo só existe markup nosso — nada do payload
    const foraDoAtributo = html.replace(/data-cba-name="[^"]*"/, '');
    assert.equal(/&lt;|&quot;/.test(foraDoAtributo), false,
      estado + ': o nome do usuário aparece fora do atributo (rótulo deveria ser texto fixo)');
  }
});

test('FRONT: pílula reflete o estado certo e some quando não deve aparecer', () => {
  const CA = carregarFront();
  const p = (estado, extra) => CA.botao({ name: 'ana', mine: false, amizade: { estado, pode_pedir: estado === 'nenhum', bloqueado: false, dias_espera: 0, ...extra } });
  assert.match(p('amigos'), /cba-amigos/);
  assert.match(p('pendente_enviado'), /data-cba-act="cancelar"/, 'pendente enviado deveria oferecer cancelar');
  assert.match(p('pendente_recebido'), /data-cba-act="aceitar"/, 'pedido recebido deveria oferecer aceitar');
  assert.match(p('nenhum'), /data-cba-act="pedir"/);
  // meu próprio post: nunca
  assert.equal(CA.botao({ name: 'ana', mine: true, amizade: { estado: 'nenhum', pode_pedir: true } }), '');
  // em carência: mostra o prazo, sem botão clicável
  const espera = p('nenhum', { pode_pedir: false, dias_espera: 5 });
  assert.equal(/data-cba-act/.test(espera), false, 'ofereceu um botão que o backend recusaria com 429');
  assert.match(espera, /5d/);
  // bloqueado de vez: não mostra nada
  assert.equal(p('nenhum', { pode_pedir: false, bloqueado: true }), '');
});

test('FRONT: usuário FREE não recebe botão de amizade nenhum', () => {
  const CA = carregarFront({ paying: false, is_moderator: false });
  assert.equal(CA.botao({ name: 'ana', mine: false, amizade: { estado: 'nenhum', pode_pedir: true } }), '',
    'o portão Full/Master não é espelhado no front');
});

test('FRONT: o esc() do arquivo cobre os cinco caracteres perigosos', () => {
  for (const par of ['&amp;', '&lt;', '&gt;', '&quot;', '&#39;']) {
    assert.ok(FRONT.includes(par), 'o esc() não cobre ' + par);
  }
  // e nenhum dado de usuário é concatenado cru no markup
  assert.equal(/'\s*\+\s*(nome|u\.name|it\.user\.name|u\.avatar)\s*\+\s*'/.test(FRONT), false,
    'dado de usuário concatenado sem esc() em comunidade-amigos.js');
});

test('FRONT: nenhuma ação usa onclick inline com dado de usuário dentro', () => {
  // onclick com nome dentro é o caminho mais curto pra injeção via aspas
  assert.equal(/onclick="[^"]*\+\s*(nome|u\.name)/.test(FRONT), false, 'onclick inline com nome de usuário');
  assert.match(FRONT, /data-cba-name="' \+ esc\(/, 'os cliques deveriam ir por data-attribute + delegação');
  assert.match(FRONT, /addEventListener\('click'/, 'sem delegação de clique');
});

test('FRONT: o portão Full/Master é espelhado (botão e painel somem pro free)', () => {
  assert.match(FRONT, /function liberado\(\)[^}]*paying[^}]*is_moderator/, 'o front não checa plano');
  assert.match(FRONT, /if \(!p \|\| p\.mine \|\| !liberado\(\)\) return ''/,
    'o botão de amizade aparece sem checar o portão (ou aparece no próprio post)');
  assert.match(FRONT, /if \(!liberado\(\)\) return toast/, 'o painel abre pra quem não é assinante');
});

test('FRONT: o botão de amizade nunca aparece no próprio post', () => {
  assert.match(COMUN, /p\.mine \|\| !window\.ComunidadeAmigos/,
    'comunidade.js renderiza o botão de amizade no post do próprio usuário');
});

test('FRONT: sem o comunidade-amigos.js o feed continua de pé', () => {
  assert.match(COMUN, /function amigoBtn\(p\) \{[\s\S]*?try \{[\s\S]*?catch \(e\) \{ return ''; \}/,
    'uma exceção no módulo de amizade derrubaria o render do feed inteiro');
});

test('FRONT: o badge de amigos não é zerado pelo contador das abas', () => {
  assert.match(COMUN, /querySelectorAll\('\.cbt-nbadge\[data-nb\]'\)/,
    'updateBadges varre TODOS os .cbt-nbadge e apagaria o badge de pedidos recebidos');
});

test('FRONT: o editProfile() inexistente não é mais chamado (ReferenceError morto)', () => {
  assert.equal(/return editProfile\(\)/.test(COMUN), false,
    'comunidade.js ainda chama editProfile(), função que não existe no arquivo');
  assert.match(COMUN, /needs_profile\) return toast\(/, 'o 428 voltou a ficar sem feedback nenhum');
});

// ═══════════════════════════════════════════════════════════════════════════
// O ESTILO NÃO PODE DEPENDER DO PAINEL
// Visto na tela (11/08): a pílula "+ Amigo" saiu no cabeçalho do post como uma
// caixa branca crua. O CSS morava dentro do montar(), que só roda quando a
// pessoa ABRE o painel de amigos — mas a pílula é pintada no feed no load.
// ═══════════════════════════════════════════════════════════════════════════
const AMIGOSJS = readFileSync(new URL('../../public/comunidade-amigos.js', import.meta.url), 'utf8');

test('ESTILO: a injeção do CSS é função própria, não parte do montar()', () => {
  assert.match(AMIGOSJS, /function garantirEstilo\(\)/,
    'o CSS voltou pra dentro do montar() — a pílula nasce sem estilo de novo');
  assert.match(AMIGOSJS, /if \(document\.getElementById\('cbaStyle'\)\) return;/,
    'sem a guarda, abrir o painel várias vezes empilha <style> repetido');
});

test('ESTILO: o CSS entra no arranque do módulo, antes de qualquer pílula', () => {
  // A chamada solta (fora de função) tem que existir: é ela que garante estilo
  // pra quem só passa pelo feed e nunca abre o painel.
  const i = AMIGOSJS.indexOf('window.ComunidadeAmigos = {');
  assert.notEqual(i, -1);
  assert.match(AMIGOSJS.slice(Math.max(0, i - 400), i), /\n\s*garantirEstilo\(\);/,
    'ninguém garante o estilo no load — quem só lê o feed vê a caixa crua');
});

test('ESTILO: o montar() continua garantindo (o painel também precisa)', () => {
  const i = AMIGOSJS.indexOf('function montar()');
  assert.match(AMIGOSJS.slice(i, i + 160), /garantirEstilo\(\)/);
});

test('ESTILO: a regra da pílula tem cor e forma, não só posição', () => {
  assert.match(AMIGOSJS, /\.cba-btn\{[^}]*border-radius:100px/);
  assert.match(AMIGOSJS, /color:#00c4ff/, 'a pílula perdeu a cor — voltaria a parecer caixa branca');
});

test('ESTILO: o ?v= subiu junto (cache de 4h da Vercel)', () => {
  const m = HTML.match(/comunidade-amigos\.js\?v=(\d+)/);
  assert.ok(m, 'sem ?v=');
  assert.ok(Number(m[1]) >= 3, 'o arquivo mudou e o ?v= não subiu — o conserto não chega em quem já visitou');
});

// ═══════════════════════════════════════════════════════════════════════════
// PERFIL — o lugar onde a amizade pode acontecer
// Nasceu da dor relatada: "não tem nada nos usuários pra adicionar". Só dava
// pra pedir amizade a quem tivesse post visível no feed naquele instante.
// ═══════════════════════════════════════════════════════════════════════════
const PERFILJS = readFileSync(new URL('../../public/comunidade-perfil.js', import.meta.url), 'utf8');
const COMJS = readFileSync(new URL('../../public/comunidade.js', import.meta.url), 'utf8');
const API = readFileSync(new URL('../../api/community.js', import.meta.url), 'utf8');

test('PERFIL: nome E foto abrem o perfil (no celular o dedo acerta a foto)', () => {
  assert.match(COMJS, /class="cbt-pname" data-cbp-name=/, 'o nome do post não abre perfil');
  assert.match(COMJS, /class="cbt-cname" data-cbp-name=/, 'o nome no comentário não abre perfil');
  assert.match(COMJS, /class="cbt-avwrap" data-cbp-name=/, 'a foto não abre perfil');
});

test('PERFIL: o nome escapado NUNCA entra em atributo executável', () => {
  // data-* é inerte; onclick com nome de outra pessoa dentro seria injeção.
  assert.equal(/onclick="[^"]*\$\{esc\(a\.name\)/.test(COMJS), false,
    'nome de usuário foi parar dentro de um onclick');
  assert.match(COMJS, /data-cbp-name="\$\{esc\(a\.name\)\}"/, 'o nome tem que ir escapado');
});

test('PERFIL: o CSS entra no arranque, não ao abrir (a lição da pílula)', () => {
  assert.match(PERFILJS, /function garantirEstilo\(\)/);
  const i = PERFILJS.indexOf('window.ComunidadePerfil = {');
  assert.match(PERFILJS.slice(Math.max(0, i - 400), i), /\n\s*garantirEstilo\(\);/,
    'o estilo voltou a depender de alguém abrir o painel');
});

test('PERFIL: erro é estado próprio, com motivo e retentativa', () => {
  assert.match(PERFILJS, /S\.erro = r\.status === 404/, 'todo erro virou a mesma mensagem');
  assert.match(PERFILJS, /data-cbp-act="retentar"/, 'sem retentativa, um blip vira beco sem saída');
  assert.equal(/Carregando…'\s*;\s*return;\s*}\s*$/m.test(PERFILJS), false);
});

test('PERFIL: contagem desconhecida NÃO vira 0 na tela', () => {
  assert.match(PERFILJS, /typeof d\.posts === 'number'\) \? String\(d\.posts\) : '—'/,
    'posts null viraria 0 — afirmar "nenhum post" sem ter medido é o defeito que já pegamos duas vezes');
});

test('PERFIL (API): banido não tem perfil acessível pra quem não é moderador', () => {
  const i = API.indexOf("if (action === 'perfil')");
  assert.notEqual(i, -1, 'a ação perfil sumiu');
  const bloco = API.slice(i, i + 1200);
  assert.match(bloco, /alvo\.banned && !isMod/,
    'o feed esconde os posts do banido, mas o perfil seria a porta dos fundos');
});

test('PERFIL (API): o uuid do alvo não vaza — a busca é por display_name', () => {
  const i = API.indexOf("if (action === 'perfil')");
  const bloco = API.slice(i, i + 1800);
  assert.match(bloco, /acharPorNome\(q\.name \|\| b\.name\)/);
  assert.equal(/user_id: alvo\.user_id|author_id: alvo/.test(bloco), false,
    'o perfil passou a devolver uuid de usuário pra tela');
});

test('PERFIL (API): enfeite que falha não derruba a identidade', () => {
  const i = API.indexOf("if (action === 'perfil')");
  const bloco = API.slice(i, i + 2200);
  // desde/posts são try/catch próprios: uma consulta ruim não pode zerar o perfil.
  assert.match(bloco, /let desde = null;/);
  assert.match(bloco, /let posts = null;/);
  assert.match(bloco, /catch \(e\) \{\}/);
});

test('PERFIL: as versões subiram (cache de 4h)', () => {
  assert.match(HTML, /comunidade-perfil\.js\?v=\d+/, 'o perfil entrou sem ?v=');
  const c = /comunidade\.js\?v=(\d+)/.exec(HTML);
  assert.ok(c && Number(c[1]) >= 10, 'o comunidade.js mudou (nomes clicáveis) e o ?v= não subiu');
  const am = /comunidade-amigos\.js\?v=(\d+)/.exec(HTML);
  assert.ok(am && Number(am[1]) >= 4, 'o de amigos não subiu junto');
});
