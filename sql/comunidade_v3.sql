-- Comunidade v3 — sino de novidades + plano no perfil + vídeo destaque vira post (2026-07-16)
-- Rodar no Supabase SQL Editor (delta sobre v1+v2).

-- Plano do autor (pra anéis ⚡ Full / 👑 Master nos avatares) — atualizado a cada visita
alter table community_profiles add column if not exists plan text;

-- Sino: última vez que o usuário viu cada aba
alter table community_profiles add column if not exists last_seen_dicas timestamptz;
alter table community_profiles add column if not exists last_seen_comunidade timestamptz;

-- O vídeo destaque vira um POST fixado de verdade (ganha comentários, curtidas
-- e o mesmo tratamento dos próximos treinamentos). Só insere se ainda não existe.
insert into community_posts (id, user_id, tab, content, media, pinned, created_at)
select gen_random_uuid(), u.id, 'dicas',
  'Criei 2 Canais do ZERO, Bati 100 MIL Inscritos Em Menos de 42 dias (Faça o Mesmo)',
  '[{"type":"youtube","id":"JAaEud-fde8"}]'::jsonb,
  true, now()
from auth.users u
where u.email = 'shaddershorts@gmail.com'
  and not exists (
    select 1 from community_posts
    where tab = 'dicas' and media @> '[{"type":"youtube","id":"JAaEud-fde8"}]'::jsonb
  );
