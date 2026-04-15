-- Blue Stories — stories de 24h com reações e replies
-- Executar no SQL editor do Supabase (mesmo projeto bluetube)

CREATE TABLE IF NOT EXISTS blue_stories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  tipo TEXT DEFAULT 'imagem', -- imagem | video | texto
  media_url TEXT,
  texto TEXT,
  cor_fundo TEXT DEFAULT '#020817',
  duracao INTEGER DEFAULT 5, -- segundos de auto-advance
  visto_por JSONB DEFAULT '[]', -- array de user_ids que viram
  expirado_em TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '24 hours'),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS blue_story_reacoes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  story_id UUID REFERENCES blue_stories(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  emoji TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(story_id, user_id)
);

CREATE TABLE IF NOT EXISTS blue_story_replies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  story_id UUID REFERENCES blue_stories(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  mensagem TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_stories_user ON blue_stories(user_id);
CREATE INDEX IF NOT EXISTS idx_stories_expiry ON blue_stories(expirado_em);
CREATE INDEX IF NOT EXISTS idx_stories_created ON blue_stories(user_id, created_at DESC)
  WHERE expirado_em > NOW();
CREATE INDEX IF NOT EXISTS idx_story_reacoes_story ON blue_story_reacoes(story_id);
CREATE INDEX IF NOT EXISTS idx_story_replies_story ON blue_story_replies(story_id);
