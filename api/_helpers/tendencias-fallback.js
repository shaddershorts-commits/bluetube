// api/_helpers/tendencias-fallback.js
// Cascade de fallbacks pra servir dados de tendencias mesmo quando
// tudo mais falhou. 4 camadas, do mais fresco ao mais basico.

const DADOS_ESTATICOS_NICHO = {
  financas: {
    rpm: { min: 15, medio: 30, max: 50 },
    hooks_comuns: ['como eu fiz', 'erro que cometi', 'descobri que', 'antes eu achava'],
    duracao_ideal: 28,
    horario_ideal: '19h-21h',
  },
  tecnologia: {
    rpm: { min: 8, medio: 14, max: 20 },
    hooks_comuns: ['voce sabia', 'truque que ninguem conta', 'atalho', 'pare de'],
    duracao_ideal: 25,
    horario_ideal: '20h-22h',
  },
  saude: {
    rpm: { min: 6, medio: 10, max: 15 },
    hooks_comuns: ['o medico nao conta', 'habito que', 'transformacao em', 'antes e depois'],
    duracao_ideal: 30,
    horario_ideal: '18h-20h',
  },
  educacao: {
    rpm: { min: 4, medio: 8, max: 12 },
    hooks_comuns: ['aprenda em', 'metodo', 'passo a passo', 'como estudar'],
    duracao_ideal: 35,
    horario_ideal: '19h-21h',
  },
  beleza: {
    rpm: { min: 3, medio: 5.5, max: 8 },
    hooks_comuns: ['antes e depois', 'produto que mudou', 'tutorial', 'erro que todos fazem'],
    duracao_ideal: 22,
    horario_ideal: '20h-22h',
  },
  lifestyle: {
    rpm: { min: 2.5, medio: 4, max: 6 },
    hooks_comuns: ['rotina', 'dia na vida', 'morning routine', 'como eu'],
    duracao_ideal: 30,
    horario_ideal: '19h-21h',
  },
  culinaria: {
    rpm: { min: 2, medio: 3.5, max: 5 },
    hooks_comuns: ['receita facil', 'em 1 minuto', 'ingrediente secreto', 'sem forno'],
    duracao_ideal: 28,
    horario_ideal: '17h-19h',
  },
  games: {
    rpm: { min: 1.5, medio: 3, max: 5 },
    hooks_comuns: ['dica', 'pro tip', 'glitch', 'easter egg'],
    duracao_ideal: 22,
    horario_ideal: '21h-23h',
  },
  humor: {
    rpm: { min: 1, medio: 2, max: 3 },
    hooks_comuns: ['quando voce', 'todo mundo que', 'pov', 'tipos de'],
    duracao_ideal: 18,
    horario_ideal: '20h-23h',
  },
  musica: {
    rpm: { min: 1, medio: 2, max: 3.5 },
    hooks_comuns: ['cover', 'remix', 'como tocar', 'versao acustica'],
    duracao_ideal: 25,
    horario_ideal: '19h-22h',
  },
  esportes: {
    rpm: { min: 1.5, medio: 3, max: 5 },
    hooks_comuns: ['jogada', 'melhor momento', 'polemica', 'bastidores'],
    duracao_ideal: 20,
    horario_ideal: '19h-22h',
  },
  pets: {
    rpm: { min: 1.5, medio: 2.5, max: 4 },
    hooks_comuns: ['meu cachorro', 'meu gato', 'transformacao pet', 'dica de adestramento'],
    duracao_ideal: 20,
    horario_ideal: '18h-20h',
  },
  viagens: {
    rpm: { min: 3, medio: 5, max: 8 },
    hooks_comuns: ['destino barato', 'erro que cometi', 'dica de viagem', 'roteiro'],
    duracao_ideal: 35,
    horario_ideal: '20h-22h',
  },
  automotivo: {
    rpm: { min: 4, medio: 7, max: 12 },
    hooks_comuns: ['carro mais', 'antes de comprar', 'problema comum', 'review'],
    duracao_ideal: 30,
    horario_ideal: '19h-21h',
  },
  geral: {
    rpm: { min: 2, medio: 4, max: 7 },
    hooks_comuns: ['voce sabia', 'nunca faca isso', 'truque', 'segredo'],
    duracao_ideal: 25,
    horario_ideal: '19h-21h',
  },
};

