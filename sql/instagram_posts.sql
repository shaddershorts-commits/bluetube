-- Tabela de posts do Instagram exibidos no carrossel da home (entre planos e FAQ).
-- Felipe adiciona URL via painel admin; frontend renderiza com embed.js oficial
-- do Instagram (sem API/scraping). Manual mas zero dependencia externa.

CREATE TABLE IF NOT EXISTS instagram_posts (
  id BIGSERIAL PRIMARY KEY,
  url TEXT NOT NULL UNIQUE,
  sort_order INT NOT NULL DEFAULT 0,
  added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  caption TEXT, -- opcional, hint pro admin lembrar do post
  CONSTRAINT instagram_posts_url_format CHECK (url ~* '^https?://(www\.)?instagram\.com/(p|reel|reels)/[a-zA-Z0-9_-]+')
);

-- Indice pra query "ativos ordenados" (usado pelo endpoint publico)
CREATE INDEX IF NOT EXISTS idx_ig_active_order ON instagram_posts (active, sort_order, added_at DESC);

-- RLS desligada (admin escreve via service_role; frontend le via endpoint backend)
ALTER TABLE instagram_posts DISABLE ROW LEVEL SECURITY;
