// api/criar-ia.js — "CRIAR COM IA": o Blublu guiando a edição automática.
//
// v2 (2026-08-13, MESMO DIA): a v1 forçava a resposta em JSON com prefill — e
// personalidade não sobrevive a formulário: o user testou e resumiu "tá um
// lixo". A régua dele é o chat da Virais (api/blublu-chat.js), então esta
// versão copia a ARQUITETURA de lá:
//   - o texto exibido é 100% do modelo (zero JSON na fala, zero frase colada);
//   - ações são FERRAMENTAS nativas: mostrar_videos roda a busca AQUI no
//     servidor (virais_banco real) e devolve o resumo pro Blublu COMENTAR o
//     que realmente achou — nunca inventar vídeo;
//   - manifesto v3 + contexto da casa + regra da etapa no system.
//
// Contrato com o front: { resposta, videos[]|null } — os cards são desenhados
// pelo front com o MESMO shape do api/virais.
//
// Gate: login + Master (trocar quando o plano de R$119,99 nascer).

const { BLUBLU_MANIFESTO_V3 } = require('./_helpers/blublu-personality.js');
// v3 (13/08): a busca própria por ilike de título era MUITO inferior — o user
// comparou com o chat da Virais ("funciona MUITO melhor") e a resposta certa
// é UM motor: o funil real (núcleos, sobrenome distintivo, confirmação por
// transcrição, ranking por qualificadores) agora vem de blublu-busca.js.
const { criarBuscaBlublu, TOOL_BUSCAR_VIDEOS } = require('./_helpers/blublu-busca.js');
const { generateSpeech } = require('./_helpers/tts.js');
const { applyRateLimit } = require('./helpers/rate-limit.js');

const MODEL = 'claude-haiku-4-5-20251001';
const MAX_DUR_BLUECLEAN = 35;   // teto do BlueClean — o fluxo não oferece vídeo maior
const QTD_CARDS_IA = 18;        // grade do chat

// (exportado no fim como _interno: a sonda de conversa REAL importa system/
// tools/busca DESTE fonte — nada de réplica que diverge)
const ETAPAS = {
  boasvindas: `ETAPA ATUAL: boas-vindas — o usuário ACABOU de abrir o Criar com IA.
Recepcione do teu jeito (curto!) e pergunte o que ele quer criar hoje. Quando
ele der um tema/nicho — ou pedir sugestão — chame mostrar_videos. Não enrole:
duas trocas no máximo antes de mostrar vídeo.`,
  escolher_video: `ETAPA ATUAL: escolher o vídeo — ele está vendo cards reais.
Pedir outro tema/mais opções = chame mostrar_videos de novo. Dúvidas, responda
curto e puxe de volta pra escolha.`,
  video_escolhido: `ETAPA ATUAL: vídeo escolhido (veio no contexto). Comemore a
escolha do teu jeito citando o vídeo, e diga que a próxima parte da montagem
vem em seguida. NÃO invente etapas prontas nem prometa prazo.`,
  marcar_legenda: `ETAPA ATUAL: marcar a legenda queimada. O usuário está vendo
o vídeo com uma caixa arrastável pra cobrir a legenda colada na imagem. Se ele
tiver dúvida, explique CURTO: cobrir o texto com uma folguinha, e apertar
"Remover legenda". Se o vídeo não tiver legenda queimada, tem o botão de pular.`,
  legenda_removida: `ETAPA ATUAL: legenda tratada (se veio "[a legenda queimada
foi removida...]" no histórico, a limpeza FUNCIONOU e o vídeo limpo está na
tela dele — comemore o resultado; se veio "[o vídeo não tinha legenda...]",
ele pulou a limpeza — siga sem drama). Diga que a próxima parte (roteiro no
idioma dele) vem em seguida. NÃO pergunte o idioma nem liste opções — essa
pergunta tem etapa própria com botões, logo depois desta fala.`,
  escolher_idioma: `ETAPA ATUAL: escolher o idioma do roteiro. Pergunte CURTO
em qual idioma ele quer o roteiro (os botões com as opções aparecem abaixo da
sua fala — não liste idiomas no texto). Nada de enrolação.`,
  escolher_roteiro: `ETAPA ATUAL: as versões do roteiro estão NA TELA em cards
(Casual, Apelativo e Tradução Fiel). Apresente CURTO a diferença: Casual =
natural e conversado; Apelativo = gancho agressivo de retenção; Tradução Fiel
= o roteiro original fielmente no idioma dele. Mande ele ler e escolher a que
curtir. NUNCA transcreva os roteiros no texto.`,
  roteiro_escolhido: `ETAPA ATUAL: roteiro escolhido (a versão veio no
histórico). Comemore CURTO no seu estilo e diga que a próxima parte (voz) vem
em seguida. NÃO invente etapas prontas nem prometa prazo.`,
  escolher_voz: `ETAPA ATUAL: a voz da narração. As opções estão NA TELA:
vozes prontas do acervo (com play de prévia) ou ele gravar a própria voz
lendo o roteiro no teleprompter. Apresente CURTO as duas e deixe ele escolher.
Não liste vozes no texto.`,
  escolher_legenda: `ETAPA ATUAL: o estilo da legenda. Os estilos estão NA
TELA em cards. Diga CURTO que é a legenda nova que vai queimada no vídeo
final, e mande escolher (tem a opção sem legenda também).`,
  montagem: `ETAPA ATUAL: montagem final rodando (narração sincronizada +
legendas + render). Comente CURTO que você está montando; se aparecer aviso
de atraso/estouro no histórico, explique honesto o que significa.`,
  aprovacao: `ETAPA ATUAL: o vídeo FINAL está na tela. Peça pra ele assistir
e aprovar — ou pedir ajuste (trocar voz, legenda ou roteiro). CURTO.`,
  entrega: `ETAPA ATUAL: aprovado! O pacote de publicação (títulos, descrição,
tags) está na tela com o botão de baixar. Comemore no seu estilo — o vídeo
dele está PRONTO pra postar. Se despeça como anfitrião orgulhoso.`,
};

