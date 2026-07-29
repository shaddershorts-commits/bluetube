// tests/unit/roteiro_intencao.test.mjs — node --test
//
// O DISCERNIMENTO. Saber quando não agir é o que separa a criança do
// pré-adolescente: não é saber mais, é errar menos por impulso.
//
// O risco desta peça é o FALSO POSITIVO: classificar ordem legítima como
// pergunta faz o Blublu responder em vez de editar, e o usuário fica sem o
// ajuste. Por isso a regra de ouro é "na dúvida, ordem".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classificar, respostaPronta, montarHistorico, RESPOSTA_VAGO, RESPOSTA_FORA_ESCOPO,
} from '../../api/_helpers/roteiro-intencao.js';
import { temPalavraProibida } from '../../api/_helpers/blublu-roteiro-voz.js';

const cl = (s) => classificar(s);

// ── ORDEM: o caminho principal, não pode ser roubado por outra classe ───────
test('ordens de edição continuam sendo ordens', () => {
  const ordens = [
    'deixa mais curto', 'encurta', 'ENCURTA O FINAL', 'corta o final',
    'troca ponte por passarela', 'troca a palavra ponte por passarela',
    'adiciona mais tensão', 'deixa mais apelativo', 'muda o tom',
    'tira os números', 'começa com uma pergunta', 'inverte a ordem',
    'deixa mais longo e mais detalhado', 'reescreve o gancho',
    'simplifica a linguagem', 'ajeita o português', 'traduz pro inglês',
    'poe o nome dela no começo', 'resume em 3 frases',
  ];
  for (const o of ordens) assert.equal(cl(o), 'ordem', `virou ${cl(o)}: "${o}"`);
});

test('ordem com "?" no fim ainda é ordem (verbo tem precedência)', () => {
  // "corta o final?" é pedido educado, não pergunta de opinião
  assert.equal(cl('corta o final?'), 'ordem');
  assert.equal(cl('da pra encurtar?'), 'ordem');
  assert.equal(cl('tem como deixar mais curto?'), 'ordem');
});

test('reclamação COM direção é ordem, não vago', () => {
  assert.equal(cl('não gostei do final, corta ele'), 'ordem');
  assert.equal(cl('ficou ruim o começo, deixa mais forte'), 'ordem');
});

// ── PERGUNTA ────────────────────────────────────────────────────────────────
test('perguntas de opinião são reconhecidas', () => {
  const perguntas = [
    'esse roteiro tá bom pra tiktok?',
    'ficou bom?',
    'o que você acha?',
    'por que o gancho é importante?',
    'qual a melhor parte disso aqui?',
    'vale a pena postar assim?',
    'acha que prende a atenção?',
    'como isso funciona no youtube?',
  ];
  for (const p of perguntas) assert.equal(cl(p), 'pergunta', `virou ${cl(p)}: "${p}"`);
});

// ── VAGO: sem direção ───────────────────────────────────────────────────────
test('reclamação e saudação sem direção viram vago', () => {
  for (const v of ['não gostei', 'nao gostei', 'ruim', 'péssimo', 'não', 'oi', 'olá',
                   'blz', 'teste', 'hummm', 'ok', 'nada a ver']) {
    assert.equal(cl(v), 'vago', `virou ${cl(v)}: "${v}"`);
  }
});

test('mensagem vazia é vago, não explode', () => {
  for (const v of ['', '   ', null, undefined]) assert.equal(cl(v), 'vago');
});

// ── FORA DE ESCOPO ──────────────────────────────────────────────────────────
test('pedido de roteiro NOVO é fora de escopo (o caso real do "gatos")', () => {
  const fora = [
    'esquece esse roteiro, escreve um totalmente novo sobre gatos',
    'escreve um roteiro novo sobre futebol',
    'quero outro roteiro',
    'faz do zero',
    'apaga tudo e começa de novo',
    'muda o tema',
  ];
  for (const f of fora) assert.equal(cl(f), 'fora_escopo', `virou ${cl(f)}: "${f}"`);
});

test('"reescreve o gancho" NÃO é fora de escopo — é ajuste legítimo', () => {
  assert.equal(cl('reescreve o gancho'), 'ordem');
  assert.equal(cl('refaz a última frase'), 'ordem');
});

