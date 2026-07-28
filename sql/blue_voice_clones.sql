-- sql/blue_voice_clones.sql — Clonagem de voz no BlueVoice (2026-07-28)
-- ============================================================================
-- 1 clone por usuário (Master). O ElevenLabs limita 30 vozes clonadas na conta
-- inteira — por isso o sistema HIBERNA clones parados: apaga a voz lá (libera
-- o slot) mas GUARDA o áudio original aqui, permitindo reativar depois.
--
-- PRIVACIDADE: voz clonada é dado biométrico. NUNCA entra na vitrine da
-- comunidade — o acervo compartilhado continua sendo só de vozes importadas.
--
-- Rodar no SQL Editor do Supabase (uma vez). Idempotente.

create table if not exists public.blue_voice_clones (
  user_id       text primary key,          -- 1 clone por usuário (a PK garante)
  voice_id      text,                      -- id no ElevenLabs (null quando hibernado)
  name          text not null,
  sample_path   text not null,             -- áudio original no nosso storage
  status        text default 'active',     -- active | hibernated
  genero        text,
  lang_code     text default 'pt-BR',
  created_at    timestamptz default now(),
  last_used_at  timestamptz default now(), -- alimenta a hibernação
  hibernated_at timestamptz,
  reactivations int default 0
);

create index if not exists idx_clones_status on public.blue_voice_clones (status, last_used_at asc);
create index if not exists idx_clones_voice on public.blue_voice_clones (voice_id);

alter table public.blue_voice_clones enable row level security;

-- Marca a voz clonada na lista do BlueVoice. OBRIGATÓRIO: sem esta coluna a
-- consulta da vitrine (que exclui clones) falha e a comunidade fica vazia.
alter table public.blue_custom_voices
  add column if not exists is_clone boolean default null;

create index if not exists idx_custom_voices_clone on public.blue_custom_voices (is_clone);

-- ── USO DIÁRIO (2026-07-28) ────────────────────────────────────────────────
-- Protege a quota do ElevenLabs (o plano tem teto mensal de créditos) E dá
-- visibilidade de consumo, que hoje não existe: ninguém sabia quanto o
-- BlueVoice gasta até a fatura chegar.
create table if not exists public.blue_voice_usage (
  user_id     text not null,
  dia         date not null,
  geracoes    int  default 0,
  caracteres  int  default 0,
  updated_at  timestamptz default now(),
  primary key (user_id, dia)
);
create index if not exists idx_bvusage_dia on public.blue_voice_usage (dia desc);
alter table public.blue_voice_usage enable row level security;

-- Eventos individuais — alimentam APENAS o anti-flood (janela de minutos).
-- Não é cota: o plano Master segue ilimitado; isto trava script em loop.
create table if not exists public.blue_voice_events (
  id         bigserial primary key,
  user_id    text not null,
  caracteres int,
  criado_em  timestamptz default now()
);
create index if not exists idx_bvevents_user_time on public.blue_voice_events (user_id, criado_em desc);
alter table public.blue_voice_events enable row level security;

-- Bucket PRIVADO com as amostras (nunca público — é a voz da pessoa)
insert into storage.buckets (id, name, public)
values ('voice-samples', 'voice-samples', false)
on conflict (id) do nothing;
