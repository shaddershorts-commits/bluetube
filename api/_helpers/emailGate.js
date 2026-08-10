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

const LIGADO = new Set(['on', 'true', '1', 'sim', 'ligado']);

function marketingLiberado() {
  return LIGADO.has(String(process.env.EMAILS_MARKETING || '').trim().toLowerCase());
}

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

// Açúcar pros handlers: uma linha no topo e acabou.
function barrarSeDesligado(res, job) {
  if (marketingLiberado()) return false;
  console.log(`[emailGate] ${job}: pulado — marketing desligado`);
  res.status(200).json(respostaBloqueado(job));
  return true;
}

module.exports = { marketingLiberado, respostaBloqueado, barrarSeDesligado };
