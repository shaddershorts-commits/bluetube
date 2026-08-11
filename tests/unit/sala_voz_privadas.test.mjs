// tests/unit/sala_voz_privadas.test.mjs — node --test
//
// SALAS DE VOZ PRIVADAS (dono, senha, co-anfitriões).
//
// ── POR QUE ESTE ARQUIVO É COMO É ───────────────────────────────────────────
// O achado que define a feature foi MEDIDO em 11/08: numa sala do LiveKit,
// NADA tira ninguém de dentro depois que a pessoa entrou. O portão só roda ao
// assinar o crachá, e o LiveKit renova a credencial do cliente sozinho, com
// validade além da nossa. Numa sala "com senha" isso significa que:
//
//   · quem já está dentro fica, mesmo que a senha mude;
//   · quem foi expulso volta com o MESMO crachá que guardou, direto no SFU,
//     sem nem passar pelo nosso endpoint.
//
// Então "senha na porta" não é sala privada. O que é: senha + REMOÇÃO ATIVA
// (RemoveParticipant/DeleteRoom) + LISTA DE EXPULSOS + VARREDURA de quem já
// está dentro. Este arquivo trava as quatro — e trava principalmente a ORDEM
// entre elas, que é onde a coisa fica errada em silêncio.
//
// Por isso os testes de backend RODAM O HANDLER DE VERDADE contra um Supabase
// falso e um LiveKit falso, gravando a ordem das chamadas. Asserção de texto
// sobre o código só aparece onde a garantia é literalmente "esta linha não
// pode voltar".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);

process.env.SUPABASE_URL = 'https://sb.test';
process.env.SUPABASE_SERVICE_KEY = 'service-key';
process.env.SUPABASE_ANON_KEY = 'anon-key';
process.env.LIVEKIT_URL = 'wss://lk.test';
process.env.LIVEKIT_API_KEY = 'APIfake';
process.env.LIVEKIT_API_SECRET = 'segredo-de-teste-com-32-bytes!!!';

const handler = require('../../api/sala-voz.js');
const I = handler.__interno;
const API = readFileSync(new URL('../../api/sala-voz.js', import.meta.url), 'utf8');
const FRONT = readFileSync(new URL('../../public/sala-voz.js', import.meta.url), 'utf8');
const SQL = readFileSync(new URL('../../sql/comunidade_salas_privadas.sql', import.meta.url), 'utf8');

const SU = 'https://sb.test';
const EU = '11111111-1111-4111-8111-111111111111';
const OUTRO = '22222222-2222-4222-8222-222222222222';
const TERCEIRO = '33333333-3333-4333-8333-333333333333';
const SALA_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

// ─── Supabase + LiveKit falsos ─────────────────────────────────────────────
// Não é um banco de verdade: é o pedaço do PostgREST que este endpoint usa.
// O que ele grava de valioso é o LOG — a ordem exata em que as coisas
// aconteceram, que é o que separa "expulsou" de "expulsou e ela voltou".
function ambiente(cfg) {
  cfg = cfg || {};
  const estado = {
    log: [],
    rooms: (cfg.rooms || []).map((r) => Object.assign({}, r)),
    members: (cfg.members || []).map((m) => Object.assign({}, m)),
    perfil: cfg.perfil === undefined ? { user_id: EU, display_name: 'Ana', avatar_url: null, is_moderator: false, plan: 'master' } : cfg.perfil,
    perfis: cfg.perfis || [],
    plano: cfg.plano === undefined ? 'master' : cfg.plano,
    dentro: (cfg.dentro || []).slice(),      // identities dentro da sala no LiveKit
    quebrado: cfg.quebrado || {},            // { members: true } = tabela fora do ar
    lk: { removidos: [], apagadas: [], mutadas: [], atualizadas: [], criadas: [], listou: [] },
  };

  const resp = (corpo, status) => ({
    ok: (status || 200) < 400,
    status: status || 200,
    json: async () => corpo,
    text: async () => JSON.stringify(corpo),
    headers: { get: () => null },
  });

  const valorDe = (qs, chave) => {
    const m = new RegExp('[?&]' + chave + '=([^&]*)').exec(qs);
    return m ? decodeURIComponent(m[1]) : null;
  };

  global.fetch = async (url, opt) => {
    url = String(url);
    opt = opt || {};
    const metodo = opt.method || 'GET';
    const corpo = opt.body ? JSON.parse(opt.body) : null;

    // ── LiveKit (twirp) ──────────────────────────────────────────────────
    const tw = /\/twirp\/livekit\.RoomService\/(\w+)$/.exec(url);
    if (tw) {
      const op = tw[1];
      estado.log.push('LK:' + op + (corpo && corpo.identity ? ':' + corpo.identity.slice(0, 8) : ''));
      if (op === 'ListRooms') {
        estado.lk.listou.push(corpo);
        const nomes = (corpo && corpo.names) || null;
        const todas = estado.rooms.map((r) => ({ name: r.slug, num_participants: r.slug === (cfg.salaViva || '') ? estado.dentro.length : estado.dentro.length }));
        return resp({ rooms: nomes ? todas.filter((r) => nomes.indexOf(r.name) >= 0) : todas });
      }
      if (op === 'ListParticipants') {
        return resp({
          participants: estado.dentro.map((id) => ({
            identity: id, name: 'P' + id.slice(0, 2), state: 'ACTIVE',
            metadata: JSON.stringify({ a: '', p: 'full' }),
            tracks: [{ sid: 'TR_' + id.slice(0, 4), type: 'AUDIO', source: 'MICROPHONE' }],
          })),
        });
      }
      if (op === 'CreateRoom') { estado.lk.criadas.push(corpo); return resp({}); }
      if (op === 'RemoveParticipant') {
        estado.lk.removidos.push(corpo.identity);
        estado.dentro = estado.dentro.filter((x) => x !== corpo.identity);
        return resp({});
      }
      if (op === 'DeleteRoom') { estado.lk.apagadas.push(corpo.room); return resp({}); }
      if (op === 'MutePublishedTrack') { estado.lk.mutadas.push(corpo); return resp({}); }
      if (op === 'UpdateParticipant') { estado.lk.atualizadas.push(corpo); return resp({}); }
      return resp({}, 404);
    }

    // ── Supabase ─────────────────────────────────────────────────────────
    if (url.startsWith(SU + '/auth/v1/user')) return resp({ id: EU, email: 'ana@test.com' });
    if (url.startsWith(SU + '/rest/v1/subscribers')) {
      return resp(estado.plano ? [{ plan: estado.plano, plan_expires_at: null, is_manual: true }] : []);
    }
    if (url.startsWith(SU + '/rest/v1/community_profiles')) {
      const uid = valorDe(url, 'user_id');
      if (uid && uid.startsWith('eq.')) {
        const alvo = uid.slice(3);
        if (alvo === EU) return resp(estado.perfil ? [estado.perfil] : []);
        const p = estado.perfis.find((x) => x.user_id === alvo);
        return resp(p ? [p] : []);
      }
      return resp(estado.perfis);
    }
    if (url.startsWith(SU + '/rest/v1/community_voice_rooms')) {
      estado.log.push('DB:rooms:' + metodo);
      if (metodo === 'GET') {
        const slug = valorDe(url, 'slug');
        if (slug) return resp(estado.rooms.filter((r) => r.slug === slug.slice(3)));
        const dono = valorDe(url, 'owner_id');
        if (dono && dono.startsWith('eq.')) return resp(estado.rooms.filter((r) => r.owner_id === dono.slice(3) && r.aberta));
        return resp(estado.rooms.filter((r) => r.aberta && r.owner_id));
      }
      if (metodo === 'POST') {
        if (estado.rooms.some((r) => r.owner_id === corpo.owner_id && r.aberta)) return resp({ message: 'duplicate' }, 409);
        const nova = Object.assign({ id: 'nova-' + estado.rooms.length }, corpo);
        estado.rooms.push(nova);
        return resp([nova]);
      }
      if (metodo === 'PATCH') {
        const id = (valorDe(url, 'id') || '').slice(3);
        const r = estado.rooms.find((x) => x.id === id);
        if (r) Object.assign(r, corpo);
        return resp([r || {}]);
      }
    }
    if (url.startsWith(SU + '/rest/v1/community_voice_members')) {
      if (estado.quebrado.members) return resp({ message: 'off' }, 500);
      estado.log.push('DB:members:' + metodo);
      if (metodo === 'GET') {
        // O endpoint usa `eq.` e `in.` nos DOIS campos-chave, em combinações
        // diferentes (um membro; os expulsos de uma sala; as minhas linhas em
        // várias salas). Um filtro genérico cobre as três sem chutar qual é.
        const filtro = (campo) => {
          const v = valorDe(url, campo);
          if (!v) return null;
          if (v.startsWith('eq.')) return (x) => x === v.slice(3);
          if (v.startsWith('in.')) { const ids = v.slice(4, -1).split(','); return (x) => ids.indexOf(x) >= 0; }
          return null;
        };
        const fRoom = filtro('room_id');
        const fUser = filtro('user_id');
        const soExpulsos = url.indexOf('expulso_ate=gt.') >= 0;
        const agora = Date.now();
        return resp(estado.members.filter((m) => (!fRoom || fRoom(m.room_id))
          && (!fUser || fUser(m.user_id))
          && (!soExpulsos || (m.expulso_ate && new Date(m.expulso_ate).getTime() > agora))));
      }
      if (metodo === 'POST') {
        const ja = estado.members.find((m) => m.room_id === corpo.room_id && m.user_id === corpo.user_id);
        if (ja) Object.assign(ja, corpo);
        else estado.members.push(Object.assign({ falhas: 0 }, corpo));
        return resp({}, 201);
      }
    }
    if (url.startsWith(SU + '/rest/v1/blue_notificacoes')) return resp([]);
    throw new Error('fetch não previsto no teste: ' + url);
  };
  return estado;
}

