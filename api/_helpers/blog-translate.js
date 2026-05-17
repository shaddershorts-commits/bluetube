// api/_helpers/blog-translate.js
// Helper compartilhado pra traduzir posts de blog HTML usando Claude 4.7.
//
// USO:
//   const { translatePostHtml } = require('./_helpers/blog-translate');
//   const htmlEn = await translatePostHtml(htmlPt, 'en', { slug: 'X' });
//
// O QUE TRADUZ (texto visivel + SEO):
//   - <title> + meta description + keywords
//   - og:* tags (title, description, image:alt, locale)
//   - twitter:* tags
//   - Schema.org JSON-LD (headline, description, articleSection, inLanguage)
//   - Breadcrumb (texto)
//   - Article body: h1-h6, p, li, blockquote, figcaption, cite, alt de img
//   - Datas em "Xh atras" formatadas pra locale (mantem ISO timestamp)
//
// O QUE NAO TRADUZ:
//   - Tags HTML, classes, ids, atributos tecnicos
//   - URLs externas (https://...)
//   - URLs internas (re-aponta pra /{lang}/blog/... se for /blog/...)
//   - <code>, <pre> (codigo nao muda)
//   - Tokens placeholder {{...}}
//
// AJUSTES AUTOMATICOS:
//   - lang attribute html → "{lang}"
//   - og:locale → "en_US" | "es_ES" | etc
//   - inLanguage no Schema → "en" | "es" | etc
//   - canonical URL → /{lang}/blog/posts/SLUG.html
//   - hreflang cross-link gerado e injetado (pt + outros idiomas)
//
// FALHA SOFT: se Claude retornar HTML invalido, valida e re-tenta 1x.
// Se ainda falhar, throw erro (caller decide o que fazer).

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
// Modelo: Opus 4.7. Apesar do custo ~5x maior que Sonnet, o cap de rate limit
// no Tier 1 da conta Felipe é 80k/min Opus vs 8k/min Sonnet — Opus cabe TODOS
// os posts (max 16k output), Sonnet truncaria os 2 maiores. Custo backfill
// estimado: ~$7-10 (14 chamadas × ~$0.5-1). Sustentavel.
//
// Pra reduzir custo no futuro: upgradar tier Anthropic (https://console.anthropic.com/settings/limits)
// e trocar pra Sonnet 4.6.
const MODEL = 'claude-opus-4-7';
// 32000 = limite output max do Opus 4.7. Posts gigantes (67k chars source)
// precisam de output ~25-30k tokens. Subindo de 20k pra 32k cobre.
const MAX_TOKENS = 32000;

const LANG_META = {
  pt: { code: 'pt', locale: 'pt_BR', name: 'Portuguese (Brazil)', html: 'pt-BR' },
  en: { code: 'en', locale: 'en_US', name: 'English (US)',       html: 'en' },
  es: { code: 'es', locale: 'es_ES', name: 'Spanish (Spain/LatAm)', html: 'es' },
  fr: { code: 'fr', locale: 'fr_FR', name: 'French',             html: 'fr' },
  de: { code: 'de', locale: 'de_DE', name: 'German',             html: 'de' },
  it: { code: 'it', locale: 'it_IT', name: 'Italian',            html: 'it' },
  ja: { code: 'ja', locale: 'ja_JP', name: 'Japanese',           html: 'ja' },
};

// Sistema fixo (cacheable via prompt caching — economiza ~30% input em backfill)
const SYSTEM_PROMPT = `You are a senior SEO translator working on the BlueTube blog (a Brazilian creator-economy SaaS targeting global creators).

CRITICAL RULES (apply to every translation):
1. Translate ONLY visible text content. Preserve EVERY tag, class, id, attribute, comment, and whitespace structure exactly as-is.
2. Translate inside: <title>, <meta name="description" content="...">, <meta name="keywords" content="...">, <meta property="og:title">, <meta property="og:description">, <meta property="og:image:alt">, <meta name="twitter:title">, <meta name="twitter:description">, <meta name="twitter:image:alt">, all <h1>-<h6>, <p>, <li>, <blockquote>, <figcaption>, <cite>, <button>, link text, alt="..." inside <img>, breadcrumb items.
3. DO NOT translate: code inside <code> or <pre>, URLs (http/https/mailto), file paths, JSON-LD scalar property keys (only values that are user-facing strings like "headline", "description", "articleSection", "name" in breadcrumb).
4. Inside Schema.org JSON-LD blocks: translate ONLY values of "headline", "description", "articleSection", breadcrumb "name". Leave all URLs, @type, @context, @id, dates untouched.
5. ALL internal links pointing to /blog/posts/X.html, /blog/, /afiliado, /termos, /privacidade, / etc — prefix with the target language code (e.g., /en/blog/posts/X.html) unless already prefixed.
6. Share URLs (whatsapp.com, twitter.com, linkedin.com) should encode the NEW translated URL with prefix.
7. Insert hreflang link tags right after <link rel="canonical">: include pt-BR, the target language, and x-default (which points to PT).
8. Preserve placeholder tokens like {{TITLE_URLENCODED}} (template artifacts) — they're not real placeholders in published posts; just leave them as-is.
9. TONE: friendly but expert, like a senior creator giving advice. Avoid stiff/literal translation. Adapt idioms to the target market. Adapt examples that mention "Brazil" or "real" (R$) to be more international when natural — but keep "BlueTube" brand untouched.
10. SEO: in <title> and meta description, prioritize natural keywords for the target market (e.g., "YouTube Shorts revenue" in EN, "ingresos YouTube Shorts" in ES) rather than literal translation of PT keywords. Same for h1 and lead paragraph.
11. Don't add new content or sections. Translate what's there.

OUTPUT FORMAT: Return ONLY the translated HTML — no markdown fences, no explanation, no preamble. Start with <!DOCTYPE html> and end with </html>.`;

