-- rls_drop_permissive_2026_07_17.sql — remove POLÍTICAS PERMISSIVAS antigas
-- 5 tabelas continuaram legíveis mesmo com RLS ligado porque tinham uma
-- policy antiga liberando anon (ex.: USING (true)). Ligar RLS não adianta se
-- existe policy dizendo "pode". Este script apaga TODAS as policies dessas 5
-- tabelas e garante RLS on. Seguro: nenhuma é lida direto pelo frontend (só a
-- API via service key, que ignora RLS). Idempotente.

DO $$
DECLARE
  t text;
  p record;
  alvos text[] := ARRAY['subscribers','user_feedback','ip_visits','ip_usage','ip_online'];
BEGIN
  FOREACH t IN ARRAY alvos LOOP
    -- apaga toda policy existente na tabela
    FOR p IN SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename=t LOOP
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', p.policyname, t);
    END LOOP;
    -- garante RLS ligado + forçado (sem policy = ninguém além do service key)
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;
