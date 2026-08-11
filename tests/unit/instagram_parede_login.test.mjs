// tests/unit/instagram_parede_login.test.mjs — node --test
// ============================================================================
// POR QUE ESTE ARQUIVO EXISTE
// A parede de login do Instagram volta com HTTP **200**. Não é 3xx, então o
// redirect:'manual' não pega, e !r.ok é falso. O parser antigo tratava aquilo
// como post normal e extraía o og:description institucional da Meta como se
// fosse a LEGENDA do Reel — e essa copy ia pro banco e era PUBLICADA na
// vitrine, sem aviso nenhum.
//
// Os HTMLs abaixo são o conteúdo REAL da parede (as três frases confirmadas).
// Todo teste aqui prova a mesma regra da casa: estado degradado é MARCADO, e
// valor inválido NÃO substitui um bom. Nunca publicar dado que o sistema não
// conseguiu ler de verdade.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const igv = require('../../api/instagram-virais.js');

const {
  detectarParedeDeLogin, extrairDePagina, escolherEntreFontes,
  capturarPublico, decidirMetricas, legendaDoEmbed,
} = igv;

// ── HTML REAL da parede de login, PT ────────────────────────────────────────
// A moldura "Instagram - <copy>" é a que a Meta usa de verdade (site_name +
// travessão) e é EXATAMENTE a que fazia o parser antigo vazar: o fallback
// `desc.split(' - ').slice(1)` devolvia a copy institucional inteira.
const COPY_PT = 'Uma maneira simples, divertida e criativa de capturar, editar e compartilhar fotos, vídeos e mensagens com amigos e familiares.';
const PAREDE_PT = `<!DOCTYPE html><html lang="pt-BR"><head>
<meta charset="utf-8">
<meta property="og:site_name" content="Instagram">
<meta property="og:title" content="Instagram">
<meta property="og:description" content='Instagram - ${COPY_PT}'>
<meta property="og:image" content="https://static.cdninstagram.com/rsrc.php/v3/yI/r/VsNE-OHk_8a.png">
<meta property="og:url" content="https://www.instagram.com/accounts/login/">
</head><body>
<form method="post" action="/accounts/login/ajax/">
<input name="username"><input name="password" type="password">
</form></body></html>`;

// ── HTML REAL da parede de login, EN (copy nova) ────────────────────────────
const COPY_EN = "Share what you're into with the people who get you.";
const PAREDE_EN = `<!DOCTYPE html><html lang="en"><head>
<meta property="og:site_name" content="Instagram">
<meta property="og:title" content='Instagram: "${COPY_EN}"'>
<meta property="og:description" content="Instagram - ${COPY_EN}">
<meta property="og:image" content="https://static.cdninstagram.com/rsrc.php/v3/yR/r/lam-fZmwmvn.png">
</head><body><div id="loginForm"></div></body></html>`;

// ── HTML REAL de post REMOVIDO ──────────────────────────────────────────────
const COPY_REMOVIDO = 'The link you followed may be broken, or the page may have been removed.';
const PAGINA_REMOVIDA = `<!DOCTYPE html><html><head>
<meta property="og:title" content="Instagram">
<meta property="og:description" content="Instagram - ${COPY_REMOVIDO}">
</head><body><h2>Sorry, this page isn't available.</h2></body></html>`;

const TODAS_AS_PAREDES = [
  ['PT (parede de login)', PAREDE_PT, COPY_PT],
  ['EN (parede de login)', PAREDE_EN, COPY_EN],
  ['REMOVIDO (post apagado)', PAGINA_REMOVIDA, COPY_REMOVIDO],
];