// a MESMA ferramenta do chat da Virais (instruções idênticas de preenchimento)
const TOOLS = [TOOL_BUSCAR_VIDEOS];

function montarSystem(etapa, video) {
  return `${BLUBLU_MANIFESTO_V3}

─── ONDE VOCÊ ESTÁ AGORA ───
Você é o ANFITRIÃO do "Criar com IA" do BlueEditor — a experiência em que VOCÊ
monta o vídeo pro usuário do início ao fim. O fluxo completo, nesta ordem:
escolher um vídeo viral → marcar a legenda queimada (o BlueClean remove) →
roteiro no idioma que ele quiser (ele escolhe entre 3 versões: Casual,
Apelativo, Tradução Fiel) → voz de IA ou ele grava a própria narração →
estilo de legenda → você monta tudo e entrega pronto com título, descrição e
tags. As etapas DEPOIS do roteiro (voz em diante) estão sendo CONSTRUÍDAS —
se ele perguntar, seja honesto que essa parte chega em breve, sem prometer data.

${ETAPAS[etapa] || ETAPAS.boasvindas}
${video ? `\nVÍDEO ESCOLHIDO: "${video.titulo}" — canal ${video.canal}, ${video.views.toLocaleString('pt-BR')} views.` : ''}

REGRAS DO CHAT:
- Respostas CURTAS (1-3 frases). É chat, não palestra. pt-BR sempre.
- Pedido de vídeos = chame buscar_videos. Conversa = responda direto, no personagem.
- Os vídeos aparecem em CARDS abaixo da sua fala — NUNCA liste vídeos no texto.
- CAMPOS DA BUSCA: tema NUNCA null quando o pedido tem assunto/pessoa/canal.
  nucleos = SÓ o núcleo e traduções; verbos/adjetivos/contexto vão SEMPRE em
  qualificadores (misturar destrói a precisão — regra dura).
- IDIOMAS: o acervo é GLOBAL. Sempre inclua nos núcleos a tradução pro inglês
  e espanhol no mínimo. Só filtre nicho se casar claramente.
- HONESTIDADE DE ACERVO: NUNCA afirme que o acervo tem ou não tem um assunto
  sem ter BUSCADO. Se cobertura_fina=true, diga o número real de certeiros e
  ofereça ampliar — JAMAIS finja fartura.
- ESTE FLUXO SÓ ACEITA vídeo de ATÉ 35 segundos (a esteira de limpeza tem esse
  teto) — a busca já filtra; se o usuário pedir vídeo longo, explique o limite.
- Comente o RESULTADO REAL da busca (quantos achou, cite 1 título se valer).
- NUNCA cite tecnologia interna, modelos, fornecedores ou APIs. A tecnologia é SUA.
- Sem markdown, sem listas — fala corrida de chat.`;
}

