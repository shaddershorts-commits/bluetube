// api/bluescore-deep.js
//
// FASE 4 / BlueScore v2 — Endpoint de PRODUÇÃO da análise profunda.
// Promove o /api/bluescore-deep-test pra produção com:
//   - Auth via Supabase token (Bearer)
//   - Plan check Master only (Free/Full bloqueados)
//   - Limite 1 análise/dia/user (validação backend, não localStorage)
//   - Salva relatório completo no bluescore_analises com user_id
//   - Retorna analise_id pra frontend usar em "salvar/deletar"
//
// Pipeline herdado da Fase 3 (deep-test):
//   1. YouTube Data API: channel + 5 últimos vídeos (paralelo)
//   2. Pra cada vídeo: Supadata transcription + Claude Haiku Vision +
//      SerpAPI Lens reverse search (3 paralelos)
//   3. Diretrizes YPP do cache adaptativo (Fase 2)
//   4. IA "advogado YPP Shorts-only" (gpt-4o-mini fallback Gemini)
//
// Custo: ~$0.10 por análise. Tempo: ~30s.
// maxDuration Vercel: 300s.

const { getTranscript, extractText } = require('./_helpers/supadata');

// Manifesto condensado pra YPP (versao reduzida do BLUBLU_MANIFESTO_V3 do helper).
// Original tem 5KB com exemplos de viral — aqui mantemos so o nucleo de tom +
// vocabulario proibido + estrutura. Reducao calibrada pra caber em max_tokens
// junto com 5 cenas + meta no output.
const BLUBLU_MANIFESTO_YPP = `
QUEM VOCE E
Voce e Blublu, mentor direto. Personalidade fusao de: storytelling com dados
duros (Finch), provocacao tecnica direta (Marcal), disciplina + matematica
(Joel Jota), brutalidade respeitosa (Flavio Augusto), ironia inteligente
(Possidonio), pitada de autoconsciencia de IA (Deadpool — 1x por analise no
maximo, em parenteses).

Nesta analise especifica voce e ADVOGADO YPP. Mesmo tom, missao diferente:
defender o canal contra desmonetizacao. Diretriz primeiro, opiniao depois.

7 PILARES DE TOM
1. Autoridade sem pedir licenca: afirma, nao "talvez/acho que/se voce quiser".
2. Dados brutos antes de opiniao: numero primeiro ("60 matches externos"),
   interpretacao depois.
3. Direto na ferida: fala o que ninguem fala. Sem suavizar.
4. Cuida de verdade: toda critica vem com caminho pra resolver.
5. Zero frufru corporativo (lista proibida abaixo).
6. Tom 40% tecnico + 35% provocacao + 15% construcao + 10% zoeira ocasional.
7. 1-2x por analise inteira: comentario lateral em parenteses sobre ser IA.

VOCABULARIO PROIBIDO
✗ "alavancar","potencializar","disruptivo","transformacional","jornada do
   criador","insights valiosos","amplo conhecimento","conteudo de qualidade",
   "experiencia do usuario","metricas","performance","engajamento" como rotulo.
✗ Coach motivacional: "vamos juntos","voce consegue","ceu e o limite",
   "saia da zona de conforto","acredite em voce".
✗ Despedidas: "espero ter ajudado","qualquer duvida","estou aqui se precisar".
✗ Palavroes pesados (fdp, vai se f*der, corno, otario, idiota direcionado).

PALAVROES MODERADOS
✓ "caralho" (1-2x na analise inteira), "porra" (1x), "puta" como intensifi-
  cador ("puta thumb"), "merda" raramente em contexto tecnico ("merda de
  audio"). Regra de ouro: temperam, nunca empilham.

EXEMPLO DE TOM CERTO (calibracao — NAO copiar literalmente)
"Cara, esse video tem 60 matches no reverse. Reuso de conteudo evidente.
A IA YouTube nao e burra — vai pegar. Refilma o frame original ou muda a
edicao em pelo menos 40%. Sem isso, desmonetiza." (dado + diretriz +
acao concreta)

EXEMPLO DE TOM ERRADO (NUNCA assim)
✗ "Seu video apresenta riscos de monetizacao por reutilizacao de conteudo.
   E importante manter consistencia na originalidade."
`.trim();

const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY;
const ANON_KEY = process.env.SUPABASE_ANON_KEY || SUPA_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const GEMINI_KEYS = [
  process.env.GEMINI_KEY_1, process.env.GEMINI_KEY_2, process.env.GEMINI_KEY_3,
].filter(Boolean);
const SERPAPI_KEY = process.env.SERPAPI_KEY;
const YT_KEYS = [
  process.env.YOUTUBE_API_KEY,
  process.env.YOUTUBE_API_KEY_2,
  process.env.YOUTUBE_API_KEY_3,
  process.env.YOUTUBE_API_KEY_4,
  process.env.YOUTUBE_API_KEY_5,
].filter(Boolean);

const MAX_VIDEOS = 5;
const PROMPT_VERSION = 'v2-fase6-cinema';

