-- ============================================================================
-- sql/user_feedback.sql — Garante schema da tabela de feedback/suporte
-- Usada por /api/feedback (BluBlu + suporte + cancel). Idempotente.
-- ============================================================================

CREATE TABLE IF NOT EXISTS user_feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT,
  plan TEXT,
  message TEXT NOT NULL,
  type TEXT DEFAULT 'feedback', -- 'feedback' | 'support' | 'cancel'
  is_read BOOLEAN DEFAULT FALSE,
  admin_response TEXT,
  responded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ADD COLUMN IF NOT EXISTS pra bancos legacy que podem ter schema diferente
ALTER TABLE user_feedback
  ADD COLUMN IF NOT EXISTS plan TEXT,
  ADD COLUMN IF NOT EXISTS type TEXT DEFAULT 'feedback',
  ADD COLUMN IF NOT EXISTS is_read BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS admin_response TEXT,
  ADD COLUMN IF NOT EXISTS responded_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_user_feedback_created
  ON user_feedback(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_feedback_type
  ON user_feedback(type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_feedback_unread
  ON user_feedback(created_at DESC) WHERE is_read = false;
