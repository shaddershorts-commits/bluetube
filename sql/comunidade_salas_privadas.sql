-- ============================================================================
-- Comunidade BlueTube — SALAS DE VOZ PRIVADAS (2026-08-11)
-- Rodar no Supabase SQL Editor. É idempotente: pode rodar quantas vezes quiser.
-- ============================================================================
--
-- ── O PROBLEMA QUE ESTE ARQUIVO EXISTE PRA RESOLVER ─────────────────────────
-- A sala de voz que já está no ar tem UM portão, e ele só roda uma vez: na hora
-- de assinar o crachá. Depois disso NADA tira ninguém de dentro — o LiveKit
-- renova a credencial sozinho pela própria conexão de sinalização, com validade
-- além da nossa. Foi MEDIDO em 11/08.
--
-- Isso torna "sala com senha" uma promessa falsa se ela for construída só com
-- uma senha na porta: quem entrou uma vez fica, e quem guardou o crachá entra
-- de novo com ele, sem passar pela porta. Uma sala privada de verdade precisa
-- de DUAS coisas que não existiam:
--
--   1) REMOÇÃO ATIVA — `RemoveParticipant` do RoomService (é o único caminho
--      que existe; quem chama é o servidor, com crachá de admin);
--   2) LISTA DE EXPULSOS — porque remover sem lembrar é enxugar gelo: a pessoa
--      pede outro crachá e volta em três segundos.
--
-- A lista mora aqui, em `community_voice_members.expulso_ate`. Ela é lida no
-- portão (antes de assinar o crachá) E numa varredura que roda quando alguém
-- entra na sala — é a varredura que fecha a fresta do crachá guardado, porque
-- ela olha quem ESTÁ dentro, não quem pediu pra entrar.
--
-- ── POR QUE A SENHA NÃO É GUARDADA ──────────────────────────────────────────
-- `senha_hash` é scrypt com sal por sala (formato `scrypt$N$sal$hash`). A senha
-- em texto nunca toca o banco. Não é paranoia de manual: a mesma senha que a
-- pessoa escolhe aqui costuma ser a que ela usa em outro lugar.
--
-- ── POR QUE `senha_versao` ──────────────────────────────────────────────────
-- Quem acerta a senha uma vez fica "liberado" (é o que faz a pessoa não digitar
-- senha a cada F5). Sem versão, trocar a senha não expulsaria ninguém da LISTA
-- de liberados — o dono trocaria a senha e as mesmas pessoas continuariam
-- entrando pra sempre com a liberação velha. Com versão, trocar a senha
-- invalida todas as liberações de uma vez: `liberado_versao < senha_versao`
-- volta a pedir senha.
--
-- ⚠️ E o que a troca de senha NÃO faz: ela não tira ninguém que já está DENTRO.
-- Isso é de propósito e está escrito na tela também. Quem está dentro entrou
-- com a senha que valia na hora; pra tirar alguém existe o expulsar, que é
-- remoção de verdade. Prometer o contrário seria construir por cima do buraco
-- em vez de resolvê-lo.
-- ============================================================================


-- ── SALAS ───────────────────────────────────────────────────────────────────
-- Uma linha aqui é a DEFINIÇÃO da sala (dono, título, senha, co-anfitriões),
-- não a sala do LiveKit. A sala do LiveKit nasce quando a primeira pessoa entra
-- e é apagada por ele quando esvazia — e é por isso que os expulsos moram no
-- banco: se a lista morresse junto com a sala vazia, bastava esperar cinco
-- minutos pra "expulso" virar nada.
create table if not exists community_voice_rooms (
  id            uuid primary key default gen_random_uuid(),
  -- Nome da sala DENTRO do LiveKit. Curto e sem PII: ele viaja no crachá e
  -- aparece em log de terceiro.
  slug          text not null unique,
  titulo        text not null,
  -- NULO é a SALA PÚBLICA (a que já estava no ar). Ela ganhou linha aqui de
  -- propósito: é o que dá a ela a lista de expulsos e a varredura, ou seja, o
  -- conserto do buraco também na sala onde a Comunidade inteira conversa. Sem
  -- dono, ninguém é "dono" dela — quem manda ali é o moderador do site.
  owner_id      uuid,
  senha_hash    text,                              -- null = sala sem senha
  senha_versao  int  not null default 1,
  aberta        boolean not null default true,     -- false = encerrada pelo dono
  criada_em     timestamptz not null default now(),
  encerrada_em  timestamptz,
  -- Carimbo da última vez que alguém ENTROU. É o que ordena a lista de salas.
  -- Existe porque o ListRooms do LiveKit já foi pego MENTINDO por omissão
  -- (medido em 11/08: dois participantes conversando e a lista voltou vazia,
  -- porque a sala tinha sido apagada e recriada). A lista de salas não pode
  -- depender só dele: com este carimbo, uma sala viva que ele esqueceu de
  -- mencionar continua aparecendo — só sem o número de gente.
  ultima_entrada timestamptz,
  updated_at    timestamptz not null default now()
);

-- ⚠️ RLS LIGADA AQUI, colada no create table — não no fim do arquivo. Este
-- arquivo é colado à mão no painel do Supabase: se a execução parar no meio, a
-- tabela fica ABERTA pro papel anon (a chave que todo visitante do site carrega
-- no navegador) e ninguém percebe. Este projeto já teve 34 tabelas expostas
-- assim (auditoria de 17/07). Ligar junto com a criação torna a janela nula.
--
-- Política igual à do resto da Comunidade: RLS ligada e SEM policy nenhuma.
-- Isso derruba anon/authenticated no PostgREST; todo acesso passa pela service
-- key dentro de api/sala-voz.js, que é quem aplica o portão Full/Master.
alter table community_voice_rooms enable row level security;
alter table community_voice_rooms force  row level security;


