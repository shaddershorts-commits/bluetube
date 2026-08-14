-- blue_stories_overlays.sql — Editor de stories estilo Instagram.
--
-- Guarda o que o usuário coloca POR CIMA da mídia como CAMADAS (metadados),
-- não "chapado" na imagem. Isso mantém link/menção CLICÁVEIS e permite o app
-- desenhar tudo na hora de ver (nada de flatten no aparelho).
--
-- overlays: array de camadas. Cada item:
--   { tipo:'texto'|'sticker'|'mencao'|'desenho',
--     x, y,           -- posição relativa 0..1 (independente do tamanho da tela)
--     escala, rot,    -- zoom e rotação
--     texto, cor, tamanho,        -- para 'texto'
--     emoji,                      -- para 'sticker' (emoji) — GIF entra depois
--     username, user_id,          -- para 'mencao' (link pro perfil)
--     pontos, cor_traco, largura  -- para 'desenho' (path)
--   }
-- musica_url: faixa anexada, tocada ao VER o story (fase 2 — acervo).
-- filtro: filtro de COR aplicado ('quente'|'frio'|'pb'|'vintage'|null).
--
-- Idempotente.
ALTER TABLE blue_stories ADD COLUMN IF NOT EXISTS overlays   JSONB DEFAULT '[]';
ALTER TABLE blue_stories ADD COLUMN IF NOT EXISTS musica_url TEXT;
ALTER TABLE blue_stories ADD COLUMN IF NOT EXISTS filtro     TEXT;
