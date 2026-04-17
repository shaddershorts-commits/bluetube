-- sql/blue_feed_algoritmo.sql — algoritmo de feed inteligente
-- Rodar no SQL Editor do Supabase.
--
-- Estrutura:
-- - blue_feed_historico: log por-video de engajamento (expande blue_video_analytics)
-- - blue_user_interests: perfil de interesses atualizado em tempo real
-- - blue_videos novas colunas: nichos, avg_watch_percent, views_24h

CREATE TABLE IF NOT EXISTS blue_feed_historico (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  video_id UUID NOT NULL,
  percentual_assistido INTEGER NOT NULL DEFAULT 0,
  replay BOOLEAN NOT NULL DEFAULT FALSE,
  pulou BOOLEAN NOT NULL DEFAULT FALSE,
  curtiu BOOLEAN NOT NULL DEFAULT FALSE,
  salvou BOOLEAN NOT NULL DEFAULT FALSE,
  comentou BOOLEAN NOT NULL DEFAULT FALSE,
  compartilhou BOOLEAN NOT NULL DEFAULT FALSE,
  abriu_perfil BOOLEAN NOT NULL DEFAULT FALSE,
  tempo_total_segundos INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, video_id)
);
CREATE INDEX IF NOT EXISTS idx_feed_hist_user_created
  ON blue_feed_historico (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_feed_hist_video
  ON blue_feed_historico (video_id);
CREATE INDEX IF NOT EXISTS idx_feed_hist_pulou
  ON blue_feed_historico (user_id, pulou, video_id) WHERE pulou = TRUE;

CREATE TABLE IF NOT EXISTS blue_user_interests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE,
  nichos JSONB NOT NULL DEFAULT '{}'::jsonb,
  criadores_favoritos JSONB NOT NULL DEFAULT '[]'::jsonb,
  criadores_bloqueados JSONB NOT NULL DEFAULT '[]'::jsonb,
  tags_positivas JSONB NOT NULL DEFAULT '[]'::jsonb,
  tags_negativas JSONB NOT NULL DEFAULT '[]'::jsonb,
  ultimo_nicho TEXT,
  sessao_atual JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_user_interests
  ON blue_user_interests (user_id);

-- Colunas novas em blue_videos pra metricas do algoritmo.
-- likes, views, comments, saves, score JA EXISTEM — nao duplicar.
ALTER TABLE blue_videos
  ADD COLUMN IF NOT EXISTS nichos TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS avg_watch_percent INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS views_24h INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_videos_nichos ON blue_videos USING GIN (nichos);
CREATE INDEX IF NOT EXISTS idx_videos_views24h ON blue_videos (views_24h DESC) WHERE status = 'active';

ALTER TABLE blue_feed_historico  ENABLE ROW LEVEL SECURITY;
ALTER TABLE blue_user_interests  ENABLE ROW LEVEL SECURITY;
-- Sem policies abertas — acesso somente via service_key
