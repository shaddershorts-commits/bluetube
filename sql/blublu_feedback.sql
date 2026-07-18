-- Blublu: eventos de aprendizado (2026-07-18)
-- tipo='clique' (alvo=video aberto pelo user — nota de relevância implícita)
-- tipo='enquete' (valor=cravou|quase|viajou — feedback direto na conversa)
create table if not exists blublu_eventos (
  id bigint generated always as identity primary key,
  user_id uuid,
  tipo text not null,
  alvo text,
  valor text,
  criado_em timestamptz not null default now()
);
alter table blublu_eventos enable row level security;
create index if not exists idx_bbev_tipo on blublu_eventos (tipo, criado_em desc);
