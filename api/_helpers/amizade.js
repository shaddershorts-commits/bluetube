// api/_helpers/amizade.js — regras puras das AMIZADES da Comunidade (CommonJS)
// ============================================================================
// Este arquivo não fala com o banco nem com a rede: recebe a linha do par
// (ou null) e devolve a DECISÃO. Toda a parte difícil de amizade mora aqui,
// porque é exatamente a parte que dá bug silencioso e que precisa de teste:
//
//   • uma linha por par, em ordem canônica (user_a < user_b) — nunca duas
//     metades que podem discordar entre si;
//   • pedido duplicado devolve o estado atual, não cria linha nova;
//   • A pede pra B e B pede pra A ⇒ amizade ACEITA (nunca dois pendentes);
//   • recusar/desfazer nunca apaga a linha — o histórico (strikes) é o que
//     impede o spam de "pede → recusa → pede de novo";
//   • quem recusou/desfez não leva strike (pode voltar atrás quando quiser);
//     quem foi recusado/desfeito leva carência escalonada e, no 3º strike,
//     bloqueio definitivo daquele lado.
//
// Schema em sql/comunidade_amizades.sql.

'use strict';

const STATUS = Object.freeze({
  PENDENTE: 'pending',
  ACEITO: 'accepted',
  RECUSADO: 'rejected',
  DESFEITO: 'removed',
});

const DIA_MS = 86400000;
const CARENCIA_RECUSA_DIAS = 7;   // base da carência; multiplica pelo nº de strikes
const MAX_STRIKES = 3;            // no 3º strike aquele lado fica bloqueado
const NOTIF_JANELA_HORAS = 24;    // dedupe da notificação (padrão do blue-interact)

const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ehUuid = (v) => typeof v === 'string' && RE_UUID.test(v.trim());
const norm = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : null);
const mesmo = (x, y) => !!norm(x) && norm(x) === norm(y);

// ── Ordem canônica ──────────────────────────────────────────────────────────
// Devolve { user_a, user_b } com user_a < user_b. Devolve null se algum id é
// inválido OU se são a mesma pessoa — amizade consigo mesmo não existe.
function parCanonico(x, y) {
  const a = norm(x), b = norm(y);
  if (!ehUuid(a) || !ehUuid(b) || a === b) return null;
  return a < b ? { user_a: a, user_b: b } : { user_a: b, user_b: a };
}

function ladoDe(linha, uid) {
  const u = norm(uid);
  if (!linha || !u) return null;
  if (norm(linha.user_a) === u) return 'a';
  if (norm(linha.user_b) === u) return 'b';
  return null;
}
const outroLado = (lado) => (lado === 'a' ? 'b' : 'a');
const idDoLado = (linha, lado) => (lado === 'a' ? linha.user_a : linha.user_b);

// O "outro" do par, do meu ponto de vista (null se eu não sou do par)
function outroDoPar(linha, eu) {
  const lado = ladoDe(linha, eu);
  return lado ? idDoLado(linha, outroLado(lado)) : null;
}

const strikesDe = (linha, lado) => Math.max(0, parseInt(linha?.['strikes_' + lado], 10) || 0);

function cooldownDe(linha, lado) {
  const v = linha?.['cooldown_' + lado];
  if (!v) return null;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
}

const estaBloqueado = (linha, lado) => strikesDe(linha, lado) >= MAX_STRIKES;

// Penalidade de quem foi RECUSADO ou teve a amizade DESFEITA pelo outro.
// Escalonada: 7 dias no 1º strike, 14 no 2º, e no 3º já bate no bloqueio.
function penalidade(linha, lado, agora) {
  const strikes = strikesDe(linha, lado) + 1;
  return {
    ['strikes_' + lado]: strikes,
    ['cooldown_' + lado]: new Date(agora.getTime() + CARENCIA_RECUSA_DIAS * DIA_MS * strikes).toISOString(),
  };
}