// Obter dados de tendencias com cascade de fallbacks.
// Retorna { dados, fonte, aviso? } — sempre retorna algo, nunca null.
async function obterTendenciasComFallback(ctx, tipo, nicho) {
  const { SU, h } = ctx;
  const nichoClause = nicho ? `&nicho=eq.${nicho}` : '&nicho=is.null';

  // Camada 1: cache atual valido
  try {
    const r = await fetch(
      `${SU}/rest/v1/tendencias_analise?tipo=eq.${tipo}${nichoClause}&valido_ate=gte.${new Date().toISOString()}&order=created_at.desc&limit=1&select=dados,created_at`,
      { headers: h, signal: AbortSignal.timeout(5000) }
    );
    if (r.ok) {
      const [row] = await r.json();
      if (row) return { dados: row.dados, fonte: 'cache_atual', atualizado_em: row.created_at };
    }
  } catch (e) { /* segue pro proximo */ }

  // Camada 2: cache expirado (ate 24h)
  try {
    const desde = new Date(Date.now() - 86400000).toISOString();
    const r = await fetch(
      `${SU}/rest/v1/tendencias_analise?tipo=eq.${tipo}${nichoClause}&valido_ate=gte.${desde}&order=created_at.desc&limit=1&select=dados,created_at`,
      { headers: h, signal: AbortSignal.timeout(5000) }
    );
    if (r.ok) {
      const [row] = await r.json();
      if (row) return { dados: row.dados, fonte: 'cache_expirado', aviso: 'Dados das ultimas 24h', atualizado_em: row.created_at };
    }
  } catch (e) { /* segue */ }

  // Camada 3: snapshot historico (ate 7 dias)
  try {
    const desde = new Date(Date.now() - 7*86400000).toISOString();
    const r = await fetch(
      `${SU}/rest/v1/tendencias_snapshots?tipo=eq.${tipo}&valido=eq.true&created_at=gte.${desde}&order=created_at.desc&limit=1&select=dados,created_at`,
      { headers: h, signal: AbortSignal.timeout(5000) }
    );
    if (r.ok) {
      const [row] = await r.json();
      if (row) return { dados: row.dados, fonte: 'snapshot', aviso: 'Dados historicos — atualizando em tempo real', atualizado_em: row.created_at };
    }
  } catch (e) { /* segue */ }

  // Camada 4: dados estaticos pre-configurados
  return {
    dados: obterDadosEstaticosNicho(nicho),
    fonte: 'estatico',
    aviso: 'Sistema atualizando — exibindo dados base',
  };
}

function obterDadosEstaticosNicho(nicho) {
  return DADOS_ESTATICOS_NICHO[nicho] || DADOS_ESTATICOS_NICHO.geral;
}

// Obter ultimo snapshot de tipo (pra restore manual)
async function ultimoSnapshotValido(ctx, tipo) {
  try {
    const r = await fetch(
      `${ctx.SU}/rest/v1/tendencias_snapshots?tipo=eq.${tipo}&valido=eq.true&order=created_at.desc&limit=1&select=*`,
      { headers: ctx.h, signal: AbortSignal.timeout(5000) }
    );
    if (!r.ok) return null;
    const [row] = await r.json();
    return row || null;
  } catch (e) { return null; }
}

module.exports = { obterTendenciasComFallback, obterDadosEstaticosNicho, ultimoSnapshotValido, DADOS_ESTATICOS_NICHO };
