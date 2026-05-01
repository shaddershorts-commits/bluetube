-- Tabela key-value simples pra configs do site (admin gerencia).
-- Hoje guarda: instagram_profile_photo_url. Pode crescer com outras configs.

CREATE TABLE IF NOT EXISTS site_kv (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  is_public BOOLEAN NOT NULL DEFAULT FALSE
);

ALTER TABLE site_kv DISABLE ROW LEVEL SECURITY;

-- Insere o slot da foto de perfil (vazio inicialmente; Felipe seta via admin)
INSERT INTO site_kv (key, value, is_public)
VALUES ('instagram_profile_photo_url', NULL, TRUE)
ON CONFLICT (key) DO NOTHING;