function diasRestantes(ateIso, agora) {
  const t = new Date(ateIso).getTime();
  if (!Number.isFinite(t)) return 0;
  return Math.max(1, Math.ceil((t - agora.getTime()) / DIA_MS));
}

// ── Estado de um par, do meu ponto de vista ─────────────────────────────────
// É isso que a UI consome: 'nenhum' | 'pendente_enviado' | 'pendente_recebido'
// | 'amigos'. `pode_pedir` já embute carência e bloqueio, para o botão não
// prometer uma ação que o backend vai recusar.
function estadoParaMim(linha, eu, agora = new Date()) {
  const lado = ladoDe(linha, eu);
  if (!linha || !lado) {
    return { estado: 'nenhum', pode_pedir: true, espera_ate: null, bloqueado: false, dias_espera: 0 };
  }
  const cd = cooldownDe(linha, lado);
  const esperando = !!cd && cd > agora.getTime();
  const bloq = estaBloqueado(linha, lado);
  const base = {
    espera_ate: esperando ? new Date(cd).toISOString() : null,
    dias_espera: esperando ? diasRestantes(new Date(cd).toISOString(), agora) : 0,
    bloqueado: bloq,
  };
  if (linha.status === STATUS.ACEITO) return { ...base, estado: 'amigos', pode_pedir: false };
  if (linha.status === STATUS.PENDENTE) {
    return {
      ...base,
      estado: mesmo(linha.requested_by, eu) ? 'pendente_enviado' : 'pendente_recebido',
      pode_pedir: false,
    };
  }
  // rejected / removed → não são amigos; pedir de novo depende da carência
  return { ...base, estado: 'nenhum', pode_pedir: !esperando && !bloq };
}

// ── PEDIR ───────────────────────────────────────────────────────────────────
function decidirPedido({ eu, alvo, linha = null, agora = new Date() }) {
  if (mesmo(eu, alvo)) {
    return { ok: false, http: 400, erro: 'Você não pode pedir amizade pra si mesmo.' };
  }
  const par = parCanonico(eu, alvo);
  if (!par) return { ok: false, http: 400, erro: 'Usuário inválido.' };

  // Sem linha = primeiro contato entre os dois
  if (!linha) {
    return {
      ok: true, acao: 'criar', estado: 'pendente_enviado', notificar: 'pedido',
      para: norm(alvo),
      linha: {
        ...par, requested_by: norm(eu), status: STATUS.PENDENTE,
        strikes_a: 0, strikes_b: 0,
        requested_at: agora.toISOString(), created_at: agora.toISOString(), updated_at: agora.toISOString(),
      },
    };
  }

  const lado = ladoDe(linha, eu);
  if (!lado || !ladoDe(linha, alvo)) return { ok: false, http: 400, erro: 'Usuário inválido.' };

  // Já são amigos → idempotente, devolve o estado (não cria nada)
  if (linha.status === STATUS.ACEITO) {
    return { ok: true, acao: 'nenhuma', estado: 'amigos', ja_existia: true, notificar: null };
  }

  if (linha.status === STATUS.PENDENTE) {
    // Pedido DUPLICADO meu: devolve o estado existente, sem linha nova e sem
    // notificar de novo (senão vira metralhadora de sininho).
    if (mesmo(linha.requested_by, eu)) {
      return { ok: true, acao: 'nenhuma', estado: 'pendente_enviado', ja_existia: true, notificar: null };
    }
    // O OUTRO já tinha pedido e agora eu peço: isso é um "sim". Vira amizade
    // aceita — jamais dois pendentes cruzados.
    return {
      ok: true, acao: 'atualizar', estado: 'amigos', notificar: 'aceite',
      para: norm(linha.requested_by), cruzado: true,
      patch: { status: STATUS.ACEITO, responded_at: agora.toISOString(), updated_at: agora.toISOString() },
    };
  }

  // rejected / removed → repedir só depois da carência
  if (estaBloqueado(linha, lado)) {
    return {
      ok: false, http: 403, bloqueado: true,
      erro: 'Essa pessoa já recusou seus pedidos várias vezes. Não dá pra pedir de novo.',
    };
  }
  const cd = cooldownDe(linha, lado);
  if (cd && cd > agora.getTime()) {
    const dias = diasRestantes(new Date(cd).toISOString(), agora);
    return {
      ok: false, http: 429, espera_ate: new Date(cd).toISOString(), dias_espera: dias,
      erro: `Aguarde ${dias} dia${dias > 1 ? 's' : ''} para enviar um novo pedido a essa pessoa.`,
    };
  }
  return {
    ok: true, acao: 'atualizar', estado: 'pendente_enviado', notificar: 'pedido',
    para: outroDoPar(linha, eu),
    // strikes_*/cooldown_* NÃO entram no patch de propósito: o histórico é o
    // que segura o spam. Zerá-los aqui reabriria o loop pede→recusa→pede.
    patch: {
      status: STATUS.PENDENTE, requested_by: norm(eu),
      requested_at: agora.toISOString(), updated_at: agora.toISOString(),
      responded_at: null, rejected_at: null, removed_at: null, removed_by: null,
    },
  };
}

