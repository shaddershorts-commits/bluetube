-- sql/virais_alertas_gatilho.sql — alerta da Virais por GATILHO de velocidade
-- ===========================================================================
-- Hoje o alerta é um resumo único às 7:30. Isso passa a conviver com gatilhos
-- que o assinante Master escolhe:
--   r1 · 100 mil views em menos de 5 horas
--   r2 · 1 milhão em até 3 dias
--   r3 · 5 milhões em até 7 dias
--
-- POR QUE DÁ PRA FAZER SEM HISTÓRICO: virais_banco já tem `publicado_em` e
-- `views`. "100k em menos de 5h" é views >= 100000 AND idade <= 5h. Não
-- precisa de série temporal.
--
-- CANAL: o aviso na hora é o SININHO (blue_notificacoes), que não custa nada.
-- Email seria inviável — medido: ~29 vídeos/dia batem a r1, e 29 × 19 Masters
-- = ~550 emails/dia contra um teto de 200/dia no Resend. O email vira resumo
-- 1x por dia, no máximo 1 por pessoa.

-- Quais gatilhos cada um quer. NULL/vazio = só o resumo diário de sempre,
-- que é o estado de quem já tinha o alerta ligado (ninguém perde nada).
alter table subscribers add column if not exists virais_alert_gatilhos text[];

-- ── ANTI-REPETIÇÃO ─────────────────────────────────────────────────────────
-- Sem isso, o cron avisaria o MESMO vídeo a cada rodada enquanto ele estivesse
-- dentro da janela — um vídeo na r1 renderia 5 avisos iguais em 5 horas.
create table if not exists virais_alertas_enviados (
  email      text        not null,
  youtube_id text        not null,
  regra      text        not null,
  criado_em  timestamptz not null default now(),
  primary key (email, youtube_id, regra)
);

-- O cron varre "o que já mandei recentemente" — o índice é por data.
create index if not exists virais_alertas_enviados_data_idx
  on virais_alertas_enviados (criado_em desc);

alter table virais_alertas_enviados enable row level security;

-- Faxina: passada a janela mais longa (7 dias), a linha não serve mais pra
-- deduplicar. Roda junto do cron pra tabela não crescer pra sempre.
-- delete from virais_alertas_enviados where criado_em < now() - interval '10 days';
