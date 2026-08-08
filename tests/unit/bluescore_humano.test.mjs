// tests/unit/bluescore_humano.test.mjs — node --test
//
// O BlueScore deixou de ser nota calculada e virou LAUDO HUMANO: o usuário
// pede, entra na fila, e quem analisa é o dono (ex-suporte do YouTube).
//
// O que estes testes travam: o portão e a cota (que antes moravam no
// localStorage e não valiam nada), o isolamento do api/auth.js (que é ESM e
// regra da casa não encostar), e o fato de que só o botão "Enviar" avisa o
// usuário — rascunho tem que ser silencioso.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const handler = require('../../api/bluescore.js');
const T = handler.__test;

const FONTE = readFileSync(new URL('../../api/bluescore.js', import.meta.url), 'utf8');
const PAGINA = readFileSync(new URL('../../public/blueScore.html', import.meta.url), 'utf8');
const ADMIN = readFileSync(new URL('../../public/admin.html', import.meta.url), 'utf8');
const SININHO = readFileSync(new URL('../../public/sininho.js', import.meta.url), 'utf8');
const INDEX = readFileSync(new URL('../../public/index.html', import.meta.url), 'utf8');

// ═══ ENTRADA: QUE LINK VALE ══════════════════════════════════════════════

test('reconhece as três redes e recusa o resto na porta', () => {
  assert.equal(T.detectarRede('https://www.youtube.com/@XiroRanks/shorts'), 'youtube');
  assert.equal(T.detectarRede('https://youtu.be/abc'), 'youtube');
  assert.equal(T.detectarRede('https://www.tiktok.com/@khaby.lame'), 'tiktok');
  assert.equal(T.detectarRede('https://instagram.com/leomessi'), 'instagram');
  // recusar aqui é melhor que o dono descobrir na fila que não dá pra analisar
  assert.equal(T.detectarRede('https://x.com/alguem'), null);
  assert.equal(T.detectarRede('https://kwai.com/@x'), null);
  assert.equal(T.detectarRede(''), null);
});

test('não confunde domínio parecido com o de verdade', () => {
  // "meuyoutube.com.br" não é YouTube; deixar passar mandaria lixo pra fila
  assert.equal(T.detectarRede('https://meuyoutube.com.br/canal'), null);
  assert.equal(T.detectarRede('https://naotiktok.com/@x'), null);
});

test('tira o @ do link pra fila ter nome legível', () => {
  assert.equal(T.extrairHandle('https://www.youtube.com/@XiroRanks/shorts', 'youtube'), '@XiroRanks');
  assert.equal(T.extrairHandle('https://www.tiktok.com/@khaby.lame', 'tiktok'), '@khaby.lame');
  assert.equal(T.extrairHandle('https://instagram.com/leomessi', 'instagram'), '@leomessi');
  assert.equal(T.extrairHandle('https://youtube.com/c/MeuCanal', 'youtube'), 'MeuCanal');
});

test('ID de canal não é nome: /channel/UCxxx não vira "handle"', () => {
  // Caso real do primeiro teste do dono: a fila mostrava
  // "UCwWJxujawMclRdihmkbgryQ" e o campo "Nome do canal" nascia com esse lixo.
  assert.equal(T.extrairHandle('https://www.youtube.com/channel/UCwWJxujawMclRdihmkbgryQ/', 'youtube'), null);
  // e o admin só prefixa o nome quando o handle é @ de verdade
  assert.match(ADMIN, /startsWith\('@'\) \? p\.perfil_handle : ''/);
});

// ═══ LAUDO ═══════════════════════════════════════════════════════════════

test('a nota fica presa entre 0 e 100', () => {
  assert.equal(T.normalizarLaudo({ nota: 999 }).nota, 100);
  assert.equal(T.normalizarLaudo({ nota: -50 }).nota, 0);
  assert.equal(T.normalizarLaudo({ nota: '78' }).nota, 78);
  assert.equal(T.normalizarLaudo({ nota: 'abc' }).nota, 0);
});