// ⚠️ FLAG TEMPORÁRIA — TROCAR PRA false ANTES DO DEPLOY OFICIAL
// Quando true: pula limite 1/dia/user pra facilitar testes em preview.
// Quando false: limite ativo (Master só pode 1 análise/dia).
// User pediu em 2026-05-04 pra deixar true durante testes.
const BYPASS_DAILY_LIMIT = true;

const supaH = {
  apikey: SUPA_KEY,
  Authorization: 'Bearer ' + SUPA_KEY,
  'Content-Type': 'application/json',
};

// ── AUTH HELPERS ───────────────────────────────────────────────────────────

async function getUser(token) {
  if (!token) return null;
  try {
    const r = await fetch(`${SUPA_URL}/auth/v1/user`, {
      headers: { apikey: ANON_KEY, Authorization: 'Bearer ' + token },
      signal: AbortSignal.timeout(5000),
    });
    return r.ok ? await r.json() : null;
  } catch (e) { return null; }
}

async function requireMaster(token) {
  const user = await getUser(token);
  if (!user?.email) return { ok: false, status: 401, error: 'token_invalido' };
  const email = user.email.toLowerCase().trim();
  const url = `${SUPA_URL}/rest/v1/subscribers?email=eq.${encodeURIComponent(email)}&select=plan,plan_expires_at,is_manual&limit=1`;
  try {
    const r = await fetch(url, { headers: supaH, signal: AbortSignal.timeout(3000) });
    const lista = r.ok ? await r.json() : [];
    const sub = lista[0];
    const plan = sub?.plan || 'free';
    const planOk = plan === 'master' && (!sub?.plan_expires_at || new Date(sub.plan_expires_at) > new Date() || sub?.is_manual);
    if (!planOk) {
      return { ok: false, status: 403, error: 'master_required', plan };
    }
    return { ok: true, user, plan };
  } catch (e) {
    return { ok: false, status: 500, error: 'auth_check_failed' };
  }
}

// 1 análise/dia/user — verifica via consulta backend (não confia localStorage)
async function hasUsedToday(userId) {
  if (!userId) return false;
  const since = new Date();
  since.setUTCHours(0, 0, 0, 0); // hoje 00:00 UTC
  try {
    const r = await fetch(
      `${SUPA_URL}/rest/v1/bluescore_analises?user_id=eq.${userId}&prompt_version=eq.${PROMPT_VERSION}&created_at=gte.${since.toISOString()}&select=id&limit=1`,
      { headers: supaH, signal: AbortSignal.timeout(3000) }
    );
    if (!r.ok) return false;
    const rows = await r.json();
    return Array.isArray(rows) && rows.length > 0;
  } catch (e) { return false; }
}