-- ── QUEM É QUEM DENTRO DE UMA SALA ──────────────────────────────────────────
-- UMA tabela pro vínculo pessoa↔sala, e não três (co-anfitriões, expulsos,
-- tentativas). O motivo é o mesmo que fez `community_friendships` ter uma linha
-- por par: estado da mesma relação espalhado em tabelas diferentes é estado que
-- discorda de si mesmo. Aqui, expulsar alguém e tirar o co-anfitrião dele é UM
-- upsert, não dois writes que podem falhar pela metade.
create table if not exists community_voice_members (
  room_id         uuid not null references community_voice_rooms(id) on delete cascade,
  user_id         uuid not null,
  -- 'co' = co-anfitrião. O dono NÃO precisa de linha aqui: ele é
  -- `community_voice_rooms.owner_id`, e derivar papel de dois lugares é como se
  -- cria o caso "o dono perdeu o controle da própria sala".
  papel           text,
  -- Versão da senha com que esta pessoa passou pela porta. null = nunca passou.
  liberado_versao int,
  -- A LISTA DE EXPULSOS. Uma data, não um booleano: expulsão que não vence
  -- vira lista de inimigos eterna, e o dono nunca lembra de limpar.
  expulso_ate     timestamptz,
  expulso_por     uuid,
  -- Freio de força bruta na senha. Sem isto, uma senha de 4 dígitos cai em
  -- segundos — e aí a senha é enfeite, não portão.
  falhas          int not null default 0,
  falhas_ate      timestamptz,
  updated_at      timestamptz not null default now(),
  primary key (room_id, user_id)
);

alter table community_voice_members enable row level security;
alter table community_voice_members force  row level security;


-- ── Invariantes no BANCO, não só na API ─────────────────────────────────────
do $$ begin
  alter table community_voice_rooms
    add constraint community_voice_rooms_slug check (slug ~ '^[a-z0-9-]{4,40}$');
exception when duplicate_object then null; end $$;

do $$ begin
  alter table community_voice_rooms
    add constraint community_voice_rooms_versao check (senha_versao >= 1);
exception when duplicate_object then null; end $$;

-- Senha em TEXTO não entra aqui. O CHECK não sabe o que é uma senha, mas sabe
-- reconhecer o formato do hash — e é o bastante pra um `update` desatento
-- gravando texto puro estourar no banco em vez de virar vazamento silencioso.
do $$ begin
  alter table community_voice_rooms
    add constraint community_voice_rooms_hash
    check (senha_hash is null or senha_hash ~ '^scrypt\$[0-9]+\$[a-f0-9]+\$[a-f0-9]+$');
exception when duplicate_object then null; end $$;

do $$ begin
  alter table community_voice_members
    add constraint community_voice_members_papel check (papel is null or papel = 'co');
exception when duplicate_object then null; end $$;

do $$ begin
  alter table community_voice_members
    add constraint community_voice_members_falhas check (falhas >= 0);
exception when duplicate_object then null; end $$;


-- ── UMA sala aberta por dono ────────────────────────────────────────────────
-- Índice parcial, não CHECK: a regra é "no máximo uma ABERTA", e sala encerrada
-- continua existindo (a lista de expulsos dela é histórico). Sem este índice,
-- um duplo-clique no botão de criar viraria duas salas e a segunda ficaria
-- órfã na tela de todo mundo.
create unique index if not exists uq_cvroom_dono_aberta
  on community_voice_rooms (owner_id) where aberta;

create index if not exists idx_cvroom_abertas on community_voice_rooms (aberta, ultima_entrada desc nulls last);

-- Coluna nova em bases que já tinham a tabela (idempotência de verdade)
alter table community_voice_rooms add column if not exists ultima_entrada timestamptz;
-- "Quem está expulso desta sala AGORA" e "quem é co-anfitrião" são as duas
-- perguntas que a API faz a cada entrada.
create index if not exists idx_cvmemb_expulso on community_voice_members (room_id, expulso_ate);
create index if not exists idx_cvmemb_papel   on community_voice_members (room_id, papel);


-- ── A SALA PÚBLICA GANHA LINHA ──────────────────────────────────────────────
-- `sala-voz-comunidade` é a sala que já está no ar desde 11/08. Ela não tem
-- dono nem senha e não aparece na lista de salas privadas (a API filtra pelo
-- slug). A linha existe por UM motivo: sem ela, a lista de expulsos e a
-- varredura não alcançariam a sala onde a Comunidade inteira conversa — e o
-- buraco medido ("nada tira ninguém de dentro") continuaria aberto justamente
-- no lugar mais movimentado. Com ela, o moderador do site expulsa de lá também.
--
-- ⚠️ A API funciona SEM esta linha (trata a ausência como "sala pública do
-- jeito antigo"), então rodar este arquivo não é pré-requisito pro que já está
-- no ar — é o que LIGA a expulsão na sala pública.
insert into community_voice_rooms (slug, titulo, owner_id, aberta)
values ('sala-voz-comunidade', 'Sala aberta da Comunidade', null, true)
on conflict (slug) do nothing;


-- ── Sanidade (rodar depois, se quiser conferir) ─────────────────────────────
-- Deve devolver 0 linhas: sala com senha guardada em texto.
-- select id, titulo from community_voice_rooms where senha_hash is not null and senha_hash not like 'scrypt$%';
-- Deve devolver no máximo 1 por dono:
-- select owner_id, count(*) from community_voice_rooms where aberta group by 1 having count(*) > 1;