function resFalso() {
  const r = { code: 0, corpo: null };
  r.setHeader = () => r;
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.corpo = b; return r; };
  r.end = () => r;
  return r;
}

async function chamar(acao, extra) {
  const res = resFalso();
  await handler({ method: 'POST', query: {}, body: Object.assign({ action: acao, token: 'tok' }, extra || {}) }, res);
  return res;
}

const SALA_PRIVADA = {
  id: SALA_ID, slug: 'sv-abc123def456', titulo: 'Papo de edição',
  owner_id: OUTRO, senha_hash: null, senha_versao: 1, aberta: true,
};
const comSenha = (senha, extra) => Object.assign({}, SALA_PRIVADA, { senha_hash: I.hashSenha(senha) }, extra || {});

// ═══ 1 — A SENHA ═════════════════════════════════════════════════════════

test('a senha nunca é guardada: o que vai pro banco é scrypt com sal por sala', () => {
  const h = I.hashSenha('segredo-do-grupo');
  assert.match(h, /^scrypt\$\d+\$[a-f0-9]+\$[a-f0-9]+$/, 'e o formato é o que o CHECK do SQL exige');
  assert.equal(h.includes('segredo-do-grupo'), false, 'a senha em texto não pode aparecer em lugar nenhum');
  assert.notEqual(I.hashSenha('igual'), I.hashSenha('igual'), 'sal por sala: senhas iguais viram hashes diferentes');
  assert.equal(I.conferirSenha('segredo-do-grupo', h), true);
  assert.equal(I.conferirSenha('segredo-do-grup', h), false);
  assert.equal(I.conferirSenha('', h), false);
});

test('hash quebrado/forjado não vira "senha certa"', () => {
  // A conferência lê o formato antes de gastar CPU: lixo tem que dar FALSO, e
  // não estourar — senão um registro corrompido derruba a entrada da sala.
  for (const lixo of ['', 'lixo', 'scrypt$x$y$z', 'scrypt$16384$zz$zz', 'scrypt$99$aa$bb', null, undefined]) {
    assert.equal(I.conferirSenha('qualquer', lixo), false, 'formato inválido: ' + lixo);
  }
});

test('a conferência não usa === de string (comparação em tempo constante)', () => {
  const trecho = API.slice(API.indexOf('function conferirSenha'), API.indexOf('function slugNovo'));
  assert.match(trecho, /timingSafeEqual/,
    'senha errada e senha certa têm que demorar o mesmo tanto — do outro lado tem gente com cronômetro');
});

test('o nome da sala no LiveKit não carrega nada do dono', () => {
  const s = I.slugNovo();
  assert.match(s, /^sv-[a-f0-9]{12}$/);
  assert.match(s, /^[a-z0-9-]{4,40}$/, 'e bate com o CHECK do slug no SQL');
  assert.notEqual(I.slugNovo(), I.slugNovo());
});

// ═══ 2 — O PORTÃO: senha, expulsos e a ordem entre eles ══════════════════

