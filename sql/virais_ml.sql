-- ============================================================================
-- sql/virais_ml.sql — Pipeline de ML para virais_banco
-- Enriquece virais_banco com features calculadas + clusters + predicoes.
-- Rodar no Supabase SQL Editor. Idempotente.
-- ============================================================================

-- 1) FEATURES CALCULADAS em virais_banco -------------------------------------
ALTER TABLE virais_banco
  ADD COLUMN IF NOT EXISTS velocidade_views_6h   DECIMAL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS velocidade_views_24h  DECIMAL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS velocidade_views_48h  DECIMAL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS aceleracao            DECIMAL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ratio_like_view       DECIMAL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ratio_comment_view    DECIMAL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS score_viralidade      DECIMAL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS dia_da_semana_post    INTEGER,
  ADD COLUMN IF NOT EXISTS hora_do_dia_post      INTEGER,
  ADD COLUMN IF NOT EXISTS titulo_features       JSONB DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS cluster_formato       INTEGER,
  ADD COLUMN IF NOT EXISTS cluster_tema          INTEGER,
  ADD COLUMN IF NOT EXISTS viralizou             BOOLEAN DEFAULT FALSE;

-- Coluna VECTOR opcional: so cria se pgvector estiver habilitado.
-- Nao eh usada pelo virais-ml.js (usa JSONB + cosine em JS), mas deixa a porta
-- aberta pra v2 com similarity search no banco.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    EXECUTE 'ALTER TABLE virais_banco ADD COLUMN IF NOT EXISTS titulo_embedding vector(1536)';
  END IF;
END$$;

-- Indices para queries de ML
CREATE INDEX IF NOT EXISTS idx_virais_score_viralidade
  ON virais_banco(score_viralidade DESC);
CREATE INDEX IF NOT EXISTS idx_virais_cluster_formato
  ON virais_banco(cluster_formato, nicho);
CREATE INDEX IF NOT EXISTS idx_virais_cluster_tema
  ON virais_banco(cluster_tema, nicho);
CREATE INDEX IF NOT EXISTS idx_virais_viralizou
  ON virais_banco(viralizou) WHERE viralizou = true;
CREATE INDEX IF NOT EXISTS idx_virais_features_sem
  ON virais_banco(coletado_em) WHERE titulo_features = '{}'::jsonb;

-- 2) CLUSTERS identificados --------------------------------------------------
CREATE TABLE IF NOT EXISTS virais_clusters (
  id SERIAL PRIMARY KEY,
  tipo TEXT NOT NULL, -- 'formato' | 'tema' | 'hook'
  nome TEXT,
  descricao TEXT,
  nicho TEXT,
  centroide JSONB DEFAULT '{}', -- features medias do cluster (pra classificar novos)
  exemplos JSONB DEFAULT '[]',  -- IDs + titulos exemplo
  total_videos INTEGER DEFAULT 0,
  taxa_viralizacao DECIMAL DEFAULT 0,
  saturacao_percentual DECIMAL DEFAULT 0,
  janela_oportunidade_dias INTEGER DEFAULT 0,
  ativo BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_clusters_tipo
  ON virais_clusters(tipo, ativo);
CREATE INDEX IF NOT EXISTS idx_clusters_nicho
  ON virais_clusters(nicho, tipo);

-- 3) PREDICOES do modelo -----------------------------------------------------
CREATE TABLE IF NOT EXISTS virais_predicoes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id UUID REFERENCES virais_banco(id) ON DELETE CASCADE,
  probabilidade_viral DECIMAL,
  confianca DECIMAL,
  cluster_previsto INTEGER,
  janela_estimada_dias INTEGER,
  features_relevantes JSONB DEFAULT '{}',
  predicao_correta BOOLEAN, -- valida pelo cron validar-predicoes (>7d)
  validado_em TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_predicoes_video
  ON virais_predicoes(video_id);
CREATE INDEX IF NOT EXISTS idx_predicoes_validar
  ON virais_predicoes(created_at) WHERE predicao_correta IS NULL;

-- 4) LOG do modelo (acuracia historica + ajustes de peso) --------------------
CREATE TABLE IF NOT EXISTS virais_modelo_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  executado_em TIMESTAMPTZ DEFAULT NOW(),
  total_predicoes INTEGER DEFAULT 0,
  total_validadas INTEGER DEFAULT 0,
  acertos INTEGER DEFAULT 0,
  acuracia DECIMAL,
  pesos_atuais JSONB DEFAULT '{}',
  ajuste_aplicado BOOLEAN DEFAULT FALSE,
  observacoes TEXT
);

CREATE INDEX IF NOT EXISTS idx_modelo_log_data
  ON virais_modelo_log(executado_em DESC);
