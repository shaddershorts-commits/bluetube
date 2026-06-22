-- SUPORTE — Chat 1:1 entre user e admin via Supabase Realtime
-- =========================================================
-- Aplicar via SQL Editor do Supabase (Project → SQL Editor → New query).
-- Idempotente: rodar 2x não causa erro.
--
-- Arquitetura:
--   • 1 thread "open" por user (constraint UNIQUE parcial)
--   • support_messages com sender=user|admin
--   • Realtime via publication supabase_realtime (Supabase WebSocket)
--   • RLS: user só vê própria thread; backend usa SERVICE_KEY (bypass RLS)

-- ── support_threads ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS support_threads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  user_email text NOT NULL,
  user_name text,
  user_plan text,                                  -- snapshot do plano na abertura (debug)
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  unread_user int NOT NULL DEFAULT 0,              -- pra badge no botão do user
  unread_admin int NOT NULL DEFAULT 0,             -- pra badge no painel admin
  last_message_preview text,                       -- primeiros 100 chars da última msg
  last_message_sender text,                        -- 'user' | 'admin'
  last_message_at timestamptz DEFAULT NOW(),
  email_sent_to_admin_at timestamptz,              -- throttle do email Resend (30min)
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  closed_at timestamptz
);

-- Apenas 1 thread "open" por user — força reabrir thread existente
CREATE UNIQUE INDEX IF NOT EXISTS uniq_open_thread_per_user
  ON support_threads(user_id) WHERE status = 'open';

-- Listagem admin: status + last_message_at
CREATE INDEX IF NOT EXISTS idx_support_threads_status_last_msg
  ON support_threads(status, last_message_at DESC);

-- ── support_messages ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS support_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id uuid NOT NULL REFERENCES support_threads(id) ON DELETE CASCADE,
  sender text NOT NULL CHECK (sender IN ('user', 'admin')),
  content text NOT NULL,
  read_at timestamptz,                             -- quando o destinatário leu
  created_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_support_messages_thread_created
  ON support_messages(thread_id, created_at DESC);

-- ── ROW LEVEL SECURITY ─────────────────────────────────────────────────────
ALTER TABLE support_threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_messages ENABLE ROW LEVEL SECURITY;

-- User vê SÓ a própria thread (SELECT)
DROP POLICY IF EXISTS user_select_own_thread ON support_threads;
CREATE POLICY user_select_own_thread
  ON support_threads FOR SELECT
  USING (auth.uid() = user_id);

-- User vê SÓ mensagens das próprias threads (SELECT)
DROP POLICY IF EXISTS user_select_own_messages ON support_messages;
CREATE POLICY user_select_own_messages
  ON support_messages FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM support_threads
      WHERE support_threads.id = support_messages.thread_id
        AND support_threads.user_id = auth.uid()
    )
  );

-- Backend (SERVICE_KEY) bypass RLS automaticamente. Não precisa policy de INSERT/UPDATE
-- porque toda escrita passa pelo /api/support-chat com SERVICE_KEY (validação no handler).

-- ── REALTIME PUBLICATION ───────────────────────────────────────────────────
-- Necessário pra Realtime emitir eventos INSERT/UPDATE pros subscribers.
-- Idempotente: tenta adicionar; ignora se já estiver.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'support_messages'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE support_messages;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'support_threads'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE support_threads;
  END IF;
END $$;

-- ── TRIGGER: updated_at automático ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION support_threads_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_support_threads_updated_at ON support_threads;
CREATE TRIGGER trg_support_threads_updated_at
  BEFORE UPDATE ON support_threads
  FOR EACH ROW EXECUTE FUNCTION support_threads_set_updated_at();

-- ── SANITY CHECK ───────────────────────────────────────────────────────────
SELECT 'support_threads' AS tbl, COUNT(*) FROM support_threads
UNION ALL
SELECT 'support_messages', COUNT(*) FROM support_messages;
