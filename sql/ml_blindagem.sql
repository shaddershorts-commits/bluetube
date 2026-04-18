-- ============================================================================
-- sql/ml_blindagem.sql — Blindagem completa do pipeline ML
-- Fallback multi-camada, monitoramento de saude, versionamento de modelo.
-- Rodar no Supabase SQL Editor. Idempotente.
-- ============================================================================

-- 1) SNAPSHOTS HISTORICOS pra fallback quando tudo mais falhar -----------------
CREATE TABLE IF NOT EXISTS tendencias_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tipo TEXT NOT NULL, -- 'top_virais' | 'emergentes' | 'clusters' | 'padroes_titulo'
  dados JSONB NOT NULL,
  valido BOOLEAN DEFAULT TRUE,
  fonte TEXT, -- 'cron_diario' | 'manual' | 'auto_recovery'
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_snapshots_tipo
  ON tendencias_snapshots(tipo, created_at DESC) WHERE valido = true;

-- 2) MONITORAMENTO DE SAUDE do ML --------------------------------------------
CREATE TABLE IF NOT EXISTS ml_saude (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  componente TEXT NOT NULL, -- 'enriquecimento' | 'clustering' | 'predicao' | 'nlp' | 'embeddings' | 'coleta' | 'snapshot'
  status TEXT DEFAULT 'ok', -- 'ok' | 'degradado' | 'falha' | 'parcial'
  ultima_execucao TIMESTAMPTZ DEFAULT NOW(),
  duracao_ms INTEGER,
  registros_processados INTEGER,
  taxa_sucesso DECIMAL,
  erro TEXT,
  meta JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ml_saude_componente
  ON ml_saude(componente, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ml_saude_status
  ON ml_saude(status, created_at DESC) WHERE status <> 'ok';

-- 3) VERSOES do modelo pra rollback ------------------------------------------
CREATE TABLE IF NOT EXISTS ml_versoes (
  id SERIAL PRIMARY KEY,
  versao TEXT NOT NULL UNIQUE,
  pesos JSONB NOT NULL, -- { velocidade_24h: 0.40, ratio_like: 0.25, ... }
  acuracia DECIMAL,
  amostra_validacao INTEGER,
  ativo BOOLEAN DEFAULT FALSE,
  criado_em TIMESTAMPTZ DEFAULT NOW(),
  ativado_em TIMESTAMPTZ,
  desativado_em TIMESTAMPTZ,
  observacoes TEXT
);

CREATE INDEX IF NOT EXISTS idx_ml_versoes_ativo
  ON ml_versoes(ativo) WHERE ativo = true;

-- 4) CACHE de embeddings (com fallback pgvector opcional) --------------------
-- Sem pgvector, guarda como JSONB (array de 1536 floats).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    EXECUTE '
      CREATE TABLE IF NOT EXISTS embeddings_cache (
        texto_hash TEXT PRIMARY KEY,
        texto_original TEXT,
        embedding vector(1536),
        modelo TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )';
  ELSE
    CREATE TABLE IF NOT EXISTS embeddings_cache (
      texto_hash TEXT PRIMARY KEY,
      texto_original TEXT,
      embedding_json JSONB,
      modelo TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS idx_embeddings_created
  ON embeddings_cache(created_at DESC);

-- 5) RELATORIO DIARIO consolidado pro admin ----------------------------------
CREATE TABLE IF NOT EXISTS tendencias_relatorio_diario (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  data DATE UNIQUE NOT NULL,
  videos_coletados INTEGER DEFAULT 0,
  videos_enriquecidos INTEGER DEFAULT 0,
  videos_com_nlp INTEGER DEFAULT 0,
  clusters_ativos INTEGER DEFAULT 0,
  emergentes_detectados INTEGER DEFAULT 0,
  predicoes_feitas INTEGER DEFAULT 0,
  acuracia_modelo DECIMAL,
  alertas_disparados INTEGER DEFAULT 0,
  problemas_detectados JSONB DEFAULT '[]',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_relatorio_diario_data
  ON tendencias_relatorio_diario(data DESC);

-- 6) EVENTOS DO SISTEMA (alertas e logs estruturados) ------------------------
CREATE TABLE IF NOT EXISTS eventos_sistema (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tipo TEXT NOT NULL, -- 'alerta_critico' | 'alerta_warning' | 'info' | 'cron_executado'
  componente TEXT,
  mensagem TEXT NOT NULL,
  dados JSONB DEFAULT '{}',
  notificado_admin BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_eventos_tipo_data
  ON eventos_sistema(tipo, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_eventos_nao_notificados
  ON eventos_sistema(created_at DESC) WHERE notificado_admin = false;

-- 7) Seed da versao inicial do modelo ----------------------------------------
INSERT INTO ml_versoes (versao, pesos, ativo, observacoes)
VALUES (
  'v1.0.0',
  '{"velocidade_24h": 0.40, "ratio_like": 0.25, "ratio_comment": 0.20, "aceleracao": 0.15}'::jsonb,
  true,
  'Versao inicial — pesos padrao heuristicos'
)
ON CONFLICT (versao) DO NOTHING;