// ── RESPOSTAS PRONTAS (sem gastar IA) ───────────────────────────────────────
test('vago e fora_escopo têm resposta pronta; ordem e pergunta não', () => {
  assert.ok(respostaPronta('vago', 0));
  assert.ok(respostaPronta('fora_escopo', 0));
  assert.equal(respostaPronta('ordem', 0), null, 'ordem não pode ter atalho — tem que ir pra IA');
  assert.equal(respostaPronta('pergunta', 0), null, 'pergunta não pode ter atalho — tem que ir pra IA');
});

test('as respostas prontas varrem todas as variações e respeitam o manifesto', () => {
  for (const lista of [RESPOSTA_VAGO, RESPOSTA_FORA_ESCOPO]) {
    for (const r of lista) {
      assert.deepEqual(temPalavraProibida(r), [], 'vocabulário proibido em: ' + r);
      assert.ok(r.length > 30, 'resposta curta demais pra ajudar: ' + r);
    }
  }
  const vistas = new Set();
  for (let g = 0; g < 30; g++) vistas.add(respostaPronta('vago', g));
  assert.equal(vistas.size, RESPOSTA_VAGO.length);
});

test('o fora de escopo aponta o caminho certo (Gerar do Zero)', () => {
  for (const r of RESPOSTA_FORA_ESCOPO) {
    assert.ok(/Gerar do Zero/i.test(r), 'não indica pra onde ir: ' + r);
  }
});

// ── MEMÓRIA (F2) ────────────────────────────────────────────────────────────
test('o histórico vira texto que a IA entende', () => {
  const h = montarHistorico([
    { quem: 'user', texto: 'deixa mais curto' },
    { quem: 'blublu', texto: 'Feito. Dá uma lida.' },
    { quem: 'user', texto: 'mais ainda' },
  ]);
  assert.match(h, /USUÁRIO: deixa mais curto/);
  assert.match(h, /VOCÊ: Feito/);
  assert.match(h, /mais ainda/);
  assert.match(h, /mais ainda"\)|referências/, 'não explica pra IA pra que serve');
});

test('histórico vazio não polui o prompt', () => {
  for (const h of [[], null, undefined, [{}], [{ quem: 'user' }]]) {
    assert.equal(montarHistorico(h), '', JSON.stringify(h));
  }
});

test('histórico é limitado e cada fala é cortada', () => {
  const muitas = Array.from({ length: 40 }, (_, i) => ({ quem: 'user', texto: 'x'.repeat(1000) + i }));
  const h = montarHistorico(muitas, 6);
  assert.equal((h.match(/USUÁRIO:/g) || []).length, 6, 'não limitou as trocas');
  assert.ok(h.length < 2500, 'prompt inflou: ' + h.length);
});

test('histórico corrompido não derruba', () => {
  assert.doesNotThrow(() => montarHistorico(['string solta', 42, null, { texto: null }]));
});

// ── ELOGIO e DESFAZER — reportados pelo user em 29/07 ───────────────────────
test('elogio no fim da conversa NÃO vira reescrita (caso "parabéns")', () => {
  const elogios = ['parabéns', 'parabens!', 'mandou bem', 'ficou ótimo', 'muito bom',
                   'arrasou', 'adorei', 'show de bola', 'perfeito', 'valeu!', 'obrigado'];
  for (const e of elogios) assert.equal(cl(e), 'elogio', `virou ${cl(e)}: "${e}"`);
});

test('elogio tem resposta pronta e não gasta IA', () => {
  const r = respostaPronta('elogio', 0);
  assert.ok(r && r.length > 20, 'sem resposta pro elogio');
  assert.deepEqual(temPalavraProibida(r), []);
});

test('"volta pro original" é DESFAZER, não ordem de edição', () => {
  const voltas = ['volta pro original', 'volta ao original', 'volta pra versão anterior',
                  'desfaz', 'desfazer', 'volta', 'cancela isso', 'volta como estava',
                  'quero o original', 'reverte'];
  for (const v of voltas) assert.equal(cl(v), 'desfazer', `virou ${cl(v)}: "${v}"`);
});

test('desfazer NÃO rouba ordens que só parecem ("volta o nome pro começo")', () => {
  assert.equal(cl('volta o nome dela pro começo do roteiro'), 'ordem');
  assert.equal(cl('cancela a pergunta do final e poe uma afirmação'), 'ordem');
});

test('elogio e desfazer não roubam ordem legítima', () => {
  assert.equal(cl('ficou ótimo mas encurta o final'), 'ordem');
  assert.equal(cl('parabéns, agora deixa mais curto'), 'ordem');
});