test('a faixa é derivada da nota, não digitada errado', () => {
  assert.equal(T.classificar(95).chave, 'high');
  assert.equal(T.classificar(80).chave, 'high');
  assert.equal(T.classificar(79).chave, 'good');
  assert.equal(T.classificar(40).chave, 'moderate');
  assert.equal(T.classificar(39).chave, 'low');
  assert.equal(T.normalizarLaudo({ nota: 90 }).classificacao, 'high');
});

test('linha vazia do formulário não vira bloco vazio na página', () => {
  const l = T.normalizarLaudo({
    nota: 70,
    pontos: [{ titulo: '', texto: '' }, { titulo: 'Gancho fraco', texto: 'os 2s iniciais' }],
    recomendacoes: [{ acao: '' }, { acao: 'Corta a intro' }],
    videos: [{ url: '', titulo: '', observacao: '' }, { url: 'https://y.t/1' }],
  });
  assert.equal(l.pontos.length, 1, 'ponto sem conteúdo tem que sumir');
  assert.equal(l.recomendacoes.length, 1);
  assert.equal(l.videos.length, 1);
});

test('o laudo tem teto de tamanho (o formulário é texto livre)', () => {
  const l = T.normalizarLaudo({
    nota: 70,
    resumo: 'x'.repeat(99999),
    videos: Array.from({ length: 50 }, (_, i) => ({ url: 'u' + i })),
    pontos: Array.from({ length: 50 }, (_, i) => ({ titulo: 't' + i })),
  });
  assert.ok(l.resumo.length <= 4000, 'resumo sem teto vira payload gigante no banco');
  assert.ok(l.videos.length <= 12);
  assert.ok(l.pontos.length <= 12);
});

test('impacto e tipo inválidos caem num padrão em vez de quebrar a tela', () => {
  const l = T.normalizarLaudo({
    nota: 50,
    pontos: [{ tipo: 'explosao', titulo: 'x' }],
    recomendacoes: [{ acao: 'y', impacto: 'urgentissimo' }],
  });
  assert.equal(l.pontos[0].tipo, 'warn');
  assert.equal(l.recomendacoes[0].impacto, 'medio');
});

test('laudo sem nota ou sem diagnóstico não é considerado pronto', () => {
  assert.ok(T.laudoEstaPronto(T.normalizarLaudo({ resumo: 'oi' })), 'sem nota tinha que reprovar');
  assert.ok(T.laudoEstaPronto(T.normalizarLaudo({ nota: 70 })), 'sem diagnóstico tinha que reprovar');
  assert.equal(T.laudoEstaPronto(T.normalizarLaudo({ nota: 70, resumo: 'diagnóstico' })), null);
});

test('a cota vira à meia-noite de Brasília, não de Londres', () => {
  const ini = T.inicioDoDiaBR();
  // 00:00 em -03:00 é 03:00 UTC. Usar UTC puro faria a cota virar às 21h.
  assert.equal(ini.getUTCHours(), 3);
  assert.ok(Date.now() - ini.getTime() >= 0, 'o início do dia não pode estar no futuro');
  assert.ok(Date.now() - ini.getTime() < 24 * 3600 * 1000);
});

// ═══ PORTÃO E COTA (agora no servidor) ═══════════════════════════════════

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_ENV = { ...process.env };

function resFalso() {
  const r = { _status: 200, _json: null };
  r.setHeader = () => {}; r.end = () => r;
  r.status = (s) => { r._status = s; return r; };
  r.json = (j) => { r._json = j; return r; };
  return r;
}

