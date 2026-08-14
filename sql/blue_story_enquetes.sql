-- blue_story_enquetes.sql — votos de enquete nos stories (editor Fase 2).
--
-- A enquete em si é uma CAMADA (overlay tipo 'enquete') dentro de blue_stories.
-- Os VOTOS vivem aqui, um por (overlay, usuário). Endpoint action=votar-enquete
-- faz upsert e devolve a contagem. overlay_id é o id da camada (string do app).
CREATE TABLE IF NOT EXISTS blue_story_votos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  story_id UUID REFERENCES blue_stories(id) ON DELETE CASCADE,
  overlay_id TEXT NOT NULL,
  user_id UUID NOT NULL,
  opcao INTEGER NOT NULL,               -- 0 ou 1
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(overlay_id, user_id)           -- 1 voto por pessoa por enquete
);
CREATE INDEX IF NOT EXISTS idx_story_votos_overlay ON blue_story_votos(overlay_id);
ALTER TABLE blue_story_votos ENABLE ROW LEVEL SECURITY; -- API usa service key