test('senha errada: 401, sem crachá, e o contador de erros SOBE', async () => {
  const amb = ambiente({ rooms: [comSenha('abre-te-sesamo')] });
  const r = await chamar('entrar', { sala: SALA_PRIVADA.slug, senha: 'chutei' });
  assert.equal(r.code, 401);
  assert.equal(r.corpo.pedeSenha, true);
  assert.equal(r.corpo.token, undefined, 'crachá nenhum sai daqui com senha errada');
  assert.equal(amb.members[0].falhas, 1, 'sem contar erro, senha de 4 dígitos cai em segundos');
});

test('cinco erros trancam a sala por um tempo — e o tranco vem ANTES de conferir', async () => {
  const amb = ambiente({
    rooms: [comSenha('abre-te-sesamo')],
    members: [{ room_id: SALA_ID, user_id: EU, falhas: 4 }],
  });
  const r5 = await chamar('entrar', { sala: SALA_PRIVADA.slug, senha: 'errada' });
  assert.equal(r5.code, 401);
  assert.ok(amb.members[0].falhas_ate, 'no 5º erro nasce a espera');
  // Agora nem a senha CERTA passa enquanto o castigo corre: quem estava
  // tentando adivinhar não ganha uma janela por acertar no fim.
  const r6 = await chamar('entrar', { sala: SALA_PRIVADA.slug, senha: 'abre-te-sesamo' });
  assert.equal(r6.code, 429);
  assert.equal(r6.corpo.travado, true);
});

test('senha certa libera, e a liberação vale a VERSÃO da senha', async () => {
  const amb = ambiente({ rooms: [comSenha('abre-te-sesamo')] });
  const r = await chamar('entrar', { sala: SALA_PRIVADA.slug, senha: 'abre-te-sesamo' });
  assert.equal(r.code, 200);
  assert.ok(r.corpo.token, 'crachá emitido');
  assert.equal(r.corpo.privada, true);
  assert.equal(amb.members[0].liberado_versao, 1, 'não precisa digitar a senha a cada F5');
  assert.equal(amb.members[0].falhas, 0);
});

test('trocar a senha derruba as liberações antigas (é pra isso que a versão existe)', async () => {
  // A pessoa foi liberada na versão 1; o dono trocou a senha (versão 2).
  const amb = ambiente({
    rooms: [comSenha('nova-senha', { senha_versao: 2 })],
    members: [{ room_id: SALA_ID, user_id: EU, liberado_versao: 1 }],
  });
  const r = await chamar('entrar', { sala: SALA_PRIVADA.slug });
  assert.equal(r.code, 401);
  assert.equal(r.corpo.pedeSenha, true, 'liberação velha não vale senha nova');
  const ok = await chamar('entrar', { sala: SALA_PRIVADA.slug, senha: 'nova-senha' });
  assert.equal(ok.code, 200);
});

test('EXPULSO não entra — e descobre isso ANTES de errar senha nenhuma', async () => {
  const amb = ambiente({
    rooms: [comSenha('abre-te-sesamo')],
    members: [{ room_id: SALA_ID, user_id: EU, expulso_ate: new Date(Date.now() + 3600000).toISOString() }],
  });
  const r = await chamar('entrar', { sala: SALA_PRIVADA.slug, senha: 'abre-te-sesamo' });
  assert.equal(r.code, 403);
  assert.equal(r.corpo.expulso, true);
  assert.equal(r.corpo.token, undefined, 'acertar a senha NÃO desfaz uma expulsão');
  assert.equal(amb.lk.criadas.length, 0, 'e nem a sala chega a ser tocada no LiveKit');
});

test('expulsão VENCE: passado o prazo, a pessoa entra de novo', async () => {
  ambiente({
    rooms: [Object.assign({}, SALA_PRIVADA)],
    members: [{ room_id: SALA_ID, user_id: EU, expulso_ate: new Date(Date.now() - 1000).toISOString() }],
  });
  const r = await chamar('entrar', { sala: SALA_PRIVADA.slug });
  assert.equal(r.code, 200, 'expulsão eterna vira lista de inimigos que ninguém limpa');
});

test('quem manda na sala não digita a própria senha', async () => {
  ambiente({ rooms: [comSenha('abre-te-sesamo', { owner_id: EU })] });
  const dono = await chamar('entrar', { sala: SALA_PRIVADA.slug });
  assert.equal(dono.code, 200);
  assert.equal(dono.corpo.papel, 'dono');

  ambiente({
    rooms: [comSenha('abre-te-sesamo')],
    members: [{ room_id: SALA_ID, user_id: EU, papel: 'co' }],
  });
  const co = await chamar('entrar', { sala: SALA_PRIVADA.slug });
  assert.equal(co.code, 200);
  assert.equal(co.corpo.papel, 'co');
});

test('sala encerrada não deixa entrar, e sala inexistente não vira sala nova', async () => {
  ambiente({ rooms: [Object.assign({}, SALA_PRIVADA, { aberta: false })] });
  const f = await chamar('entrar', { sala: SALA_PRIVADA.slug });
  assert.equal(f.code, 410);
  assert.equal(f.corpo.encerrada, true);

  ambiente({ rooms: [] });
  const g = await chamar('entrar', { sala: 'sv-naoexiste00' });
  assert.equal(g.code, 404);
  assert.equal(g.corpo.sumiu, true);
});

// ═══ 3 — A REMOÇÃO DE VERDADE (o buraco que a feature existe pra tapar) ══

test('EXPULSAR: a lista é gravada ANTES de mandar o LiveKit remover', async () => {
  // A ordem não é estilo. As duas falhas possíveis não custam o mesmo:
  //   banco ok + remoção falhou → ela fica por ora, mas não VOLTA;
  //   remoção ok + banco falhou → ela volta em 3 segundos, pra sempre.
  const amb = ambiente({
    rooms: [Object.assign({}, SALA_PRIVADA, { owner_id: EU })],
    dentro: [EU, OUTRO],
    perfis: [{ user_id: OUTRO, display_name: 'Bruno', is_moderator: false }],
  });
  const r = await chamar('expulsar', { sala: SALA_PRIVADA.slug, alvo: OUTRO });
  assert.equal(r.code, 200);
  assert.equal(r.corpo.tirou, true);

  const iBanco = amb.log.indexOf('DB:members:POST');
  const iRemove = amb.log.findIndex((l) => l.startsWith('LK:RemoveParticipant'));
  assert.ok(iBanco >= 0 && iRemove >= 0, 'as duas coisas têm que acontecer');
  assert.ok(iBanco < iRemove, 'gravar a expulsão vem primeiro — o erro barato primeiro');
  assert.deepEqual(amb.lk.removidos, [OUTRO], 'e o RemoveParticipant é o que TIRA de fato');

  const m = amb.members.find((x) => x.user_id === OUTRO);
  assert.ok(new Date(m.expulso_ate).getTime() > Date.now(), 'ficou na lista de expulsos');
  assert.equal(m.papel, null, 'expulso não pode voltar promovido');
  assert.equal(m.liberado_versao, null, 'e nem já liberado pela senha');
});

