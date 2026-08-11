// tests/unit/blublu_suporte.test.mjs — node --test
//
// Agente "Como usar?" da Comunidade. O pedido do dono foi explícito: um Claude
// de verdade respondendo, com a personalidade do Blublu, treinado pra ENSINAR
// o BlueTube — nada de árvore de resposta pronta.
//
// Estes testes travam o que não pode regredir: o portão, o isolamento da chave
// do estúdio, a ausência de respostas canned, e a veracidade das rotas que ele
// ensina (ensinar um caminho que não existe é o pior defeito de um suporte).
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const handler = require('../../api/blublu-suporte.js');
const FONTE = readFileSync(new URL('../../api/blublu-suporte.js', import.meta.url), 'utf8');
const FRONT = readFileSync(new URL('../../public/blublu-suporte.js', import.meta.url), 'utf8');
const TOOLBAR = readFileSync(new URL('../../public/toolbar.js', import.meta.url), 'utf8');

// ═══ É UM CLAUDE DE VERDADE, NÃO UM MENU ═════════════════════════════════

test('não existe resposta pronta: quem responde é o modelo', () => {
  assert.match(FONTE, /api\.anthropic\.com\/v1\/messages/, 'tem que chamar a API');
  // sinais de árvore de decisão / respostas canned
  assert.doesNotMatch(FONTE, /const RESPOSTAS\s*=|const FAQ\s*=|respostasProntas/,
    'dicionário de respostas prontas foi exatamente o que o dono NÃO quis');
  assert.doesNotMatch(FONTE, /if \(\/como (baixo|faço)\/i\.test\(mensagem\)\)/,
    'casar a pergunta por regex e devolver texto fixo é menu disfarçado');
});

test('o histórico volta pro modelo (é conversa, não pergunta isolada)', () => {
  assert.match(FONTE, /const mensagens = \[\]/);
  assert.match(FONTE, /for \(const t of historico\)/, 'sem histórico ele esquece o contexto a cada turno');
  assert.match(FONTE, /role: papel, content: texto/);
});

// ═══ CHAVE E ORÇAMENTO ═══════════════════════════════════════════════════

test('NÃO usa a chave do estúdio (orçamento isolado da BlueTendências)', () => {
  // O comentário do topo EXPLICA a regra e naturalmente cita a env proibida.
  // O que importa é USO, então tira comentário antes de julgar.
  const codigo = FONTE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(codigo, /process\.env\.ANTHROPIC_API_KEY_STUDIO/,
    'a chave do estúdio é exclusiva da BlueTendências — regra da casa');
  assert.match(codigo, /process\.env\.ANTHROPIC_API_KEY \|\| ''/, 'usa a reserva');
});

test('sem configuração, falha claro em vez de vazar erro cru', () => {
  assert.match(FONTE, /if \(!SU \|\| !SK \|\| !ANTHROPIC\) return res\.status\(500\)/);
});

// ═══ PORTÃO ══════════════════════════════════════════════════════════════

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_ENV = { ...process.env };

function resFalso() {
  const r = { _status: 200, _json: null };
  r.setHeader = () => {}; r.end = () => r;
  r.status = (s) => { r._status = s; return r; };
  r.json = (j) => { r._json = j; return r; };
  return r;
}

function dublar({ email = 'a@b.c', plano = 'master', chamadas }) {
  return async (url, opts) => {
    const u = String(url);
    if (chamadas) chamadas.push(u.replace(/https?:\/\/[^/]+/, ''));
    if (u.includes('/auth/v1/user')) return { ok: !!email, json: async () => ({ email }) };
    if (u.includes('/rest/v1/subscribers')) {
      return { ok: true, json: async () => [{ plan: plano, plan_expires_at: null, is_manual: false, name: 'Felipe Teste' }] };
    }
    if (u.includes('anthropic.com')) {
      return { ok: true, json: async () => ({ content: [{ type: 'text', text: 'Abre /baixaBlue e cola o link.' }] }) };
    }
    return { ok: true, json: async () => ({}) };
  };
}

beforeEach(() => {
  process.env.SUPABASE_URL = 'https://exemplo.supabase.co';
  process.env.SUPABASE_SERVICE_KEY = 'sk';
  process.env.SUPABASE_ANON_KEY = 'ak';
  process.env.ANTHROPIC_API_KEY = 'sk-ant-teste';
});
afterEach(() => { globalThis.fetch = ORIGINAL_FETCH; process.env = { ...ORIGINAL_ENV }; });