function dublar({ plano = 'master', hoje = [], abertos = [], escritas } = {}) {
  return async (url, opts) => {
    const u = String(url);
    const metodo = (opts && opts.method) || 'GET';
    if (escritas && metodo !== 'GET') escritas.push(u.replace(/https?:\/\/[^/]+/, ''));

    if (u.includes('/auth/v1/user')) {
      return { ok: true, json: async () => ({ id: 'user-1', email: 'a@b.c', user_metadata: { name: 'Felipe' } }) };
    }
    if (u.includes('/rest/v1/subscribers')) {
      return { ok: true, json: async () => [{ plan: plano, plan_expires_at: null, is_manual: false }] };
    }
    if (u.includes('bluescore_pedidos') && u.includes('status=in.(na_fila,em_analise)')) {
      return { ok: true, json: async () => abertos };
    }
    if (u.includes('bluescore_pedidos') && u.includes('criado_em=gte.')) {
      return { ok: true, json: async () => hoje };
    }
    if (u.includes('bluescore_pedidos') && metodo === 'POST') {
      return { ok: true, json: async () => [{ id: 'novo-1', status: 'na_fila' }] };
    }
    if (u.includes('resend.com')) return { ok: true, json: async () => ({}) };
    return { ok: true, json: async () => [] };
  };
}

beforeEach(() => {
  process.env.SUPABASE_URL = 'https://exemplo.supabase.co';
  process.env.SUPABASE_SERVICE_KEY = 'sk';
  process.env.SUPABASE_ANON_KEY = 'ak';
  process.env.ADMIN_SECRET = 'segredo';
  delete process.env.RESEND_API_KEY;
});
afterEach(() => { globalThis.fetch = ORIGINAL_FETCH; process.env = { ...ORIGINAL_ENV }; });

const chamar = async (body, cen = {}, headers = {}) => {
  const escritas = [];
  globalThis.fetch = dublar({ ...cen, escritas });
  const res = resFalso();
  await handler({ method: 'POST', headers, body }, res);
  return { res, escritas };
};

test('sem token não pede análise', async () => {
  const { res } = await chamar({ action: 'pedir', url: 'https://youtube.com/@x' });
  assert.equal(res._status, 401);
});

test('free não pede — mesmo mexendo no localStorage do navegador', async () => {
  const { res } = await chamar({ action: 'pedir', token: 't', url: 'https://youtube.com/@x' }, { plano: 'free' });
  assert.equal(res._status, 403);
  assert.equal(res._json.error, 'plano_necessario');
});

test('full e master pedem', async () => {
  for (const plano of ['full', 'master']) {
    const { res } = await chamar({ action: 'pedir', token: 't', url: 'https://youtube.com/@x' }, { plano });
    assert.equal(res._status, 200, `${plano} deveria conseguir`);
    assert.equal(res._json.id, 'novo-1');
  }
});

test('link de rede não suportada morre antes de virar linha na fila', async () => {
  const { res, escritas } = await chamar({ action: 'pedir', token: 't', url: 'https://x.com/alguem' });
  assert.equal(res._status, 400);
  assert.equal(res._json.error, 'rede_nao_suportada');
  assert.equal(escritas.filter((e) => e.includes('bluescore_pedidos')).length, 0);
});

test('a cota de 2 por dia é contada no SERVIDOR', async () => {
  const { res } = await chamar(
    { action: 'pedir', token: 't', url: 'https://youtube.com/@x' },
    { hoje: [{ id: 1 }, { id: 2 }] });
  assert.equal(res._status, 429);
  assert.equal(res._json.error, 'limite_diario');
  assert.equal(res._json.limite, 2);
});

test('pedir o mesmo perfil duas vezes não duplica trabalho nem gasta cota', async () => {
  const { res, escritas } = await chamar(
    { action: 'pedir', token: 't', url: 'https://youtube.com/@x' },
    { abertos: [{ id: 'ja-existe', status: 'na_fila' }] });
  assert.equal(res._status, 200);
  assert.equal(res._json.id, 'ja-existe');
  assert.equal(res._json.ja_existia, true);
  assert.equal(escritas.filter((e) => e.includes('bluescore_pedidos')).length, 0, 'não pode inserir de novo');
});

