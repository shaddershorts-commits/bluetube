# Pipeline de tradução do blog

Sistema de i18n do blog do BlueTube. PT canonica em `/blog/`, traduções em `/{lang}/blog/`.

## Arquitetura

```
USER → Vercel Edge middleware.js → decide idioma cascata
         ↓
         ├── URL ja tem /{lang}/  → respeita
         ├── Cookie user_lang     → respeita
         ├── Accept-Language      → match SUPPORTED_LANGS
         ├── x-vercel-ip-country  → COUNTRY_TO_LANG mapping
         └── default PT           → mantem /blog/ original
         ↓
         IF target lang em LANGS_WITH_BLOG:
            Redirect 302 → /{lang}/blog/<path>
         ELSE:
            Serve PT original
```

## Arquivos

| Arquivo | Papel |
|---|---|
| `middleware.js` | Vercel Edge — language routing |
| `api/_helpers/blog-translate.js` | Helper `translatePostHtml()` Claude Sonnet 4.6, prompt cacheable |
| `api/blog-translate.js` | Endpoint admin Bearer ADMIN_SECRET (stats/translate/translate-all) — só pra DRY-RUN |
| `api/sitemap.js` | Sitemap dinâmico com xhtml:link hreflang cross-link |
| `scripts/backfill-blog-translations.js` | CLI local pra rodar traduções (filesystem persistente) |
| `public/blog/index.html` | Index PT canonica |
| `public/blog/posts/*.html` | Posts PT canonica |
| `public/{lang}/blog/index.html` | Index traduzido |
| `public/{lang}/blog/posts/*.html` | Posts traduzidos |
| `public/sitemap.xml.bak` | Sitemap estático antigo (renomeado pra .bak; ativo é /api/sitemap via rewrite) |

## Por que CLI local em vez de endpoint Vercel pra publish?

**Vercel Functions filesystem é efêmero** — `fs.writeFileSync('/public/...')` durante runtime NÃO persiste entre invocações. O endpoint `/api/blog-translate?mode=publish` falha silenciosamente em prod (escreve no /tmp do worker que morre).

Solução: tradução roda no CLI local (`scripts/backfill-blog-translations.js`), arquivos vão pra `/public/{lang}/blog/`, commit + push deploya via Git.

Endpoint `/api/blog-translate` continua útil pra:
- `?action=stats` — ver status de tradução por slug
- `?action=translate&mode=dry-run` — smoke pra validar Claude sem escrever

## Novo post publicado em PT — como traduzir

```bash
# 1. Criar post PT normal em public/blog/posts/MEU-SLUG.html
# 2. Atualizar public/blog/index.html com card do novo post

# 3. Rodar tradução local
cd /caminho/bluetube
ANTHROPIC_API_KEY=sk-ant-... node scripts/backfill-blog-translations.js --slug=MEU-SLUG

# 4. Opcionalmente atualizar tambem o index (se tiver novo card)
ANTHROPIC_API_KEY=sk-ant-... node scripts/backfill-blog-translations.js --slug=index --force

# 5. Commit + push
git add public/en/blog public/es/blog
git commit -m "feat(blog-i18n): adiciona MEU-SLUG em EN+ES"
git push origin main
```

Sitemap auto-detecta novas versões traduzidas em `/public/{lang}/blog/posts/` e injeta no XML — não precisa atualizar manualmente.

## Adicionar novo idioma

1. Editar `middleware.js`:
   - Adicionar em `SUPPORTED_LANGS`
   - Adicionar em `COUNTRY_TO_LANG` os countries que mapeiam pra esse idioma
   - **Após** rodar backfill completo, adicionar em `LANGS_WITH_BLOG`
2. Editar `api/_helpers/blog-translate.js`:
   - Adicionar em `LANG_META` com `code`, `locale`, `name`, `html`
3. Editar `api/sitemap.js`:
   - Adicionar em `SUPPORTED_LANGS`
4. Rodar backfill: `node scripts/backfill-blog-translations.js --targets=NOVO_LANG`
5. Commit + push

## Custos

- Modelo: `claude-sonnet-4-6` (~10x mais barato que Opus 4.7, qualidade SEO equivalente pra tradução)
- Prompt caching ativo (system message com `cache_control: ephemeral`) → ~30% economia em backfill seguido
- Custo estimado por post por idioma: $0.30-1.00 (variando com tamanho)
- Backfill inicial (6 posts + index × 2 idiomas = 14 chamadas): ~$15-30

## Decisões arquiteturais documentadas

1. **URL structure `/{lang}/...` em vez de `/blog/{lang}/...`**: prefixo global escala pra todo o site no futuro (`/en/baixaBlue`, `/en/blue`, etc).
2. **PT canonica sem prefixo** (`/blog/posts/X.html`): zero quebra de SEO existente.
3. **Auto-publish** (sem UI de revisão manual): Felipe escolheu confiar no Claude. Pode editar arquivos commitados depois se algo estiver ruim.
4. **HTML inteiro traduzido** (não dictionary-based via i18n.js): cobre conteúdo de artigo + UI labels num único arquivo por idioma.
5. **Sitemap dinâmico** com hreflang cross-link auto-gerado por filesystem detection.
6. **Middleware Edge** com `x-vercel-ip-country` (FREE, instantâneo) em vez de ipapi.co (latência + custo).
7. **CLI local em vez de endpoint pra publish**: filesystem Vercel é efêmero.

## Pendências futuras

- Adicionar mais idiomas (fr, de, it, ja) — basta rodar backfill com novos targets e atualizar LANGS_WITH_BLOG no middleware
- UI Admin pra trigger backfill via web (em vez de CLI) — usar GitHub Actions com workflow_dispatch + commit automático
- Glossário de termos brand (BlueTube, BlueVoice, etc) pra Claude nunca traduzir
- Tradução de páginas principais (/, /blue, /afiliado) — adicionar ao matcher do middleware e criar versão CLI similar
