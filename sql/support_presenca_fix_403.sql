-- sql/support_presenca_fix_403.sql — conserta o 403 no ping de presença
-- ===========================================================================
-- Idempotente: rodar 2x não dá erro. Roda em cima do sql/support_chat_v2.sql.
--
-- ── O QUE ACONTECIA ──────────────────────────────────────────────────────
-- No console de produção, a cada 2 minutos:
--     POST .../rest/v1/support_presenca  403 (Forbidden)
--
-- O navegador manda um UPSERT (Prefer: resolution=merge-duplicates), que o
-- PostgREST traduz pra:
--     INSERT INTO support_presenca (...) VALUES (...)
--       ON CONFLICT (user_id) DO UPDATE SET visto_em = excluded.visto_em
--
-- O support_chat_v2.sql criou a policy de INSERT e a de UPDATE, e deixou de
-- fora a de SELECT DE PROPÓSITO ("usuário não descobre quem mais está online").
-- A intenção estava certa; o efeito colateral, não:
--
--   INSERT ... ON CONFLICT DO UPDATE, numa tabela com RLS, executa uma
--   checagem extra (WCO_RLS_CONFLICT_CHECK no Postgres) que pergunta: "a linha
--   que eu vou atualizar é visível pra este usuário pelas policies de SELECT?".
--   SEM policy de SELECT, nenhuma linha é visível — a checagem falha sempre,
--   o Postgres levanta 42501 e o PostgREST devolve 403.
--
-- Isso explica o comportamento exato observado: o PRIMEIRO ping de cada
-- usuário (INSERT puro, sem conflito) passava; do segundo em diante, todo ping
-- caía no ON CONFLICT e virava 403 pra sempre.
--
-- ── O CONSERTO ───────────────────────────────────────────────────────────
-- 1. Policy de SELECT restrita à PRÓPRIA linha. A regra de privacidade
--    original continua de pé: ninguém vê a presença de mais ninguém. Ver o
--    próprio "visto_em" não revela nada que a pessoa já não saiba.
-- 2. WITH CHECK explícito no UPDATE (o implícito herdaria o USING, mas aqui a
--    linha muda de valor e é melhor a regra estar escrita).
-- 3. RPC support_ping(): SECURITY DEFINER, faz o upsert por dentro. É o
--    caminho preferido do front — uma função não tem essa armadilha de
--    ON CONFLICT + RLS, e o dia que alguém mexer nas policies o ping não cai
--    junto. A escrita direta na tabela continua valendo como reserva.

-- ── 1) A policy que faltava ────────────────────────────────────────────────
drop policy if exists presenca_select_own on support_presenca;
create policy presenca_select_own on support_presenca
  for select to authenticated using (auth.uid() = user_id);

-- ── 2) UPDATE com os dois lados escritos ───────────────────────────────────
drop policy if exists presenca_update_own on support_presenca;
create policy presenca_update_own on support_presenca
  for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Sem GRANT, RLS nem chega a ser consultada: o Postgres barra antes, com o
-- mesmo 42501/403. Idempotente por natureza.
grant select, insert, update on support_presenca to authenticated;

-- ── 3) Caminho preferido: RPC ──────────────────────────────────────────────
-- SECURITY DEFINER + search_path fixo (sem o search_path, um schema plantado
-- na frente do public sequestraria a função — é o buraco clássico de
-- SECURITY DEFINER).
-- Quem é o dono da linha sai de auth.uid(), NUNCA de argumento: o navegador
-- não escolhe por quem está pingando.
create or replace function public.support_ping()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'sem sessão' using errcode = '42501';
  end if;
  insert into support_presenca (user_id, visto_em)
  values (auth.uid(), now())
  on conflict (user_id) do update set visto_em = excluded.visto_em;
end;
$$;

revoke all on function public.support_ping() from public;
grant execute on function public.support_ping() to authenticated;
