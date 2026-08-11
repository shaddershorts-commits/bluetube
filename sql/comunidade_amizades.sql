-- ============================================================================
-- Comunidade BlueTube — AMIZADES (2026-08-11)
-- Rodar no Supabase SQL Editor. É idempotente: pode rodar quantas vezes quiser.
-- ============================================================================
--
-- POR QUE UMA TABELA NOVA E NÃO `blue_contatos`
-- `blue_contatos` guarda DUAS linhas por par (user_id→contato_id e a inversa,
-- inserida no aceite em api/blue-chat.js). Se qualquer um dos dois INSERTs
-- falhar, a amizade passa a existir num sentido e não no outro — o clássico
-- "ele é meu amigo mas eu não sou dele". Aqui o par tem UMA linha só, com
-- ordem canônica (user_a < user_b), então essa classe de bug não existe: não
-- há como as duas metades discordarem porque não há duas metades.
--
-- ORDEM CANÔNICA
-- user_a é SEMPRE o menor uuid do par e user_b o maior (o CHECK garante).
-- Como efeito colateral de graça, `user_a < user_b` torna impossível gravar
-- amizade de alguém consigo mesmo (a < a é falso) — a regra vive no banco,
-- não só no código.
--
-- ANTI-SPAM (strikes + carência)
-- Desfazer/recusar NUNCA apaga a linha: o histórico é o que impede o spam.
-- Se a linha fosse deletada, bastava recusar → pedir de novo → recusar…
-- para sempre. Em vez disso:
--   • strikes_a / strikes_b = quantas vezes os pedidos DAQUELE lado foram
--     recusados, ou a amizade que ele tinha foi desfeita pelo outro.
--   • cooldown_a / cooldown_b = data até quando AQUELE lado não pode pedir
--     de novo. A carência é escalonada (7 dias × strikes).
--   • strikes >= 3 = bloqueio definitivo daquele lado (a API responde 403).
-- Quem recusou/desfez NÃO leva strike: pode voltar atrás quando quiser.
-- ============================================================================

create table if not exists community_friendships (
  user_a       uuid not null,           -- SEMPRE o menor uuid do par
  user_b       uuid not null,           -- SEMPRE o maior uuid do par
  requested_by uuid not null,           -- quem mandou o pedido em vigor
  status       text not null default 'pending', -- pending|accepted|rejected|removed
  strikes_a    int  not null default 0, -- recusas/remoções sofridas pelo lado A
  strikes_b    int  not null default 0, -- idem pelo lado B
  cooldown_a   timestamptz,             -- A não pode pedir antes disso
  cooldown_b   timestamptz,             -- B não pode pedir antes disso
  removed_by   uuid,                    -- quem desfez/cancelou por último
  requested_at timestamptz default now(),
  responded_at timestamptz,             -- virou 'accepted'
  rejected_at  timestamptz,             -- virou 'rejected'
  removed_at   timestamptz,             -- virou 'removed'
  created_at   timestamptz default now(),
  updated_at   timestamptz default now(),
  primary key (user_a, user_b)
);

-- Colunas novas em bases que já tinham a tabela (idempotência de verdade)
alter table community_friendships add column if not exists strikes_a    int not null default 0;
alter table community_friendships add column if not exists strikes_b    int not null default 0;
alter table community_friendships add column if not exists cooldown_a   timestamptz;
alter table community_friendships add column if not exists cooldown_b   timestamptz;
alter table community_friendships add column if not exists removed_by   uuid;
alter table community_friendships add column if not exists requested_at timestamptz default now();
alter table community_friendships add column if not exists responded_at timestamptz;
alter table community_friendships add column if not exists rejected_at  timestamptz;
alter table community_friendships add column if not exists removed_at   timestamptz;
alter table community_friendships add column if not exists updated_at   timestamptz default now();

-- ── Invariantes no BANCO (não só na API) ────────────────────────────────────
-- `user_a < user_b` faz três trabalhos: ordem canônica, uma linha por par
-- (junto com a PK) e proibição de amizade consigo mesmo.
do $$ begin
  alter table community_friendships
    add constraint community_friendships_ordem check (user_a < user_b);
exception when duplicate_object then null; end $$;

do $$ begin
  alter table community_friendships
    add constraint community_friendships_status
    check (status in ('pending', 'accepted', 'rejected', 'removed'));
exception when duplicate_object then null; end $$;

-- Quem pediu tem que ser um dos dois do par — não dá pra terceiro empurrar
-- amizade entre outras duas pessoas.
do $$ begin
  alter table community_friendships
    add constraint community_friendships_autor
    check (requested_by = user_a or requested_by = user_b);
exception when duplicate_object then null; end $$;

do $$ begin
  alter table community_friendships
    add constraint community_friendships_strikes check (strikes_a >= 0 and strikes_b >= 0);
exception when duplicate_object then null; end $$;

-- ── Índices ─────────────────────────────────────────────────────────────────
-- As duas pontas precisam de índice porque "meus amigos" é
-- (user_a = eu OR user_b = eu) — um índice só cobriria metade das buscas.
create index if not exists idx_cfriend_a on community_friendships (user_a, status);
create index if not exists idx_cfriend_b on community_friendships (user_b, status);
-- Caixa de "pedidos recebidos": pendentes que NÃO fui eu quem mandei.
create index if not exists idx_cfriend_pend on community_friendships (status, requested_by);

-- ── RLS ─────────────────────────────────────────────────────────────────────
-- Mesma política do resto da Comunidade: RLS ligada e SEM policy nenhuma.
-- Isso derruba anon/authenticated no PostgREST; todo acesso passa pela
-- service key dentro de api/community.js, que é quem aplica o portão
-- Full/Master. Sem isso, qualquer um com a anon key listaria as amizades
-- de todo mundo.
alter table community_friendships enable row level security;

-- Reforço explícito (RLS não vale pro dono da tabela por padrão).
alter table community_friendships force row level security;

-- ── Sanidade: sobrou alguma linha fora da ordem canônica? ───────────────────
-- Deve devolver 0. Se devolver mais, algo escreveu por fora da API.
-- select count(*) as fora_de_ordem from community_friendships where user_a >= user_b;
