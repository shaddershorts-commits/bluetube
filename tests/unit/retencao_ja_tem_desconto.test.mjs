// tests/unit/retencao_ja_tem_desconto.test.mjs — node --test
//
// FURO ACHADO PELO DONO (04/08): a tela de cancelamento oferecia "50% de
// desconto permanente" pra QUEM JÁ PAGAVA METADE (cupom de afiliado). O front
// lia só o bt_plan do localStorage e nunca perguntava se a pessoa já tinha
// desconto. Além de absurdo, faz a oferta inteira parecer mentira.
//
// A mensagem certa pra esse caso é o INVERSO: cancelar significa PERDER o
// desconto — voltar custa o preço cheio.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const API = readFileSync(new URL('../../api/retencao-50.js', import.meta.url), 'utf8');
const FRONT = readFileSync(new URL('../../public/retencao.js', import.meta.url), 'utf8');

test('existe consulta somente-leitura do estado do desconto', () => {
  assert.match(API, /action.*===.*'status'/, 'precisa de uma consulta que não aplica nada');
  assert.match(API, /soConsulta/, 'a consulta precisa ser distinguível do POST que aplica');
  const bloco = API.slice(API.indexOf('if (soConsulta)'), API.indexOf('if (jaTem)'));
  assert.match(bloco, /ja_tem_desconto/, 'tem que dizer se a pessoa já tem desconto');
  assert.match(bloco, /valor_cheio/, 'e quanto custaria sem ele');
});

test('a consulta NÃO aplica cupom nem altera assinatura', () => {
  const i = API.indexOf('if (soConsulta)');
  const j = API.indexOf('if (jaTem)', i);
  const bloco = API.slice(i, j);
  assert.doesNotMatch(bloco, /method: 'POST'/, 'consulta não pode escrever na Stripe');
  assert.doesNotMatch(bloco, /coupon/, 'consulta não pode mexer em cupom');
  assert.doesNotMatch(bloco, /PATCH/, 'consulta não pode alterar o subscriber');
});

test('GET só passa quando é a consulta de status', () => {
  const bloco = API.slice(API.indexOf('const soConsulta'), API.indexOf('const { SU, SK'));
  assert.match(bloco, /req\.method !== 'POST' && !soConsulta/,
    'GET sem action=status tem que continuar bloqueado');
});

test('o front pergunta antes de decidir qual tela mostrar', () => {
  assert.match(FRONT, /action=status/, 'precisa consultar o servidor');
  assert.match(FRONT, /ja_tem_desconto/, 'e usar a resposta');
  assert.match(FRONT, /montarPerda\(d\)/, 'quem já tem desconto vê a tela de perda');
});

test('a tela de perda mostra os DOIS valores: o de hoje e o de voltar', () => {
  const i = FRONT.indexOf('function montarPerda');
  const bloco = FRONT.slice(i, FRONT.indexOf('function montarOferta'));
  assert.ok(i > 0, 'montarPerda não existe');
  assert.match(bloco, /valor_atual/, 'precisa mostrar o preço atual');
  assert.match(bloco, /valor_cheio/, 'e o preço cheio de quem volta');
  assert.match(bloco, /SEU PREÇO HOJE/, 'comparação tem que ser explícita');
});

test('a tela de perda NÃO oferece desconto de novo', () => {
  const i = FRONT.indexOf('function montarPerda');
  const bloco = FRONT.slice(i, FRONT.indexOf('function montarOferta'));
  assert.doesNotMatch(bloco, /acceptDiscount/,
    'aplicar desconto em quem já tem não faz sentido — e o backend recusaria');
  assert.doesNotMatch(bloco, /50% de desconto/,
    'oferecer o que a pessoa já tem é o bug que estamos consertando');
});

test('falha na consulta não deixa a tela vazia', () => {
  const i = FRONT.indexOf('window.confirmCancelStep2 = function');
  const bloco = FRONT.slice(i, i + 1200);
  assert.match(bloco, /montarOferta\(\);/, 'desenha a oferta na hora, sem esperar a rede');
  assert.match(bloco, /\.catch\(function \(\) \{\}\)/, 'erro de rede mantém o fluxo normal');
});

test('o backend continua se recusando a empilhar desconto', () => {
  // idempotência: quem já tem 50% forever não recebe outro
  assert.match(API, /const jaTem = s\.d\.discount\?\.coupon\?\.percent_off >= 50/,
    'a checagem de desconto existente é o que impede empilhar');
  assert.match(API, /ja_tinha: true/, 'e responde sem aplicar de novo');
});
