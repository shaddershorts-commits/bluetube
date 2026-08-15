-- sql/longos_orcamento.sql — teto diário de BUSCAS do coletor de longos
--
-- Por que existe: `search.list` custa 100 unidades e o Longos divide o pool de
-- chaves com a Virais de Shorts, que é produto pago. Sem teto, um cron mal
-- configurado (ou uma varredura manual repetida) drena a cota e a Virais para
-- de coletar sem ninguém entender o motivo.
--
-- O contador é diário e compartilhado entre TODAS as rodadas — cron e disparo
-- manual gastam do mesmo bolso. Quando zera, o coletor para sozinho e volta no
-- dia seguinte.
--
-- Uma linha por dia. Não precisa limpar: ~365 linhas por ano.

create table if not exists longos_orcamento (
  dia            date        primary key,
  buscas         integer     not null default 0,
  atualizado_em  timestamptz not null default now()
);

-- O incremento é compare-and-swap (PATCH filtrando pelo valor lido), então a
-- chave primária em `dia` garante uma linha só por dia mesmo com duas rodadas
-- disparando junto.
alter table longos_orcamento enable row level security;

-- Quanto já gastei hoje:
--   select * from longos_orcamento order by dia desc limit 7;
--
-- Liberar o resto do dia na mão (ex: pra uma varredura pontual):
--   update longos_orcamento set buscas = 0 where dia = current_date;
