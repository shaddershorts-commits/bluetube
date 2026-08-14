-- ============================================================================
-- BlueTube LONGOS — vídeos longos virais de criadores dark (2026-08-14)
-- Rodar no Supabase SQL Editor. É idempotente: pode rodar quantas vezes quiser.
-- ============================================================================
--
-- ── O QUE É ISTO, E O QUE NÃO É ─────────────────────────────────────────────
-- Página /longos, separada da Virais de Shorts. NÃO toca em virais_banco, NÃO
-- usa os 484 canais curados do painel, NÃO mexe em nada do que já existe.
-- Aqui a descoberta é por BUSCA, sem canal pré-selecionado.
--
-- ── AS REGRAS, E DE ONDE ELAS VIERAM (tudo MEDIDO em 13-14/08/2026) ─────────
--
-- 1) DURAÇÃO 15-50 min. Pedido do dono. Ela CRUZA as duas faixas da API do
--    YouTube (`medium` = 4-20min, `long` = +20min), então a busca pede as duas
--    e o corte fino é feito no código com a duração exata.
--
-- 2) ATÉ 70 MIL INSCRITOS. O pedido original era "excluir canal com selo de
--    verificado" — e o selo NÃO EXISTE na API (conferido no recurso `channels`:
--    tem título, país, inscritos, banner, e nenhum campo de verificação).
--    O substituto é o número que GERA o selo: ele é liberado a partir de 100
--    mil inscritos. O dono apertou pra 70 mil.
--    O substituto é melhor que o original: o YouTube também verifica
--    proativamente canais menores famosos FORA do YouTube — justamente os que
--    o dono quer excluir. Inscritos pega esses; o selo não pegaria.
--
-- 3) DESCOBERTA POR TERMO, não por categoria. MEDIDO com sonda: `search.list`
--    com `videoCategoryId` devolve ZERO (três variações, todas com
--    totalResults 0). Com termo de busca, devolve 50 por chamada.
--
-- 4) order=relevance. Comparação medida, 4 buscas cada, mesmos filtros:
--       viewCount → 1 canal pequeno de 24  (traz o gigante de sempre)
--       date      → 50 canais pequenos, mas só 2 acima de 30k views
--       relevance → 6 acima de 30k, 2 acima de 300k  ← escolhido
--
-- ⚠️ `views_por_inscrito` é a coluna mais interessante desta tabela e não veio
-- do pedido: ela apareceu na sonda. Canal de 15.900 inscritos com 957 mil
-- views dá 60x — é a assinatura de vídeo que estourou SOZINHO, sem público
-- cativo. É o número que separa "canal pequeno" de "canal pequeno que acertou".
-- ============================================================================


-- ── VÍDEOS ──────────────────────────────────────────────────────────────────
create table if not exists longos_virais (
  id                 uuid primary key default gen_random_uuid(),
  youtube_id         text not null unique,
  titulo             text not null,
  thumbnail_url      text,
  url                text not null,
  -- Dados do canal ficam DESNORMALIZADOS aqui de propósito: a página lista
  -- vídeo e precisa mostrar inscritos junto, e um join por vídeo na listagem
  -- seria caro à toa. A tabela de canais existe pra outra pergunta.
  canal_id           text not null,
  canal_nome         text,
  canal_inscritos    int  not null default 0,
  views              bigint not null default 0,
  likes              bigint not null default 0,
  comentarios        bigint not null default 0,
  duracao_segundos   int  not null,
  -- views ÷ inscritos, gravado na coleta pra a listagem poder ORDENAR por ele
  -- sem calcular linha a linha.
  views_por_inscrito numeric(10,2),
  -- ── RITMO REAL (14/08) ───────────────────────────────────────────────────
  -- MEDIDO antes de existir: calcular ritmo como "views ÷ idade do vídeo" dá
  -- número errado, porque dilui. A idade mediana do acervo é 174 dias — um
  -- vídeo com 1 milhão de views em 120 dias marca 362/h na média de vida
  -- mesmo que esteja fazendo 5 mil/h AGORA. Pelo cálculo de média, o acervo
  -- inteiro ficava abaixo de 1.526/h e nenhum filtro de ritmo faria sentido.
  --
  -- O ritmo honesto é a DIFERENÇA entre duas medições. Estas três colunas são
  -- o que permite isso: guarda-se o valor anterior e quando ele foi medido, e
  -- o ritmo sai da subtração. Custa 1 unidade de API a cada 50 vídeos.
  views_anterior     bigint,
  medido_em          timestamptz,
  -- views por HORA, da última janela medida. Null = ainda só foi visto uma vez.
  views_por_hora     numeric(12,2),
  -- Qual termo do vocabulário achou este vídeo. Serve pra saber qual termo
  -- rende e qual só gasta cota.
  termo              text,
  publicado_em       timestamptz,
  collected_at       timestamptz not null default now(),
  last_seen_at       timestamptz not null default now(),
  ativo              boolean not null default true
);