test('EXPULSAR: se o banco não aceitou, o LiveKit nem é chamado', async () => {
  const amb = ambiente({
    rooms: [Object.assign({}, SALA_PRIVADA, { owner_id: EU })],
    dentro: [EU, OUTRO],
    quebrado: { members: true },
  });
  const r = await chamar('expulsar', { sala: SALA_PRIVADA.slug, alvo: OUTRO });
  assert.equal(r.code, 500);
  assert.equal(amb.lk.removidos.length, 0,
    'remover sem registrar é a pior das duas falhas: ela volta em 3 segundos');
});

test('a VARREDURA tira quem está dentro com crachá guardado', async () => {
  // O cenário real: Bruno foi expulso, guardou o crachá (vale 2h e o LiveKit
  // renova sozinho) e reconectou DIRETO no SFU, sem passar pelo endpoint.
  // Ninguém do lado de cá saberia — exceto pela varredura.
  const amb = ambiente({
    rooms: [Object.assign({}, SALA_PRIVADA, { owner_id: EU })],
    dentro: [OUTRO],
    members: [{ room_id: SALA_ID, user_id: OUTRO, expulso_ate: new Date(Date.now() + 3600000).toISOString() }],
  });
  const r = await chamar('guardar', { sala: SALA_PRIVADA.slug });
  assert.equal(r.code, 200);
  assert.equal(r.corpo.removidos, 1);
  assert.deepEqual(amb.lk.removidos, [OUTRO]);
});