// ── /embed/captioned/ de verdade: a legenda mora em edge_media_to_caption ───
const LEGENDA_REAL = 'ele não acreditou no que viu 😂 marca aquele amigo #futebol';
const EMBED_BOM = `<!DOCTYPE html><html><head>
<meta property="og:image" content="https://scontent-gru1-1.cdninstagram.com/v/t51/123_n.jpg">
</head><body>
<div class="EmbedVideo"></div>
<script type="text/javascript">
window.__additionalDataLoaded('extra',{"shortcode":"CxYz123abcd","owner":{"username":"canal_teste","full_name":"Canal Teste"},
"edge_media_to_caption":{"edges":[{"node":{"text":"${LEGENDA_REAL}"}}]},
"edge_media_preview_like":{"count":184000},
"edge_media_to_comment":{"count":2310},
"thumbnail_src":"https:\\/\\/scontent-gru1-1.cdninstagram.com\\/v\\/t51\\/123_n.jpg"});
</script></body></html>`;

// ── O parser ANTIGO, copiado LITERALMENTE do arquivo antes do fix ───────────
// (linhas 430-439 do api/instagram-virais.js original). Existe só pra provar,
// dentro da própria suíte, que o bug era real e que o fix o mata.
function legendaDoParserAntigo(html) {
  const meta = igv.lerMetaTags(html);
  const desc = meta['og:description'] || '';
  const titulo = meta['og:title'] || '';
  const limpa = (v) => { const s = String(v ?? '').replace(/\s+/g, ' ').trim(); return s ? s.slice(0, 2200) : null; };
  const entreAspas = (s) => {
    const m = /:\s*["“”](.+)["“”]\s*\.?\s*$/s.exec(s || '');
    return m ? m[1] : null;
  };
  const semAspas = (s) => String(s || '').replace(/^["“](.*)["”]$/s, '$1');
  return limpa(entreAspas(desc))
    || limpa(entreAspas(titulo))
    || limpa(semAspas((desc.split(' - ').slice(1).join(' - ') || '').replace(/^[^:]*:\s*/, '')))
    || null;
}

// ═══════════════════════════════════════════════════════════════════════════
// DEFEITO 1 — parede de HTTP 200 detectada por CONTEÚDO
// ═══════════════════════════════════════════════════════════════════════════

test('DEFEITO 1 (antes×depois): o parser ANTIGO publicava a copy da Meta; o novo não', () => {
  for (const [nome, html, copy] of TODAS_AS_PAREDES) {
    // ANTES: a copy institucional saía como se fosse a legenda do Reel
    const antes = legendaDoParserAntigo(html);
    assert.equal(antes, copy, `${nome}: o fixture não reproduz o bug original (antes=${JSON.stringify(antes)})`);
    // DEPOIS: a mesma página é reconhecida como parede e não entrega campo nenhum
    const depois = extrairDePagina(html, 'og');
    assert.ok(depois.parede, `${nome}: a parede continua passando como post`);
    assert.equal(depois.campos.titulo, undefined, `${nome}: a copy da Meta AINDA vira legenda`);
  }
});

test('DEFEITO 1: as três paredes reais são detectadas mesmo vindo com HTTP 200', () => {
  for (const [nome, html] of TODAS_AS_PAREDES) {
    const motivo = detectarParedeDeLogin(html);
    assert.ok(motivo, `${nome}: passou batido — viraria post normal`);
    assert.match(motivo, /parede de login|removido|bloco do post/i, `${nome}: motivo pouco claro: ${motivo}`);
  }
});

test('DEFEITO 1: a copy institucional da Meta NUNCA vira legenda', () => {
  for (const [nome, html, copy] of TODAS_AS_PAREDES) {
    const p = extrairDePagina(html, 'og');
    assert.ok(p.parede, `${nome}: não marcou parede`);
    assert.deepEqual(p.campos, {}, `${nome}: extraiu campo de uma parede de login`);
    // A prova direta: a frase institucional não sai em campo nenhum
    const tudo = JSON.stringify(p.campos);
    assert.equal(tudo.includes(copy.slice(0, 30)), false, `${nome}: a copy da Meta vazou pros campos`);
  }
});

