// tests/unit/blublu_sigla_e_casa.test.mjs — node --test
//
// Nasceu da análise das conversas reais do chat do Blublu na Virais (7 dias:
// 31 mensagens, 30 buscas, 6 SEM RESULTADO — 20%). Duas coisas saíram de lá:
//
// 1. SIGLA sumia. "GTA" e "GTA IV" apareceram na lista de demanda NÃO atendida
//    com o acervo cheio de games. Causa: o piso de 4 letras do filtro de termos
//    (escrito pra barrar fragmento ambíguo tipo "ney") derrubava junto toda
//    sigla de 3 letras. Sem termo válido, a busca por título nem chega a rodar.
//    Isso é a regra do dono — precisão E DEPOIS muita quantidade — falhando no
//    primeiro degrau: sem recall não existe volume nenhum pra entregar.
//
// 2. O PLANO era buscado do banco e jogado fora, então o Blublu não sabia com
//    quem falava. Inofensivo enquanto a lista dele só tinha ferramenta Full;
//    virou bug no instante em que entrou o BlueClean, que é Master e responde
//    403 pro Full.
//
// Trava também o que NÃO pode ser prometido: editor de vídeo e geração por IA
// não estão no ar (a página do BlueEditor é lista de espera). Mandar assinante
// procurar tela inexistente é exatamente o defeito que já aconteceu antes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const FONTE = readFileSync(new URL('../../api/blublu-chat.js', import.meta.url), 'utf8');
// comentário explica, comentário não executa: os testes de comportamento olham
// só o código, senão um comentário bem escrito passa no lugar da regra.
const CODIGO = FONTE.replace(/^\s*\/\/.*$/gm, '');

// ═══ 1. A SIGLA VOLTA A BUSCAR ═══════════════════════════════════════════════

test('o filtro de termos deixa a sigla passar (era o piso cego de 4 letras)', () => {
  const linha = CODIGO.split('\n').find((l) => l.includes('let termosOk = termos.map(clean)'));
  assert.ok(linha, 'a linha do filtro de termos sumiu — reveja o teste junto com o código');
  assert.ok(
    linha.includes('ehSigla(t)'),
    'sem a saída pra sigla, "GTA"/"NBA"/"UFC" voltam a ser descartados em silêncio',
  );
});