test('o carimbo de atividade é AGUARDADO (em serverless, promise solta é descartada)', async () => {
  // Foi assim que 28 notificações de amizade viraram zero neste projeto: a
  // função retorna e o runtime corta a promise no meio. Sem o carimbo, uma sala
  // viva some da ordenação da lista.
  const amb = ambiente({ rooms: [Object.assign({}, SALA_PRIVADA)] });
  await chamar('entrar', { sala: SALA_PRIVADA.slug });
  assert.ok(amb.rooms[0].ultima_entrada, 'o PATCH tem que ter chegado ANTES da resposta sair');
  const trecho = API.slice(API.indexOf("if (action === 'entrar')"), API.indexOf('crachaParticipante({ id: userId'));
  assert.match(trecho, /await Promise\.all\(\[/, 'e ele tem que estar dentro de um await, não solto');
});

test('a vaga liberada pela varredura conta na hora (não vira "sala cheia")', async () => {
  const dez = [];
  for (let i = 0; i < 10; i++) dez.push('00000000-0000-4000-8000-00000000000' + i.toString(16));
  const amb = ambiente({
    rooms: [Object.assign({}, SALA_PRIVADA)],
    dentro: dez,
    members: [{ room_id: SALA_ID, user_id: dez[0], expulso_ate: new Date(Date.now() + 3600000).toISOString() }],
  });
  const r = await chamar('entrar', { sala: SALA_PRIVADA.slug });
  assert.equal(r.code, 200, 'levar "sala cheia" no instante em que uma vaga foi aberta pra você é o pior tipo de recusa');
  assert.equal(r.corpo.n, 9);
});

test('a varredura roda TAMBÉM em toda entrada (a lista já está na mão)', async () => {
  const amb = ambiente({
    rooms: [Object.assign({}, SALA_PRIVADA)],
    dentro: [TERCEIRO],
    members: [{ room_id: SALA_ID, user_id: TERCEIRO, expulso_ate: new Date(Date.now() + 3600000).toISOString() }],
  });
  const r = await chamar('entrar', { sala: SALA_PRIVADA.slug });
  assert.equal(r.code, 200, 'quem está entrando não é o expulso — ele entra normal');
  assert.deepEqual(amb.lk.removidos, [TERCEIRO], 'e o expulso que estava dentro sai');
});

test('a varredura NÃO tira ninguém quando não há expulso (e nem chama o LiveKit à toa)', async () => {
  const amb = ambiente({
    rooms: [Object.assign({}, SALA_PRIVADA, { owner_id: EU })],
    dentro: [EU, OUTRO],
    members: [{ room_id: SALA_ID, user_id: OUTRO, papel: 'co' }],
  });
  await chamar('guardar', { sala: SALA_PRIVADA.slug });
  assert.equal(amb.lk.removidos.length, 0);
});

test('banco fora do ar não vira "não tem expulso nenhum"', async () => {
  const amb = ambiente({
    rooms: [Object.assign({}, SALA_PRIVADA, { owner_id: EU })],
    dentro: [EU, OUTRO],
    quebrado: { members: true },
  });
  const r = await chamar('guardar', { sala: SALA_PRIVADA.slug });
  // O papel de dono sai do owner_id da sala, então a autorização passa mesmo
  // com a tabela de membros fora do ar — mas a varredura se declara não-feita.
  assert.equal(r.corpo.varreu, false, 'não saber é diferente de não ter');
  assert.equal(amb.lk.removidos.length, 0);
});

test('ENCERRAR apaga a sala no LiveKit (é o que tira TODO MUNDO de uma vez)', async () => {
  const amb = ambiente({ rooms: [Object.assign({}, SALA_PRIVADA, { owner_id: EU })], dentro: [EU, OUTRO] });
  const r = await chamar('encerrar', { sala: SALA_PRIVADA.slug });
  assert.equal(r.code, 200);
  assert.equal(r.corpo.esvaziou, true);
  assert.deepEqual(amb.lk.apagadas, [SALA_PRIVADA.slug]);
  assert.equal(amb.rooms[0].aberta, false, 'e a sala fecha pra novas entradas');
  const iBanco = amb.log.lastIndexOf('DB:rooms:PATCH');
  const iDel = amb.log.findIndex((l) => l.startsWith('LK:DeleteRoom'));
  assert.ok(iBanco < iDel, 'fechar a porta antes de esvaziar: se o DeleteRoom falhar, ninguém entra por engano');
});

// ═══ 4 — HIERARQUIA: quem manda em quem ═════════════════════════════════

test('co-anfitrião NÃO expulsa co-anfitrião (empate não dá poder)', async () => {
  const amb = ambiente({
    rooms: [Object.assign({}, SALA_PRIVADA)],
    dentro: [EU, OUTRO],
    members: [
      { room_id: SALA_ID, user_id: EU, papel: 'co' },
      { room_id: SALA_ID, user_id: OUTRO, papel: 'co' },
    ],
    perfis: [{ user_id: OUTRO, display_name: 'Bruno', is_moderator: false }],
  });
  const r = await chamar('expulsar', { sala: SALA_PRIVADA.slug, alvo: OUTRO });
  assert.equal(r.code, 403);
  assert.equal(amb.lk.removidos.length, 0);
});

test('co-anfitrião NÃO expulsa o dono, e o dono NÃO expulsa o moderador do site', async () => {
  ambiente({
    rooms: [Object.assign({}, SALA_PRIVADA)],
    members: [{ room_id: SALA_ID, user_id: EU, papel: 'co' }],
    perfis: [{ user_id: OUTRO, display_name: 'Dono', is_moderator: false }],
  });
  const a = await chamar('expulsar', { sala: SALA_PRIVADA.slug, alvo: OUTRO });
  assert.equal(a.code, 403, 'o dono da sala é o topo dela');

  ambiente({
    rooms: [Object.assign({}, SALA_PRIVADA, { owner_id: EU })],
    perfis: [{ user_id: OUTRO, display_name: 'Mod', is_moderator: true }],
  });
  const b = await chamar('expulsar', { sala: SALA_PRIVADA.slug, alvo: OUTRO });
  assert.equal(b.code, 403, 'a moderação da Comunidade não é expulsável pelo dono da sala');
});

test('quem não manda na sala não expulsa ninguém', async () => {
  const amb = ambiente({
    rooms: [Object.assign({}, SALA_PRIVADA)],
    dentro: [EU, TERCEIRO],
    perfis: [{ user_id: TERCEIRO, display_name: 'Carla', is_moderator: false }],
  });
  const r = await chamar('expulsar', { sala: SALA_PRIVADA.slug, alvo: TERCEIRO });
  assert.equal(r.code, 403);
  assert.equal(amb.lk.removidos.length, 0);
});

test('ninguém se expulsa (isso é sair), e alvo inválido não vira chamada ao LiveKit', async () => {
  const amb = ambiente({ rooms: [Object.assign({}, SALA_PRIVADA, { owner_id: EU })], dentro: [EU] });
  const eu = await chamar('expulsar', { sala: SALA_PRIVADA.slug, alvo: EU });
  assert.equal(eu.code, 400);
  const lixo = await chamar('expulsar', { sala: SALA_PRIVADA.slug, alvo: 'nao-e-uuid' });
  assert.equal(lixo.code, 400);
  assert.equal(amb.lk.removidos.length, 0);
});

test('só o DONO promove co-anfitrião — e a promoção chega na hora a quem está dentro', async () => {
  const amb = ambiente({
    rooms: [Object.assign({}, SALA_PRIVADA, { owner_id: EU })],
    dentro: [EU, OUTRO],
    perfis: [{ user_id: OUTRO, display_name: 'Bruno', is_moderator: false }],
  });
  const r = await chamar('papel', { sala: SALA_PRIVADA.slug, alvo: OUTRO, papel: 'co' });
  assert.equal(r.code, 200);
  assert.equal(amb.members.find((m) => m.user_id === OUTRO).papel, 'co');
  assert.equal(amb.lk.atualizadas.length, 1, 'UpdateParticipant reescreve o crachá vivo dela');
  assert.match(amb.lk.atualizadas[0].metadata, /"h":"co"/,
    'é o que faz a coroa aparecer pra todo mundo sem ninguém recarregar nada');

  // Co-anfitrião NÃO promove ninguém: ele comanda a conversa, não a hierarquia.
  const amb2 = ambiente({
    rooms: [Object.assign({}, SALA_PRIVADA)],
    members: [{ room_id: SALA_ID, user_id: EU, papel: 'co' }],
    perfis: [{ user_id: TERCEIRO, display_name: 'Carla', is_moderator: false }],
  });
  const r2 = await chamar('papel', { sala: SALA_PRIVADA.slug, alvo: TERCEIRO, papel: 'co' });
  assert.equal(r2.code, 403);
  assert.equal(amb2.members.filter((m) => m.papel === 'co').length, 1);
});

test('SILENCIAR fecha o microfone no SERVIDOR (não é um pedido ao navegador dela)', async () => {
  const amb = ambiente({
    rooms: [Object.assign({}, SALA_PRIVADA, { owner_id: EU })],
    dentro: [EU, OUTRO],
    perfis: [{ user_id: OUTRO, display_name: 'Bruno', is_moderator: false }],
  });
  const r = await chamar('silenciar', { sala: SALA_PRIVADA.slug, alvo: OUTRO });
  assert.equal(r.code, 200);
  assert.equal(amb.lk.mutadas.length, 1);
  assert.equal(amb.lk.mutadas[0].muted, true);
  assert.equal(amb.lk.mutadas[0].identity, OUTRO);
});

test('PERDOAR é do dono, e limpa a lista de expulsos daquela pessoa', async () => {
  const amb = ambiente({
    rooms: [Object.assign({}, SALA_PRIVADA, { owner_id: EU })],
    members: [{ room_id: SALA_ID, user_id: OUTRO, expulso_ate: new Date(Date.now() + 3600000).toISOString() }],
    perfis: [{ user_id: OUTRO, display_name: 'Bruno', is_moderator: false }],
  });
  const r = await chamar('perdoar', { sala: SALA_PRIVADA.slug, alvo: OUTRO });
  assert.equal(r.code, 200);
  assert.equal(amb.members.find((m) => m.user_id === OUTRO).expulso_ate, null);
});

// ═══ 5 — CRIAR, LISTAR e a sala PÚBLICA ══════════════════════════════════

test('criar sala: uma por dono, e o duplo-clique devolve a que existe', async () => {
  const amb = ambiente({ rooms: [] });
  const r = await chamar('criar', { titulo: 'Papo de edição', senha: 'segredo123' });
  assert.equal(r.code, 200);
  assert.ok(r.corpo.slug);
  assert.equal(r.corpo.comSenha, true);
  assert.equal(amb.rooms.length, 1);
  assert.notEqual(amb.rooms[0].senha_hash, 'segredo123', 'a senha não pode ir em texto pro banco');
  assert.match(amb.rooms[0].senha_hash, /^scrypt\$/);

  const r2 = await chamar('criar', { titulo: 'Outra sala' });
  assert.equal(r2.code, 200);
  assert.equal(r2.corpo.jaTinha, true, 'erro cru num duplo-clique é erro que a pessoa não entende');
  assert.equal(amb.rooms.length, 1);
});

test('criar sala recusa nome vazio, senha curta e nome que não passa na moderação', async () => {
  ambiente({ rooms: [] });
  assert.equal((await chamar('criar', { titulo: 'x' })).code, 400);
  assert.equal((await chamar('criar', { titulo: 'Sala boa', senha: '12' })).code, 400);
  assert.equal((await chamar('criar', { titulo: 'sala de porn' })).code, 400);
});

test('a lista de salas não vaza senha nem hash, e marca quem está barrado', async () => {
  const amb = ambiente({
    rooms: [comSenha('abre-te-sesamo')],
    members: [{ room_id: SALA_ID, user_id: EU, expulso_ate: new Date(Date.now() + 3600000).toISOString() }],
    perfis: [{ user_id: OUTRO, display_name: 'Bruno', avatar_url: null }],
    dentro: [OUTRO],
  });
  const r = await chamar('salas');
  assert.equal(r.code, 200);
  const s = r.corpo.salas[0];
  assert.equal(s.comSenha, true);
  assert.equal(s.expulso, true, 'descobrir a expulsão só no clique é humilhação com passo extra');
  assert.equal(s.liberado, false);
  assert.equal(JSON.stringify(r.corpo).includes('scrypt$'), false, 'hash de senha não sai deste endpoint');
  assert.equal(JSON.stringify(r.corpo).includes('senha_hash'), false);
});

test('sem o SQL rodado, a seção de salas privadas simplesmente não existe', async () => {
  // O SQL é colado à mão no painel do Supabase. Enquanto ninguém rodou, a
  // resposta diz `semTabela` e o front esconde tudo — botão que dá erro no
  // clique é pior que botão que não aparece.
  const amb = ambiente({ rooms: [] });
  const fetchOriginal = global.fetch;
  global.fetch = async (url, opt) => {
    if (String(url).startsWith(SU + '/rest/v1/community_voice_rooms')) {
      return { ok: false, status: 404, json: async () => ({}), text: async () => '{}', headers: { get: () => null } };
    }
    return fetchOriginal(url, opt);
  };
  const r = await chamar('salas');
  assert.equal(r.code, 200);
  assert.equal(r.corpo.semTabela, true);
  assert.equal(r.corpo.podeCriar, false);
  assert.deepEqual(r.corpo.salas, []);
  assert.match(FRONT, /if \(S\.semTabela \|\| !S\.salasOk\) \{ box\.style\.display = 'none'; return; \}/);
});

test('a sala PÚBLICA continua funcionando sem linha nenhuma no banco', async () => {
  // Regressão que importa mais que a feature: o que está no ar não pode
  // depender de alguém colar um SQL no painel pra continuar de pé.
  const amb = ambiente({ rooms: [], dentro: [] });
  const r = await chamar('entrar', {});
  assert.equal(r.code, 200);
  assert.ok(r.corpo.token);
  assert.equal(r.corpo.sala, I.SALA);
  assert.equal(r.corpo.privada, false);
  assert.equal(r.corpo.papel, null);
});

test('com linha no banco, a sala pública ganha lista de expulsos e varredura', async () => {
  // É o mesmo buraco, no lugar mais movimentado: até aqui NADA tirava ninguém
  // da sala onde a Comunidade inteira conversa.
  const publica = { id: 'pub-1', slug: I.SALA, titulo: 'Sala aberta', owner_id: null, senha_hash: null, senha_versao: 1, aberta: true };
  const amb = ambiente({
    rooms: [publica],
    dentro: [OUTRO],
    members: [{ room_id: 'pub-1', user_id: OUTRO, expulso_ate: new Date(Date.now() + 3600000).toISOString() }],
    perfil: { user_id: EU, display_name: 'Ana', is_moderator: true, plan: 'master' },
  });
  const r = await chamar('entrar', {});
  assert.equal(r.code, 200);
  assert.equal(r.corpo.privada, false, 'ela não vira uma sala privada por ter linha');
  assert.equal(r.corpo.papel, 'mod', 'mas o moderador do site passa a mandar nela');
  assert.deepEqual(amb.lk.removidos, [OUTRO], 'e o expulso que estava dentro sai');
});

test('a sala pública não ganha senha nem é encerrável', async () => {
  const publica = { id: 'pub-1', slug: I.SALA, titulo: 'Sala aberta', owner_id: null, aberta: true, senha_versao: 1 };
  ambiente({ rooms: [publica], perfil: { user_id: EU, display_name: 'Ana', is_moderator: true, plan: 'master' } });
  assert.equal((await chamar('sala-editar', { sala: I.SALA, senha: '123456' })).code, 403);
  assert.equal((await chamar('encerrar', { sala: I.SALA })).code, 403);
});

test('trocar a senha sobe a versão e DIZ que não tira quem já está dentro', async () => {
  const amb = ambiente({ rooms: [comSenha('velha', { owner_id: EU })] });
  const r = await chamar('sala-editar', { sala: SALA_PRIVADA.slug, senha: 'nova-senha' });
  assert.equal(r.code, 200);
  assert.equal(amb.rooms[0].senha_versao, 2);
  assert.match(r.corpo.aviso, /já está na sala continua nela/i,
    'prometer que a senha nova esvazia a sala seria construir por cima do buraco');
  assert.equal(amb.lk.removidos.length, 0, 'e de fato ela não tira ninguém');
});

test('tirar a senha é diferente de não mexer nela', async () => {
  const amb = ambiente({ rooms: [comSenha('velha', { owner_id: EU })] });
  await chamar('sala-editar', { sala: SALA_PRIVADA.slug, titulo: 'Outro nome' });
  assert.ok(amb.rooms[0].senha_hash, 'sem mandar `senha`, a senha fica como está');
  assert.equal(amb.rooms[0].titulo, 'Outro nome');
  await chamar('sala-editar', { sala: SALA_PRIVADA.slug, senha: '' });
  assert.equal(amb.rooms[0].senha_hash, null, 'string vazia é a ordem de ABRIR a sala');
});

// ═══ 6 — O PORTÃO DE PLANO CONTINUA VALENDO PRAS SALAS NOVAS ════════════

test('quem não é assinante não cria, não lista e não entra em sala nenhuma', async () => {
  ambiente({ rooms: [Object.assign({}, SALA_PRIVADA)], plano: null, perfil: { user_id: EU, display_name: 'Ana', is_moderator: false } });
  for (const acao of ['salas', 'criar', 'entrar', 'expulsar', 'guardar']) {
    const r = await chamar(acao, { sala: SALA_PRIVADA.slug, titulo: 'x', alvo: OUTRO });
    assert.equal(r.code, 403, acao + ' tinha que parar no portão de plano');
    assert.equal(r.corpo.upgrade, true);
  }
});

test('banido da Comunidade não entra nas salas privadas também', async () => {
  ambiente({
    rooms: [Object.assign({}, SALA_PRIVADA)],
    perfil: { user_id: EU, display_name: 'Ana', is_moderator: false, plan: 'master', banned: true },
  });
  const r = await chamar('entrar', { sala: SALA_PRIVADA.slug });
  assert.equal(r.code, 403);
  assert.equal(r.corpo.banned, true);
});

// ═══ 7 — O FRONT ════════════════════════════════════════════════════════

// O arquivo real, dentro de um DOM mínimo. Não simula rede: o que se prova
// aqui é a REGRA de desenho — quem vê o ⋯, o que o menu oferece, e que a senha
// de uma sala nunca vai parar em outra.
function carregarFront() {
  const nos = new Map();
  const criarNo = (tag) => {
    const el = {
      tagName: String(tag || 'div').toUpperCase(), children: [], style: {}, dataset: {},
      _classes: new Set(), _attrs: {}, _html: '', textContent: '', value: '',
      addEventListener() {}, removeEventListener() {}, remove() {}, focus() {}, contains: () => false,
      appendChild(c) { this.children.push(c); return c; },
      insertBefore(c) { this.children.push(c); return c; },
      querySelector: () => null,
      querySelectorAll: () => [],
      getBoundingClientRect: () => ({ left: 0, top: 0, bottom: 0, right: 0 }),
      closest: () => null,
      setAttribute(k, v) { this._attrs[k] = v; if (k === 'id') { this.id = v; nos.set(v, this); } },
      getAttribute(k) { return this._attrs[k] === undefined ? null : this._attrs[k]; },
    };
    el.classList = {
      add: (c) => el._classes.add(c), remove: (c) => el._classes.delete(c),
      toggle: (c, v) => (v ? el._classes.add(c) : el._classes.delete(c)),
      contains: (c) => el._classes.has(c),
    };
    Object.defineProperty(el, 'innerHTML', { get() { return el._html; }, set(v) { el._html = String(v); } });
    Object.defineProperty(el, 'firstElementChild', { get() { return el.children[0] || null; } });
    Object.defineProperty(el, 'id', {
      get() { return el._attrs.id || ''; },
      set(v) { el._attrs.id = v; nos.set(v, el); },
      configurable: true,
    });
    return el;
  };
  const document = {
    readyState: 'complete',
    head: criarNo('head'), body: criarNo('body'), documentElement: criarNo('html'),
    hidden: false,
    createElement: criarNo,
    getElementById: (id) => nos.get(id) || null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {}, removeEventListener() {},
  };
  const ctx = {
    window: { addEventListener() {}, removeEventListener() {}, PointerEvent: function () {}, location: { href: 'https://x/comunidade', origin: 'https://x', pathname: '/comunidade', search: '' }, innerWidth: 900, innerHeight: 700 },
    document, navigator: { mediaDevices: {} }, localStorage: { getItem: () => 'tok', setItem() {} },
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {}, console,
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    // O arquivo observa o DOM esperando as âncoras da Comunidade aparecerem.
    // Sem isto o observador estoura DEPOIS do teste terminar, e o erro chega
    // como unhandledRejection — ruído que ensina a ignorar vermelho.
    MutationObserver: function () { this.observe = () => {}; this.disconnect = () => {}; },
    Promise, Map, Set, Array, JSON, Date, Math, String, Number, Object, Boolean, RegExp, URL, Error,
  };
  ctx.window.document = document;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInNewContext(FRONT, ctx, { filename: 'sala-voz.js' });
  return { SV: ctx.window.SalaVoz, S: ctx.window.SalaVoz._estado(), I: ctx.window.SalaVoz._interno, ctx };
}

test('FRONT: o ⋯ só aparece pra quem manda, e nunca sobre mim mesmo', () => {
  const { S, I } = carregarFront();
  S.entrei = true;
  S.cfg = { me: { id: 'eu' } };
  S.papel = 'dono';
  assert.equal(I.possoMexerEm('outro', { manda: null }), true);
  assert.equal(I.possoMexerEm('eu', { manda: null }), false, 'sobre mim, o botão é "Sair"');
  assert.equal(I.possoMexerEm('outro', { manda: 'dono' }), false);
  S.papel = 'co';
  assert.equal(I.possoMexerEm('outro', { manda: 'co' }), false, 'empate não dá poder');
  assert.equal(I.possoMexerEm('outro', { manda: null }), true);
  S.papel = null;
  assert.equal(I.possoMexerEm('outro', { manda: null }), false, 'quem não manda não vê comando nenhum');
});

test('FRONT: a régua de força é a MESMA do servidor', () => {
  const { I } = carregarFront();
  assert.ok(I.forcaDe('mod') > I.forcaDe('dono'));
  assert.ok(I.forcaDe('dono') > I.forcaDe('co'));
  assert.ok(I.forcaDe('co') > I.forcaDe(null));
  // E a do servidor, lida do arquivo: se uma mudar sem a outra, a tela passa a
  // desenhar botão que o servidor recusa.
  assert.match(API, /const forca = \(p\) => \(p === 'mod' \? 3 : p === 'dono' \? 2 : p === 'co' \? 1 : 0\)/);
});

test('FRONT: a tela NÃO autoriza nada — toda ação é decidida no servidor', () => {
  const trecho = FRONT.slice(FRONT.indexOf('function comandar'), FRONT.indexOf('function pedirExpulsao'));
  assert.match(trecho, /api\(acao, corpo\)/, 'o comando é um pedido, não uma decisão local');
  assert.match(trecho, /r\.d\.aviso \|\| sucesso/,
    'quando o servidor diz que fez pela metade, quem clicou tem que ler isso');
  assert.match(FRONT, /não AUTORIZA nada/, 'e quem mexer depois precisa saber disso');
});

test('FRONT: trocar de sala LIMPA a senha digitada', () => {
  const { S, I, ctx } = carregarFront();
  const campo = ctx.document.createElement('input');
  campo.id = 'svzSenha';
  campo.value = 'senha-da-sala-A';
  I.escolher('sv-outra-sala');
  assert.equal(campo.value, '', 'senha de uma sala não pode ser mandada pra outra por descuido de tela');
  assert.equal(S.escolhida, 'sv-outra-sala');
});

test('FRONT: a senha some do campo assim que serve', () => {
  const trecho = FRONT.slice(FRONT.indexOf('async function entrarInterno'));
  assert.match(trecho, /if \(campoSenha\) campoSenha\.value = '';/,
    'campo de senha preenchido numa aba esquecida é senha guardada em lugar nenhum bom');
});

test('FRONT: sala barrada nasce desabilitada, com o motivo escrito', () => {
  const { I } = carregarFront();
  const html = I.cardSalaHTML({ slug: 'sv-x', titulo: 'Fechada', dono: 'Bruno', comSenha: true, expulso: true, n: 3 });
  assert.match(html, /barrada/);
  assert.match(html, /disabled/);
  assert.match(html, /você foi removido desta sala/);
});

test('FRONT: o card da sala escapa título e nome do dono', () => {
  const { I } = carregarFront();
  const html = I.cardSalaHTML({ slug: 'sv-x', titulo: '<img src=x onerror=alert(1)>', dono: '<b>mal</b>', comSenha: false, n: 0 });
  assert.equal(html.includes('<img'), false);
  assert.equal(html.includes('<b>mal'), false);
  assert.match(html, /&lt;img/);
});

test('FRONT: a varredura só é pedida por quem manda, e com freio', () => {
  const trecho = FRONT.slice(FRONT.indexOf('function pedirVarredura'), FRONT.indexOf('// ── eventos do Room'));
  assert.match(trecho, /if \(!S\.entrei \|\| !S\.papel \|\| !S\.naSala\) return;/, 'quem não manda, não varre');
  assert.match(trecho, /VARREDURA_FREIO_MS/, 'três pessoas entrando juntas não podem virar três varreduras iguais');
  // E ela é disparada pelo EVENTO de chegada, não por um relógio: polling foi o
  // que encareceu a Vercel neste projeto antes.
  const ev = FRONT.slice(FRONT.indexOf('sala.on(E.ParticipantConnected'), FRONT.indexOf('sala.on(E.ParticipantDisconnected'));
  assert.match(ev, /pedirVarredura\(\)/);
  assert.equal(/setInterval\([^)]*[Vv]arredura/.test(FRONT), false, 'varredura não pode virar relógio');
});

test('FRONT: sair de uma sala apaga o meu papel nela', () => {
  const trecho = FRONT.slice(FRONT.indexOf('function sair(motivo)'), FRONT.indexOf('async function alternarMudo'));
  assert.match(trecho, /S\.naSala = null;\s*\n\s*S\.papel = null;/,
    'papel pendurado desenharia botão de expulsar numa sala em que eu nem estou');
  assert.match(trecho, /fecharMenu\(\)/);
});

test('FRONT: nada de prompt()/confirm() nativo — eles travam a thread e o áudio engasga', () => {
  const codigo = FRONT.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(codigo, /(^|[^.\w])prompt\s*\(/m);
  assert.doesNotMatch(codigo, /(^|[^.\w])confirm\s*\(/m);
  assert.match(FRONT, /id="svzConfCampo"/, 'a troca de senha acontece dentro do painel');
});

test('FRONT: sem a caixa de pergunta, uma ação COM campo não roda com valor vazio', () => {
  const trecho = FRONT.slice(FRONT.indexOf('function perguntar('), FRONT.indexOf('function abrirConfirmacaoSaida'));
  assert.match(trecho, /if \(pergunta\.campo\) \{ aviso\(/,
    'seguir com valor vazio significaria REMOVER a senha da sala porque a caixa não carregou');
});

test('FRONT: a versão do sala-voz.js no HTML subiu (a Vercel cacheia .js por 4h)', () => {
  const HTML = readFileSync(new URL('../../public/comunidade.html', import.meta.url), 'utf8');
  const m = /\/sala-voz\.js\?v=([\w.-]+)/.exec(HTML);
  assert.ok(m, 'o script tem que continuar versionado');
  assert.notEqual(m[1], '20260811lk2',
    'mexeu no arquivo sem bumpar a versão: o deploy vai pro ar e o navegador de quem já visitou roda o JS velho por 4h');
});

// ═══ 8 — O SQL ═══════════════════════════════════════════════════════════

test('SQL: a RLS liga COLADA no create table, nas duas tabelas', () => {
  for (const tab of ['community_voice_rooms', 'community_voice_members']) {
    const iCria = SQL.indexOf('create table if not exists ' + tab);
    const iRls = SQL.indexOf('alter table ' + tab + ' enable row level security');
    assert.ok(iCria >= 0 && iRls > iCria, tab + ': faltou ligar a RLS');
    const meio = SQL.slice(iCria, iRls);
    assert.equal(meio.split(';').length < 12, true,
      tab + ': a RLS ficou longe da criação — a tabela passa a existir aberta pro anon nesse intervalo');
    assert.match(SQL, new RegExp('alter table ' + tab + ' force  ?row level security'));
  }
});

test('SQL: o banco recusa senha em texto e sala sem ordem', () => {
  assert.match(SQL, /senha_hash is null or senha_hash ~ '\^scrypt/,
    'um update desatento gravando texto puro tem que estourar no banco, não virar vazamento');
  assert.match(SQL, /create unique index if not exists uq_cvroom_dono_aberta[\s\S]{0,120}where aberta/,
    'uma sala aberta por dono é regra do banco, não só da API');
});

test('SQL: a sala pública ganha linha, e o slug bate com o do código', () => {
  assert.match(SQL, /insert into community_voice_rooms[\s\S]{0,200}'sala-voz-comunidade'/);
  assert.match(SQL, /on conflict \(slug\) do nothing/, 'rodar o arquivo duas vezes não pode dar erro');
  assert.equal(I.SALA, 'sala-voz-comunidade', 'o slug do SQL e a constante do código são a mesma coisa');
});
