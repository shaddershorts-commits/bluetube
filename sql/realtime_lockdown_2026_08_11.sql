-- realtime_lockdown_2026_08_11.sql  (v2)
--
-- FECHA OS CANAIS DE TEMPO REAL (campainha e sinalização de chamada).
--
-- O que foi encontrado (teste real, 11/08): dois clientes ANÔNIMOS, só com a
-- chave pública do APK, entraram no MESMO canal `ring-` e trocaram mensagem.
-- Nomes previsíveis (`ring-<uid>`, `call-<id>`) => dava pra tocar o telefone
-- de qualquer um e entrar na sinalização de uma chamada (escutar a ligação).
--
-- Como o Supabase autoriza canal: a checagem por policy só roda em canais
-- PRIVADOS (private: true no app). Canal público não é checado. Por isso este
-- SQL anda de mãos dadas com a mudança no app que marca os canais como
-- privados — um sem o outro não protege.
--
-- ⚠️ ORDEM (importa e é o oposto do que parece):
--   1º) rodar ESTE SQL. O app ATUAL usa canais públicos, que não passam por
--       policy — então rodar isto NÃO quebra o app atual.
--   2º) publicar o app com os canais privados. A partir daí a proteção vale
--       pros aparelhos atualizados. (Se o app privado chegar ANTES do SQL, as
--       chamadas dele falhariam ao entrar no canal — por isso SQL primeiro.)
--
-- ── correção sobre a v1 ────────────────────────────────────────────────────
-- A v1 checava a chamada com EXISTS direto na blue_calls. Mas blue_calls tem
-- FORCE ROW LEVEL SECURITY e nenhuma policy pra 'authenticated' — ou seja, o
-- usuário logado não enxerga NENHUMA linha dela. O EXISTS daria sempre falso e
-- NINGUÉM entraria no canal da chamada: derrubaria todas as chamadas. A v2
-- primeiro dá a cada um o direito de ver as PRÓPRIAS chamadas.

-- 1) cada um enxerga as próprias chamadas (pré-requisito da checagem abaixo).
--    Não vaza nada de terceiros: só linhas onde você é uma das pontas. A API
--    continua usando a service key (que ignora RLS), então nada muda pra ela.
ALTER TABLE public.blue_calls ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "blue_calls_select_own" ON public.blue_calls;
CREATE POLICY "blue_calls_select_own" ON public.blue_calls
  FOR SELECT TO authenticated
  USING (caller_id = (SELECT auth.uid()) OR callee_id = (SELECT auth.uid()));

-- 2) Realtime Authorization.
ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY;

-- OUVIR (entrar no canal):
--   - `ring-<meu uid>`: só o dono escuta a própria campainha;
--   - `call-<id>`: só as duas pontas da chamada.
DROP POLICY IF EXISTS "blue_realtime_listen" ON realtime.messages;
CREATE POLICY "blue_realtime_listen" ON realtime.messages
  FOR SELECT TO authenticated
  USING (
    realtime.topic() = 'ring-' || (SELECT auth.uid())::text
    OR EXISTS (
      SELECT 1 FROM public.blue_calls c
      WHERE realtime.topic() = 'call-' || c.id::text
        AND (c.caller_id = (SELECT auth.uid()) OR c.callee_id = (SELECT auth.uid()))
    )
  );

-- FALAR (publicar no canal): só na sinalização da chamada, e só as duas
-- pontas. `ring-` NÃO aparece aqui de propósito: nenhum aparelho publica
-- campainha — quem toca é o servidor (api/blue-calls.js, com service key, que
-- ignora RLS). Assim ninguém faz o telefone de outro tocar sem passar pela API.
DROP POLICY IF EXISTS "blue_realtime_send" ON realtime.messages;
CREATE POLICY "blue_realtime_send" ON realtime.messages
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.blue_calls c
      WHERE realtime.topic() = 'call-' || c.id::text
        AND (c.caller_id = (SELECT auth.uid()) OR c.callee_id = (SELECT auth.uid()))
    )
  );

-- CONFERÊNCIA
SELECT policyname, cmd, roles::text
FROM pg_policies
WHERE schemaname = 'realtime' AND tablename = 'messages'
ORDER BY policyname;