// ── ACEITAR ─────────────────────────────────────────────────────────────────
function decidirAceite({ eu, linha = null, agora = new Date() }) {
  const lado = ladoDe(linha, eu);
  if (!linha || !lado) return { ok: false, http: 404, erro: 'Pedido não encontrado.' };
  if (linha.status === STATUS.ACEITO) {
    return { ok: true, acao: 'nenhuma', estado: 'amigos', ja_existia: true, notificar: null };
  }
  if (linha.status !== STATUS.PENDENTE) {
    return { ok: false, http: 404, erro: 'Esse pedido não está mais disponível.' };
  }
  if (mesmo(linha.requested_by, eu)) {
    return { ok: false, http: 400, erro: 'Você não pode aceitar o seu próprio pedido.' };
  }
  return {
    ok: true, acao: 'atualizar', estado: 'amigos', notificar: 'aceite',
    para: norm(linha.requested_by),
    patch: { status: STATUS.ACEITO, responded_at: agora.toISOString(), updated_at: agora.toISOString() },
  };
}

// ── RECUSAR (só quem RECEBEU o pedido) ──────────────────────────────────────
// Não notifica ninguém de propósito: "fulano recusou você" só serve pra
// constranger, e ainda daria um canal de mensagem pra quem foi recusado.
function decidirRecusa({ eu, linha = null, agora = new Date() }) {
  const lado = ladoDe(linha, eu);
  if (!linha || !lado) return { ok: false, http: 404, erro: 'Pedido não encontrado.' };
  if (linha.status !== STATUS.PENDENTE) {
    return { ok: false, http: 404, erro: 'Esse pedido não está mais disponível.' };
  }
  if (mesmo(linha.requested_by, eu)) {
    return { ok: false, http: 400, erro: 'Esse pedido é seu — use cancelar.' };
  }
  return {
    ok: true, acao: 'atualizar', estado: 'nenhum', notificar: null,
    patch: {
      status: STATUS.RECUSADO, rejected_at: agora.toISOString(), updated_at: agora.toISOString(),
      ...penalidade(linha, outroLado(lado), agora), // a carência é de quem pediu
    },
  };
}