function buildUserMessage(htmlSource, targetLang, slug) {
  const meta = LANG_META[targetLang];
  if (!meta) throw new Error(`unsupported_lang: ${targetLang}`);

  return `Translate this HTML from Brazilian Portuguese into ${meta.name} (lang code: ${meta.code}).

Specific adjustments for THIS translation:
- Change <html lang="pt-BR"> to <html lang="${meta.html}">
- Change og:locale "pt_BR" to "${meta.locale}"
- Update <link rel="canonical"> from "/blog/posts/${slug}.html" to "/${meta.code}/blog/posts/${slug}.html"
- Update og:url to use "/${meta.code}/blog/posts/${slug}.html"
- Update mainEntityOfPage @id in Schema to "/${meta.code}/blog/posts/${slug}.html"
- Update breadcrumb URLs (Home/Blog) to "/${meta.code}/" and "/${meta.code}/blog/"
- Set "inLanguage" in Schema.org to "${meta.code}"
- All internal links: prefix with /${meta.code}/ unless already prefixed
- Insert hreflang tags after canonical:
  <link rel="alternate" hreflang="pt-BR" href="https://bluetubeviral.com/blog/posts/${slug}.html"/>
  <link rel="alternate" hreflang="${meta.html}" href="https://bluetubeviral.com/${meta.code}/blog/posts/${slug}.html"/>
  <link rel="alternate" hreflang="x-default" href="https://bluetubeviral.com/blog/posts/${slug}.html"/>

SOURCE HTML:
\`\`\`
${htmlSource}
\`\`\``;
}

// Legacy alias pra compat com smoke test (se houver)
function buildPrompt(htmlSource, targetLang, slug) {
  const meta = LANG_META[targetLang];
  if (!meta) throw new Error(`unsupported_lang: ${targetLang}`);

  return `You are a senior SEO translator working on the BlueTube blog (a Brazilian creator-economy SaaS).

Your job: translate the FULL HTML below from Brazilian Portuguese into ${meta.name}, keeping the page SEO-optimized for the target market.

CRITICAL RULES:
1. Translate ONLY visible text content. Preserve EVERY tag, class, id, attribute, comment, and whitespace structure exactly as-is.
2. Translate inside: <title>, <meta name="description" content="...">, <meta name="keywords" content="...">, <meta property="og:title">, <meta property="og:description">, <meta property="og:image:alt">, <meta property="og:locale">, <meta name="twitter:title">, <meta name="twitter:description">, <meta name="twitter:image:alt">, all <h1>-<h6>, <p>, <li>, <blockquote>, <figcaption>, <cite>, <button>, link text, alt="..." inside <img>, breadcrumb items.
3. DO NOT translate: code inside <code> or <pre>, URLs (http/https/mailto), file paths, JSON-LD scalar property keys (only values that are user-facing strings like "headline", "description", "articleSection").
4. Inside the Schema.org JSON-LD blocks (<script type="application/ld+json">): translate ONLY the values of "headline", "description", "articleSection", "name" (when it's a breadcrumb item text), AND set "inLanguage" to "${meta.code}". Leave all URLs, @type, @context, @id, dates untouched.
5. Change <html lang="pt-BR"> to <html lang="${meta.html}">
6. Change <meta property="og:locale" content="pt_BR"/> to content="${meta.locale}"
7. Update <link rel="canonical" href="..."> from "/blog/posts/${slug}.html" to "/${meta.code}/blog/posts/${slug}.html"
8. Update <meta property="og:url" content="..."> to use /${meta.code}/blog/posts/${slug}.html
9. Update mainEntityOfPage @id in Schema to /${meta.code}/blog/posts/${slug}.html
10. Update breadcrumb URLs (Home/Blog) to /${meta.code}/ and /${meta.code}/blog/
11. ALL internal links pointing to /blog/posts/X.html should become /${meta.code}/blog/posts/X.html. Same for /blog/, /afiliado, /termos, /privacidade, /, etc — prefix with /${meta.code}/ unless already prefixed.
12. ALL share URLs (whatsapp.com, twitter.com, linkedin.com) should encode the NEW translated URL.
13. Insert hreflang link tags right after the canonical link:
    <link rel="alternate" hreflang="pt-BR" href="https://bluetubeviral.com/blog/posts/${slug}.html"/>
    <link rel="alternate" hreflang="${meta.html}" href="https://bluetubeviral.com/${meta.code}/blog/posts/${slug}.html"/>
    <link rel="alternate" hreflang="x-default" href="https://bluetubeviral.com/blog/posts/${slug}.html"/>
14. Preserve placeholder tokens like {{TITLE_URLENCODED}} (template artifacts) — they're not real placeholders in published posts.
15. TONE: friendly but expert, like a senior creator giving advice. Avoid stiff/literal translation. Adapt idioms to the target market. Adapt examples that mention "Brazil" or "real" (R$) to be more international when natural (e.g., "creators worldwide" instead of "criadores brasileiros") — but keep "BlueTube" brand untouched.
16. SEO: in <title> and meta description, prioritize natural keywords for the target market (e.g., "YouTube Shorts revenue" in EN, "ingresos YouTube Shorts" in ES) rather than literal translation of PT keywords. Same for h1 and lead paragraph.
17. Don't add new content or sections. Translate what's there.

OUTPUT FORMAT: Return ONLY the translated HTML — no markdown fences, no explanation, no preamble. Start with <!DOCTYPE html> and end with </html>.

SOURCE HTML (Brazilian Portuguese):
\`\`\`
${htmlSource}
\`\`\``;
}