test('ler o próprio laudo não exige plano vivo (a pessoa já pagou por ele)', async () => {
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/auth/v1/user')) return { ok: true, json: async () => ({ id: 'user-1', email: 'a@b.c' }) };
    if (u.includes('subscribers')) return { ok: true, json: async () => [{ plan: 'free' }] };
    return { ok: true, json: async () => [{ id: 'p1', status: 'entregue', laudo: { nota: 80 } }] };
  };
  const res = resFalso();
  await handler({ method: 'POST', headers: {}, body: { action: 'ver', token: 't', id: 'p1' } }, res);
  assert.equal(res._status, 200, 'quem virou free não pode perder o laudo que já recebeu');
});

test('o SELECT de subscribers só pede coluna que existe', () => {
  const CONFIRMADAS = new Set(['plan', 'plan_expires_at', 'is_manual']);
  const selects = [...FONTE.matchAll(/subscribers\?[^`'"]*select=([\w,]+)/g)].map((m) => m[1]);
  assert.ok(selects.length > 0);
  for (const sel of selects) {
    for (const col of sel.split(',')) {
      assert.ok(CONFIRMADAS.has(col),
        `pede "${col}" — coluna inexistente devolve 400 e derruba o plano pra free (bug de 06/08)`);
    }
  }
});

// ═══ ADMIN ═══════════════════════════════════════════════════════════════

test('fila quebrada NÃO se parece com fila vazia', async () => {
  // Achado no smoke do preview: sem a tabela, o admin via "fila vazia 🎉"
  // enquanto gente esperava análise. Erro de banco tem que gritar.
  globalThis.fetch = async () => ({ ok: false, status: 404, text: async () => 'PGRST205 relation does not exist' });
  const res = resFalso();
  await handler({ method: 'POST', headers: { authorization: 'Bearer segredo' }, body: { action: 'fila' } }, res);
  assert.equal(res._status, 500);
  assert.equal(res._json.error, 'fila_indisponivel');
  assert.match(res._json.detalhe, /bluescore_pedidos/, 'a mensagem tem que dizer o que fazer');
});

test('histórico do usuário também falha alto em vez de dizer "não tem nada"', async () => {
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/auth/v1/user')) return { ok: true, json: async () => ({ id: 'u1', email: 'a@b.c' }) };
    return { ok: false, status: 500, text: async () => 'boom' };
  };
  const res = resFalso();
  await handler({ method: 'POST', headers: {}, body: { action: 'meus', token: 't' } }, res);
  assert.equal(res._status, 503, 'lista vazia por engano faz a pessoa pedir de novo e gastar cota');
});

test('ação de admin sem o segredo é 401', async () => {
  for (const acao of ['fila', 'laudo_salvar', 'laudo_enviar', 'recusar']) {
    const { res } = await chamar({ action: acao, id: 'x' });
    assert.equal(res._status, 401, `${acao} vazou sem segredo`);
  }
});

test('não dá pra entregar laudo pela metade', async () => {
  const { res } = await chamar(
    { action: 'laudo_enviar', id: 'p1', laudo: { nota: 0, resumo: '' } },
    {}, { authorization: 'Bearer segredo' });
  assert.equal(res._status, 400);
  assert.equal(res._json.error, 'laudo_incompleto');
});

test('RASCUNHO é silencioso: não avisa sininho nem email', async () => {
  const escritas = [];
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if ((opts?.method || 'GET') !== 'GET') escritas.push(u.replace(/https?:\/\/[^/]+/, ''));
    if (u.includes('bluescore_pedidos')) return { ok: true, json: async () => [{ id: 'p1', user_id: 'u1', laudo: {} }] };
    return { ok: true, json: async () => [] };
  };
  const res = resFalso();
  await handler({ method: 'POST', headers: { authorization: 'Bearer segredo' },
    body: { action: 'laudo_salvar', id: 'p1', laudo: { nota: 80, resumo: 'oi' } } }, res);
  assert.equal(res._status, 200);
  assert.equal(res._json.status, 'em_analise');
  assert.equal(escritas.filter((e) => e.includes('blue_notificacoes')).length, 0,
    'salvar rascunho não pode avisar o usuário — ele receberia email de análise incompleta');
  assert.equal(escritas.filter((e) => e.includes('resend')).length, 0);
});

test('ENVIAR avisa o sininho e devolve o resultado de cada aviso', async () => {
  const escritas = [];
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if ((opts?.method || 'GET') !== 'GET') escritas.push(u.replace(/https?:\/\/[^/]+/, ''));
    if (u.includes('bluescore_pedidos')) {
      return { ok: true, json: async () => [{ id: 'p1', user_id: 'u1', email: 'a@b.c', rede: 'youtube',
        perfil_handle: '@x', laudo: { nota: 80, canal: { nome: 'Canal X' } } }] };
    }
    return { ok: true, json: async () => [] };
  };
  const res = resFalso();
  await handler({ method: 'POST', headers: { authorization: 'Bearer segredo' },
    body: { action: 'laudo_enviar', id: 'p1', laudo: { nota: 80, resumo: 'diagnóstico completo' } } }, res);
  assert.equal(res._status, 200);
  assert.equal(res._json.status, 'entregue');
  assert.equal(escritas.filter((e) => e.includes('blue_notificacoes')).length, 1, 'o sininho é o aviso que fica no site');
});

test('sininho fora do ar não impede a entrega da análise', async () => {
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('blue_notificacoes')) throw new Error('supabase fora');
    if (u.includes('bluescore_pedidos')) return { ok: true, json: async () => [{ id: 'p1', user_id: 'u1', email: 'a@b.c', laudo: { nota: 80 } }] };
    return { ok: true, json: async () => [] };
  };
  const res = resFalso();
  await handler({ method: 'POST', headers: { authorization: 'Bearer segredo' },
    body: { action: 'laudo_enviar', id: 'p1', laudo: { nota: 80, resumo: 'ok' } } }, res);
  assert.equal(res._status, 200, 'a análise já está publicada; aviso que falha não pode desfazer isso');
  assert.equal(res._json.sininho, false, 'mas o admin precisa SABER que o aviso falhou');
});

test('recusar avisa o motivo em vez de sumir com o pedido', async () => {
  const corpos = [];
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (opts?.body) corpos.push({ url: u, body: opts.body });
    if (u.includes('bluescore_pedidos')) return { ok: true, json: async () => [{ id: 'p1', user_id: 'u1' }] };
    return { ok: true, json: async () => [] };
  };
  const res = resFalso();
  await handler({ method: 'POST', headers: { authorization: 'Bearer segredo' },
    body: { action: 'recusar', id: 'p1', motivo: 'O perfil está privado.' } }, res);
  assert.equal(res._status, 200);
  const notif = corpos.find((c) => c.url.includes('blue_notificacoes'));
  assert.ok(notif, 'recusa tem que avisar');
  assert.match(notif.body, /perfil está privado/i, 'a pessoa precisa saber POR QUE não deu');
});

// ═══ ISOLAMENTO E VERACIDADE ═════════════════════════════════════════════

test('não encosta no api/auth.js (que é ESM — regra da casa)', () => {
  const AUTH = readFileSync(new URL('../../api/auth.js', import.meta.url), 'utf8');
  assert.match(AUTH, /^import /m, 'se auth.js deixou de ser ESM, revisar a regra');
  const codigo = FONTE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(codigo, /require\(['"]\.\/auth/, 'importar o auth.js quebraria o login inteiro');
});

test('a página não calcula mais nota nenhuma', () => {
  // O motor antigo vivia no navegador: o usuário via a fórmula e podia mandar
  // score 100 pro backend. Agora a nota SÓ vem do laudo.
  for (const morto of ['calculateBlueScore', 'calculateShortsScore', 'shortsViewsScore', 'generateAIDiagnosis']) {
    assert.ok(!PAGINA.includes(morto), `${morto} continua na página — a nota tem que vir do laudo`);
  }
  assert.ok(!PAGINA.includes('bluescore-ai'), 'a página não pode mais chamar a IA');
  assert.ok(!PAGINA.includes('bluescore-channel'), 'a página não pode mais gastar quota do YouTube');
});

test('a página promete o que a gente cumpre: análise humana e aviso depois', () => {
  assert.match(PAGINA, /ex-funcionário do suporte do YouTube/,
    'a credencial é o que dá peso à análise — o dono pediu explicitamente');
  assert.match(PAGINA, /YouTube, TikTok e Instagram/);
  assert.match(PAGINA, /avisa assim que a análise ficar pronta/i);
  // Sem prazo fixo foi decisão do dono: prometer 48h prende ele.
  assert.ok(!/48\s*horas|em at[ée] \d+ dias/i.test(PAGINA), 'não prometer prazo que não foi combinado');
});

test('o portão da página é Full e Master, igual ao do backend', () => {
  assert.match(PAGINA, /PLANO !== 'full' && PLANO !== 'master'/);
  assert.deepEqual(T.PLANOS_OK, ['full', 'master']);
  assert.equal(T.LIMITE_DIA, 2);
});

test('o laudo é escapado antes de virar HTML', () => {
  assert.match(PAGINA, /function esc\(t\)/);
  const i = PAGINA.indexOf('function renderizar');
  const bloco = PAGINA.slice(i, i + 6000);
  assert.match(bloco, /esc\(p\.titulo\)/, 'texto do laudo entra por innerHTML — tem que escapar');
  assert.match(bloco, /esc\(v\.url\)/);
});

// ═══ ADMIN E SININHO NO FRONT ════════════════════════════════════════════

test('o admin tem a fila e os dois botões separados', () => {
  assert.match(ADMIN, /id="bluescoreFila"/);
  assert.match(ADMIN, /bsSalvarRascunho/);
  assert.match(ADMIN, /bsEnviar/);
  assert.match(ADMIN, /bsRecusar/);
  // enviar é irreversível (dispara email): tem que confirmar
  const i = ADMIN.indexOf('async function bsEnviar');
  assert.match(ADMIN.slice(i, i + 900), /confirm\(/, 'enviar dispara email — sem confirmação é pedir acidente');
});

test('a fila carrega sozinha no login do admin (senão ninguém vê o pedido)', () => {
  assert.match(ADMIN, /bsCarregarFila\(\)\.catch/);
  assert.match(ADMIN, /id="bsFilaBadge"/);
});

test('o sininho existe no site e lê a caixa VIVA', () => {
  assert.match(INDEX, /src="\/sininho\.js"/, 'sem o script o sino não existe');
  assert.match(SININHO, /action: 'notificacoes'/);
  assert.match(SININHO, /action: 'marcar-lidas'/);
  // blue_notifications (com S no fim) é tabela morta — PGRST205 confirmado
  assert.ok(!SININHO.includes('blue_notifications'), 'essa tabela não existe');
});

test('o sininho escapa o que veio do banco e respeita o teto do observer', () => {
  assert.match(SININHO, /function esc\(t\)/);
  assert.match(SININHO, /esc\(n\.titulo/);
  assert.match(SININHO, /esc\(n\.mensagem/);
  assert.match(SININHO, /MAX_TENTATIVAS/, 'observer sem teto fica rodando pra sempre');
  assert.match(SININHO, /montar\._globais/, 'listener de documento não pode empilhar a cada remontagem');
});
