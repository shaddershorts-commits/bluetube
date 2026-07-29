// tests/unit/blublu_roteiro_voz.test.mjs — node --test
//
// A VOZ do Blublu no chat de ajuste. O que este arquivo protege:
//  1. Ele soa como o Blublu do manifesto v3 (sem vocabulário corporativo,
//     sem coach motivacional, sem "Ficarei feliz em ajudar!").
//  2. A voz dele NÃO contamina o roteiro do usuário — separação que, se
//     quebrar, corrompe o trabalho de quem tá usando.
//  3. Toda variação de fala é varrida, não só a primeira.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FALAS, PROIBIDAS, falar, temPalavraProibida, JULGAMENTO, ANGULO, anguloDe,
} from '../../api/_helpers/blublu-roteiro-voz.js';
import { montarPrompt } from '../../api/roteiro-chat.js';

const TODAS = Object.entries(FALAS).flatMap(([sit, arr]) => arr.map((f) => [sit, f]));

test('TODA fala passa no vocabulário proibido do manifesto', () => {
  for (const [sit, f] of TODAS) {
    const achadas = temPalavraProibida(f);
    assert.equal(achadas.length, 0, `${sit}: "${f}" usa ${achadas.join(', ')}`);
  }
});

test('nenhuma fala é de assistente genérica', () => {
  const GENERICO = /\b(claro!|com certeza!|perfeito!|ótimo!|posso ajudar|à disposição|sinto muito)\b/i;
  for (const [sit, f] of TODAS) {
    assert.equal(GENERICO.test(f), false, `${sit}: "${f}" soa robô de atendimento`);
  }
});

test('toda recusa diz que o roteiro do usuário está a salvo ou o que fazer', () => {
  // O usuário precisa saber DUAS coisas: não perdeu nada, e qual o próximo passo.
  const RECUSAS = ['vazio', 'virou_conversa', 'instrucao_vazou', 'encolheu_demais', 'cresceu_demais', 'perdeu_numeros'];
  for (const sit of RECUSAS) {
    for (const f of FALAS[sit]) {
      const tranquiliza = /(intacto|não (encostei|troquei|mexi)|preservei|deixei como estava|mantive|barrei|não vale)/i.test(f);
      assert.ok(tranquiliza, `${sit}: "${f}" não deixa claro que o roteiro está a salvo`);
    }
  }
});

test('toda falha de infra deixa claro que não foi culpa do usuário', () => {
  for (const cod of ['IA-AUTH', 'IA-CREDITO', 'IA-FILA', 'IA-TIMEOUT', 'GERAL']) {
    for (const f of FALAS[cod]) {
      assert.ok(/(meu lado|não é você|aqui do lado|tô com|minha conexão|demorei)/i.test(f),
        `${cod}: "${f}" joga a culpa no usuário`);
      assert.ok(/(intacto|salvo|não foi (tocado|alterado)|tá igual|não encostei)/i.test(f),
        `${cod}: "${f}" não tranquiliza sobre o roteiro`);
    }
  }
});

test('falar() varia entre as opções e nunca estoura o índice', () => {
  const vistas = new Set();
  for (let g = 0; g < 40; g++) vistas.add(falar('aplicado', g));
  assert.equal(vistas.size, FALAS.aplicado.length, 'não varreu todas as variações');
  // entradas esquisitas não quebram
  for (const g of [-7, 0, NaN, undefined, 1e9]) {
    assert.equal(typeof falar('aplicado', g), 'string');
  }
});

test('situação desconhecida cai no GERAL em vez de devolver undefined', () => {
  assert.equal(falar('coisa_que_nao_existe', 3), FALAS.GERAL[0]);
});

// ════════════════════════════════════════════════════════════════════════════
// A SEPARAÇÃO: voz no chat, NUNCA no roteiro
// ════════════════════════════════════════════════════════════════════════════

test('o prompt de edição NÃO carrega a voz do Blublu', () => {
  const { system } = montarPrompt({ roteiro: 'x'.repeat(50), instrucao: 'encurta', lang: 'Português (Brasil)', versao: 'V1' });
  // marcas da personalidade que corromperiam o roteiro do usuário
  for (const marca of ['Blublu', 'Deadpool', 'Marçal', 'caralho', 'quarta parede', 'mentor']) {
    assert.equal(system.includes(marca), false, `voz vazou pro prompt de edição: "${marca}"`);
  }
});

test('mas o prompt CARREGA o julgamento editorial', () => {
  const { system } = montarPrompt({ roteiro: 'x'.repeat(50), instrucao: 'encurta', lang: 'Português (Brasil)', versao: 'V1' });
  assert.ok(system.includes('3 segundos'), 'perdeu a regra do gancho');
  assert.ok(/Número e nome próprio/.test(system), 'perdeu a regra de credibilidade');
});

// ════════════════════════════════════════════════════════════════════════════
// ÂNGULO POR ABA — o defeito medido na auditoria de 29/07
// ════════════════════════════════════════════════════════════════════════════

test('cada aba manda a sua regra pro prompt', () => {
  const casual = montarPrompt({ roteiro: 'x'.repeat(50), instrucao: 'e', lang: 'pt', versao: 'V1' }).system;
  const apel = montarPrompt({ roteiro: 'x'.repeat(50), instrucao: 'e', lang: 'pt', versao: 'V2' }).system;
  const trad = montarPrompt({ roteiro: 'x'.repeat(50), instrucao: 'e', lang: 'pt', versao: 'V3' }).system;

  assert.ok(/CASUAL/.test(casual) && !/APELATIVA|TRADUÇÃO FIEL/.test(casual));
  assert.ok(/APELATIVA/.test(apel) && !/TRADUÇÃO FIEL/.test(apel));
  assert.ok(/TRADUÇÃO FIEL/.test(trad));
});

test('a aba Tradução leva as garantias que ela vende (fidelidade, moeda, idioma)', () => {
  const { system } = montarPrompt({ roteiro: 'x'.repeat(50), instrucao: 'encurta', lang: 'English', versao: 'V3' });
  assert.ok(/fidelidade/i.test(system), 'sem regra de fidelidade');
  assert.ok(/monetários|moeda/i.test(system), 'sem regra de valores — o V3 converte moeda');
  assert.ok(/idioma em que o texto já está/i.test(system), 'sem trava de idioma');
  assert.ok(/Nomes próprios/i.test(system), 'sem trava de nome próprio');
});

test('versão desconhecida não fica sem ângulo (cai no Casual)', () => {
  assert.equal(anguloDe('V9'), ANGULO.V1);
  assert.equal(anguloDe(undefined), ANGULO.V1);
});

test('o julgamento editorial não usa vocabulário proibido', () => {
  assert.deepEqual(temPalavraProibida(JULGAMENTO), []);
  for (const a of Object.values(ANGULO)) assert.deepEqual(temPalavraProibida(a), []);
});

test('a lista de proibidas cobre os campeões do manifesto', () => {
  for (const p of ['disruptivo', 'engajamento', 'performance', 'agregar valor']) {
    assert.ok(PROIBIDAS.includes(p), 'faltou na lista: ' + p);
  }
});
