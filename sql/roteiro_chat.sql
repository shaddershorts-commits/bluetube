-- ═══════════════════════════════════════════════════════════════════════════
-- CHAT DE AJUSTE DE ROTEIRO — Blublu (home / ferramenta de transcrição)
-- 2026-07-29. Rodar no SQL Editor do Supabase. Idempotente (pode rodar 2x).
--
-- Chatbot SEPARADO do "Falar com o Blublu" da Virais (blublu_chat_usage):
-- outro cérebro, outra cota, outro registro. Mesma personalidade, só.
--
-- RLS: negado pra anon — acesso só via service key na API, seguindo o
-- lockdown de 2026-07-17.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1) REGISTRO DE TODA TROCA ──────────────────────────────────────────────
-- Motivo de existir: na auditoria de 29/07 não havia UMA conversa gravada.
-- O histórico vivia só no localStorage do navegador, então era impossível
-- saber o que os usuários pediam nem se ficavam satisfeitos.
create table if not exists roteiro_chat_log (
  id             bigserial primary key,
  user_id        uuid,
  email          text,
  plano          text,                    -- free | full | master
  versao         text,                    -- V1 casual | V2 apelativo | V3 tradução
  idioma         text,
  intencao       text,                    -- Fase 3: ordem | pergunta | vago | fora_escopo
  instrucao      text,
  roteiro_antes  text,
  roteiro_depois text,
  mudou          boolean,
  recusado_por   text,                    -- motivo do portão de sanidade
  erro           text,
  latencia_ms    int,
  criado_em      timestamptz not null default now()
);
alter table roteiro_chat_log enable row level security;

create index if not exists idx_rchat_criado   on roteiro_chat_log (criado_em desc);
create index if not exists idx_rchat_user     on roteiro_chat_log (user_id, criado_em desc);
-- as duas consultas que a gente vai fazer toda semana:
create index if not exists idx_rchat_recusa   on roteiro_chat_log (recusado_por) where recusado_por is not null;
create index if not exists idx_rchat_erro     on roteiro_chat_log (erro)         where erro is not null;

-- ── 2) COTA DIÁRIA ─────────────────────────────────────────────────────────
-- free com conta = 5 ajustes/dia. full e master = ilimitado.
-- Sem conta não chega aqui: o front abre o popup de cadastro.
create table if not exists roteiro_chat_usage (
  user_id uuid  not null,
  dia     date  not null default current_date,
  count   int   not null default 0,
  primary key (user_id, dia)
);
alter table roteiro_chat_usage enable row level security;

-- ── 3) LIMPEZA ─────────────────────────────────────────────────────────────
-- O log guarda roteiro inteiro (antes e depois); sem poda ele cresce rápido.
-- 90 dias é bastante pra análise e mantém a tabela leve.
create or replace function limpar_roteiro_chat_log() returns void
language sql as $$
  delete from roteiro_chat_log where criado_em < now() - interval '90 days';
  delete from roteiro_chat_usage where dia < current_date - 60;
$$;

-- ── CONFERÊNCIA ────────────────────────────────────────────────────────────
-- select count(*) from roteiro_chat_log;
-- select recusado_por, count(*) from roteiro_chat_log
--   where recusado_por is not null group by 1 order by 2 desc;
-- select intencao, count(*), avg(latencia_ms)::int from roteiro_chat_log
--   group by 1 order by 2 desc;
