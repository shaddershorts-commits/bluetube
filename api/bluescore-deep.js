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
const PROMPT_VERSION = 'v2-fase3-deep';

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
    const dicas = Array.isArray(report?.top_3_actions) ? report.top_3_actions.slice(0, 10) : [];
    const r = await fetch(`${SUPA_URL}/rest/v1/bluescore_analises`, {
      method: 'POST',
      headers: { ...supaH, Prefer: 'return=representation' },
      body: JSON.stringify({
        user_id: userId,
        canal_id: channelId,
        canal_nome: channel?.title || '',
        nicho: report?.summary?.match(/nicho[:\s]+([^.,;]+)/i)?.[1]?.trim() || null,
        eh_shorts: true,
        score: report?.compliance_score ?? null,
        verdict: report?.verdict || null,
        compliance_score: report?.compliance_score ?? null,
        relatorio_v2: { report, videos_data: videosData, channel },
        prompt_version: PROMPT_VERSION,
        diagnostico: (report?.summary || '').slice(0, 1000),
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
  return {
    title: ch.snippet?.title || 'Canal',
    subscribers: parseInt(ch.statistics?.subscriberCount || 0),
    videoCount: parseInt(ch.statistics?.videoCount || 0),
    totalViews: parseInt(ch.statistics?.viewCount || 0),
    country: ch.snippet?.country || '',
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
  if (!ANTHROPIC_KEY) return { ok: false, error: 'no_anthropic_key' };
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
      return { ok: false, error: `claude HTTP ${r.status}: ${txt.slice(0, 150)}` };
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
  if (!SERPAPI_KEY) return { ok: false, error: 'no_serpapi_key' };
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

async function generateLegalReport(channel, videoData, guidelines) {
  const guidelinesText =
    guidelines.length > 0
      ? `📋 DIRETRIZES YPP ATUALIZADAS (semana atual, ${guidelines.length} snippets oficiais YouTube + imprensa):\n` +
        guidelines.map((g) => `- "${(g.snippet || '').slice(0, 280)}"`).join('\n')
      : '(cache YPP vazio — usando conhecimento base do modelo)';

  const videosBlock = videoData
    .map(
      (v, i) => `
<video num="${i + 1}">
<title>${sanitize(v.title, 200)}</title>
<meta>${v.duration}s, ${v.views.toLocaleString()} views, publicado ${sanitize(v.publishedAt || '', 50)}</meta>
<transcript>${v.transcript?.ok ? sanitize(v.transcript.text, 1000) : '(falhou: ' + sanitize(v.transcript?.error || 'sem dados', 100) + ')'}</transcript>
<visual_analysis>${v.visual?.ok ? sanitize(JSON.stringify(v.visual.analysis), 500) : '(falhou: ' + sanitize(v.visual?.error || 'sem dados', 100) + ')'}</visual_analysis>
<reverse_search>${v.reverse?.ok ? `${v.reverse.total_matches} matches. Top 3: ` + (v.reverse.external_top8 || []).slice(0, 3).map((m) => '"' + sanitize(m.title, 80) + '" (' + sanitize(m.source, 40) + ')').join(' | ') : '(sem matches ou falhou)'}</reverse_search>
</video>`
    )
    .join('\n');

  const systemPrompt = `Você é um ADVOGADO ESPECIALISTA em diretrizes do YouTube Partner Program (YPP) com foco EXCLUSIVO em canais de YouTube SHORTS verticais. Sua missão: identificar riscos REAIS de DESMONETIZAÇÃO no canal abaixo, citando evidências CONCRETAS de cada vídeo analisado.

⚠️ ESTE É CANAL DE SHORTS VERTICAIS. NUNCA sugira:
- Vídeos longos / formato episódico
- Capítulos / cards / end screens
- Lives / Memberships
- "Watch time tradicional"
- Descrições longas com timestamps

FOQUE em risco de DESMONETIZAÇÃO Shorts:
- Conteúdo reutilizado/republicado de terceiros sem transformação substancial
- Voz IA sintética sem disclosure adequada (regra YPP 2024+)
- Música licenciada vs YouTube Audio Library
- Thumbnail enganosa / clickbait extremo (CTR fake)
- Compilações sem comentário/identidade
- Engajamento artificial

${guidelinesText}

CANAL ANALISADO: <name>${sanitize(channel.title, 80)}</name> (${channel.subscribers?.toLocaleString()} inscritos, ${channel.videoCount} vídeos totais)

VÍDEOS ANALISADOS:
${videosBlock}

INSTRUÇÃO:
Como advogado YPP, gere relatório estruturado JURÍDICO. Cite vídeo específico (Vídeo 1, 2, ...) com evidência concreta. Seja específico, NÃO genérico.

Responda APENAS JSON válido sem markdown:
{
  "verdict": "compliant|warning|risk",
  "compliance_score": 0-100,
  "risk_categories": [
    {
      "category": "reused_content|ai_voice_no_disclosure|copyright_music|clickbait|compilation|engagement_artificial|other",
      "severity": "high|medium|low",
      "evidence": "Vídeo X — citação literal da evidência",
      "ypp_guideline_violated": "diretriz YPP específica",
      "fix": "ação específica e mensurável"
    }
  ],
  "compliant_signals": ["sinal positivo 1", ...],
  "summary": "diagnóstico executivo 2-3 frases focado em risco DESMONETIZAÇÃO Shorts. Mencione nicho.",
  "top_3_actions": ["ação 1", "ação 2", "ação 3"]
}`;

  const extractJson = (text) => {
    text = (text || '').split('```json').join('').split('```').join('').trim();
    const s = text.indexOf('{');
    const e = text.lastIndexOf('}');
    if (s === -1 || e === -1) return null;
    try { return JSON.parse(text.slice(s, e + 1)); } catch (er) { return null; }
  };

  if (OPENAI_KEY) {
    try {
      const r = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_KEY}` },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: systemPrompt }],
          max_tokens: 1500,
          temperature: 0.3,
        }),
        signal: AbortSignal.timeout(40000),
      });
      const d = await r.json();
      if (r.ok && d.choices?.[0]?.message?.content) {
        const parsed = extractJson(d.choices[0].message.content);
        if (parsed) return { ok: true, source: 'openai-gpt-4o-mini', report: parsed };
      }
    } catch (e) { /* fallback */ }
  }

  for (const key of GEMINI_KEYS.slice(0, 3)) {
    try {
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: systemPrompt }] }],
            generationConfig: { temperature: 0.3, maxOutputTokens: 1500 },
          }),
          signal: AbortSignal.timeout(40000),
        }
      );
      const d = await r.json();
      if (d.error?.code === 429) continue;
      if (!r.ok) continue;
      const text = d.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('').trim() || '';
      const parsed = extractJson(text);
      if (parsed) return { ok: true, source: 'gemini-2.0-flash', report: parsed };
    } catch (e) { /* try next */ }
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

  // 4. Limite 1/dia/user (validacao backend)
  const userId = auth.user?.id;
  const usedToday = await hasUsedToday(userId);
  if (usedToday) {
    return res.status(429).json({
      error: 'limite_diario_atingido',
      message: 'Voce ja usou sua analise BlueScore Deep hoje. Volte amanha.',
    });
  }

  const startTs = Date.now();
  const stages = [];

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
    stages[stages.length - 1].source = reportResult.source || 'failed';

    if (!reportResult.ok) {
      return res.status(502).json({ error: 'all_ia_providers_failed', stages });
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

    return res.status(200).json({
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
          ? { source: v.transcript.source, length: v.transcript.text.length, sample: v.transcript.text.slice(0, 200) }
          : { error: v.transcript?.error || 'unknown' },
        visual: v.visual?.ok ? v.visual.analysis : { error: v.visual?.error || 'unknown' },
        reverse: v.reverse?.ok
          ? { total_matches: v.reverse.total_matches, top3: v.reverse.external_top8.slice(0, 3) }
          : { error: v.reverse?.error || 'unknown' },
      })),
      report: reportResult.report,
      report_source: reportResult.source,
      timing_ms: Date.now() - startTs,
      stages,
    });
  } catch (e) {
    return res.status(500).json({
      error: (e.message || '').slice(0, 300),
      timing_ms: Date.now() - startTs,
      stages,
    });
  }
};