async function saveAnalysis(userId, channel, channelId, report, videosData) {
  if (!SUPA_URL || !SUPA_KEY) return null;
  try {
    // Dicas extraidas de scenes que VIOLAM diretrizes — uma frase Blublu por dica.
    const dicas = Array.isArray(report?.scenes)
      ? report.scenes
          .filter((sc) => sc?.verdict_for_scene === 'violates')
          .slice(0, 5)
          .map((sc) => (sc.blublu_says || '').slice(0, 240))
          .filter(Boolean)
      : [];
    const diagnostico = (report?.blublu_summary || report?.channel_observation || '').slice(0, 1000);
    const r = await fetch(`${SUPA_URL}/rest/v1/bluescore_analises`, {
      method: 'POST',
      headers: { ...supaH, Prefer: 'return=representation' },
      body: JSON.stringify({
        user_id: userId,
        canal_id: channelId,
        canal_nome: channel?.title || '',
        nicho: (report?.niche || '').toString().trim().slice(0, 100) || null,
        eh_shorts: true,
        score: report?.compliance_score ?? null,
        verdict: report?.verdict || null,
        compliance_score: report?.compliance_score ?? null,
        relatorio_v2: { report, videos_data: videosData, channel },
        prompt_version: PROMPT_VERSION,
        diagnostico,
        dicas,
        feedback_util: null,
        salva: false,
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return null;
    const rows = await r.json();
    return rows?.[0]?.id || null;
  } catch (e) { return null; }
}

// ── PIPELINE HELPERS (mesmos da Fase 3 deep-test) ─────────────────────────

async function ytFetch(baseUrl) {
  let lastError = null;
  for (const key of YT_KEYS) {
    try {
      const r = await fetch(baseUrl + (baseUrl.includes('?') ? '&' : '?') + 'key=' + key);
      const d = await r.json();
      if (d.error?.code === 403 || d.error?.message?.toLowerCase().includes('quota')) {
        lastError = 'quota_exhausted';
        continue;
      }
      return { r, d, ok: true };
    } catch (e) { lastError = e.message; continue; }
  }
  return { r: null, d: { error: { message: lastError || 'all_keys_failed', code: 403 } }, ok: false };
}

function sanitize(s, max = 500) {
  return String(s || '')
    .replace(/[━┃═]/g, '-')
    .replace(/```/g, "''")
    .slice(0, max);
}

async function getLatestVideos(channelId, n) {
  const sRes = await ytFetch(
    `https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${channelId}&type=video&order=date&maxResults=${n}`
  );
  if (!sRes.ok) return { error: 'youtube_api_error', detail: sRes.d?.error?.message };
  if (!Array.isArray(sRes.d.items)) return { videos: [] };
  const ids = sRes.d.items.map((i) => i.id?.videoId).filter(Boolean).join(',');
  if (!ids) return { videos: [] };
  const vRes = await ytFetch(
    `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails,statistics&id=${ids}`
  );
  if (!vRes.ok) return { error: 'youtube_api_error', detail: vRes.d?.error?.message };
  return {
    videos: (vRes.d.items || []).map((v) => {
      const dur = v.contentDetails?.duration || '';
      const m = dur.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
      const secs = (parseInt(m?.[1] || 0) * 3600) + (parseInt(m?.[2] || 0) * 60) + parseInt(m?.[3] || 0);
      return {
        id: v.id,
        title: v.snippet?.title || '',
        description: (v.snippet?.description || '').slice(0, 300),
        duration: secs,
        views: parseInt(v.statistics?.viewCount || 0),
        likes: parseInt(v.statistics?.likeCount || 0),
        comments: parseInt(v.statistics?.commentCount || 0),
        publishedAt: v.snippet?.publishedAt,
      };
    }),
  };
}

async function getChannelInfo(channelId) {
  const cRes = await ytFetch(
    `https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&id=${channelId}`
  );
  if (!cRes.ok) return { error: 'youtube_api_error', detail: cRes.d?.error?.message };
  const ch = cRes.d.items?.[0];
  if (!ch) return { error: 'channel_not_found' };
  const thumbs = ch.snippet?.thumbnails || {};
  const avatar = thumbs.high?.url || thumbs.medium?.url || thumbs.default?.url || '';
  return {
    title: ch.snippet?.title || 'Canal',
    subscribers: parseInt(ch.statistics?.subscriberCount || 0),
    videoCount: parseInt(ch.statistics?.videoCount || 0),
    totalViews: parseInt(ch.statistics?.viewCount || 0),
    country: ch.snippet?.country || '',
    avatar,
  };
}

async function transcribeVideo(videoId) {
  try {
    const r = await getTranscript(videoId, { SUPABASE_URL: SUPA_URL, SUPABASE_KEY: SUPA_KEY });
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, source: r.source, text: extractText(r.data, 1500) };
  } catch (e) {
    return { ok: false, error: (e.message || '').slice(0, 150) };
  }
}

async function analyzeVisual(thumbnailUrl, frameUrl) {
  if (!ANTHROPIC_KEY) return { ok: false, error: 'visual_engine_unavailable' };
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 400,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'url', url: thumbnailUrl } },
            { type: 'image', source: { type: 'url', url: frameUrl } },
            {
              type: 'text',
              text: `Analise a thumbnail (1ª img) e um frame interno (2ª img) de um Short YouTube. Responda APENAS em JSON:
{
  "thumbnail_style": "estilo da thumb em 1 frase (cores, hooks, texto)",
  "frame_content": "o que aparece no frame interno em 1 frase",
  "thumb_vs_content_match": "match|mismatch|partial",
  "visual_signals": {
    "has_text_overlay": true|false,
    "has_face": true|false,
    "has_arrows_or_highlights": true|false,
    "looks_clickbait": true|false
  },
  "ai_voice_likely": "high|medium|low|none"
}`,
            },
          ],
        }],
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      return { ok: false, error: `visual_engine HTTP ${r.status}: ${txt.slice(0, 150)}` };
    }
    const d = await r.json();
    const text = d.content?.[0]?.text || '';
    const s = text.indexOf('{');
    const e = text.lastIndexOf('}');
    if (s === -1 || e === -1) return { ok: false, error: 'no_json' };
    try { return { ok: true, analysis: JSON.parse(text.slice(s, e + 1)) }; }
    catch (er) { return { ok: false, error: 'json_parse' }; }
  } catch (e) {
    return { ok: false, error: (e.message || '').slice(0, 150) };
  }
}

async function reverseSearch(thumbnailUrl) {
  if (!SERPAPI_KEY) return { ok: false, error: 'reverse_engine_unavailable' };
  try {
    const url = `https://serpapi.com/search?engine=google_lens&url=${encodeURIComponent(thumbnailUrl)}&api_key=${SERPAPI_KEY}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
    const d = await r.json();
    if (d.error) return { ok: false, error: String(d.error).slice(0, 150) };
    const matches = Array.isArray(d.visual_matches) ? d.visual_matches : [];
    const externalMatches = matches.slice(0, 8).map((m) => ({
      title: (m.title || '').slice(0, 100),
      link: m.link || '',
      source: m.source || '',
    }));
    return { ok: true, total_matches: matches.length, external_top8: externalMatches };
  } catch (e) {
    return { ok: false, error: (e.message || '').slice(0, 150) };
  }
}

async function getYppGuidelines() {
  if (!SUPA_URL || !SUPA_KEY) return [];
  try {
    const _now = new Date();
    const _t = new Date(_now.valueOf());
    const _dayNr = (_now.getUTCDay() + 6) % 7;
    _t.setUTCDate(_t.getUTCDate() - _dayNr + 3);
    const _firstThu = _t.valueOf();
    _t.setUTCMonth(0, 1);
    if (_t.getUTCDay() !== 4) _t.setUTCMonth(0, 1 + ((4 - _t.getUTCDay()) + 7) % 7);
    const _weekNum = 1 + Math.ceil((_firstThu - _t) / 604800000);
    const week = `${_now.getUTCFullYear()}-W${String(_weekNum).padStart(2, '0')}`;

    const r = await fetch(
      `${SUPA_URL}/rest/v1/ypp_guidelines_cache?week_iso=eq.${encodeURIComponent(week)}&select=query,snippet,is_official_youtube&order=is_official_youtube.desc,rank_position.asc&limit=24`,
      { headers: { apikey: SUPA_KEY, Authorization: 'Bearer ' + SUPA_KEY }, signal: AbortSignal.timeout(3000) }
    );
    if (!r.ok) return [];
    return await r.json();
  } catch { return []; }
}

// Quality gate: rejeita relatório genérico/sem evidência específica.
// Retorna { passed: bool, issues: string[] }
function validateCinemaReport(report, videoData) {
  const issues = [];
  if (!report || typeof report !== 'object') return { passed: false, issues: ['report ausente'] };
  if (!['compliant', 'warning', 'risk'].includes(report.verdict)) issues.push('verdict invalido');
  if (typeof report.compliance_score !== 'number') issues.push('compliance_score nao e numero');
  if (typeof report.niche !== 'string' || report.niche.trim().length < 2) issues.push('niche vazio');
  if (typeof report.channel_observation !== 'string' || report.channel_observation.trim().length < 30) {
    issues.push('channel_observation muito curto');
  }
  if (typeof report.blublu_summary !== 'string' || report.blublu_summary.trim().length < 50) {
    issues.push('blublu_summary muito curto');
  }
  if (!Array.isArray(report.scenes) || report.scenes.length < Math.min(3, videoData.length)) {
    issues.push(`scenes precisa ter pelo menos ${Math.min(3, videoData.length)} entradas`);
  } else {
    // Detector de viés: se TODAS as cenas têm o mesmo verdict, é provável
    // overcorrection. Sinaliza pra forçar retry com regra de equilíbrio.
    const verdicts = report.scenes.map((sc) => sc?.verdict_for_scene).filter(Boolean);
    if (verdicts.length >= 4) {
      const unique = [...new Set(verdicts)];
      if (unique.length === 1 && unique[0] !== 'neutral') {
        // Detecta sinais positivos disponíveis nos videoData
        const hasPositiveSignals = videoData.some((v) => {
          const noAiVoice = v.visual?.ok && (v.visual.analysis?.ai_voice_likely === 'low' || v.visual.analysis?.ai_voice_likely === 'none');
          const noClickbait = v.visual?.ok && v.visual.analysis?.visual_signals?.looks_clickbait === false;
          const goodMatch = v.visual?.ok && v.visual.analysis?.thumb_vs_content_match === 'match';
          const noReposts = v.reverse?.ok && (v.reverse.total_matches || 0) < 5;
          return noAiVoice || noClickbait || goodMatch || noReposts;
        });
        if (hasPositiveSignals) {
          issues.push(`distribuicao_enviesada: todas cenas "${unique[0]}" mas videoData tem sinais positivos (voz humana / sem matches / thumb match) — releia equilibrio`);
        }
      }
    }
    const validIds = new Set(videoData.map((v) => v.id));
    report.scenes.forEach((sc, i) => {
      const path = `scenes[${i}]`;
      if (!sc || typeof sc !== 'object') { issues.push(`${path} vazio`); return; }
      if (!validIds.has(sc.video_id)) issues.push(`${path}.video_id desconhecido (${sc.video_id})`);
      ['what_we_saw', 'guideline_reference', 'evidence_quote', 'blublu_says'].forEach((c) => {
        if (typeof sc[c] !== 'string' || sc[c].trim().length < 25) {
          issues.push(`${path}.${c} muito curto (<25 chars)`);
        }
      });
      if (!['follows', 'violates', 'neutral'].includes(sc.verdict_for_scene)) {
        issues.push(`${path}.verdict_for_scene invalido`);
      }
      // Bloqueia padrões corporativos / motivacionais (manifesto)
      const blob = [sc.what_we_saw, sc.evidence_quote, sc.blublu_says].filter(Boolean).join(' ');
      const proibidos = [
        /\bdisruptivo\b/i, /\btransformacional\b/i, /\balavancar\b/i, /\bpotencializar\b/i,
        /vamos\s+juntos/i, /voc[eê]\s+consegue/i, /espero\s+ter\s+ajudado/i,
        /jornada\s+do\s+criador/i, /amplo\s+conhecimento/i, /insights\s+valiosos/i,
        /qualidade\s+do\s+conte[uú]do/i, /experi[eê]ncia\s+do\s+usu[aá]rio/i,
      ];
      for (const re of proibidos) {
        if (re.test(blob)) { issues.push(`${path}: padrao proibido "${re.source}"`); break; }
      }
    });
  }
  return { passed: issues.length === 0, issues };
}

function buildCinemaPrompt(channel, videoData, guidelines) {
  const guidelinesText =
    guidelines.length > 0
      ? `DIRETRIZES YPP ATUAIS (snippets oficiais da semana, use como base de citacao em 'guideline_reference'):\n` +
        guidelines.slice(0, 12).map((g, i) => `[G${i + 1}] "${(g.snippet || '').slice(0, 240)}"`).join('\n')
      : '(cache YPP vazio — use teu conhecimento base do YouTube YPP/Shorts 2024-2026)';

  const videosBlock = videoData
    .map(
      (v, i) => `
<video index="${i + 1}" video_id="${sanitize(v.id, 30)}">
<title>${sanitize(v.title, 200)}</title>
<meta>${v.duration}s · ${v.views.toLocaleString()} views · publicado ${sanitize(v.publishedAt || '', 30)}</meta>
<transcript>${v.transcript?.ok ? sanitize(v.transcript.text, 900) : '(audio_engine falhou — sem transcricao deste video)'}</transcript>
<visual>${v.visual?.ok ? sanitize(JSON.stringify(v.visual.analysis), 450) : '(visual_engine falhou)'}</visual>
<reverse>${v.reverse?.ok ? `${v.reverse.total_matches} matches externos. Top: ` + (v.reverse.external_top8 || []).slice(0, 3).map((m) => '"' + sanitize(m.title, 70) + '" @ ' + sanitize(m.source, 30)).join(' | ') : '(sem reposts detectados ou engine falhou)'}</reverse>
</video>`
    )
    .join('\n');

  const yppContext = `
─────────────────────────────────────────────────────────────────────────
CONTEXTO DA TUA ANALISE: ADVOGADO YPP DE SHORTS
─────────────────────────────────────────────────────────────────────────

Tu nao tas analisando "se o video viralizou". Tas analisando RISCO DE
DESMONETIZACAO sob o YouTube Partner Program, EXCLUSIVAMENTE pra Shorts
verticais. Pensa como advogado defendendo o canal contra desmonetizacao.

NAO sugira NUNCA:
- Videos longos / capitulos / end screens / cards
- Lives / Memberships / Super Chat
- "Aumentar watch time tradicional"
- Descricoes longas com timestamps
- "Responder comentarios" (irrelevante pra YPP Shorts)

FOCO EM RISCO YPP SHORTS:
- Conteudo reutilizado/repostado sem transformacao substancial
- Voz IA sintetica sem disclosure (regra 2024+)
- Musica licenciada vs YouTube Audio Library
- Thumbnail/titulo enganoso (clickbait extremo)
- Compilacao sem comentario/identidade do canal
- Engajamento artificial / spam

─────────────────────────────────────────────────────────────────────────
COMO TU VAI ENTREGAR (formato CINEMA — uma cena por video)
─────────────────────────────────────────────────────────────────────────

Pra CADA video da lista (todos, ${videoData.length} cenas), entrega 1 OBJETO em "scenes" com:

1. video_id — copia EXATAMENTE o video_id do <video>
2. video_index — numero da ordem (1, 2, 3...)
3. video_title — copia o titulo
4. what_we_saw — frase OBJETIVA do que as engines viram NESTE video
   (cita transcript, visual ou reverse — o que tiver dado real).
   PROIBIDO frase generica que cabia em qualquer video.
5. guideline_reference — diretriz YPP especifica que se aplica a esta cena.
   Se houver snippet G1..G12, cita pelo numero. Se nao, cita YPP por nome
   ("Reuso de Conteudo - YouTube Help 2024", "Voz Sintetica - Disclosure
   YPP", "Conteudo Original - Politica de Adsense").
6. verdict_for_scene — "follows" se o video SEGUE essa diretriz,
   "violates" se VIOLA, "neutral" se nao da pra dizer.
7. evidence_quote — citacao curta da evidencia (transcript "...",
   ou descricao visual "thumb com setas vermelhas e zoom no rosto",
   ou reverse "match com TikTok @username"). Min 25 chars.
8. blublu_says — fala do Blublu sobre ESTA cena (40-180 chars).
   Tem que MENCIONAR algo especifico do video (titulo abreviado,
   detalhe do transcript, do visual ou do reverse). Voz Blublu
   (autoridade direta, dado primeiro, palavrao moderado se cabe).

Alem das cenas:
- channel_observation: 1 frase brutal-mas-construtiva do Blublu sobre o
  canal inteiro (cita nome do canal e padrao observado em pelo menos 2
  videos). 80-280 chars.
- blublu_summary: paragrafo final do Blublu (180-450 chars). Diagnostico
  honesto + qual o maior risco YPP DESTE canal especifico + 1 acao
  acionavel imediata. Termina com IMPACTO (proibido "espero ter ajudado").
- niche: 1-3 palavras
- verdict: "compliant" | "warning" | "risk"
- compliance_score: 0-100 (sub-indicador YPP — NAO confunde com BlueScore
  algoritmico que ja existe no canal). Score baixo = risco alto YPP.

REGRA DE EQUILIBRIO (CRITICA — nao virar advogado do diabo):
Tu nao tas tentando "achar problema". Tas avaliando JUSTO. Avaliacao YPP
desequilibrada = falsa. Aplica este criterio em CADA cena:

→ Marca "follows" quando houver QUALQUER sinal positivo concreto:
   - transcript com voz humana fluida (entonacao natural, pausas, gírias,
     respiracao, conteudo coerente — sinal de voz real)
   - visual.ai_voice_likely = "low" ou "none"
   - reverse search SEM matches diretos no YouTube/TikTok/Instagram
     (= conteudo provavelmente original)
   - edicao com identidade clara do canal (mesmo personagem/cenario/voz
     em multiplos videos)
   - thumbnail expressiva mas que ENTREGA o que promete no transcript
     (sensacionalismo ≠ enganacao se o conteudo cumpre)

→ Marca "neutral" quando incerto (dado insuficiente pra concluir).

→ Marca "violates" SO quando houver evidencia clara de:
   - reverse_search com match direto em outra plataforma (repost real)
   - voz IA detectada (ai_voice_likely = "high") sem disclosure no titulo/transcript
   - thumb_vs_content_match = "mismatch" claro (promete X, entrega Y)
   - transcript copiado de fonte conhecida

CALIBRACAO ESPERADA:
Em canal saudavel grande (1M+ inscritos, voz real, edicao propria,
sem matches no reverse), o normal e ter 3-5 cenas "follows" e 0-2
"violates". Se TODAS as cenas viram "violates", tu errou — releia os
sinais positivos. Thumbnail chamativa de canal de curiosidades NAO e
clickbait automatico — clickbait e quando promete e nao entrega.

Tom Blublu na cena "follows" tambem: elogia com dado, sem virar coach
("Voz natural com pausas reais aos 0:08, sem cheiro de IA. Tu tas no
caminho. Continua assim.").

REGRAS DE OURO (quality gate):
✗ NENHUMA frase pode caber em qualquer canal. Cita o canal "${sanitize(channel.title, 80)}".
✗ NENHUMA cena pode ter blublu_says generico tipo "edicao boa, continua".
   Sempre cita detalhe especifico do video.
✗ NENHUMA recomendacao de video longo, capitulo, end screen.
✗ Vocabulario corporativo proibido (alavancar, potencializar, disruptivo,
   transformacional, jornada do criador, insights valiosos).
✗ Frases motivacionais proibidas ("vamos juntos", "voce consegue").
✓ Pelo menos 2 dados numericos no relatorio (segundos, %, views, matches).
✓ Tom Blublu em channel_observation, blublu_summary E todos blublu_says.
✓ Distribuicao realista de verdict_for_scene (nao tudo violates, nao tudo follows).
`;

  return `${BLUBLU_MANIFESTO_YPP}

${yppContext}

${guidelinesText}

CANAL ANALISADO: <name>${sanitize(channel.title, 80)}</name> (${(channel.subscribers || 0).toLocaleString()} inscritos · ${channel.videoCount} videos totais)

VIDEOS DISSECADOS:
${videosBlock}

Retorna APENAS JSON valido (zero markdown, zero explicacao fora do JSON):
{
  "verdict": "compliant|warning|risk",
  "compliance_score": 0-100,
  "niche": "...",
  "channel_observation": "...",
  "scenes": [
    {
      "video_index": 1,
      "video_id": "...",
      "video_title": "...",
      "what_we_saw": "...",
      "guideline_reference": "...",
      "verdict_for_scene": "follows|violates|neutral",
      "evidence_quote": "...",
      "blublu_says": "..."
    }
  ],
  "blublu_summary": "..."
}`;
}

const extractJson = (text) => {
  text = (text || '').split('```json').join('').split('```').join('').trim();
  const s = text.indexOf('{');
  const e = text.lastIndexOf('}');
  if (s === -1 || e === -1) return null;
  try { return JSON.parse(text.slice(s, e + 1)); } catch (er) { return null; }
};

// Logs server-side guardam motivo da falha pro debug. NAO expoe detalhes
// no response (mascarado com bluescore_engine_unavailable pro frontend).
const _engineLog = [];
function logEngine(provider, status, detail) {
  _engineLog.push({ provider, status, detail: (detail || '').slice(0, 200), t: Date.now() });
  console.warn(`[bluescore-engine] ${provider} ${status}: ${(detail || '').slice(0, 200)}`);
}

async function callOpenAI(prompt, temperature) {
  if (!OPENAI_KEY) { logEngine('openai', 'no_key', 'OPENAI_API_KEY ausente'); return null; }
  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_KEY}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 4000, // 5 cenas + meta cabem confortavelmente
        temperature,
        response_format: { type: 'json_object' },
      }),
      signal: AbortSignal.timeout(80000),
    });
    const d = await r.json();
    if (!r.ok) { logEngine('openai', 'http_' + r.status, JSON.stringify(d).slice(0, 200)); return null; }
    const content = d.choices?.[0]?.message?.content || '';
    if (!content) { logEngine('openai', 'empty_content', JSON.stringify(d.choices?.[0] || {}).slice(0, 200)); return null; }
    const parsed = extractJson(content);
    if (!parsed) { logEngine('openai', 'json_parse_failed', content.slice(0, 200)); return null; }
    return parsed;
  } catch (e) {
    logEngine('openai', 'exception', e.message);
    return null;
  }
}

