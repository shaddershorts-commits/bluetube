-- ============================================================================
-- Comunidade BlueTube — DENÚNCIAS (2026-08-11)
-- Rodar no Supabase SQL Editor. É idempotente: pode rodar quantas vezes quiser.
-- ============================================================================
--
-- Nasceu junto com o menu de 3 pontos. Até aqui o ⋯ só existia pra quem era
-- AUTOR do post ou moderador — quem via algo errado não tinha o que fazer além
-- de fechar a aba.
--
-- ⚠️ A REGRA QUE DEU ORIGEM À TABELA: denúncia que ninguém lê é botão falso.
-- Por isso a linha aqui não é o produto final — o produto é a NOTIFICAÇÃO que
-- chega no sininho do moderador na hora, com o nome de quem foi denunciado e o
-- começo do conteúdo. A tabela é o histórico e o anti-spam; o sino é o que faz
-- a denúncia virar ação.
--
-- ANTI-SPAM: uma denúncia por pessoa por alvo (índice único). Sem isso, o botão
-- vira metralhadora de sino — e o moderador aprende a ignorar o sino, que é o
-- pior resultado possível.
-- ============================================================================

create table if not exists community_reports (
  id           uuid primary key default gen_random_uuid(),
  reporter_id  uuid not null,
  -- 'post' | 'comentario' | 'perfil'
  alvo_tipo    text not null,
  -- id do post/comentário; pro perfil, o display_name (a UI nunca recebe uuid
  -- de ninguém — mesma convenção das amizades em api/community.js).
  alvo_id      text not null,
  alvo_user_id uuid,                 -- dono do conteúdo, resolvido no servidor
  motivo       text not null,        -- spam | ofensa | improprio | outro
  status       text not null default 'aberta',   -- aberta | vista | resolvida
  created_at   timestamptz not null default now()
);

-- RLS colada na criação (a tabela guarda quem denunciou quem — é o tipo de
-- linha que não pode ficar nem um segundo aberta pro papel anon).
alter table community_reports enable row level security;
alter table community_reports force  row level security;

do $$ begin
  alter table community_reports
    add constraint community_reports_tipo check (alvo_tipo in ('post', 'comentario', 'perfil'));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table community_reports
    add constraint community_reports_motivo check (motivo in ('spam', 'ofensa', 'improprio', 'outro'));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table community_reports
    add constraint community_reports_status check (status in ('aberta', 'vista', 'resolvida'));
exception when duplicate_object then null; end $$;

-- Uma denúncia por pessoa por alvo. O 409 que este índice devolve é tratado
-- como SUCESSO na API: quem já denunciou não precisa saber que já denunciou —
-- e, principalmente, o botão não vira sonda pra descobrir isso.
create unique index if not exists uq_creport_uma_por_alvo
  on community_reports (reporter_id, alvo_tipo, alvo_id);

-- A fila do moderador: as abertas, mais novas primeiro.
create index if not exists idx_creport_abertas on community_reports (status, created_at desc);

-- ── Fila de denúncias (o moderador roda isto pra ver o que chegou) ──────────
-- select r.created_at, r.alvo_tipo, r.motivo, p.display_name as denunciado, r.alvo_id
--   from community_reports r
--   left join community_profiles p on p.user_id = r.alvo_user_id
--  where r.status = 'aberta'
--  order by r.created_at desc;