test('DEFEITO 1: titulo/legenda/métricas ficam NULL quando só há parede', () => {
  const achado = escolherEntreFontes([
    extrairDePagina(PAREDE_PT, 'og'),
    extrairDePagina(PAREDE_EN, 'embed'),
  ]);
  for (const campo of ['titulo', 'autor', 'autor_nome', 'views', 'likes', 'comments', 'thumb_origem']) {
    assert.equal(achado[campo], undefined, `${campo} não ficou ausente`);
  }
  assert.equal(achado.pagina_ilegivel, true, 'não marcou a página como ilegível');
});

test('DEFEITO 1: o og:description institucional é rejeitado ATÉ se a página passar pelos outros filtros', () => {
  // Cenário paranoico: a Meta serve a copy institucional DENTRO de uma página
  // que tem marcas de post. O guard de legenda tem que barrar assim mesmo.
  const disfarcada = `<html><head>
    <meta property="og:title" content="Instagram">
    <meta property="og:image" content="https://scontent.cdninstagram.com/v/t51/x_n.jpg">
    </head><body><div class="EmbedVideo"></div>
    <script>window.x={"shortcode":"AAAA1","edge_media_to_caption":{"edges":[{"node":{"text":"${COPY_PT}"}}]}}</script>
    </body></html>`;
  const p = extrairDePagina(disfarcada, 'embed');
  assert.equal(p.campos.titulo, undefined, 'a copy institucional passou como legenda');
});

// ═══════════════════════════════════════════════════════════════════════════
// DEFEITO 2 — o lixo da fonte 1 não pode trancar a fonte 2
// ═══════════════════════════════════════════════════════════════════════════

test('DEFEITO 2: parede na fonte 1 NÃO impede a fonte 2 de entregar a legenda real', () => {
  const achado = escolherEntreFontes([
    extrairDePagina(PAREDE_PT, 'og'),     // vale ZERO
    extrairDePagina(EMBED_BOM, 'embed'),  // é quem funciona deslogado
  ]);
  assert.equal(achado.titulo, LEGENDA_REAL, 'a legenda real do embed não chegou');
  assert.equal(achado.autor, 'canal_teste');
  assert.equal(achado.likes, 184000);
  assert.equal(achado.comments, 2310);
  assert.equal(achado.pagina_ilegivel, false, 'marcou ilegível apesar do embed ter lido');
});

test('DEFEITO 2 (antes×depois): o gate `if (!achado.titulo)` trancava a fonte 2', () => {
  // Reprodução do laço antigo: a fonte 1 preenchia achado.titulo com a copy da
  // Meta e, a partir daí, `if (!achado.titulo)` impedia a fonte 2 de corrigir.
  const achadoAntigo = {};
  for (const html of [PAREDE_PT, EMBED_BOM]) {
    if (!achadoAntigo.titulo) achadoAntigo.titulo = legendaDoParserAntigo(html);
  }
  assert.equal(achadoAntigo.titulo, COPY_PT, 'o fixture não reproduz o trancamento antigo');

  // Depois: as duas fontes são avaliadas e a parede vale ZERO.
  const agora = escolherEntreFontes([extrairDePagina(PAREDE_PT, 'og'), extrairDePagina(EMBED_BOM, 'embed')]);
  assert.equal(agora.titulo, LEGENDA_REAL);
});

test('DEFEITO 2: a legenda REAL vem de edge_media_to_caption (que antes nem era parseado)', () => {
  assert.equal(legendaDoEmbed(EMBED_BOM), LEGENDA_REAL);
  const p = extrairDePagina(EMBED_BOM, 'embed');
  assert.equal(p.campos.titulo.valor, LEGENDA_REAL);
  assert.equal(p.campos.titulo.confianca, 4, 'edge_media_to_caption tem que ser a fonte de MAIOR confiança');
});

test('DEFEITO 2: entre fontes boas, ganha a de maior confiança (não a primeira)', () => {
  const ogFraco = `<html><head>
    <meta property="og:title" content="Canal Teste on Instagram">
    <meta property="og:description" content='184 mil likes, 2.310 comments - canal_teste on August 1, 2026: "legenda truncada do og…"'>
    <meta property="og:image" content="https://scontent.cdninstagram.com/v/t51/og_n.jpg">
    </head><body></body></html>`;
  const achado = escolherEntreFontes([
    extrairDePagina(ogFraco, 'og'),
    extrairDePagina(EMBED_BOM, 'embed'),
  ]);
  assert.equal(achado.titulo, LEGENDA_REAL, 'a fonte 1 (mais fraca) venceu a fonte 2');
  assert.equal(achado.confianca.titulo.fonte, 'embed');
});