test('a lista de siglas não aceita pedaço de palavra comum (precisão primeiro)', () => {
  const m = CODIGO.match(/const SIGLA_CONHECIDA = new Set\(\[([^\]]*)\]\)/);
  assert.ok(m, 'SIGLA_CONHECIDA sumiu');
  const siglas = m[1].split(',').map((x) => x.trim().replace(/'/g, '')).filter(Boolean);

  assert.ok(siglas.includes('gta'), 'GTA foi o caso medido na demanda não atendida');
  assert.ok(siglas.length >= 10, 'a lista ficou pequena demais pra valer a pena');

  // o match é ilike.*termo*, então sigla que vive DENTRO de palavra comum
  // envenena o resultado inteiro. Estas são as armadilhas reais em pt/en.
  for (const proibida of ['ted', 'cia', 'ia', 'ai', 'ar', 'as', 'com']) {
    assert.ok(
      !siglas.includes(proibida),
      `"${proibida}" casa dentro de palavra comum (wanted/polícia/família) e sujaria a busca`,
    );
  }
  for (const s of siglas) {
    assert.ok(s.length >= 3, `"${s}" tem menos de 3 letras — com ilike.*x* isso pesca qualquer coisa`);
  }
});

test('nenhuma sigla passa com menos de 3 letras, nem em CAIXA ALTA', () => {
  assert.ok(
    /x\.length >= 3 &&/.test(CODIGO),
    'o piso de 3 letras da sigla é o que impede "ia" de pescar "família"',
  );
  assert.ok(
    /\{2,5\}/.test(CODIGO),
    'a detecção de caixa alta precisa exigir 3+ maiúsculas seguidas',
  );
});

test('mensagem GRITADA não transforma tudo em sigla', () => {
  assert.ok(
    CODIGO.includes('soCaps'),
    'sem a guarda de mensagem toda em maiúscula, "QUERO VIDEOS DE NEY" liberaria "NEY"',
  );
  assert.ok(
    /soCaps \? new Set\(\)/.test(CODIGO),
    'quando a mensagem é toda gritada, a caixa alta deixa de ser sinal e some',
  );
});

test('o piso de 4 letras continua barrando fragmento minúsculo solto', () => {
  const linha = CODIGO.split('\n').find((l) => l.includes('let termosOk = termos.map(clean)'));
  assert.ok(
    linha.includes("t.length >= 4"),
    'a regra que protege a precisão não pode ter sido trocada pela exceção',
  );
});

// ═══ 2. ELE SABE COM QUEM ESTÁ FALANDO ═══════════════════════════════════════

test('o plano do assinante é guardado, não descartado', () => {
  assert.ok(CODIGO.includes('let userPlan = null;'), 'userPlan sumiu');
  assert.ok(
    /userId = u\.id; userPlan = sub\.plan;/.test(CODIGO),
    'o plano precisa ser capturado no mesmo ponto em que o acesso é liberado',
  );
});

test('o plano real entra no prompt (era hardcoded "Full ou Master")', () => {
  assert.ok(
    CODIGO.includes("${userPlan === 'master'"),
    'sem interpolar o plano, o Blublu volta a achar que todo mundo tem tudo',
  );
  assert.ok(
    !CODIGO.includes('é assinante (Full ou Master) — ele TEM acesso a tudo isso'),
    'a frase antiga afirma acesso total e é falsa pra ferramenta Master',
  );
});

// ═══ 3. SÓ ENSINA O QUE ESTÁ NO AR ═══════════════════════════════════════════

test('as ferramentas recomendadas existem como página de verdade', () => {
  // conferido em produção: todas devolvem página própria, com <title> próprio
  for (const rota of ['/baixaBlue', '/blueLens', '/blueVoice', '/blueScore', '/blueClean', '/comunidade']) {
    assert.ok(FONTE.includes(rota), `${rota} deveria estar na lista da casa`);
  }
});

test('BlueClean é anunciado como Master (ele responde 403 pro Full)', () => {
  const linha = FONTE.split('\n').find((l) => l.includes('/blueClean'));
  assert.ok(linha, 'BlueClean sumiu da lista');
  assert.ok(
    /\(Master\)/.test(linha),
    'sem a marca de Master, o Blublu manda assinante Full bater em 403',
  );
});

// ATUALIZADO 15/08 (lançamento): o BlueEditor SAIU da lista de espera e virou
// ferramenta recomendável (Master); só GERAÇÃO de vídeo por IA segue proibida.
test('BlueEditor LANÇADO na lista (Master) e geração por IA segue proibida', () => {
  assert.ok(
    /NÃO EXISTE AINDA/.test(FONTE),
    'a proibição do que não existe (geração por IA) precisa continuar escrita',
  );
  assert.ok(
    /GERAÇÃO de vídeo por IA/i.test(FONTE),
    'o que segue proibido é a GERAÇÃO de vídeo por IA — dito com todas as letras',
  );
  assert.ok(
    /• BlueEditor \(\/blueEditor\)/.test(FONTE) && /LANÇADO/.test(FONTE),
    'o BlueEditor lançado precisa estar na lista de ferramentas da casa',
  );
  assert.ok(
    /BlueEditor.*\(Master\)|\(Master\).*editor de vídeo/i.test(FONTE),
    'o Blublu precisa saber que o editor é EXCLUSIVO Master (Full não acessa)',
  );
  assert.ok(
    !/lista de espera/.test(FONTE),
    'não pode sobrar menção a lista de espera — o editor está no ar',
  );
});

test('a regra de nunca indicar ferramenta de fora sobreviveu', () => {
  assert.ok(
    FONTE.includes('JAMAIS recomende ferramenta de FORA'),
    'a regra de ouro do dono não pode ter sido empurrada pra fora na edição',
  );
});