const chamar = async (body, cen = {}) => {
  const chamadas = [];
  globalThis.fetch = dublar({ ...cen, chamadas });
  const res = resFalso();
  await handler({ method: 'POST', headers: {}, body }, res);
  return { res, chamadas };
};

test('sem token → 401 e a Anthropic nem é chamada (custo)', async () => {
  const { res, chamadas } = await chamar({ mensagem: 'como uso?' });
  assert.equal(res._status, 401);
  assert.equal(chamadas.filter((c) => c.includes('anthropic')).length, 0);
});

test('mensagem vazia → 400 sem gastar chamada', async () => {
  const { res, chamadas } = await chamar({ token: 't', mensagem: '   ' });
  assert.equal(res._status, 400);
  assert.equal(chamadas.filter((c) => c.includes('anthropic')).length, 0);
});

test('free não entra (o suporte é da Comunidade, que é de assinante)', async () => {
  const { res, chamadas } = await chamar({ token: 't', mensagem: 'oi' }, { plano: 'free' });
  assert.equal(res._status, 403);
  assert.equal(res._json.error, 'plano_necessario');
  assert.equal(chamadas.filter((c) => c.includes('anthropic')).length, 0);
});

test('full e master entram', async () => {
  for (const plano of ['full', 'master']) {
    const { res } = await chamar({ token: 't', mensagem: 'como faço roteiro?' }, { plano });
    assert.equal(res._status, 200, `${plano} deveria entrar`);
    assert.ok(res._json.resposta);
  }
});

// ═══ REGRESSÃO 06/08: o 403 que barrava TODO assinante ═══════════════════
// Eu pedi a coluna `name` no SELECT de subscribers. Ela NÃO EXISTE: o
// PostgREST devolve 400, o `sub` vira null, o plano cai pra 'free' e o
// assinante leva 403. É a armadilha que já estava registrada como regra da
// casa — nunca adicionar campo a SELECT sem confirmar o schema.

