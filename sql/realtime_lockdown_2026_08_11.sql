-- realtime_lockdown_2026_08_11.sql
--
-- FECHA OS CANAIS DE TEMPO REAL (chamadas e presença).
--
-- O que foi encontrado (teste real, 11/08):
--   Dois clientes ANÔNIMOS, usando só a chave pública que está dentro do APK,
--   entraram no MESMO canal `ring-<uid>` e trocaram mensagem entre si.
--   Nenhuma credencial de usuário foi necessária.
--
-- Por que isso é grave — os canais têm nome PREVISÍVEL:
--   `ring-<user_id>`  → dá pra tocar o telefone de qualquer usuário fingindo
--                       ser outra pessoa, e dá pra ver quem está ligando pra ele.
--   `call-<call_id>`  → é por onde passam SDP e ICE do WebRTC. Quem entra no
--                       canal pode responder antes do destinatário e assumir a
--                       ponta da chamada. Na prática: escutar a ligação.
--
-- Causa: o cliente Realtime do app é criado com a chave anon e
-- `persistSession: false`, então NUNCA manda o token do usuário; e o projeto
-- está sem Realtime Authorization, que é o padrão do Supabase (canal de
-- broadcast aceita qualquer apikey válida).
--
-- O conserto tem DUAS metades e as duas são obrigatórias:
--   (a) este SQL, que passa a exigir identidade nos canais;
--   (b) a mudança no app (src/lib/supabase.js + telas de chamada) que passa a
--       mandar o JWT do usuário no Realtime via setAuth().
--
-- ⚠️ ORDEM IMPORTA: rodar este SQL ANTES do app atualizado derruba as chamadas
-- (o app antigo não manda token e vai ser barrado). Publique o app primeiro,
-- espere ele chegar nos aparelhos, e só então rode este script.

-- Realtime Authorization: a partir daqui, entrar num canal é uma operação
-- verificada por policy na tabela realtime.messages.
ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY;

-- ── OUVIR (entrar no canal) ───────────────────────────────────────────────
DROP POLICY IF EXISTS "blue_realtime_listen" ON realtime.messages;
CREATE POLICY "blue_realtime_listen" ON realtime.messages
  FOR SELECT TO authenticated
  USING (
    -- meu próprio canal de campainha, e só o meu
    realtime.topic() = 'ring-' || auth.uid()::text
    OR
    -- canal da chamada: só quem é uma das duas pontas dela
    EXISTS (
      SELECT 1 FROM public.blue_calls c
      WHERE realtime.topic() = 'call-' || c.id::text
        AND (c.caller_id = auth.uid() OR c.callee_id = auth.uid())
    )
  );

-- ── FALAR (publicar no canal) ─────────────────────────────────────────────
-- Repare que `ring-` NÃO aparece aqui: nenhum aparelho publica campainha.
-- Quem toca é o servidor, em api/blue-calls.js, com a service key (que ignora
-- RLS). Assim ninguém consegue fazer o telefone de outra pessoa tocar sem
-- passar pela API — que exige token e registra a chamada no banco.
DROP POLICY IF EXISTS "blue_realtime_send" ON realtime.messages;
CREATE POLICY "blue_realtime_send" ON realtime.messages
  FOR INSERT TO authenticated
  WITH CHECK (
    -- na sinalização da chamada, só as duas pontas falam
    EXISTS (
      SELECT 1 FROM public.blue_calls c
      WHERE realtime.topic() = 'call-' || c.id::text
        AND (c.caller_id = auth.uid() OR c.callee_id = auth.uid())
    )
  );

-- CONFERÊNCIA
SELECT policyname, cmd, roles::text
FROM pg_policies
WHERE schemaname = 'realtime' AND tablename = 'messages'
ORDER BY policyname;
