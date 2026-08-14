// api/_helpers/emailGate.js — interruptor único do email de marketing
// ===========================================================================
// 10/08/2026: o plano do Resend caiu pra 200 envios/dia e 3.000/mês. Um único
// disparo do /api/weekly-trends-email (que vai pra TODOS os ativos) queima a
// cota do dia inteiro e derruba junto o que não pode falhar: código de login,
// recibo de pagamento, aviso de cobrança recusada, entrega do BlueScore.
//
// Por isso o corte é aqui, num lugar só, e não espalhado por oito arquivos com
// a mesma linha copiada — do jeito espalhado, religar depois vira caça ao
// tesouro e sempre sobra um cron esquecido mandando email.
//
// PADRÃO É DESLIGADO. Sem a env, ninguém dispara marketing. Isso é de
// propósito: o deploy já corta, sem depender de você lembrar de configurar.
//
// PRA RELIGAR: criar EMAILS_MARKETING=on na Vercel e fazer um deploy novo
// (env nova só vale em deploy novo — já nos mordeu no caso do TikAPI).
//
// O QUE **NÃO** PASSA POR AQUI, de propósito — é transacional, a pessoa está
// esperando, e cortar dá prejuízo maior que o da cota:
//   • código OTP e login (api/auth.js)
//   • recibos e cobrança recusada (webhook, dunning)
//   • comissão de afiliado e saque via Pix
//   • entrega do laudo do BlueScore
//   • resposta do suporte
//   • aviso de plano vencendo (plan-expiry-sweep)
//
// ═══ 14/08/2026 — ORÇAMENTO DIÁRIO ═════════════════════════════════════════
// Religar no liga/desliga puro não resolve: o interruptor é binário e os jobs
// não se conhecem. Cada um respeitando "30 por dia" viraria 8 × 30 = 240, que
// estoura a cota e derruba o OTP — exatamente o acidente que o corte evitou.
//
// Então o teto agora é UM SÓ, compartilhado, contado no banco (email_orcamento,
// uma linha por dia). Cada job PEDE cota antes de mandar e recebe quanto pode;
// quem chega depois pega o resto; quando zera, ninguém manda mais naquele dia.
//
// FALHA FECHADA, de propósito: se o banco não responder ou a tabela não
// existir, a cota concedida é ZERO. Deixar passar "porque não deu pra contar"
// é como o OTP morre — e email não enviado se recupera na rodada seguinte,
// código de cadastro não.
//
// A RESERVA: os últimos EMAILS_MARKETING_RESERVA_ALTA envios do dia só podem
// ser gastos por job de prioridade alta (hoje: recuperação de carrinho, que é
// receita e tem volume baixo). Sem isso, um blast de marketing de manhã come a
// cota e o cara que abandonou o checkout à tarde não recebe nada. Pra desligar
// a reserva, é só setar 0.

const LIGADO = new Set(['on', 'true', '1', 'sim', 'ligado']);

const LIMITE_PADRAO = 30;   // pedido do dono: no máximo ~30/dia de marketing
const RESERVA_PADRAO = 10;  // do teto acima, quanto fica guardado pra alta

function marketingLiberado() {
  return LIGADO.has(String(process.env.EMAILS_MARKETING || '').trim().toLowerCase());
}

function numeroDaEnv(nome, padrao) {
  const n = parseInt(process.env[nome], 10);
  return Number.isFinite(n) && n >= 0 ? n : padrao;
}

function limiteDoDia() { return numeroDaEnv('EMAILS_MARKETING_LIMITE_DIA', LIMITE_PADRAO); }
function reservaAlta() { return Math.min(numeroDaEnv('EMAILS_MARKETING_RESERVA_ALTA', RESERVA_PADRAO), limiteDoDia()); }

