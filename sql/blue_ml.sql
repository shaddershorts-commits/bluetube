-- sql/blue_ml.sql — infra de coleta de dados para ML em background.
-- ML NAO atua no feed — so observa e aprende.
-- Rodar no SQL Editor do Supabase.

CREATE TABLE IF NOT EXISTS blue_ml_dataset (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  sessao_id TEXT NOT NULL,
  posicao_no_feed INTEGER NOT NULL DEFAULT 0,
  video_id UUID NOT NULL,
  criador_id UUID NOT NULL,
  nichos TEXT[] NOT NULL DEFAULT '{}',
  hashtags TEXT[] NOT NULL DEFAULT '{}',
  duracao_video INTEGER,
  hora_publicacao_video TIMESTAMPTZ,
  views_no_momento INTEGER NOT NULL DEFAULT 0,
  likes_no_momento INTEGER NOT NULL DEFAULT 0,
  hora_do_dia INTEGER NOT NULL DEFAULT 0,
  dia_da_semana INTEGER NOT NULL DEFAULT 0,
  dispositivo TEXT,
  percentual_assistido INTEGER NOT NULL DEFAULT 0,
  tempo_assistido_segundos INTEGER NOT NULL DEFAULT 0,
  pulou BOOLEAN NOT NULL DEFAULT FALSE,
  tempo_ate_pular_segundos DECIMAL,
  curtiu BOOLEAN NOT NULL DEFAULT FALSE,
  salvou BOOLEAN NOT NULL DEFAULT FALSE,
  comentou BOOLEAN NOT NULL DEFAULT FALSE,
  compartilhou BOOLEAN NOT NULL DEFAULT FALSE,
  replay BOOLEAN NOT NULL DEFAULT FALSE,
  abriu_perfil_criador BOOLEAN NOT NULL DEFAULT FALSE,
  seguiu_criador BOOLEAN NOT NULL DEFAULT FALSE,
  score_regras DECIMAL,
  engagement_score DECIMAL NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Um user+video+sessao gera no maximo UMA linha (upsert mescla sinais).
  UNIQUE(user_id, video_id, sessao_id)
);
CREATE INDEX IF NOT EXISTS idx_ml_dataset_user ON blue_ml_dataset (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ml_dataset_video ON blue_ml_dataset (video_id);
CREATE INDEX IF NOT EXISTS idx_ml_dataset_created ON blue_ml_dataset (created_at DESC);

CREATE TABLE IF NOT EXISTS blue_ml_experimentos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nome TEXT UNIQUE NOT NULL,
  descricao TEXT,
  status TEXT NOT NULL DEFAULT 'coletando_dados'
    CHECK (status IN ('coletando_dados','treinando','testando','ativo','pausado')),
  versao TEXT,
  metricas JSONB NOT NULL DEFAULT '{}'::jsonb,
  porcentagem_usuarios DECIMAL NOT NULL DEFAULT 0,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ativado_em TIMESTAMPTZ
);

INSERT INTO blue_ml_experimentos (nome, descricao, status, porcentagem_usuarios)
VALUES (
  'feed_ml_v1',
  'Modelo de recomendacao baseado em comportamento do usuario. Fase 1: coleta de dados.',
  'coletando_dados',
  0
) ON CONFLICT (nome) DO NOTHING;

CREATE TABLE IF NOT EXISTS blue_ml_user_features (
  user_id UUID PRIMARY KEY,
  avg_watch_percent DECIMAL NOT NULL DEFAULT 0,
  taxa_like DECIMAL NOT NULL DEFAULT 0,
  taxa_skip DECIMAL NOT NULL DEFAULT 0,
  taxa_save DECIMAL NOT NULL DEFAULT 0,
  taxa_share DECIMAL NOT NULL DEFAULT 0,
  taxa_comment DECIMAL NOT NULL DEFAULT 0,
  sessoes_por_semana DECIMAL NOT NULL DEFAULT 0,
  videos_por_sessao DECIMAL NOT NULL DEFAULT 0,
  horario_preferido INTEGER,
  nichos_vetor JSONB NOT NULL DEFAULT '{}'::jsonb,
  total_interacoes INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS blue_ml_video_features (
  video_id UUID PRIMARY KEY,
  avg_watch_percent DECIMAL NOT NULL DEFAULT 0,
  taxa_like DECIMAL NOT NULL DEFAULT 0,
  taxa_skip DECIMAL NOT NULL DEFAULT 0,
  taxa_save DECIMAL NOT NULL DEFAULT 0,
  taxa_share DECIMAL NOT NULL DEFAULT 0,
  taxa_comment DECIMAL NOT NULL DEFAULT 0,
  taxa_replay DECIMAL NOT NULL DEFAULT 0,
  taxa_follow_criador DECIMAL NOT NULL DEFAULT 0,
  engagement_score DECIMAL NOT NULL DEFAULT 0,
  total_impressoes INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE blue_ml_dataset         ENABLE ROW LEVEL SECURITY;
ALTER TABLE blue_ml_experimentos    ENABLE ROW LEVEL SECURITY;
ALTER TABLE blue_ml_user_features   ENABLE ROW LEVEL SECURITY;
ALTER TABLE blue_ml_video_features  ENABLE ROW LEVEL SECURITY;
-- Acesso somente via service_key.
