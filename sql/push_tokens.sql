-- sql/push_tokens.sql — tokens Expo Push para notificações no app
-- Rodar no SQL Editor do Supabase (app.supabase.com/project/pokpfvjrccviwgguwuck/sql).

CREATE TABLE IF NOT EXISTS user_push_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  expo_push_token TEXT NOT NULL UNIQUE,
  platform TEXT,
  device_name TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_push_tokens_user ON user_push_tokens (user_id);

ALTER TABLE user_push_tokens ENABLE ROW LEVEL SECURITY;
-- Sem policies abertas — acesso somente via service_key pelo backend