// Resposta 200 de propósito: cron que recebe erro fica retentando e enche o
// log de alarme falso. O corte não é falha, é estado esperado.
function respostaBloqueado(job) {
  return {
    ok: true,
    pulado: true,
    motivo: 'emails_marketing_desligados',
    job: job || 'marketing',
    detalhe: 'Cota do Resend (200/dia · 3.000/mês). Religar com EMAILS_MARKETING=on + deploy.',
    enviados: 0,
  };
}

function respostaSemCota(job, estado) {
  return {
    ok: true,
    pulado: true,
    motivo: 'cota_diaria_esgotada',
    job: job || 'marketing',
    detalhe: `Teto de ${estado.limite}/dia já gasto (${estado.usado}). Volta amanhã sozinho.`,
    orcamento: estado,
    enviados: 0,
  };
}

// Açúcar pros handlers: uma linha no topo e acabou.
function barrarSeDesligado(res, job) {
  if (marketingLiberado()) return false;
  console.log(`[emailGate] ${job}: pulado — marketing desligado`);
  res.status(200).json(respostaBloqueado(job));
  return true;
}

// ── O CONTADOR ─────────────────────────────────────────────────────────────
// Uma linha por dia em email_orcamento. O incremento é COMPARE-AND-SWAP: o
// PATCH filtra pelo valor que acabei de ler, então se outro job escreveu no
// meio o update não casa nenhuma linha e eu releio. Sem isso, dois crons no
// mesmo minuto leem 0, gravam 1, e o teto vira decoração.

function hojeUTC() { return new Date().toISOString().slice(0, 10); }

