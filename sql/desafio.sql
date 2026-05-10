-- Desafio BlueTube — competição de views entre criadores
-- Rodar no Supabase SQL Editor

-- Participantes (canais inscritos pelo admin)
CREATE TABLE IF NOT EXISTS desafio_participantes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id TEXT UNIQUE NOT NULL,
  channel_handle TEXT,
  channel_name TEXT,
  channel_thumbnail TEXT,
  total_inscritos BIGINT DEFAULT 0,
  adicionado_em TIMESTAMPTZ DEFAULT NOW(),
  ativo BOOLEAN DEFAULT true
);

-- Vídeos do desafio (Shorts dos participantes, métricas atualizadas)
CREATE TABLE IF NOT EXISTS desafio_videos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  youtube_id TEXT UNIQUE NOT NULL,
  participante_id UUID REFERENCES desafio_participantes(id),
  titulo TEXT,
  thumbnail_url TEXT,
  url TEXT,
  canal_nome TEXT,
  canal_id TEXT,
  views BIGINT DEFAULT 0,
  likes BIGINT DEFAULT 0,
  comentarios BIGINT DEFAULT 0,
  duracao_segundos INT,
  publicado_em TIMESTAMPTZ,
  coletado_em TIMESTAMPTZ DEFAULT NOW(),
  atualizado_em TIMESTAMPTZ DEFAULT NOW(),
  ativo BOOLEAN DEFAULT true
);

CREATE INDEX IF NOT EXISTS idx_desafio_videos_views ON desafio_videos(views DESC);
CREATE INDEX IF NOT EXISTS idx_desafio_videos_publicado ON desafio_videos(publicado_em DESC);
CREATE INDEX IF NOT EXISTS idx_desafio_videos_participante ON desafio_videos(participante_id);