test('DEFEITO 2: capturarPublico chama AS DUAS fontes mesmo quando a primeira responde 200', async () => {
  const chamadas = [];
  const fetchOriginal = globalThis.fetch;
  globalThis.fetch = async (url) => {
    chamadas.push(String(url));
    const body = String(url).includes('/embed/') ? EMBED_BOM : PAREDE_PT;
    return { ok: true, status: 200, text: async () => body };
  };
  try {
    const achado = await capturarPublico({ shortcode: 'CxYz123abcd', tipo: 'reel', url: 'https://www.instagram.com/reel/CxYz123abcd/' });
    assert.equal(chamadas.length, 2, 'parou na primeira fonte — o lixo da parede trancou o embed');
    assert.ok(chamadas.some((u) => u.includes('/embed/captioned/')), 'não chamou o /embed/captioned/');
    assert.equal(achado.titulo, LEGENDA_REAL, 'a legenda publicada não é a real');
    assert.notEqual(achado.titulo, COPY_PT, 'PUBLICOU A COPY DA META COMO LEGENDA');
    // A parede continua registrada como aviso, mesmo com o embed salvando o dia
    assert.ok(achado.avisos.some((a) => /não consegui ler/i.test(a)), 'a parede da fonte 1 não virou aviso');
  } finally {
    globalThis.fetch = fetchOriginal;
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// DEFEITO 3 — parede com 200 tem que gerar aviso (antes: avisos vazio)
// ═══════════════════════════════════════════════════════════════════════════

test('DEFEITO 3: parede com HTTP 200 gera aviso explícito "não consegui ler essa página"', async () => {
  const fetchOriginal = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => PAREDE_PT });
  try {
    const achado = await capturarPublico({ shortcode: 'AAAA1', tipo: 'reel', url: 'https://www.instagram.com/reel/AAAA1/' });
    assert.ok(achado.avisos.length > 0, 'avisos veio VAZIO — o dono não fica sabendo de nada');
    const texto = achado.avisos.join(' | ');
    assert.match(texto, /não consegui ler/i, 'nenhum aviso diz que a leitura falhou');
    assert.match(texto, /parede de login/i, 'o aviso não nomeia a causa (parede de login)');
    assert.equal(achado.pagina_ilegivel, true);
    // E o aviso não pode falar só de imagem: 'falta_imagem' já existia e não
    // servia, porque fala de imagem e não de "não consegui ler a página".
    assert.equal(/^imagem/i.test(achado.avisos[0]), false);
  } finally {
    globalThis.fetch = fetchOriginal;
  }
});

test('DEFEITO 3: falha ALTA (302) e falha MUDA (200) avisam do mesmo jeito', async () => {
  const fetchOriginal = globalThis.fetch;
  const rodar = async (resposta) => {
    globalThis.fetch = async () => resposta;
    try {
      return await capturarPublico({ shortcode: 'AAAA1', tipo: 'reel', url: 'https://www.instagram.com/reel/AAAA1/' });
    } finally { globalThis.fetch = fetchOriginal; }
  };
  const alto = await rodar({ ok: false, status: 302, text: async () => '' });
  const mudo = await rodar({ ok: true, status: 200, text: async () => PAREDE_PT });
  assert.ok(alto.avisos.length > 0, 'falha alta sem aviso');
  assert.ok(mudo.avisos.length > 0, 'falha muda sem aviso — o modo MAIS PROVÁVEL seguia silencioso');
  assert.equal(alto.pagina_ilegivel, true);
  assert.equal(mudo.pagina_ilegivel, true);
  assert.equal(alto.titulo, undefined);
  assert.equal(mudo.titulo, undefined, 'a falha muda produziu título — vira legenda falsa no card');
});

// ═══════════════════════════════════════════════════════════════════════════
// DEFEITO 4 — métrica ausente fica AUSENTE, nunca vira 0
// ═══════════════════════════════════════════════════════════════════════════

const semLinha = { lido: true, row: null };

test('DEFEITO 4 (antes×depois): o OR das três calava o aviso e deixava views virar 0', () => {
  const dados = { views: null, likes: 184000, comments: 2310 };

  // ANTES: temMetrica = OR das três → likes presente calava tudo; views nula
  // simplesmente não entrava no body e o DEFAULT 0 da coluna assumia.
  const temMetricaAntigo = dados.views !== null || dados.likes !== null || dados.comments !== null;
  const bodyAntigo = {
    metrics_measured_at: '2026-08-11T12:00:00.000Z',
    ...(dados.views !== null ? { views_count: dados.views } : {}),
    ...(dados.likes !== null ? { likes_count: dados.likes } : {}),
  };
  assert.equal(temMetricaAntigo, true, 'o fixture não reproduz o OR antigo');
  assert.equal('views_count' in bodyAntigo, false, 'views ficava fora do body → DEFAULT 0 no banco');
  // …e com metrics_measured_at preenchido, o card publicava "▶ 0 · medido em hoje".

  // DEPOIS: views vai como NULL explícito e o aviso sai por métrica.
  const d = decidirMetricas({ dados, origem: { likes: 'automatico' }, medidoEmBruto: '2026-08-11', existente: semLinha });
  assert.equal(d.colunas.views_count, null, 'views ainda pode cair no DEFAULT 0');
  assert.ok(d.avisos.some((a) => /Sem views/i.test(a)), 'o OR ainda cala o aviso de views');
});

test('DEFEITO 4: og de Reel com likes/comments mas SEM views não grava views 0', () => {
  const dados = { views: null, likes: 184000, comments: 2310 };
  const origem = { views: 'ilegivel', likes: 'automatico', comments: 'automatico' };
  const d = decidirMetricas({ dados, origem, medidoEmBruto: '2026-08-11', existente: semLinha });
  // O antigo `temMetrica` era OR: likes presente já calava tudo.
  assert.deepEqual(d.medidas, ['likes', 'comments']);
  assert.equal(d.colunas.views_count, null, 'views ausente NÃO pode virar 0 (o DEFAULT da coluna morde no INSERT)');
  assert.equal(d.colunas.likes_count, 184000);
  assert.ok(d.avisos.some((a) => /Sem views/i.test(a)), 'não avisou que views não foi medida');
  assert.ok(d.avisos.some((a) => /não inventamos 0/i.test(a)));
});

test('DEFEITO 4: sem NENHUMA métrica não existe "medido em"', () => {
  const d = decidirMetricas({
    dados: { views: null, likes: null, comments: null },
    origem: {}, medidoEmBruto: '2026-08-11', existente: semLinha,
  });
  assert.equal(d.temMetrica, false);
  assert.equal(d.medidoEm, null, '"medido em <hoje>" apareceria sem nada ter sido medido');
  assert.equal(d.fonte, 'nenhuma');
  assert.equal(d.colunas.views_count, null);
  assert.equal(d.colunas.likes_count, null);
  assert.equal(d.colunas.comments_count, null);
});

test('DEFEITO 4: métrica medida ganha "medido em"; a ausente não é inventada', () => {
  const d = decidirMetricas({
    dados: { views: null, likes: 184000, comments: null },
    origem: { likes: 'manual' }, medidoEmBruto: '2026-08-11', existente: semLinha,
  });
  assert.ok(d.medidoEm, 'métrica medida ficou sem data de medição');
  assert.match(d.medidoEm, /^2026-08-11T12:00/);
  assert.equal(d.fonte, 'manual');
  assert.equal(d.colunas.likes_count, 184000);
  assert.equal(d.colunas.views_count, null);
});

test('DEFEITO 4: valor bom já gravado NÃO é substituído por ausência', () => {
  const d = decidirMetricas({
    dados: { views: null, likes: 200000, comments: null },
    origem: { likes: 'manual' }, medidoEmBruto: '',
    existente: { lido: true, row: { views_count: 12400000, likes_count: 184000, comments_count: 0 } },
  });
  assert.equal('views_count' in d.colunas, false, 'ia apagar um views bom que já estava no banco');
  assert.equal(d.colunas.comments_count, null, 'comments 0 no banco é "não medido" — pode virar null');
});

test('parede de login não APAGA a legenda boa de uma réplica anterior', () => {
  const { textoOuPreserva } = igv;
  const jaSalvo = { lido: true, row: { caption: 'legenda boa de antes', author_handle: 'canal_teste' } };
  // Recolar a URL com a página em parede de login → dados.titulo = null.
  assert.deepEqual(textoOuPreserva('caption', null, jaSalvo), {}, 'ia sobrescrever a legenda boa com null');
  assert.deepEqual(textoOuPreserva('caption', 'nova legenda', jaSalvo), { caption: 'nova legenda' });
  assert.deepEqual(textoOuPreserva('caption', null, { lido: true, row: null }), { caption: null });
  assert.deepEqual(textoOuPreserva('caption', null, { lido: false }), {}, 'sem saber o que há lá, não mexo');
});

test('DEFEITO 4: se não consegui LER o que já existe, não mexo (lado seguro)', () => {
  const d = decidirMetricas({
    dados: { views: null, likes: 1, comments: null },
    origem: { likes: 'manual' }, medidoEmBruto: '', existente: { lido: false },
  });
  assert.equal('views_count' in d.colunas, false, 'gravaria null sem saber o que havia lá');
  assert.equal('comments_count' in d.colunas, false);
});

// ═══════════════════════════════════════════════════════════════════════════
// FIM A FIM — nada da parede chega a virar conteúdo publicável
// ═══════════════════════════════════════════════════════════════════════════

test('FIM A FIM: parede em todas as fontes → nada publicável e tudo marcado', async () => {
  const fetchOriginal = globalThis.fetch;
  globalThis.fetch = async (url) => ({
    ok: true, status: 200,
    text: async () => (String(url).includes('/embed/') ? PAREDE_EN : PAREDE_PT),
  });
  try {
    const auto = await capturarPublico({ shortcode: 'AAAA1', tipo: 'reel', url: 'https://www.instagram.com/reel/AAAA1/' });

    // 1) nenhuma frase institucional em campo nenhum
    const serializado = JSON.stringify({
      titulo: auto.titulo ?? null, autor: auto.autor ?? null, autor_nome: auto.autor_nome ?? null,
    });
    for (const [, , copy] of TODAS_AS_PAREDES) {
      assert.equal(serializado.includes(copy.slice(0, 30)), false, 'copy institucional virou conteúdo: ' + copy);
    }

    // 2) o estado degradado está MARCADO e chega à tela
    assert.equal(auto.pagina_ilegivel, true);
    assert.match(auto.avisos.join(' | '), /não consegui ler/i);

    // 3) e nada disso vira métrica zerada com data de hoje
    const d = decidirMetricas({
      dados: { views: auto.views ?? null, likes: auto.likes ?? null, comments: auto.comments ?? null },
      origem: {}, medidoEmBruto: '', existente: semLinha,
    });
    assert.equal(d.medidoEm, null, 'publicaria "medido em hoje" sobre uma página que não foi lida');
    assert.equal(d.colunas.views_count, null, 'publicaria "▶ 0"');
  } finally {
    globalThis.fetch = fetchOriginal;
  }
});

test('FIM A FIM: página BOA continua sendo lida normalmente (sem falso positivo)', () => {
  const p = extrairDePagina(EMBED_BOM, 'embed');
  assert.equal(p.parede, null, 'post legítimo foi confundido com parede de login');
  assert.equal(p.campos.titulo.valor, LEGENDA_REAL);
  assert.ok(String(p.campos.thumb_origem.valor).includes('cdninstagram.com'));
});