function conexao() {
  const SU = process.env.SUPABASE_URL;
  const SK = process.env.SUPABASE_SERVICE_KEY;
  if (!SU || !SK) return null;
  return { SU, H: { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' } };
}

async function lerUsado(cx, dia) {
  const r = await fetch(`${cx.SU}/rest/v1/email_orcamento?dia=eq.${dia}&select=enviados`, { headers: cx.H });
  if (!r.ok) throw new Error(`leitura do orçamento falhou (${r.status})`);
  const linhas = await r.json();
  if (linhas.length) return linhas[0].enviados || 0;

  // primeira rodada do dia: cria a linha. ignore-duplicates porque dois jobs
  // podem chegar juntos — e merge-duplicates ZERARIA o contador de quem chegou
  // primeiro (o upsert do PostgREST é INSERT…ON CONFLICT, ele sobrescreve).
  await fetch(`${cx.SU}/rest/v1/email_orcamento`, {
    method: 'POST',
    headers: { ...cx.H, Prefer: 'resolution=ignore-duplicates,return=minimal' },
    body: JSON.stringify({ dia, enviados: 0 }),
  });
  return 0;
}

// Pede até `quero` envios. Devolve quantos pode mandar (0 = não manda nada).
// prioridade 'alta' pode gastar a reserva; qualquer outra coisa, não.
async function reservarCota(job, quero, prioridade) {
  const limite = limiteDoDia();
  const teto = prioridade === 'alta' ? limite : Math.max(0, limite - reservaAlta());
  const cx = conexao();
  if (!cx || !(quero > 0)) {
    return { concedido: 0, limite, usado: null, erro: cx ? null : 'sem credencial do banco' };
  }

  const dia = hojeUTC();
  for (let tentativa = 0; tentativa < 5; tentativa++) {
    try {
      const usado = await lerUsado(cx, dia);
      const concedido = Math.max(0, Math.min(quero, teto - usado));
      if (concedido === 0) return { concedido: 0, limite, usado, teto };

      const r = await fetch(
        `${cx.SU}/rest/v1/email_orcamento?dia=eq.${dia}&enviados=eq.${usado}`,
        {
          method: 'PATCH',
          headers: { ...cx.H, Prefer: 'return=representation' },
          body: JSON.stringify({ enviados: usado + concedido, atualizado_em: new Date().toISOString() }),
        },
      );
      if (!r.ok) throw new Error(`reserva falhou (${r.status})`);
      const linhas = await r.json();
      // vazio = outro job gravou entre o meu SELECT e o meu UPDATE: releio.
      if (linhas.length) {
        console.log(`[emailGate] ${job}: reservou ${concedido} (usado ${usado + concedido}/${limite})`);
        return { concedido, limite, usado: usado + concedido, teto };
      }
    } catch (e) {
      // falha fechada: não sei quanto já foi, então não mando nada.
      console.log(`[emailGate] ${job}: cota NEGADA — ${e.message}`);
      return { concedido: 0, limite, usado: null, erro: e.message };
    }
  }
  console.log(`[emailGate] ${job}: cota NEGADA — disputa demais no contador`);
  return { concedido: 0, limite, usado: null, erro: 'disputa no contador' };
}

// Sobrou cota reservada e não usada (erro de envio, lista menor que o
// esperado)? Devolve, senão o dia inteiro fica pago por email que não saiu.
async function devolverCota(job, n) {
  const cx = conexao();
  if (!cx || !(n > 0)) return;
  const dia = hojeUTC();
  for (let tentativa = 0; tentativa < 5; tentativa++) {
    try {
      const usado = await lerUsado(cx, dia);
      const novo = Math.max(0, usado - n);
      const r = await fetch(
        `${cx.SU}/rest/v1/email_orcamento?dia=eq.${dia}&enviados=eq.${usado}`,
        {
          method: 'PATCH',
          headers: { ...cx.H, Prefer: 'return=representation' },
          body: JSON.stringify({ enviados: novo, atualizado_em: new Date().toISOString() }),
        },
      );
      if (!r.ok) return;
      if ((await r.json()).length) {
        console.log(`[emailGate] ${job}: devolveu ${n} (usado ${novo})`);
        return;
      }
    } catch (e) { return; }
  }
}

// A CARTEIRA: usada DENTRO do laço de envio, um email por vez. É aqui que o
// teto fica inescapável — mesmo que um job erre a conta da lista, o laço para
// no envio exato em que a cota acaba.
//
// Um por vez, e não um bloco reservado no início, DE PROPÓSITO: se o job
// estourasse no meio do laço com um bloco na mão, a cota reservada morreria
// com ele e o dia inteiro ficaria queimado sem ter mandado nada. Um por vez
// nunca deixa crédito preso — o custo é uma ida ao banco por email, o que em
// 30 emails/dia não é custo nenhum.
//
// Uso no handler:
//   const cota = abrirCota('meu-job');
//   for (const pessoa of lista) {
//     if (!await cota.pegarUm()) break;   // acabou a cota do dia
//     ...envia...
//   }
function abrirCota(job, prioridade) {
  let gastos = 0;
  let esgotou = false;
  let ultimo = null;
  return {
    async pegarUm() {
      if (esgotou) return false;
      const estado = await reservarCota(job, 1, prioridade);
      ultimo = estado;
      if (estado.concedido > 0) { gastos += 1; return true; }
      esgotou = true;   // não insiste: bateu no teto ou o banco caiu
      return false;
    },
    gastos() { return gastos; },
    esgotou() { return esgotou; },
    estado() { return ultimo; },
  };
}

// Portão completo pros handlers: liga/desliga + cota, numa linha só.
// Devolve 0 quando já respondeu ao cron (desligado ou sem cota).
async function cotaOuBarrar(res, job, quero, prioridade) {
  if (barrarSeDesligado(res, job)) return 0;
  const estado = await reservarCota(job, quero, prioridade);
  if (estado.concedido === 0) {
    res.status(200).json(respostaSemCota(job, estado));
    return 0;
  }
  return estado.concedido;
}

module.exports = {
  marketingLiberado,
  respostaBloqueado,
  barrarSeDesligado,
  limiteDoDia,
  reservaAlta,
  reservarCota,
  devolverCota,
  abrirCota,
  cotaOuBarrar,
  respostaSemCota,
};