-- RLS colada na criação (regra da casa: entre o create e o alter a tabela fica
-- aberta pro papel anon, e este projeto já teve 34 tabelas expostas assim).
-- Sem policy: todo acesso passa pela service key dentro de api/longos.js.
alter table longos_virais enable row level security;
alter table longos_virais force  row level security;


-- ── CANAIS DESCOBERTOS (a aba "Canais") ─────────────────────────────────────
-- Nasce de graça: o coletor JÁ precisa consultar os inscritos de cada canal pra
-- aplicar o teto de 70 mil. Guardar isso transforma um dado que seria jogado
-- fora na segunda aba da página.
create table if not exists longos_canais (
  channel_id      text primary key,
  nome            text,
  thumbnail_url   text,
  inscritos       int not null default 0,
  pais            text,
  -- Agregados do que ESTE sistema viu — não é o total do canal no YouTube.
  videos_no_acervo int not null default 0,
  melhor_video_id  text,
  melhor_views     bigint not null default 0,
  melhor_titulo    text,
  primeiro_visto   timestamptz not null default now(),
  ultimo_visto     timestamptz not null default now()
);

alter table longos_canais enable row level security;
alter table longos_canais force  row level security;


-- ── Invariantes no banco, não só na API ─────────────────────────────────────
do $$ begin
  alter table longos_virais
    add constraint longos_virais_duracao check (duracao_segundos between 60 and 7200);
exception when duplicate_object then null; end $$;

do $$ begin
  alter table longos_virais
    add constraint longos_virais_views check (views >= 0);
exception when duplicate_object then null; end $$;

-- O teto de inscritos é a regra CENTRAL da página (é o substituto do selo de
-- verificado). Ela vive no banco também: se alguém afrouxar a API sem pensar,
-- o insert estoura em vez de encher a página de canal grande em silêncio.
-- 200 mil, e não 70 mil, de propósito: o teto de exibição é decisão de produto
-- e pode mudar; este CHECK é só a rede contra "entrou canal com 2 milhões".
do $$ begin
  alter table longos_virais
    add constraint longos_virais_canal_pequeno check (canal_inscritos <= 200000);
exception when duplicate_object then null; end $$;


-- Colunas do ritmo em bases que já tinham a tabela (idempotência de verdade).
alter table longos_virais add column if not exists views_anterior bigint;
alter table longos_virais add column if not exists medido_em      timestamptz;
alter table longos_virais add column if not exists views_por_hora numeric(12,2);
-- O ritmo do canal é o do MELHOR vídeo dele — é a pergunta "esse canal está
-- acertando agora?", e a soma diluiria isso num canal com muitos vídeos velhos.
alter table longos_canais add column if not exists views_por_hora numeric(12,2);
alter table longos_canais add column if not exists ritmo_medido_em timestamptz;

-- ── Índices: as três perguntas que a página faz ─────────────────────────────
create index if not exists idx_longos_ritmo on longos_virais (ativo, views_por_hora desc nulls last);
create index if not exists idx_longos_canais_ritmo on longos_canais (views_por_hora desc nulls last);
-- 1) "os mais vistos acima do piso X"
create index if not exists idx_longos_views on longos_virais (ativo, views desc);
-- 2) "os que mais estouraram pro tamanho do canal"
create index if not exists idx_longos_ratio on longos_virais (ativo, views_por_inscrito desc nulls last);
-- 3) "o que entrou agora"
create index if not exists idx_longos_recentes on longos_virais (ativo, collected_at desc);
create index if not exists idx_longos_canal on longos_virais (canal_id);
create index if not exists idx_longos_canais_subs on longos_canais (inscritos desc);


-- ── Sanidade (rodar depois, se quiser conferir) ─────────────────────────────
-- Deve devolver 0: vídeo fora da faixa de duração pedida.
-- select count(*) from longos_virais where duracao_segundos not between 900 and 3000;
-- Deve devolver 0: canal acima do teto de exibição.
-- select count(*) from longos_virais where canal_inscritos > 70000;
-- Os termos que mais rendem (pra podar o vocabulário depois):
-- select termo, count(*), round(avg(views)) as views_medias
--   from longos_virais group by termo order by 2 desc;
