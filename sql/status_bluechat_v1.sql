-- status_bluechat_v1.sql — Batch BlueChat (2026-07-17)
-- AUTOSSUFICIENTE: inclui a criação das tabelas de stories (o
-- blue_stories_schema.sql de sessão anterior nunca foi executado —
-- descoberto em 2026-07-17 via 42P01). Idempotente: pode rodar 2x.

-- ── 0. Tabelas base de stories (nunca criadas) ───────────────────────────────
CREATE TABLE IF NOT EXISTS blue_stories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  tipo TEXT DEFAULT 'imagem', -- imagem | video | texto | video_share
  media_url TEXT,
  texto TEXT,
  cor_fundo TEXT DEFAULT '#020817',
  duracao INTEGER DEFAULT 5,
  visto_por JSONB DEFAULT '[]',
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
CREATE INDEX IF NOT EXISTS idx_story_reacoes_story ON blue_story_reacoes(story_id);
CREATE INDEX IF NOT EXISTS idx_story_replies_story ON blue_story_replies(story_id);
-- Segurança: API usa service key (bypassa RLS); RLS ligado sem policy = anon bloqueado
ALTER TABLE blue_stories ENABLE ROW LEVEL SECURITY;
ALTER TABLE blue_story_reacoes ENABLE ROW LEVEL SECURITY;
ALTER TABLE blue_story_replies ENABLE ROW LEVEL SECURITY;

-- ── 1. Stories ganham audiência ──────────────────────────────────────────────
-- 'stories' = aparece pro perfil/seguidores | 'status' = SÓ contatos do BlueChat
ALTER TABLE blue_stories ADD COLUMN IF NOT EXISTS audience TEXT NOT NULL DEFAULT 'stories';
CREATE INDEX IF NOT EXISTS idx_bstories_aud_exp ON blue_stories(audience, expirado_em);

-- ── 2. Compartilhar vídeo do feed no story/status ────────────────────────────
ALTER TABLE blue_stories ADD COLUMN IF NOT EXISTS video_id UUID;

-- ── 3. Contatos com aceite (adicionar usuário → outro precisa aceitar) ───────
ALTER TABLE blue_contatos ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'accepted';
CREATE INDEX IF NOT EXISTS idx_bcontatos_pending ON blue_contatos(contato_id, status);

-- ── 4. Perfil: privacidade + tipo de conta ───────────────────────────────────
ALTER TABLE blue_profiles ADD COLUMN IF NOT EXISTS is_private BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE blue_profiles ADD COLUMN IF NOT EXISTS account_type TEXT NOT NULL DEFAULT 'profissional';
