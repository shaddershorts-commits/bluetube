-- blue_sounds — catálogo de músicas do story (royalty-free + sons originais).
--
-- Data-driven: cada faixa é uma linha. Trocar/expandir o acervo é só INSERT —
-- zero mudança de código no app ou no backend. O endpoint /api/blue-stories?
-- action=sons lê daqui (por service key, então RLS não bloqueia a leitura dele).
--
-- origem: 'royalty' (livre de direitos, curado)  |  'original' (extraído de
--         vídeos dos próprios usuários — Fase 2, populado pelo backend).
--
-- ⚠️ IMPORTANTE (licenciamento): só entra aqui faixa com licença que permita uso
-- comercial + remix em UGC (CC0, licença Pixabay, ou faixa própria/licenciada).
-- NUNCA música de gravadora sem contrato — dá takedown e risco na Play Store.

create table if not exists blue_sounds (
  id              uuid primary key default gen_random_uuid(),
  titulo          text not null,
  artista         text,
  url             text not null,               -- mp3/m4a streamável (CDN)
  capa_url        text,
  duracao         int  default 0,              -- segundos (0 = desconhecido)
  origem          text not null default 'royalty', -- 'royalty' | 'original'
  source_video_id uuid,                          -- p/ sons originais (Fase 2)
  created_by      uuid,                          -- quem gerou o som original
  licenca         text,                          -- 'CC0' | 'pixabay' | 'propria' ...
  usos            int  default 0,                -- quantos stories usaram (ranking)
  created_at      timestamptz default now()
);

create index if not exists idx_blue_sounds_origem on blue_sounds(origem);
create index if not exists idx_blue_sounds_usos   on blue_sounds(usos desc);

-- RLS: leitura pública (o app lê via backend com service key de qualquer forma;
-- a policy cobre leitura direta via anon). Escrita só via service role.
alter table blue_sounds enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename='blue_sounds' and policyname='blue_sounds_read') then
    create policy blue_sounds_read on blue_sounds for select using (true);
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- SEED DE DEMONSTRAÇÃO (placeholder) — faixas instrumentais livres do SoundHelix,
-- só pra VALIDAR o mecanismo (buscar → prévia → usar → tocar no viewer).
-- TROCAR pelo acervo royalty-free final depois (é só apagar estas e inserir as
-- suas). Não são "hits" — servem pra testar que tudo funciona ponta-a-ponta.
insert into blue_sounds (titulo, artista, url, origem, licenca, duracao) values
  ('Song One',   'SoundHelix', 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3', 'royalty', 'demo', 0),
  ('Song Two',   'SoundHelix', 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-2.mp3', 'royalty', 'demo', 0),
  ('Song Three', 'SoundHelix', 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-3.mp3', 'royalty', 'demo', 0),
  ('Song Five',  'SoundHelix', 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-5.mp3', 'royalty', 'demo', 0),
  ('Song Eight', 'SoundHelix', 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-8.mp3', 'royalty', 'demo', 0)
on conflict do nothing;