test('o SELECT de subscribers só pede colunas que existem', () => {
  const CONFIRMADAS = new Set(['plan', 'plan_expires_at', 'is_manual', 'email', 'currency',
    'cancel_at_period_end', 'coupon_applied', 'coupon_discount', 'affiliate_ref', 'amount_paid',
    'billing_period', 'trial_origin', 'created_at', 'virais_daily_alert', 'stripe_subscription_id']);
  const selects = [...FONTE.matchAll(/subscribers\?[^`'"]*select=([\w,]+)/g)].map((m) => m[1]);
  assert.ok(selects.length > 0, 'nenhum SELECT de subscribers encontrado');
  for (const sel of selects) {
    for (const col of sel.split(',')) {
      assert.ok(CONFIRMADAS.has(col),
        `pede "${col}" em subscribers — se a coluna não existir, o 400 derruba o plano pra free e o assinante leva 403`);
    }
  }
});

test('o nome vem do AUTH, não de uma coluna inventada', () => {
  assert.match(FONTE, /user_metadata\?\.name \|\| usuario\?\.user_metadata\?\.full_name/,
    'o nome tem que sair do usuário autenticado, que não depende de schema do subscribers');
  const i = FONTE.indexOf('subscribers?email=');
  const bloco = FONTE.slice(i, i + 200);
  assert.doesNotMatch(bloco, /,name/, 'a coluna name não existe em subscribers');
});

test('falha ao ler o plano não vira acesso liberado (falha SEGURA)', async () => {
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/auth/v1/user')) return { ok: true, json: async () => ({ email: 'a@b.c' }) };
    if (u.includes('/rest/v1/subscribers')) return { ok: false, status: 400, json: async () => ({ message: 'column does not exist' }) };
    return { ok: true, json: async () => ({}) };
  };
  const res = resFalso();
  await handler({ method: 'POST', headers: {}, body: { token: 't', mensagem: 'oi' } }, res);
  assert.equal(res._status, 403, 'consulta quebrada tem que NEGAR, nunca liberar');
});

// ═══ CONVERSA SALVA ══════════════════════════════════════════════════════

test('a conversa fica salva no servidor (continua em outro aparelho)', async () => {
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/auth/v1/user')) return { ok: true, json: async () => ({ email: 'a@b.c' }) };
    if (u.includes('/rest/v1/subscribers')) return { ok: true, json: async () => [{ plan: 'master' }] };
    if (u.includes('blublu_suporte_logs')) {
      return { ok: true, json: async () => [{ pergunta: 'como baixo?', resposta: 'Abre /baixaBlue' }] };
    }
    return { ok: true, json: async () => ({}) };
  };
  const res = resFalso();
  await handler({ method: 'POST', headers: {}, body: { token: 't', acao: 'historico', mensagem: '.' } }, res);
  assert.equal(res._status, 200);
  assert.equal(res._json.conversa.length, 2, 'pergunta e resposta viram dois balões');
  assert.equal(res._json.conversa[0].papel, 'voce');
  assert.equal(res._json.conversa[1].papel, 'blublu');
});

test('histórico indisponível abre conversa nova em vez de quebrar', async () => {
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/auth/v1/user')) return { ok: true, json: async () => ({ email: 'a@b.c' }) };
    if (u.includes('/rest/v1/subscribers')) return { ok: true, json: async () => [{ plan: 'master' }] };
    if (u.includes('blublu_suporte_logs')) throw new Error('supabase fora');
    return { ok: true, json: async () => ({}) };
  };
  const res = resFalso();
  await handler({ method: 'POST', headers: {}, body: { token: 't', acao: 'historico', mensagem: '.' } }, res);
  assert.equal(res._status, 200);
  assert.deepEqual(res._json.conversa, []);
});

test('o front busca a conversa salva ao abrir', () => {
  assert.match(FRONT, /acao: 'historico'/, 'precisa pedir o histórico');
  assert.match(FRONT, /async function carregarConversa/);
  assert.match(FRONT, /if \(historico\.length\) return;/, 'não recarrega por cima de conversa em andamento');
});

test('o plano vai no prompt (não ensina a usar o que a pessoa não tem)', () => {
  assert.match(FONTE, /## COM QUEM VOCÊ ESTÁ FALANDO AGORA/);
  assert.match(FONTE, /plano === 'full'[\s\S]{0,300}é do Master/,
    'Full precisa ser avisado do que é Master, em vez de procurar botão que não existe');
});

// ═══ O QUE ELE ENSINA TEM QUE SER VERDADE ════════════════════════════════

test('todas as rotas que ele ensina existem de verdade na toolbar', () => {
  const i = FONTE.indexOf('const CONHECIMENTO');
  const conhecimento = FONTE.slice(i, FONTE.indexOf('const PERSONALIDADE'));
  // formato real no conhecimento: "**🔥 Virais — em /virais**"
  const rotas = [...conhecimento.matchAll(/— em (\/[A-Za-z]*)\*\*/g)].map((m) => m[1]);
  assert.ok(rotas.length >= 8, `só achei ${rotas.length} rotas ensinadas`);
  for (const rota of rotas) {
    if (rota === '/') continue;                       // home = Roteiro
    if (rota === '/comunidade' || rota === '/afiliado') continue;  // não estão na toolbar
    assert.ok(TOOLBAR.includes("href:'" + rota + "'"),
      `ensina ${rota}, que não existe na toolbar — ensinar caminho falso é o pior defeito`);
  }
});

// ═══ PRECISÃO DO CONHECIMENTO (06/08) ════════════════════════════════════
// O dono reclamou de duas coisas no mesmo dia: (1) ele deflete pergunta que
// SABE responder ("não tenho a lista aqui") e (2) responde em bloco de manual.
// A causa da (1) é conhecimento raso; a da (2) é instrução. Os testes abaixo
// travam as duas — e a veracidade do que ele ensina, que é o pior defeito.

const CONHECIMENTO_TXT = FONTE.slice(
  FONTE.indexOf('const CONHECIMENTO'), FONTE.indexOf('const PERSONALIDADE'));
const PERSONALIDADE_TXT = FONTE.slice(
  FONTE.indexOf('const PERSONALIDADE'), FONTE.indexOf('module.exports'));
// O texto é quebrado em 78 colunas pra caber na tela, então "Bahasa\nIndonesia"
// existe mas um includes() cru não acha. Compara sempre nesta versão achatada.
const CONHECIMENTO_1L = CONHECIMENTO_TXT.replace(/\s+/g, ' ');

test('a lista de idiomas do roteiro é a MESMA da tela (não desatualiza)', () => {
  const INDEX = readFileSync(new URL('../../public/index.html', import.meta.url), 'utf8');
  const bloco = INDEX.slice(INDEX.indexOf('id="langSelect"'), INDEX.indexOf('</select>', INDEX.indexOf('id="langSelect"')));
  const idiomas = [...bloco.matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(idiomas.length >= 10, `só achei ${idiomas.length} idiomas no select`);
  for (const idioma of idiomas) {
    assert.ok(CONHECIMENTO_1L.includes(idioma),
      `a tela oferece "${idioma}" e o Blublu não sabe — foi assim que ele respondeu "não tenho a lista"`);
  }
  assert.ok(CONHECIMENTO_1L.includes(`**${idiomas.length}**`),
    `o total de idiomas mudou pra ${idiomas.length}; o conhecimento precisa dizer o número certo`);
});

test('sabe os limites REAIS do BlueClean, que é o que ele checa antes de mandar processar', () => {
  const BC = readFileSync(new URL('../../api/blueclean.js', import.meta.url), 'utf8');
  const limite = (BC.match(/const LIMIT\s*=\s*(\d+)/) || [])[1];
  const segundos = (BC.match(/max_seconds:\s*(\d+)/) || [])[1];
  assert.ok(limite && segundos, 'não consegui ler os limites do api/blueclean.js');
  assert.ok(CONHECIMENTO_1L.includes(`**${limite} limpezas`), `o limite virou ${limite}/mês`);
  assert.ok(CONHECIMENTO_1L.includes(`**${segundos} segundos**`), `o teto virou ${segundos}s`);
  // as três ferramentas de marcação e a janela de tempo — a dica que mais muda resultado
  for (const t of ['Caixa', 'Círculo', 'Pincel', 'Começa aqui', 'Termina aqui']) {
    assert.ok(CONHECIMENTO_1L.includes(t), `não ensina "${t}", que existe na tela do BlueClean`);
  }
});

test('sabe o que o Adaptar roteiro entrega (2 versões, 2 títulos, ajuste com IA)', () => {
  for (const item of ['Casual', 'Apelativa', '2 títulos', 'Pedir ajuste com IA', 'Tradução Fiel']) {
    assert.ok(CONHECIMENTO_1L.includes(item), `não sabe explicar "${item}"`);
  }
});

test('não ensina o que não existe em produção', () => {
  // O "Advogado YPP" vive na branch bluescore-v2 e NUNCA foi pra main. Estava
  // escrito no conhecimento como se existisse: suporte inventando tela.
  const BS = readFileSync(new URL('../../public/blueScore.html', import.meta.url), 'utf8');
  if (!/Advogado/i.test(BS)) {
    assert.ok(!/Advogado YPP/i.test(CONHECIMENTO_1L),
      'ensina o Advogado YPP, que não existe em main — mandar o assinante procurar tela inexistente é o pior defeito');
  }
});

test('o portão de cada ferramenta bate com o código da página', () => {
  const paginas = [
    ['baixaBlue.html', 'BaixaBlue', 'master'],
    ['blueVoice.html', 'BlueVoice', 'master'],
    ['blueLens.html', 'BlueLens', 'full'],
    ['blueScore.html', 'BlueScore', 'full'],
  ];
  for (const [arquivo, nome, esperado] of paginas) {
    const html = readFileSync(new URL('../../public/' + arquivo, import.meta.url), 'utf8');
    // ⚠️ o portão do Full é `plan !== 'full' && plan !== 'master'`, que CONTÉM
    // a string do portão do Master. Testar só por "!== 'master'" dá falso
    // positivo em toda página Full — checar o do Full primeiro.
    const aceitaFull = /plan !== 'full'/.test(html);
    const soMaster = !aceitaFull && /plan !== 'master'/.test(html);
    assert.equal(soMaster, esperado === 'master',
      `${arquivo} mudou de portão — o conhecimento do Blublu sobre ${nome} ficou mentiroso`);
    const i = CONHECIMENTO_1L.indexOf(nome + ' — em');
    assert.ok(i > 0, `${nome} sumiu do conhecimento`);
    const cabecalho = CONHECIMENTO_1L.slice(i, i + 160);
    assert.match(cabecalho, esperado === 'master' ? /Master/ : /Full e Master/,
      `${nome} é ${esperado} e o cabeçalho não diz isso`);
  }
});

test('BlueTendências é Master — o portão dela mora no backend, não no HTML', () => {
  // Aqui a página é uma landing pra todo mundo; quem barra é o api. Testar o
  // HTML como nas outras daria verde numa informação errada — e foi exatamente
  // esse o erro: o conhecimento listava BlueTendências como Full.
  const BT = readFileSync(new URL('../../api/bluetendencias.js', import.meta.url), 'utf8');
  assert.match(BT, /plan === 'master'/, 'o backend deixou de exigir master?');
  const i = CONHECIMENTO_1L.indexOf('BlueTendências — em');
  assert.ok(i > 0, 'BlueTendências sumiu do conhecimento');
  assert.match(CONHECIMENTO_1L.slice(i, i + 120), /exclusiva Master/);
  // e não pode aparecer na linha do Full
  const p = CONHECIMENTO_1L.indexOf('- **Full**');
  assert.ok(!CONHECIMENTO_1L.slice(p, CONHECIMENTO_1L.indexOf('- **Master**')).includes('BlueTendências'),
    'listar ferramenta de Master no plano Full manda o assinante procurar botão que não abre');
});

test('proíbe deflexão: não pode dizer que não sabe o que está no conhecimento', () => {
  assert.match(PERSONALIDADE_TXT, /Nunca diga "não\s*\n?\s*tenho essa lista aqui"/,
    'o caso real foi ele deflitir uma pergunta de idiomas que ele sabia responder');
  assert.match(PERSONALIDADE_TXT, /fingir que não sabe pra se\s*\n?proteger/,
    'o erro mais comum é o oposto de inventar: se esconder');
});

test('proíbe o menu de fechamento e o despejo de manual (o que soa pré-programado)', () => {
  assert.match(PERSONALIDADE_TXT, /Terminar toda mensagem com um menu/,
    '"Quer que eu te explique A ou B?" em toda resposta é a marca do chat de script');
  assert.match(PERSONALIDADE_TXT, /Nunca despeje o bloco inteiro/,
    'ele sabe muito de cada ferramenta; sem essa trava ele responde com o manual inteiro');
  assert.match(PERSONALIDADE_TXT, /responda a pergunta que foi feita, com o dado exato/i);
});

test('"me explica tudo" não pode terminar cortado no meio da palavra', () => {
  // Aconteceu no smoke: com teto de 900 a resposta morria em "reconstru".
  // Duas travas — o teto subiu E existe instrução pra dar mapa em vez de
  // catálogo, que é o que evita chegar perto do teto.
  const teto = Number((FONTE.match(/const MAX_TOKENS = (\d+)/) || [])[1]);
  assert.ok(teto >= 1100, `teto de ${teto} tokens já cortou resposta no meio`);
  assert.match(PERSONALIDADE_TXT, /QUANDO PEDIREM "ME EXPLICA TUDO"/);
  assert.match(PERSONALIDADE_TXT, /UMA linha por ferramenta/);
});

test('proíbe inventar funcionalidade, prometer resultado e citar concorrente', () => {
  const i = FONTE.indexOf('const PERSONALIDADE');
  const p = FONTE.slice(i, FONTE.indexOf('module.exports'));
  assert.match(p, /Não inventa funcionalidade/);
  assert.match(p, /Não promete resultado/);
  assert.match(p, /Não fala de ferramenta de fora/, 'regra da casa: nunca citar concorrente');
  assert.match(p, /Não cita preço de plano/, 'preço muda por país e promoção');
});

test('tem instrução de PUXAR DE VOLTA quando o assunto desvia', () => {
  const i = FONTE.indexOf('const PERSONALIDADE');
  const p = FONTE.slice(i, FONTE.indexOf('module.exports'));
  assert.match(p, /QUANDO A PESSOA SAI DO ASSUNTO/);
  assert.match(p, /PUXA DE VOLTA/);
  assert.match(p, /Varie|varie/, 'recusa idêntica toda vez soa robô — o dono pediu inteligência');
});

test('manda admitir que não sabe em vez de inventar tela', () => {
  const i = FONTE.indexOf('QUANDO VOCÊ NÃO SABE');
  assert.ok(i > 0, 'falta a instrução de admitir ignorância');
  const bloco = FONTE.slice(i, i + 400);
  assert.match(bloco, /nunca invent/i);
});

// ═══ ROBUSTEZ ════════════════════════════════════════════════════════════

test('modelo fora do ar → mensagem humana, não stack', async () => {
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/auth/v1/user')) return { ok: true, json: async () => ({ email: 'a@b.c' }) };
    if (u.includes('/rest/v1/subscribers')) return { ok: true, json: async () => [{ plan: 'master' }] };
    if (u.includes('anthropic.com')) return { ok: false, status: 529, text: async () => 'overloaded' };
    return { ok: true, json: async () => ({}) };
  };
  const res = resFalso();
  await handler({ method: 'POST', headers: {}, body: { token: 't', mensagem: 'oi' } }, res);
  assert.equal(res._status, 502);
  assert.ok(res._json.detail && !/stack|Error:|529/.test(res._json.detail),
    'o usuário não pode ver erro técnico: ' + res._json.detail);
});

test('mensagem e histórico têm teto (custo e prompt injection por volume)', () => {
  assert.match(FONTE, /MAX_CHARS_MSG/, 'mensagem precisa de teto');
  assert.match(FONTE, /MAX_TURNOS/, 'histórico precisa de teto');
  assert.match(FONTE, /historico\.slice\(-MAX_TURNOS\)/);
});

test('o log de auditoria não bloqueia a resposta', () => {
  // ⚠️ ancorar na GRAVAÇÃO. Existem duas menções à tabela (ler o histórico e
  // gravar o log); indexOf sem cuidado pega a leitura e o teste falha por
  // motivo errado.
  const i = FONTE.indexOf("method: 'POST',\n      headers: { apikey: SK");
  const alt = FONTE.indexOf('Prefer: \'return=minimal\'');
  const inicio = i > 0 ? i : alt;
  assert.ok(inicio > 0, 'gravação do log não encontrada');
  const bloco = FONTE.slice(inicio - 400, inicio + 700);
  assert.match(bloco, /\.catch\(\(\) => \{\}\)/,
    'falha ao gravar log não pode derrubar a resposta do usuário');
});

// ═══ FRONT ═══════════════════════════════════════════════════════════════

test('a entrada fica ACIMA das abas, como pedido', () => {
  assert.match(FRONT, /cbtTabs/, 'precisa ancorar na barra de abas');
  assert.match(FRONT, /insertBefore\(el, alvo\)/, 'antes das abas, não depois');
  assert.match(FRONT, /Como usar\?/);
});

test('o Blublu flutua num círculo, em azul brilhante', () => {
  assert.match(FRONT, /blublu-pointing\.png/, 'avatar do Blublu');
  assert.match(FRONT, /border-radius:50%/, 'dentro de um círculo');
  assert.match(FRONT, /@keyframes bspFlut/, 'flutuando');
  assert.match(FRONT, /#5fe3ff/, 'azul claro brilhante');
  assert.match(FRONT, /prefers-reduced-motion/, 'quem desliga animação precisa ser respeitado');
});

test('o front é isolado: não chama função do comunidade.js', () => {
  for (const fn of ['ComunidadeBT.setTab', 'ComunidadeBT.open', 'ComunidadeBT.load']) {
    assert.ok(!FRONT.includes(fn), `chama ${fn} — quebra o isolamento`);
  }
});

test('escapa o que vem do modelo (XSS)', () => {
  assert.match(FRONT, /function esc\(t\)/);
  assert.match(FRONT, /replace\(\/</, 'precisa escapar < antes de jogar no innerHTML');
  const i = FRONT.indexOf('function fmt(t)');
  const bloco = FRONT.slice(i, i + 300);
  assert.match(bloco, /esc\(t\)/, 'o formatador tem que escapar ANTES de aplicar markdown');
});

test('erro de rede no front vira mensagem legível', () => {
  assert.match(FRONT, /Sem conexão aqui/);
  assert.match(FRONT, /login_obrigatorio:/, 'cada erro do backend precisa de tradução');
  assert.match(FRONT, /plano_necessario:/);
});

// ═══ A COMUNIDADE INTEIRA (11/08) ════════════════════════════════════════
// Por que estes testes existem: a sala de voz entrou em produção em 11/08 e o
// conhecimento do Blublu NÃO foi atualizado junto. Ele passou a atender gente
// da Comunidade sem saber que a sala de voz existia — e o pior modo de falha de
// um suporte não é errar, é ignorar com confiança uma tela que está na frente
// da pessoa. Os testes abaixo amarram cada NÚMERO que ele ensina ao código que
// manda nele, do mesmo jeito que os idiomas e o BlueClean já eram amarrados.

const SALA_API = readFileSync(new URL('../../api/sala-voz.js', import.meta.url), 'utf8');
const SALA_FRONT = readFileSync(new URL('../../public/sala-voz.js', import.meta.url), 'utf8');
const COMM_API = readFileSync(new URL('../../api/community.js', import.meta.url), 'utf8');
const AMIZADE = readFileSync(new URL('../../api/_helpers/amizade.js', import.meta.url), 'utf8');

const numeroDe = (fonte, re, nome) => {
  const m = fonte.match(re);
  assert.ok(m, `não consegui ler ${nome} do código — o teste ficou cego`);
  return m[1];
};

test('os números da SALA DE VOZ que ele ensina são os do código', () => {
  const teto = numeroDe(SALA_API, /const MAX_PESSOAS = (\d+)/, 'MAX_PESSOAS');
  assert.ok(CONHECIMENTO_1L.includes(`**${teto} pessoas**`),
    `a sala cabe ${teto} e o Blublu ensina outro número`);

  // Os dois relógios de inatividade: são a causa nº 1 de "fui expulso do nada".
  const semFalar = numeroDe(SALA_FRONT, /SEM_FALAR_MS: (\d+) \* 60 \* 1000/, 'SEM_FALAR_MS');
  const semTocar = numeroDe(SALA_FRONT, /SEM_TOCAR_MS: (\d+) \* 60 \* 1000/, 'SEM_TOCAR_MS');
  assert.ok(CONHECIMENTO_1L.includes(`**${semFalar} minutos sem falar**`), `o relógio de fala virou ${semFalar}min`);
  assert.ok(CONHECIMENTO_1L.includes(`**${semTocar} minutos**`), `o teto sem toque virou ${semTocar}min`);
});

test('os números das SALAS PRIVADAS que ele ensina são os do código', () => {
  const horas = numeroDe(SALA_API, /const EXPULSAO_H = (\d+)/, 'EXPULSAO_H');
  const tentativas = numeroDe(SALA_API, /const SENHA_TENTATIVAS = (\d+)/, 'SENHA_TENTATIVAS');
  const castigo = numeroDe(SALA_API, /const SENHA_CASTIGO_MIN = (\d+)/, 'SENHA_CASTIGO_MIN');
  const titulo = numeroDe(SALA_API, /const TITULO_MAX = (\d+)/, 'TITULO_MAX');
  const senhaMin = numeroDe(SALA_API, /const SENHA_MIN = (\d+)/, 'SENHA_MIN');

  assert.ok(CONHECIMENTO_1L.includes(`**${horas} horas**`), `a expulsão virou ${horas}h`);
  assert.ok(CONHECIMENTO_1L.includes(`**${tentativas} vezes**`), `o freio virou ${tentativas} tentativas`);
  assert.ok(CONHECIMENTO_1L.includes(`**${castigo} minutos**`), `o castigo virou ${castigo}min`);
  assert.ok(CONHECIMENTO_1L.includes(`**${titulo}** letras`), `o nome da sala virou ${titulo}`);
  assert.ok(CONHECIMENTO_1L.includes(`**${senhaMin}** caracteres`), `a senha mínima virou ${senhaMin}`);
});

test('ele explica a diferença entre TROCAR SENHA e EXPULSAR (a promessa que não pode virar mentira)', () => {
  // Isto não é detalhe de texto: trocar a senha NÃO tira quem já está dentro, e
  // o código foi construído dizendo isso na cara. Um suporte prometendo o
  // contrário desfaz a única garantia real que a feature tem.
  assert.match(SALA_API, /aviso: b\.senha !== undefined \? 'A senha nova vale pra quem entrar daqui pra frente/,
    'o servidor deixou de avisar isso — o conhecimento abaixo ficou órfão');
  assert.match(CONHECIMENTO_1L, /trocar a senha fecha a PORTA, não esvazia a sala/i);
  assert.match(CONHECIMENTO_1L, /Expulsar\*\*, que é o único que tira de verdade/i);
});

test('ele sabe que o ⋯ só aparece no card de OUTRA pessoa (a dúvida real do dono)', () => {
  // O próprio dono do produto abriu a sala, não viu o botão e perguntou se a
  // feature existia. Se ele tropeçou, o assinante tropeça mais.
  assert.match(SALA_FRONT, /if \(souEu\(identity\) \|\| \(pe && pe\.eu\)\) return false;/,
    'a regra mudou: o ⋯ passou a aparecer no próprio card?');
  assert.match(CONHECIMENTO_1L, /sozinho na sala não tem em quem clicar/i);
});

test('ele sabe as regras das AMIZADES que estão no helper', () => {
  const dias = numeroDe(AMIZADE, /const CARENCIA_RECUSA_DIAS = (\d+)/, 'CARENCIA_RECUSA_DIAS');
  const strikes = numeroDe(AMIZADE, /const MAX_STRIKES = (\d+)/, 'MAX_STRIKES');
  assert.ok(CONHECIMENTO_1L.includes(`**${dias} dias**`), `a carência virou ${dias} dias`);
  assert.ok(CONHECIMENTO_1L.includes(`**${strikes}** recusas`), `o bloqueio virou ${strikes} recusas`);
});

test('ele sabe o tamanho da bio do perfil', () => {
  const bio = numeroDe(COMM_API, /const bio = clean\(b\.bio, (\d+)\)/, 'limite da bio');
  assert.ok(CONHECIMENTO_1L.includes(`**${bio}** caracteres`), `a bio virou ${bio}`);
});

test('COBERTURA: feature que existe no código tem que existir no conhecimento', () => {
  // O teste anti-apodrecimento. Cada linha amarra um SINAL do código (uma ação
  // real do backend, não um texto) à palavra que o Blublu precisa saber. Subir
  // feature nova sem ensinar o suporte passa a quebrar o build.
  const cobertura = [
    ['sala de voz',    SALA_API,  /action === 'entrar'/,     /sala de voz ao vivo/i],
    ['salas privadas', SALA_API,  /action === 'criar'/,      /criar\s+minha sala/i],
    ['expulsar',       SALA_API,  /action === 'expulsar'/,   /expulsar/i],
    ['co-anfitrião',   SALA_API,  /action === 'papel'/,      /co-anfitrião/i],
    ['silenciar',      SALA_API,  /action === 'silenciar'/,  /silenciar/i],
    ['encerrar sala',  SALA_API,  /action === 'encerrar'/,   /encerrar sala/i],
    ['chat da sala',   SALA_FRONT, /function receberDados/,  /chat de texto da sala/i],
    ['denunciar',      COMM_API,  /action === 'denunciar'/,  /denunciar/i],
    ['amizades',       COMM_API,  /action === 'amizades'/,   /amigos/i],
    ['perfil',         COMM_API,  /action === 'perfil'/,     /perfil/i],
  ];
  for (const [nome, fonte, existeNoCodigo, ensinado] of cobertura) {
    if (!existeNoCodigo.test(fonte)) continue;   // a feature saiu: nada a exigir
    assert.match(CONHECIMENTO_1L, ensinado,
      `"${nome}" existe no código e o Blublu não sabe — ele vai atender alguém sobre uma tela que ele ignora`);
  }
});

test('o conhecimento novo entrou no CONHECIMENTO, não virou resposta pronta na PERSONALIDADE', () => {
  // A premissa do produto é conversa de gente, não árvore de resposta. A
  // tentação, quando o suporte erra, é escrever a resposta certa direto na
  // instrução — e é assim que ele vira robô. Fato vai no conhecimento;
  // comportamento, na personalidade.
  for (const fato of ['12 horas', 'co-anfitrião', 'Criar minha sala', '10 pessoas']) {
    assert.ok(!PERSONALIDADE_TXT.includes(fato),
      `"${fato}" foi parar na PERSONALIDADE — fato é conhecimento, não instrução de comportamento`);
  }
  // E a personalidade continua sendo a de conversa, não a de menu.
  assert.match(PERSONALIDADE_TXT, /responda a pergunta que foi feita, com o dado exato/i);
  assert.match(PERSONALIDADE_TXT, /Nunca despeje o bloco inteiro de uma ferramenta/);
});
