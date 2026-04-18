// api/_helpers/ml-saude.js
// Registra saude de cada componente ML + helpers de alerta.

async function registrarSaude(ctx, componente, status, meta = {}) {
  try {
    await fetch(`${ctx.SU}/rest/v1/ml_saude`, {
      method: 'POST',
      headers: { ...ctx.h, Prefer: 'return=minimal' },
      body: JSON.stringify({
        componente,
        status,
        ultima_execucao: new Date().toISOString(),
        duracao_ms: meta.duracao_ms || null,
        registros_processados: meta.registros_processados || null,
        taxa_sucesso: meta.taxa_sucesso != null ? meta.taxa_sucesso : null,
        erro: meta.erro || null,
        meta: meta.extras || {},
      }),
    });
  } catch (e) { console.error('[ml-saude] falha ao registrar:', e.message); }
}

async function ultimaExecucao(ctx, componente) {
  try {
    const r = await fetch(
      `${ctx.SU}/rest/v1/ml_saude?componente=eq.${componente}&order=created_at.desc&limit=1&select=*`,
      { headers: ctx.h, signal: AbortSignal.timeout(5000) }
    );
    if (!r.ok) return null;
    const [row] = await r.json();
    return row || null;
  } catch (e) { return null; }
}

async function registrarEvento(ctx, tipo, componente, mensagem, dados = {}) {
  try {
    await fetch(`${ctx.SU}/rest/v1/eventos_sistema`, {
      method: 'POST',
      headers: { ...ctx.h, Prefer: 'return=minimal' },
      body: JSON.stringify({ tipo, componente, mensagem, dados }),
    });
  } catch (e) { console.error('[evento] falha:', e.message); }
}

// Wrapper pra rodar uma acao com tracking automatico de saude
async function executarComTracking(ctx, componente, fn) {
  const inicio = Date.now();
  try {
    const resultado = await fn();
    await registrarSaude(ctx, componente, 'ok', {
      duracao_ms: Date.now() - inicio,
      registros_processados: resultado?.processados || resultado?.atualizados || 0,
      extras: { resultado: resultado?.ok === true ? 'sucesso' : 'parcial' },
    });
    return resultado;
  } catch (e) {
    await registrarSaude(ctx, componente, 'falha', {
      duracao_ms: Date.now() - inicio,
      erro: (e.message || String(e)).slice(0, 500),
    });
    await registrarEvento(ctx, 'alerta_critico', componente, `Componente ${componente} falhou: ${e.message}`, { stack: e.stack?.slice(0, 500) });
    throw e;
  }
}

// Wrapper com timeout preventivo (default 25s pra Vercel)
async function executarComTimeout(fn, timeoutMs = 25000) {
  return Promise.race([
    fn(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout_preventivo')), timeoutMs)),
  ]);
}

// Obtem view consolidada da saude (todos componentes)
async function obterHealthGeral(ctx) {
  const componentes = ['coleta', 'enriquecimento', 'clustering', 'predicao', 'nlp', 'embeddings', 'snapshot'];
  const status = {};
  await Promise.all(componentes.map(async (c) => {
    status[c] = await ultimaExecucao(ctx, c);
  }));
  return status;
}

module.exports = {
  registrarSaude,
  ultimaExecucao,
  registrarEvento,
  executarComTracking,
  executarComTimeout,
  obterHealthGeral,
};