async function callGemini(prompt, temperature) {
  if (!GEMINI_KEYS.length) { logEngine('gemini', 'no_keys', 'GEMINI_KEY_* ausente'); return null; }
  for (const key of GEMINI_KEYS.slice(0, 3)) {
    try {
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
              temperature,
              maxOutputTokens: 4000,
              responseMimeType: 'application/json',
            },
          }),
          signal: AbortSignal.timeout(80000),
        }
      );
      const d = await r.json();
      if (d.error?.code === 429) { logEngine('gemini', 'rate_limit', 'try next key'); continue; }
      if (!r.ok) { logEngine('gemini', 'http_' + r.status, JSON.stringify(d).slice(0, 200)); continue; }
      const text = d.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('').trim() || '';
      if (!text) { logEngine('gemini', 'empty_content', JSON.stringify(d).slice(0, 200)); continue; }
      const parsed = extractJson(text);
      if (!parsed) { logEngine('gemini', 'json_parse_failed', text.slice(0, 200)); continue; }
      return parsed;
    } catch (e) { logEngine('gemini', 'exception', e.message); }
  }
  return null;
}

async function generateLegalReport(channel, videoData, guidelines) {
  const basePrompt = buildCinemaPrompt(channel, videoData, guidelines);

  // Tentativa 1 — OpenAI temp 0.4 (espaço pra voz Blublu)
  let parsed = await callOpenAI(basePrompt, 0.4);
  let source = 'bluescore-engine-primary';
  let gate = parsed ? validateCinemaReport(parsed, videoData) : { passed: false, issues: ['parsing_failed'] };

  // Retry com prompt reforçado se falhar quality gate
  if (!gate.passed && parsed) {
    const retryPrompt =
      basePrompt +
      `\n\nQUALITY GATE ANTERIOR FALHOU. Issues:\n- ${gate.issues.slice(0, 8).join('\n- ')}\n\nReescreve. Cita detalhes ESPECIFICOS de cada video. Min 25 chars em what_we_saw/guideline_reference/evidence_quote/blublu_says. Voz Blublu obrigatoria.`;
    parsed = await callOpenAI(retryPrompt, 0.5);
    gate = parsed ? validateCinemaReport(parsed, videoData) : { passed: false, issues: ['retry_parsing_failed'] };
  }

  // Fallback Gemini
  if (!gate.passed) {
    parsed = await callGemini(basePrompt, 0.4);
    source = 'bluescore-engine-fallback';
    gate = parsed ? validateCinemaReport(parsed, videoData) : { passed: false, issues: ['gemini_parsing_failed'] };
  }

  if (parsed && gate.passed) {
    return { ok: true, source, report: parsed, quality_issues: [] };
  }
  if (parsed) {
    // Aceita com warning de qualidade — frontend pode flagear
    return { ok: true, source, report: parsed, quality_issues: gate.issues.slice(0, 10) };
  }
  return { ok: false, error: 'all_providers_failed' };
}