// ── CANCELAR (quem MANDOU desiste do próprio pedido) ────────────────────────
// Sem strike pra ninguém: desistir do próprio pedido não é ofensa. O que
// impede o loop cancela→pede→cancela virar spam de sininho é o dedupe da
// notificação (deveNotificar), não uma penalidade.
function decidirCancelamento({ eu, linha = null, agora = new Date() }) {
  const lado = ladoDe(linha, eu);
  if (!linha || !lado) return { ok: false, http: 404, erro: 'Pedido não encontrado.' };
  if (linha.status !== STATUS.PENDENTE) {
    return { ok: false, http: 404, erro: 'Esse pedido não está mais disponível.' };
  }
  if (!mesmo(linha.requested_by, eu)) {
    return { ok: false, http: 400, erro: 'Esse pedido não é seu — use recusar.' };
  }
  return {
    ok: true, acao: 'atualizar', estado: 'nenhum', notificar: null,
    patch: {
      status: STATUS.DESFEITO, removed_at: agora.toISOString(), removed_by: norm(eu),
      updated_at: agora.toISOString(),
    },
  };
}

// ── DESFAZER AMIZADE ────────────────────────────────────────────────────────
// A linha NUNCA é apagada. Apagar zeraria strikes/cooldown e reabriria o
// caminho "vira amigo → desfaz → pede de novo" pra sempre. Quem foi desfeito
// leva a carência; quem desfez não leva nada e pode readicionar quando quiser.
function decidirDesfazer({ eu, linha = null, agora = new Date() }) {
  const lado = ladoDe(linha, eu);
  if (!linha || !lado) return { ok: false, http: 404, erro: 'Vocês não são amigos.' };
  if (linha.status !== STATUS.ACEITO) return { ok: false, http: 404, erro: 'Vocês não são amigos.' };
  return {
    ok: true, acao: 'atualizar', estado: 'nenhum', notificar: null,
    patch: {
      status: STATUS.DESFEITO, removed_at: agora.toISOString(), removed_by: norm(eu),
      updated_at: agora.toISOString(),
      ...penalidade(linha, outroLado(lado), agora),
    },
  };
}

// ── Notificação (sininho) ───────────────────────────────────────────────────
// tipo 'amizade' precisa existir no ICONES de public/sininho.js, senão cai no
// 🔔 genérico. E SEM dados.url a notificação não é clicável (sininho.js só
// põe a classe .link quando há url) — foi assim que "novo seguidor" nasceu
// como texto morto. Por isso url é obrigatória aqui.
function limparNome(n) {
  return String(n == null ? '' : n).replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40) || 'Alguém';
}

const URL_AMIGOS = '/comunidade?amigos=1';

function notificacao(kind, { deId, deNome, paraId }) {
  const nome = limparNome(deNome);
  if (kind === 'pedido') {
    return {
      user_id: paraId, tipo: 'amizade',
      titulo: 'Novo pedido de amizade',
      mensagem: `${nome} quer ser seu amigo na Comunidade`,
      dados: { from_user_id: deId, kind: 'pedido', url: URL_AMIGOS },
    };
  }
  if (kind === 'aceite') {
    return {
      user_id: paraId, tipo: 'amizade',
      titulo: 'Pedido de amizade aceito',
      mensagem: `${nome} aceitou seu pedido de amizade`,
      dados: { from_user_id: deId, kind: 'aceite', url: URL_AMIGOS },
    };
  }
  return null;
}

// Dedupe: mesma pessoa, mesmo tipo, dentro da janela → não notifica de novo.
function deveNotificar(ultimaIso, agora = new Date(), horas = NOTIF_JANELA_HORAS) {
  if (!ultimaIso) return true;
  const t = new Date(ultimaIso).getTime();
  if (!Number.isFinite(t)) return true;
  return agora.getTime() - t >= horas * 3600000;
}

module.exports = {
  STATUS, CARENCIA_RECUSA_DIAS, MAX_STRIKES, NOTIF_JANELA_HORAS, DIA_MS, URL_AMIGOS,
  ehUuid, parCanonico, ladoDe, outroLado, idDoLado, outroDoPar,
  strikesDe, cooldownDe, estaBloqueado, penalidade, diasRestantes,
  estadoParaMim, decidirPedido, decidirAceite, decidirRecusa,
  decidirCancelamento, decidirDesfazer,
  notificacao, deveNotificar, limparNome,
};
