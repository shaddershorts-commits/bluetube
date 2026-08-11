-- ============================================================================
-- sql/comunidade_perfil_bio.sql
-- Bio, link e capa no perfil da Comunidade.
--
-- Só ACRESCENTA colunas numa tabela que já existe (community_profiles) e que já
-- está com row level security ligada — então aqui não há a janela de "tabela
-- nasce aberta" que existia no arquivo das amizades. Nada de policy nova:
-- todo acesso continua passando pela service key dentro de api/community.js,
-- que é quem aplica o portão Full/Master.
--
-- IDEMPOTENTE: pode rodar duas vezes sem erro. Rode de uma vez só, não em
-- pedaços.
-- ============================================================================

-- Descrição curta. 160 caracteres é o teto que a API também aplica — os dois
-- lados precisam concordar, senão o banco aceita o que a tela recusa (ou pior,
-- o contrário).
alter table community_profiles add column if not exists bio text;

-- Um link só. A API exige https e recusa javascript:/data: — mas a checagem de
-- verdade é lá, não aqui: banco não valida esquema de URL.
alter table community_profiles add column if not exists link text;

-- Capa: URL no nosso próprio storage. A API só grava caminho que ela mesma
-- acabou de escrever, então isto nunca aponta pra fora.
alter table community_profiles add column if not exists cover_url text;

-- Teto no banco também, e não só na aplicação: se algum dia outro caminho
-- escrever aqui, o limite continua valendo. NOT VALID pra não travar caso
-- exista linha antiga fora do padrão — as novas já entram checadas.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'community_profiles_bio_len'
  ) then
    alter table community_profiles
      add constraint community_profiles_bio_len check (bio is null or length(bio) <= 160) not valid;
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'community_profiles_link_len'
  ) then
    alter table community_profiles
      add constraint community_profiles_link_len check (link is null or length(link) <= 200) not valid;
  end if;
end $$;

-- Confirmação: deve listar bio, link e cover_url.
-- select column_name from information_schema.columns
--  where table_name = 'community_profiles' and column_name in ('bio','link','cover_url');
