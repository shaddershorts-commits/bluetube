-- ═══════════════════════════════════════════════════════════════════════════
-- VARREDURA DE PLANOS VENCIDOS — aviso + rebaixamento pra free
-- 2026-07-30. Idempotente.
--
-- Contexto: descobrimos 3 trials de 30 dias que terminaram EM SILÊNCIO (nenhum
-- email) e 1 assinante paga cuja assinatura foi cancelada por bug nosso. Em
-- todos, a coluna `plan` continuou marcando "full"/"master" pra sempre, o que
-- suja contagem e relatório. O acesso já era negado (get-plan respeita a
-- expiração) — o que faltava era avisar a pessoa e limpar o registro.
-- ═══════════════════════════════════════════════════════════════════════════

-- Quando o aviso de vencimento foi enviado. Serve pra 2 coisas:
--   1. não mandar o mesmo email duas vezes
--   2. contar a carência de 3 dias A PARTIR do aviso — ninguém é rebaixado
--      sem ter sido avisado antes
alter table subscribers add column if not exists expiry_notice_sent_at timestamptz;

comment on column subscribers.expiry_notice_sent_at is
  'Quando avisamos que o plano ia vencer. Rebaixamento pra free só 3 dias depois disso.';

create index if not exists idx_subs_expiry_sweep
  on subscribers (plan_expires_at)
  where plan <> 'free' and is_manual = false;

-- ── CONFERÊNCIA ────────────────────────────────────────────────────────────
-- quem a varredura vai pegar hoje:
-- select email, plan, trial_origin, plan_expires_at, expiry_notice_sent_at
--   from subscribers
--  where plan <> 'free' and is_manual = false
--    and plan_expires_at is not null
--    and plan_expires_at < now() + interval '3 days'
--  order by plan_expires_at;