// ── HANDLER ────────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  // 1. Auth: aceita Authorization header ou ?token= (compat frontend simples)
  const authHeader = req.headers?.authorization || req.headers?.Authorization || '';
  const headerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  const queryToken = req.query?.token || '';
  const token = headerToken || queryToken;
  if (!token) return res.status(401).json({ error: 'token obrigatorio (Bearer ou ?token=)' });

  // 2. Plan check Master only
  const auth = await requireMaster(token);
  if (!auth.ok) {
    return res.status(auth.status).json({
      error: auth.error,
      message: auth.error === 'master_required'
        ? 'BlueScore Deep e exclusivo do plano Master. Faca upgrade pra acessar.'
        : 'Token invalido. Faca login novamente.',
      plan: auth.plan,
    });
  }

  // 3. Validar input
  const channelId = req.query?.channelId;
  if (!channelId) return res.status(400).json({ error: 'channelId obrigatorio' });
  if (!YT_KEYS.length) return res.status(500).json({ error: 'YouTube API keys ausentes' });

  // 4. Limite 1/dia/user (validacao backend) — bypass enquanto BYPASS_DAILY_LIMIT=true
  const userId = auth.user?.id;
  if (!BYPASS_DAILY_LIMIT) {
    const usedToday = await hasUsedToday(userId);
    if (usedToday) {
      return res.status(429).json({
        error: 'limite_diario_atingido',
        message: 'Voce ja usou sua analise BlueScore Deep hoje. Volte amanha.',
      });
    }
  }

  const startTs = Date.now();
  const stages = [];
  _engineLog.length = 0; // reset por invocacao (serverless cache do module)

  try {
    // 5. Channel + videos (paralelo)
    stages.push({ stage: 'channel_and_videos', t: Date.now() });
    const [channelRes, videosRes] = await Promise.all([
      getChannelInfo(channelId),
      getLatestVideos(channelId, MAX_VIDEOS),
    ]);
    stages[stages.length - 1].duration_ms = Date.now() - stages[stages.length - 1].t;

    if (channelRes.error === 'youtube_api_error') {
      return res.status(503).json({ error: 'YouTube API erro: ' + (channelRes.detail || ''), stages });
    }
    if (channelRes.error === 'channel_not_found') {
      return res.status(404).json({ error: 'canal_nao_encontrado', stages });
    }
    if (videosRes.error === 'youtube_api_error') {
      return res.status(503).json({ error: 'YouTube videos erro: ' + (videosRes.detail || ''), stages });
    }
    const channel = channelRes;
    const videos = videosRes.videos || [];
    if (!videos.length) return res.status(404).json({ error: 'canal_sem_videos', stages });

    // 6. Pra cada vídeo: transcript + visual + reverse (paralelo)
    stages.push({ stage: 'parallel_video_analysis', t: Date.now() });
    const videoData = await Promise.all(
      videos.map(async (v) => {
        const thumbnailUrl = `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`;
        const frameUrl = `https://i.ytimg.com/vi/${v.id}/2.jpg`;
        const [transcript, visual, reverse] = await Promise.all([
          transcribeVideo(v.id),
          analyzeVisual(thumbnailUrl, frameUrl),
          reverseSearch(thumbnailUrl),
        ]);
        return { ...v, thumbnailUrl, frameUrl, transcript, visual, reverse };
      })
    );
    stages[stages.length - 1].duration_ms = Date.now() - stages[stages.length - 1].t;

    // 7. Diretrizes do cache
    stages.push({ stage: 'fetch_guidelines', t: Date.now() });
    const guidelines = await getYppGuidelines();
    stages[stages.length - 1].duration_ms = Date.now() - stages[stages.length - 1].t;
    stages[stages.length - 1].guidelines_count = guidelines.length;

    // 8. IA advogado YPP
    stages.push({ stage: 'legal_report', t: Date.now() });
    const reportResult = await generateLegalReport(channel, videoData, guidelines);
    stages[stages.length - 1].duration_ms = Date.now() - stages[stages.length - 1].t;
    // Source mantido internamente nos logs server-side mas nao exposto no stage

    if (!reportResult.ok) {
      return res.status(502).json({
        error: 'bluescore_engine_unavailable',
        stages,
        engine_log: _engineLog.slice(-10), // ultimos eventos pra debug
      });
    }

    // 9. Salva no Supabase com user_id
    stages.push({ stage: 'save_db', t: Date.now() });
    const analiseId = await saveAnalysis(userId, channel, channelId, reportResult.report, videoData);
    stages[stages.length - 1].duration_ms = Date.now() - stages[stages.length - 1].t;

    const stats = {
      transcripts_ok: videoData.filter((v) => v.transcript?.ok).length,
      visuals_ok: videoData.filter((v) => v.visual?.ok).length,
      reverses_ok: videoData.filter((v) => v.reverse?.ok).length,
    };

    const response = {
      ok: true,
      analise_id: analiseId,
      channel,
      guidelines_count: guidelines.length,
      videos_analyzed: videoData.length,
      stats,
      videos_data: videoData.map((v) => ({
        id: v.id,
        title: v.title,
        duration: v.duration,
        views: v.views,
        publishedAt: v.publishedAt,
        thumbnail: v.thumbnailUrl,
        transcript: v.transcript?.ok
          ? { length: v.transcript.text.length, sample: v.transcript.text.slice(0, 200) }
          : { error: 'audio_engine_failed' },
        visual: v.visual?.ok ? v.visual.analysis : { error: 'visual_engine_failed' },
        reverse: v.reverse?.ok
          ? { total_matches: v.reverse.total_matches, top3: v.reverse.external_top8.slice(0, 3) }
          : { error: 'reverse_engine_failed' },
      })),
      report: reportResult.report,
      engine_version: 'bluescore-v2-cinema',
      timing_ms: Date.now() - startTs,
      stages,
    };
    if (Array.isArray(reportResult.quality_issues) && reportResult.quality_issues.length > 0) {
      response.quality_warnings = reportResult.quality_issues;
    }
    return res.status(200).json(response);
  } catch (e) {
    return res.status(500).json({
      error: (e.message || '').slice(0, 300),
      timing_ms: Date.now() - startTs,
      stages,
    });
  }
};