/** Peneira do fluxo em cima do resultado do motor: só YouTube (o pipeline
 *  baixa e limpa YouTube por ora), só <= 35s (teto do BlueClean), sem os já
 *  vistos nesta conversa ("outras opções" = opções NOVAS), teto da grade. */
function peneirarPraEsteira(videos, vistos) {
  const vistosSet = new Set((Array.isArray(vistos) ? vistos : []).map(String).slice(0, 300));
  return (videos || [])
    .filter((v) => v.plataforma === 'youtube' && v.youtube_id)
    .filter((v) => v.duracao_segundos != null && v.duracao_segundos <= MAX_DUR_BLUECLEAN)
    .filter((v) => !vistosSet.has(String(v.youtube_id)))
    .slice(0, QTD_CARDS_IA);
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  if (await applyRateLimit(req, res)) return;

  const SU = process.env.SUPABASE_URL;
  const SK = process.env.SUPABASE_SERVICE_KEY;
  const AK = process.env.SUPABASE_ANON_KEY || SK;
  const ANTHROPIC = process.env.ANTHROPIC_API_KEY_STUDIO || process.env.ANTHROPIC_API_KEY;
  if (!SU || !SK || !ANTHROPIC) return res.status(500).json({ error: 'config' });
  const H = { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' };

  // ── AUTH: login + Master (mesmo padrão do blublu-chat) ─────────────────────
  const token = req.body?.token;
  let userId = null;
  if (token) {
    try {
      const ur = await fetch(`${SU}/auth/v1/user`, { headers: { apikey: AK, Authorization: 'Bearer ' + token } });
      if (ur.ok) {
        const u = await ur.json();
        const pr = await fetch(`${SU}/rest/v1/subscribers?email=eq.${encodeURIComponent(u.email)}&select=plan,plan_expires_at,is_manual`, { headers: H });
        if (pr.ok) {
          const sub = (await pr.json())[0];
          const vivo = sub && sub.plan === 'master' && (sub.is_manual || !sub.plan_expires_at || new Date(sub.plan_expires_at) > new Date());
          if (vivo) userId = u.id;
        }
      }
    } catch (e) {}
  }
  if (!userId) return res.status(403).json({ error: 'O Criar com IA é exclusivo de assinantes.', upgrade: true });

  // ── PREPARAR-VIDEO: short escolhido → mp4 no Storage ──────────────────────
  // CADEIA REAL medida em 13/08 (na ordem do que está VIVO em produção):
  //   1. Cobalt self-hosted (camada 1 do BaixaBlue — testado ok) → tunnel URL
  //      → Railway /blue-transcode baixa do tunnel, normaliza (moov no início)
  //      e sobe pro Storage (a tunnel expira em ~2h; Storage é permanente).
  //   2. /youtube-hq (ytstream) — medido dando 403 no stream hoje, fica de
  //      fallback pra quando voltar.
  //   3. /download-youtube (yt-dlp) — cookies queimados hoje, idem.
  // Erro pro usuário é SEMPRE amigável: o técnico fica no log.
  if (req.body?.action === 'preparar-video') {
    const RW = (process.env.RAILWAY_FFMPEG_URL || '').replace(/\/$/, '');
    const RAPID = process.env.RAPIDAPI_KEY;
    const COBALT = process.env.COBALT_API_URL;
    const COBALT_KEY = process.env.COBALT_API_KEY;
    const m = String(req.body?.url_youtube || '').match(/(?:shorts\/|v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
    if (!m) return res.status(400).json({ error: 'Não reconheci esse vídeo. Escolhe outro card.' });
    if (!RW) return res.status(500).json({ error: 'config' });
    const videoId = m[1];
    const outPath = `criar-ia/${userId}/${Date.now()}/original.mp4`;
    const deadline = Date.now() + 52000;   // orçamento global (maxDuration 60)
    const restante = () => Math.max(1000, deadline - Date.now());
    const postJson = async (url, body, ms, headers = {}) => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), Math.min(ms, restante()));
      try {
        const r = await fetch(url, {
          method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
          body: JSON.stringify(body), signal: ctrl.signal,
        });
        return { ok: r.ok, data: await r.json().catch(() => ({})) };
      } finally { clearTimeout(timer); }
    };

    // 1º: Cobalt → tunnel → blue-transcode (job) → polling → Storage
    const viaCobalt = async () => {
      const cb = await postJson(COBALT, { url: 'https://www.youtube.com/shorts/' + videoId }, 25000,
        COBALT_KEY ? { Accept: 'application/json', Authorization: 'Api-Key ' + COBALT_KEY } : { Accept: 'application/json' });
      const tunnel = cb.ok ? (cb.data.status === 'picker' ? cb.data.picker?.[0]?.url : cb.data.url) : null;
      if (!tunnel) throw new Error('cobalt: ' + JSON.stringify(cb.data).slice(0, 150));
      const tj = await postJson(`${RW}/blue-transcode`, {
        video_url: tunnel, storage_path: outPath, supabase_url: SU, supabase_key: SK,
      }, 10000);
      if (!tj.ok || !tj.data.job_id) throw new Error('blue-transcode start: ' + JSON.stringify(tj.data).slice(0, 150));
      // polling do job (transcode de short leva ~10-30s)
      while (restante() > 3000) {
        await new Promise((r) => setTimeout(r, 2500));
        const st = await fetch(`${RW}/status/${tj.data.job_id}`).then((r) => r.json()).catch(() => null);
        if (st?.status === 'done') return `${SU}/storage/v1/object/public/blue-videos/${outPath}`;
        if (st?.status === 'error') throw new Error('blue-transcode: ' + (st.error || '').slice(0, 150));
      }
      throw new Error('blue-transcode: orçamento de tempo estourou');
    };
    // 2º/3º: motores diretos do Railway (voltam a valer quando saírem do 403/bot-check)
    const viaRota = (rota, body) => async () => {
      const r = await postJson(`${RW}${rota}`, body, restante());
      if (r.ok && r.data.url) return r.data.url;
      throw new Error(`${rota}: ${JSON.stringify(r.data).slice(0, 150)}`);
    };

    const tentativas = [
      ...(COBALT ? [viaCobalt] : []),
      ...(RAPID ? [viaRota('/youtube-hq', { video_id: videoId, rapidapi_key: RAPID, supabase_url: SU, supabase_key: SK, output_path: outPath })] : []),
      viaRota('/download-youtube', { youtube_url: 'https://www.youtube.com/watch?v=' + videoId, quality: '720', supabase_url: SU, supabase_key: SK, output_path: outPath }),
    ];
    for (const tentar of tentativas) {
      if (restante() < 8000) break;
      try {
        const url = await tentar();
        return res.status(200).json({ url });
      } catch (e) { console.error('[criar-ia] preparar-video:', e.message); }
    }
    return res.status(502).json({ error: 'Não consegui puxar esse vídeo agora. Escolhe outro card — ou tenta esse de novo daqui a pouco.' });
  }

  // ── SEGMENTAR-ROTEIRO: o roteiro escolhido preso às âncoras do original ───
  // O roteiro é texto corrido; a sincronização precisa dele QUEBRADO em
  // trechos, cada um apontando pro offset da fala original correspondente.
  // Quem quebra é o modelo (entende correspondência semântica); a saída é
  // JSON puro validado aqui — só números e texto atravessam.
  if (req.body?.action === 'segmentar-roteiro') {
    const roteiro = String(req.body?.roteiro || '').slice(0, 4000);
    const segs = Array.isArray(req.body?.segments) ? req.body.segments.slice(0, 80) : [];
    if (!roteiro || !segs.length) return res.status(400).json({ error: 'roteiro e segments obrigatórios' });
    const mapa = segs.map((s, i) => `[${i}] offset=${Math.round(Number(s.offset) || 0)}ms · "${String(s.text || '').slice(0, 140)}"`).join('\n');
    const sys = `Você alinha roteiros a vídeos. O vídeo original tinha estas falas com os tempos:
${mapa}

O roteiro NOVO (que substitui a narração) é:
"""${roteiro}"""

Divida o roteiro novo em 3 a 10 trechos NA ORDEM, cada um casando com o momento do vídeo em que o assunto correspondente acontecia. Cada trecho = 1 a 3 frases completas do roteiro (não invente nem corte palavras; use o roteiro INTEIRO). Responda SOMENTE um array JSON: [{"offset_ms": <offset do 1º segmento original correspondente>, "texto": "<trecho>"}] em ordem crescente de offset_ms.`;
    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': ANTHROPIC, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: MODEL, max_tokens: 1500, system: 'Responda apenas JSON válido.', messages: [
          { role: 'user', content: sys }, { role: 'assistant', content: '[' },
        ] }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(JSON.stringify(d).slice(0, 150));
      const bruto = '[' + (d?.content?.[0]?.text || '');
      const arr = JSON.parse(bruto.slice(0, bruto.lastIndexOf(']') + 1));
      const chunks = (Array.isArray(arr) ? arr : []).map((c) => ({
        offset_ms: Math.max(0, Math.round(Number(c.offset_ms) || 0)),
        texto: String(c.texto || '').slice(0, 600),
      })).filter((c) => c.texto.length > 1).slice(0, 12);
      if (!chunks.length) throw new Error('sem chunks');
      chunks.sort((a, b) => a.offset_ms - b.offset_ms);
      return res.status(200).json({ chunks });
    } catch (e) {
      console.error('[criar-ia] segmentar:', e.message);
      return res.status(502).json({ error: 'Não consegui alinhar o roteiro agora. Tenta de novo.' });
    }
  }

  // ── GERAR-VOZ: TTS por trecho → Storage (o render precisa de URLs) ────────
  if (req.body?.action === 'gerar-voz') {
    const chunks = Array.isArray(req.body?.chunks) ? req.body.chunks.slice(0, 12) : [];
    const voiceId = typeof req.body?.voice_id === 'string' ? req.body.voice_id.slice(0, 60) : null;
    if (!chunks.length) return res.status(400).json({ error: 'chunks obrigatórios' });
    const base = `criar-ia/${userId}/${Date.now()}`;
    try {
      const urls = [];
      for (let i = 0; i < chunks.length; i++) {
        const texto = String(chunks[i] || '').slice(0, 600);
        if (!texto) { urls.push(null); continue; }
        const { audio } = await generateSpeech(texto, voiceId, {
          stability: 0.45, similarity: 0.78, modelId: 'eleven_multilingual_v2',
          language: req.body?.language || 'default',
        });
        const p = `${base}/voz_${i}.mp3`;
        const up = await fetch(`${SU}/storage/v1/object/blue-videos/${p}`, {
          method: 'POST', headers: { 'Content-Type': 'audio/mpeg', Authorization: 'Bearer ' + SK, 'x-upsert': 'true' },
          body: audio,
        });
        if (!up.ok) throw new Error('upload ' + up.status);
        urls.push(`${SU}/storage/v1/object/public/blue-videos/${p}`);
      }
      return res.status(200).json({ urls });
    } catch (e) {
      console.error('[criar-ia] gerar-voz:', e.message);
      return res.status(502).json({ error: 'A voz falhou agora. Tenta de novo em instantes.' });
    }
  }

  // ── UPLOAD-VOZ: gravação própria (teleprompter) por trecho → Storage ──────
  if (req.body?.action === 'upload-voz') {
    const b64 = String(req.body?.audio_b64 || '');
    if (!b64 || b64.length > 4000000) return res.status(400).json({ error: 'áudio inválido' });
    const mime = req.body?.mime === 'audio/mpeg' ? 'audio/mpeg' : 'audio/webm';
    const ext = mime === 'audio/mpeg' ? 'mp3' : 'webm';
    try {
      const buf = Buffer.from(b64, 'base64');
      const p = `criar-ia/${userId}/${Date.now()}/gravacao_${Math.floor(Math.random() * 1e6)}.${ext}`;
      const up = await fetch(`${SU}/storage/v1/object/blue-videos/${p}`, {
        method: 'POST', headers: { 'Content-Type': mime, Authorization: 'Bearer ' + SK, 'x-upsert': 'true' },
        body: buf,
      });
      if (!up.ok) throw new Error('upload ' + up.status);
      return res.status(200).json({ url: `${SU}/storage/v1/object/public/blue-videos/${p}` });
    } catch (e) {
      console.error('[criar-ia] upload-voz:', e.message);
      return res.status(502).json({ error: 'Não consegui salvar a gravação. Tenta de novo.' });
    }
  }

  // ── TITULO-TAGS: o pacote de publicação ───────────────────────────────────
  if (req.body?.action === 'titulo-tags') {
    const roteiro = String(req.body?.roteiro || '').slice(0, 3000);
    const idioma = String(req.body?.idioma || 'Português (Brasil)').slice(0, 40);
    const tituloOriginal = String(req.body?.titulo_original || '').slice(0, 200);
    if (!roteiro) return res.status(400).json({ error: 'roteiro obrigatório' });
    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': ANTHROPIC, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: MODEL, max_tokens: 700, system: 'Responda apenas JSON válido.', messages: [
          { role: 'user', content: `Roteiro de um vídeo curto (${idioma}):\n"""${roteiro}"""\n${tituloOriginal ? 'Título do vídeo de referência: "' + tituloOriginal + '"\n' : ''}
Gere o pacote de publicação EM ${idioma}, otimizado pra Shorts/Reels: {"titulos": [3 títulos virais curtos e diferentes entre si], "descricao": "descrição de 2-3 frases com gancho + CTA", "tags": [12 a 18 tags relevantes sem #]}. JSON puro.` },
          { role: 'assistant', content: '{' },
        ] }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(JSON.stringify(d).slice(0, 150));
      const bruto = '{' + (d?.content?.[0]?.text || '');
      const out = JSON.parse(bruto.slice(0, bruto.lastIndexOf('}') + 1));
      return res.status(200).json({
        titulos: (Array.isArray(out.titulos) ? out.titulos : []).map((t) => String(t).slice(0, 120)).slice(0, 3),
        descricao: String(out.descricao || '').slice(0, 800),
        tags: (Array.isArray(out.tags) ? out.tags : []).map((t) => String(t).replace(/^#/, '').trim()).filter(Boolean).slice(0, 18),
      });
    } catch (e) {
      console.error('[criar-ia] titulo-tags:', e.message);
      return res.status(502).json({ error: 'Não consegui gerar o pacote agora. Tenta de novo.' });
    }
  }

  // ── RENDER: a montagem final no Railway (/edit-v0, mesmo motor do editor) ─
  if (req.body?.action === 'render') {
    const RW = (process.env.RAILWAY_FFMPEG_URL || '').replace(/\/$/, '');
    if (!RW) return res.status(500).json({ error: 'config' });
    const p = req.body?.payload || {};
    // SÓ NÚMEROS E CAMPOS CONHECIDOS atravessam (payload vindo do cliente)
    const n = (v, def, min, max) => { const x = Number(v); return Number.isFinite(x) ? Math.min(max, Math.max(min, x)) : def; };
    const urlOk = (u) => typeof u === 'string' && u.startsWith(SU + '/storage/');
    if (!urlOk(p.video_url)) return res.status(400).json({ error: 'vídeo inválido' });
    const durVideo = n(p.dur_video, 0, 0.5, 120);
    if (!durVideo) return res.status(400).json({ error: 'duração inválida' });
    const audio_clips = (Array.isArray(p.audio_clips) ? p.audio_clips.slice(0, 12) : [])
      .filter((a) => urlOk(a.url))
      .map((a) => ({ kind: 'extra', url: a.url, start: n(a.start, 0, 0, 120), source_in: n(a.source_in, 0, 0, 600), source_out: n(a.source_out, 1, 0.05, 600), volume: 1, speed: 1 }));
    // ÂNCORA DE DURAÇÃO (medido 13/08): o mux de produção termina no fim do
    // ÁUDIO — narração curta CORTAVA o vídeo (15,7s viravam 12,9s). Um clipe
    // de silêncio colado no fim segura o arquivo até a duração real do vídeo.
    audio_clips.push({
      kind: 'extra', url: `${SU}/storage/v1/object/public/blue-videos/criar-ia/assets/silencio-1s.mp3`,
      start: Math.max(0, durVideo - 1), source_in: 0, source_out: 1, volume: 0, speed: 1,
    });
    const texts = (Array.isArray(p.texts) ? p.texts.slice(0, 24) : []).map((t) => ({
      content: String(t.content || '').slice(0, 300),
      lines: (Array.isArray(t.lines) ? t.lines : [String(t.content || '')]).map((l) => String(l).slice(0, 80)).slice(0, 6),
      font_pct: n(t.font_pct, 0.045, 0.02, 0.12), font: String(t.font || 'Anton').slice(0, 24),
      size: 'medium', color: /^#[0-9a-fA-F]{6}$/.test(t.color) ? t.color : '#FFFFFF',
      x_pct: n(t.x_pct, 0.5, 0, 1), y_pct: n(t.y_pct, 0.78, 0, 1),
      start_sec: n(t.start_sec, 0, 0, 120), end_sec: n(t.end_sec, 1, 0, 130), lane: 4,
      ...(t.box && /^#[0-9a-fA-F]{6}$/.test(t.box) ? { box: t.box } : {}),
      ...(t.stroke && /^#[0-9a-fA-F]{6}$/.test(t.stroke) ? { stroke: t.stroke } : {}),
    }));
    try {
      const jr = await fetch(`${RW}/edit-v0`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          video_url: p.video_url,
          source_width: 1080, source_height: 1920,
          aspect_strategy: 'crop_center',
          clips: [{ source_in: 0, source_out: durVideo }],
          audio_clips, overlays: [], transitions: [], texts,
          volumes: { video: 0, audio_extra: 1 },   // a narração NOVA substitui o áudio
          output_width: 1080, output_height: 1920,
          supabase_url: SU, supabase_key: SK,
        }),
      });
      const jd = await jr.json().catch(() => ({}));
      if (!jr.ok || !jd.job_id) return res.status(502).json({ error: 'A montagem não começou. Tenta de novo.' });
      return res.status(200).json({ job_id: jd.job_id });
    } catch (e) {
      console.error('[criar-ia] render:', e.message);
      return res.status(502).json({ error: 'A montagem não começou. Tenta de novo.' });
    }
  }
  if (req.body?.action === 'render-status') {
    const RW = (process.env.RAILWAY_FFMPEG_URL || '').replace(/\/$/, '');
    const id = String(req.body?.job_id || '').slice(0, 64);
    if (!RW || !id) return res.status(400).json({ error: 'job_id' });
    try {
      const st = await fetch(`${RW}/status/${encodeURIComponent(id)}`).then((r) => r.json());
      return res.status(200).json({ status: st.status, progress: st.progress || 0, output_url: st.output_url || null, error: st.status === 'error' ? 'A montagem falhou. Tenta de novo.' : null });
    } catch (e) {
      return res.status(502).json({ error: 'status indisponível' });
    }
  }

  if (req.body?.action !== 'chat') return res.status(400).json({ error: 'action inválida' });

  const etapa = String(req.body?.etapa || 'boasvindas');
  const msg = typeof req.body?.msg === 'string' ? req.body.msg.slice(0, 500) : null;
  const video = req.body?.video && typeof req.body.video === 'object'
    ? { titulo: String(req.body.video.titulo || '').slice(0, 200), canal: String(req.body.video.canal || '').slice(0, 100), views: Number(req.body.video.views) || 0 }
    : null;
  const historico = Array.isArray(req.body?.historico)
    ? req.body.historico.slice(-12).map((m) => ({
        role: m?.role === 'user' ? 'user' : 'assistant',
        content: String(m?.text || '').slice(0, 600),
      })).filter((m) => m.content)
    : [];

  const system = montarSystem(etapa, video);
  const tools = TOOLS;

  const anthropicCall = async (messages) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25000);
    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': ANTHROPIC, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: MODEL, max_tokens: 700, system, tools, messages }),
        signal: controller.signal,
      });
      const d = await r.json();
      if (!r.ok) throw new Error('ia ' + r.status + ': ' + JSON.stringify(d).slice(0, 160));
      return d;
    } finally { clearTimeout(timer); }
  };

  try {
    const msgs = [...historico];
    if (msg) msgs.push({ role: 'user', content: msg });
    if (!msgs.length || msgs[msgs.length - 1].role !== 'user') {
      msgs.push({ role: 'user', content: '[o usuário acabou de chegar — abra a conversa]' });
    }

    // loop de ferramentas: o modelo conduz (mesmo desenho do blublu-chat).
    // O MOTOR é o mesmo da Virais; a peneira do fluxo (YouTube, <=35s, sem
    // repetidos) roda em cima e o resumo que volta pro modelo reflete o que
    // REALMENTE vai pros cards.
    const executarBusca = criarBuscaBlublu({
      SU, H,
      OPENAI: process.env.OPENAI_API_KEY || '',
      RW: (process.env.RAILWAY_FFMPEG_URL || '').replace(/\/$/, ''),
      message: msg || '',
      skipIds: new Set(),
    });
    let videos = null;
    let resp = await anthropicCall(msgs);
    for (let volta = 0; volta < 2 && resp.stop_reason === 'tool_use'; volta++) {
      const toolResults = [];
      for (const bloco of resp.content) {
        if (bloco.type !== 'tool_use') continue;
        let out;
        if (bloco.name === 'buscar_videos') {
          const r = await executarBusca({ ...(bloco.input || {}), plataforma: 'youtube' });
          videos = peneirarPraEsteira(r.videos, req.body?.vistos);
          out = JSON.stringify({
            ...r.resumo,
            // O NÚMERO QUE VALE é o dos CARDS: a peneira da esteira (<=35s,
            // sem repetidos) corta depois do funil — sem sobrescrever, o
            // modelo falava "achei 30" com 8 cards na tela (visto em 13/08)
            total_entregue: videos.length,
            descartados_por_passarem_de_35s: Math.max(0, (r.videos || []).length - videos.length),
            amostra: videos.slice(0, 5).map((v) => ({ titulo: (v.titulo || '').slice(0, 70), views: v.views, confirmado_por: v.confirmado_por })),
          });
        } else {
          out = JSON.stringify({ erro: 'ferramenta desconhecida' });
        }
        toolResults.push({ type: 'tool_result', tool_use_id: bloco.id, content: out });
      }
      msgs.push({ role: 'assistant', content: resp.content });
      msgs.push({ role: 'user', content: toolResults });
      resp = await anthropicCall(msgs);
    }

    const resposta = ((resp.content || []).filter((c) => c.type === 'text').map((c) => c.text).join(' ').trim()
      || 'Fala de novo aí — me distraí contando views. 👀')
      .replace(/\*\*?/g, '');   // a bolha não renderiza markdown — asterisco vira lixo visual
    return res.status(200).json({ resposta: resposta.slice(0, 1500), videos });
  } catch (e) {
    console.error('[criar-ia]', e.message);
    return res.status(502).json({ error: 'IA temporariamente indisponível. Tente de novo.' });
  }
};

// pra sonda de conversa REAL (importa DESTE fonte, sem réplica)
module.exports._interno = { ETAPAS, TOOLS, montarSystem, peneirarPraEsteira, MODEL };