/**
 * Traduz HTML completo de post de blog de PT pra targetLang.
 * @param {string} htmlSource - HTML completo em PT (com <!DOCTYPE html>...</html>)
 * @param {string} targetLang - 'en' | 'es' | 'fr' | 'de' | 'it' | 'ja'
 * @param {object} opts - { slug: string } — slug do post pra ajustar URLs
 * @returns {Promise<string>} HTML traduzido
 */
async function translatePostHtml(htmlSource, targetLang, opts = {}) {
  const slug = opts.slug || 'post';
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY missing');
  if (!LANG_META[targetLang]) throw new Error(`unsupported_lang: ${targetLang}`);
  if (!htmlSource || typeof htmlSource !== 'string') throw new Error('html_source_required');

  const userMessage = buildUserMessage(htmlSource, targetLang, slug);

  let lastErr = null;
  // 4 tentativas com backoff exponencial — cobre rate limit 429 e network blips.
  // Backoff: 30s, 90s, 180s (total max ~5min de espera entre retries)
  const backoffs = [0, 30000, 90000, 180000];
  for (let attempt = 1; attempt <= 4; attempt++) {
    if (backoffs[attempt - 1] > 0) {
      await new Promise(r => setTimeout(r, backoffs[attempt - 1]));
    }
    try {
      const r = await fetch(ANTHROPIC_API, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: MAX_TOKENS,
          // System message com cache_control=ephemeral → Anthropic cacheia o
          // prompt fixo (~2k tokens) por 5min, ~30% economia em backfill
          // de varias chamadas seguidas.
          system: [{
            type: 'text',
            text: SYSTEM_PROMPT,
            cache_control: { type: 'ephemeral' },
          }],
          messages: [{ role: 'user', content: userMessage }],
        }),
      });

      if (!r.ok) {
        const errBody = await r.text().catch(() => '');
        const status = r.status;
        // 429 rate limit → continua tentando (proximo backoff)
        // 5xx → continua tentando
        // 4xx (exceto 429) → erro permanente, sai
        if (status !== 429 && status < 500) {
          throw new Error(`anthropic_${status}_permanent: ${errBody.slice(0, 200)}`);
        }
        throw new Error(`anthropic_${status}: ${errBody.slice(0, 200)}`);
      }

      const data = await r.json();
      const text = data?.content?.[0]?.text || '';
      if (!text) throw new Error('empty_response');

      // Strip markdown fences se Claude colocou por engano
      let html = text.trim();
      html = html.replace(/^```html\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '');

      // Validacao minima: deve comecar com <!DOCTYPE ou <html
      if (!/^<!DOCTYPE|^<html/i.test(html)) {
        throw new Error('invalid_html_start');
      }
      if (!html.includes('</html>')) {
        throw new Error('invalid_html_no_close');
      }

      return html;
    } catch (e) {
      lastErr = e;
      console.error(`[blog-translate] ${targetLang} ${slug} attempt ${attempt}/4 failed:`, e.message.slice(0, 200));
      // Erro permanente — nao retentar
      if (e.message.includes('_permanent')) break;
    }
  }
  throw lastErr || new Error('translation_failed');
}

/**
 * Helper pra calcular hash do HTML source (pra cache: nao retraduzir se nao mudou)
 */
async function hashHtml(html) {
  const crypto = require('crypto');
  return crypto.createHash('sha256').update(html).digest('hex').slice(0, 16);
}

module.exports = { translatePostHtml, hashHtml, LANG_META, SUPPORTED_LANGS: Object.keys(LANG_META) };
