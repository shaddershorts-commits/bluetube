// api/audit-baixablue.js
//
// Health check diario dos providers do baixaBlue YouTube. Roda 6h BRT via
// cron + manual via GET /api/audit-baixablue. Testa cada provider com video
// publico conhecido (Rick Astley) e registra resultado em download_health_log.
// Se algum provider falhou 2x consecutivas, manda email pro admin.
//
// Providers testados:
//   1. cobalt        — instancia Cobalt no Railway
//   2. railway_ytdlp — /youtube-hq do bluetube-ffmpeg (yt-dlp + mux 1080p)
//   3. ytstream      — RapidAPI ytstream-download-youtube-videos
//   4. youtube_media — RapidAPI youtube-media-downloader
//   5. invidious     — fallback de natureza diferente (futuro Camada 5)
//
// Tabela download_health_log (criar SQL antes de rodar):
//   id, provider, status, duration_ms, error, test_video_id, checked_at

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const RESEND_KEY = process.env.RESEND_API_KEY;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const FROM_EMAIL = process.env.RESEND_FROM_EMAIL || 'BlueTube <bluetubeoficial@bluetubeviral.com>';
const COBALT_URL = process.env.COBALT_API_URL;
const COBALT_KEY = process.env.COBALT_API_KEY;
const RAILWAY_FFMPEG_URL = process.env.RAILWAY_FFMPEG_URL;
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;

// ⚠️ LIÇÃO DE 03/08: o vigia usava SÓ o dQw4w9WgXcQ — que é justamente o
// vídeo com tratamento especial no Google e funciona quando todo o resto
// falha. Resultado: 5 provedores "verdes" com o Cobalt caído há semanas e o
// download de produção levando 45s. Vigia que testa a exceção não vale nada.
// Agora: pool variado (Shorts + vídeo comum), sorteado por hora do dia pra
// cobrir casos diferentes ao longo do tempo.
const POOL_VIDEOS = [
  'NW0dJ9ejxKE',  // Short vertical
  'eR4FtXPLxuE',  // Short vertical
  'poUrVmuTt6E',  // Short vertical
  '9bZkp7q19f0',  // vídeo comum
  'kJQP7kiw5Fk',  // vídeo comum
];
const TEST_VIDEO_ID = POOL_VIDEOS[new Date().getUTCHours() % POOL_VIDEOS.length];
const TEST_VIDEO_URL = 'https://www.youtube.com/watch?v=' + TEST_VIDEO_ID;
const TIMEOUT_MS = 30000;

// ⚠️ LIÇÃO 2: "o provedor respondeu" ≠ "o download funciona". O Cobalt
// devolvia URL e era marcado OK enquanto os bytes não vinham. Agora todo
// provedor precisa ENTREGAR BYTES pra passar. 256 KB é suficiente e barato.
const AMOSTRA_BYTES = 262144;
async function entregaBytes(url) {
  try {
    const r = await fetch(url, {
      headers: { Range: 'bytes=0-' + (AMOSTRA_BYTES - 1), 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!r.ok) return { ok: false, motivo: 'http ' + r.status };
    const b = Buffer.from(await r.arrayBuffer());
    if (b.length < 10000) return { ok: false, motivo: 'só ' + b.length + ' bytes' };
    return { ok: true, kb: Math.round(b.length / 1024) };
  } catch (e) { return { ok: false, motivo: String(e.message).slice(0, 60) }; }
}

const supaH = SUPABASE_SERVICE_KEY ? {
  apikey: SUPABASE_SERVICE_KEY,
  Authorization: 'Bearer ' + SUPABASE_SERVICE_KEY,
  'Content-Type': 'application/json',
} : null;

async function testCobalt() {
  if (!COBALT_URL) return { provider: 'cobalt', status: 'fail', error: 'COBALT_API_URL nao configurada', duration_ms: 0 };
  const t0 = Date.now();
  try {
    const headers = { 'Accept': 'application/json', 'Content-Type': 'application/json' };
    if (COBALT_KEY) headers['Authorization'] = 'Api-Key ' + COBALT_KEY;
    const r = await fetch(COBALT_URL, {
      method: 'POST', headers,
      body: JSON.stringify({ url: TEST_VIDEO_URL }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const duration_ms = Date.now() - t0;
    if (!r.ok) return { provider: 'cobalt', status: 'fail', error: `HTTP ${r.status}`, duration_ms };
    const d = await r.json();
    if (!d.url) {
      return { provider: 'cobalt', status: 'fail', error: `sem url: ${(d.error?.code || d.status || 'unknown')}`, duration_ms };
    }
    // devolveu link — mas ENTREGA? (era exatamente aqui que o falso verde nascia)
    const amostra = await entregaBytes(d.url);
    if (!amostra.ok) {
      return { provider: 'cobalt', status: 'fail', error: 'link sem bytes: ' + amostra.motivo, duration_ms: Date.now() - t0 };
    }
    return { provider: 'cobalt', status: 'ok', duration_ms: Date.now() - t0, amostra_kb: amostra.kb };
  } catch (e) {
    return { provider: 'cobalt', status: 'fail', error: e.message, duration_ms: Date.now() - t0 };
  }
}

async function testRailwayYtdlp() {
  if (!RAILWAY_FFMPEG_URL) return { provider: 'railway_ytdlp', status: 'fail', error: 'RAILWAY_FFMPEG_URL nao configurada', duration_ms: 0 };
  const t0 = Date.now();
  try {
    // ⚠️ LIÇÃO 3: antes isto só perguntava "o serviço está vivo?", o que
    // sempre dava verde. O que quebra de verdade é OUTRA coisa: o Google
    // devolve 403 pro IP de datacenter na hora de puxar a mídia (medido em
    // 03/08 — residencial 206, Railway 502/403). O teste de saúde do Railway
    // que importa é esse, e ele roda logo abaixo em testRailwayMedia().
    const url = RAILWAY_FFMPEG_URL.replace(/\/$/, '') + '/health';
    const r = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    const duration_ms = Date.now() - t0;
    if (!r.ok) return { provider: 'railway_ytdlp', status: 'fail', error: `HTTP ${r.status}`, duration_ms };
    const d = await r.json();
    if (!d.ok || !d.ytdlp || d.ytdlp === 'n/a') {
      return { provider: 'railway_ytdlp', status: 'fail', error: `health degraded: ytdlp=${d.ytdlp}`, duration_ms };
    }
    // Detecta yt-dlp velho (>30 dias) — warn mas nao fail
    return { provider: 'railway_ytdlp', status: 'ok', duration_ms, version: d.ytdlp };
  } catch (e) {
    return { provider: 'railway_ytdlp', status: 'fail', error: e.message, duration_ms: Date.now() - t0 };
  }
}

async function testYtstream() {
  if (!RAPIDAPI_KEY) return { provider: 'ytstream', status: 'fail', error: 'RAPIDAPI_KEY nao configurada', duration_ms: 0 };
  const t0 = Date.now();
  try {
    const r = await fetch(`https://ytstream-download-youtube-videos.p.rapidapi.com/dl?id=${TEST_VIDEO_ID}`, {
      headers: {
        'x-rapidapi-key': RAPIDAPI_KEY,
        'x-rapidapi-host': 'ytstream-download-youtube-videos.p.rapidapi.com',
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const duration_ms = Date.now() - t0;
    if (!r.ok) return { provider: 'ytstream', status: 'fail', error: `HTTP ${r.status}`, duration_ms };
    const d = await r.json();
    if (d.adaptiveFormats || d.formats || d.videoId) {
      const fmt = [...(d.adaptiveFormats || []), ...(d.formats || [])].find((f) => f.url);
      if (!fmt) return { provider: 'ytstream', status: 'fail', error: 'schema ok mas sem url', duration_ms };
      const amostra = await entregaBytes(fmt.url);
      if (!amostra.ok) {
        return { provider: 'ytstream', status: 'fail', error: 'link sem bytes: ' + amostra.motivo, duration_ms: Date.now() - t0 };
      }
      return { provider: 'ytstream', status: 'ok', duration_ms: Date.now() - t0, amostra_kb: amostra.kb };
    }
    const topKeys = Object.keys(d).slice(0, 5).join(',');
    return { provider: 'ytstream', status: 'fail', error: `schema desconhecido (keys: ${topKeys})`, duration_ms };
  } catch (e) {
    return { provider: 'ytstream', status: 'fail', error: e.message, duration_ms: Date.now() - t0 };
  }
}

async function testYoutubeMedia() {
  if (!RAPIDAPI_KEY) return { provider: 'youtube_media', status: 'fail', error: 'RAPIDAPI_KEY nao configurada', duration_ms: 0 };
  const t0 = Date.now();
  try {
    const r = await fetch(`https://youtube-media-downloader.p.rapidapi.com/v2/video/details?videoId=${TEST_VIDEO_ID}`, {
      headers: {
        'x-rapidapi-key': RAPIDAPI_KEY,
        'x-rapidapi-host': 'youtube-media-downloader.p.rapidapi.com',
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const duration_ms = Date.now() - t0;
    if (!r.ok) return { provider: 'youtube_media', status: 'fail', error: `HTTP ${r.status}`, duration_ms };
    const d = await r.json();
    if (d.videos?.items?.length || d.title) {
      const item = (d.videos?.items || []).find((x) => x.url);
      if (!item) return { provider: 'youtube_media', status: 'fail', error: 'sem url baixável', duration_ms };
      const amostra = await entregaBytes(item.url);
      if (!amostra.ok) {
        return { provider: 'youtube_media', status: 'fail', error: 'link sem bytes: ' + amostra.motivo, duration_ms: Date.now() - t0 };
      }
      return { provider: 'youtube_media', status: 'ok', duration_ms: Date.now() - t0, amostra_kb: amostra.kb };
    }
    return { provider: 'youtube_media', status: 'fail', error: 'sem videos retornados', duration_ms };
  } catch (e) {
    return { provider: 'youtube_media', status: 'fail', error: e.message, duration_ms: Date.now() - t0 };
  }
}

// O IP do Railway consegue puxar mídia do googlevideo? Este é o teste que
// teria explicado o download de 45s: o provedor entrega o link, mas o
// container leva 403 e a cadeia inteira desce até o yt-dlp.
async function testRailwayMedia() {
  if (!RAILWAY_FFMPEG_URL || !RAPIDAPI_KEY) {
    return { provider: 'railway_media', status: 'skip', error: 'sem RAILWAY_FFMPEG_URL ou RAPIDAPI_KEY', duration_ms: 0 };
  }
  const t0 = Date.now();
  try {
    const r = await fetch(`https://ytstream-download-youtube-videos.p.rapidapi.com/dl?id=${TEST_VIDEO_ID}`, {
      headers: { 'x-rapidapi-key': RAPIDAPI_KEY, 'x-rapidapi-host': 'ytstream-download-youtube-videos.p.rapidapi.com' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!r.ok) return { provider: 'railway_media', status: 'skip', error: 'provedor fora, nao da pra testar', duration_ms: Date.now() - t0 };
    const d = await r.json();
    const fmt = [...(d.adaptiveFormats || []), ...(d.formats || [])].find((f) => f.url);
    if (!fmt) return { provider: 'railway_media', status: 'skip', error: 'sem url pra testar', duration_ms: Date.now() - t0 };

    const proxy = RAILWAY_FFMPEG_URL.replace(/\/$/, '') + '/proxy-download?url=' + encodeURIComponent(fmt.url) + '&filename=t.mp4';
    const pr = await fetch(proxy, { headers: { Range: 'bytes=0-' + (AMOSTRA_BYTES - 1) }, signal: AbortSignal.timeout(TIMEOUT_MS + 30000) });
    const b = Buffer.from(await pr.arrayBuffer());
    const duration_ms = Date.now() - t0;
    if (b.length < 10000) {
      return { provider: 'railway_media', status: 'fail', duration_ms,
        error: 'IP do container bloqueado pelo Google: ' + b.toString().slice(0, 90) };
    }
    return { provider: 'railway_media', status: 'ok', duration_ms, amostra_kb: Math.round(b.length / 1024) };
  } catch (e) {
    return { provider: 'railway_media', status: 'fail', error: String(e.message).slice(0, 100), duration_ms: Date.now() - t0 };
  }
}

async function testInvidious() {
  // Camada 5 — testa endpoint /api/baixa-invidious (que internamente
  // tenta Invidious dinamico + Piped). Se algum responder com URL valida,
  // ok. Note que esse endpoint pode demorar (5+ instancias x timeout).
  const t0 = Date.now();
  const SITE_URL = process.env.SITE_URL || 'https://bluetubeviral.com';
  try {
    const r = await fetch(`${SITE_URL}/api/baixa-invidious?url=${encodeURIComponent('https://www.youtube.com/watch?v=' + TEST_VIDEO_ID)}`, {
      signal: AbortSignal.timeout(45000),
    });
    const duration_ms = Date.now() - t0;
    const d = await r.json().catch(() => ({}));
    if (r.ok && d.ok && d.url) {
      return { provider: 'invidious', status: 'ok', duration_ms, source: d.provider, instance: d.instance };
    }
    return { provider: 'invidious', status: 'fail', error: (d.error || `HTTP ${r.status}`).slice(0, 200), duration_ms };
  } catch (e) {
    return { provider: 'invidious', status: 'fail', error: e.message, duration_ms: Date.now() - t0 };
  }
}

async function logResult(r) {
  if (!supaH || r.status === 'skip') return;
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/download_health_log`, {
      method: 'POST',
      headers: { ...supaH, Prefer: 'return=minimal' },
      body: JSON.stringify({
        provider: r.provider,
        status: r.status,
        duration_ms: r.duration_ms,
        error: r.error || null,
        test_video_id: TEST_VIDEO_ID,
        checked_at: new Date().toISOString(),
      }),
    });
  } catch (e) { console.error('[audit-baixablue] log falhou:', e.message); }
}

async function getConsecutiveFailures(provider) {
  if (!supaH) return 0;
  try {
    // Pega ultimas 5 entradas desse provider
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/download_health_log?provider=eq.${provider}&order=checked_at.desc&limit=5&select=status,checked_at`,
      { headers: supaH }
    );
    if (!r.ok) return 0;
    const rows = await r.json();
    let count = 0;
    for (const row of rows) {
      if (row.status === 'fail') count++;
      else break;
    }
    return count;
  } catch (e) { return 0; }
}

module.exports = async function handler(req, res) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: 'config_missing' });
  }

  // ?action=summary — le ultimo resultado de cada provider sem rodar teste
  // (rapido, usado pelo painel admin pra mostrar status sem custo)
  if (req.query?.action === 'summary') {
    try {
      const providers = ['cobalt', 'railway_ytdlp', 'ytstream', 'youtube_media', 'invidious'];
      const results = [];
      let latestChecked = null;
      for (const p of providers) {
        const r = await fetch(
          `${SUPABASE_URL}/rest/v1/download_health_log?provider=eq.${p}&order=checked_at.desc&limit=1&select=provider,status,duration_ms,error,checked_at`,
          { headers: supaH }
        );
        if (r.ok) {
          const rows = await r.json();
          if (rows[0]) {
            results.push(rows[0]);
            if (!latestChecked || rows[0].checked_at > latestChecked) latestChecked = rows[0].checked_at;
          }
        }
      }
      return res.status(200).json({
        ok: true,
        action: 'summary',
        results,
        checked_at: latestChecked,
        test_video_id: TEST_VIDEO_ID,
        healthy_providers: results.filter(r => r.status === 'ok').length,
        failed_providers: results.filter(r => r.status === 'fail').length,
      });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  const startTs = Date.now();
  const results = await Promise.all([
    testCobalt(),
    testRailwayYtdlp(),
    testYtstream(),
    testYoutubeMedia(),
    testInvidious(),
    testRailwayMedia(),
  ]);

  // Log cada resultado
  await Promise.all(results.map(logResult));

  // Detecta providers com 2+ falhas consecutivas (incluindo essa).
  // railway_media fica de fora: ele é diagnóstico de rede e é vermelho por
  // natureza (Google bloqueia IP de datacenter). Alertar por ele todo dia
  // treinaria o dono a ignorar o alerta — que é como um alarme morre.
  const failuresEsteRun = results
    .filter(r => r.status === 'fail' && r.provider !== 'railway_media')
    .map(r => r.provider);
  const alertas = [];
  for (const provider of failuresEsteRun) {
    const consec = await getConsecutiveFailures(provider);
    if (consec >= 2) {
      const r = results.find(x => x.provider === provider);
      alertas.push({ provider, consecutive_failures: consec, error: r.error });
    }
  }

  // Email pro admin se houver alertas
  if (alertas.length > 0 && RESEND_KEY && ADMIN_EMAIL) {
    const html = renderEmailHtml({ alertas, results, total_checados: results.length });
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to: ADMIN_EMAIL,
        subject: `🚨 baixaBlue YouTube — ${alertas.length} provider(s) caido(s)`,
        html,
      }),
    }).catch((e) => console.error('[audit-baixablue] email falhou:', e.message));
  }

  // ── VEREDITO DO PRODUTO (vem PRIMEIRO, de propósito) ────────────────────
  // Lição de 04/08: eu devolvi "4 de 6 provedores vermelhos" e o dono
  // concluiu, com razão, que o sistema estava quebrado — quando na verdade os
  // downloads estavam saindo em 1080p. Provedor é CAMADA DE RESERVA: a cadeia
  // precisa de UMA funcionando. A pergunta que importa é "dá pra baixar?", e
  // ela tem que estar no topo da resposta, não escondida numa contagem.
  const entregam = results.filter((r) => r.status === 'ok' && r.provider !== 'railway_media');
  const daPraBaixar = entregam.length > 0;
  const veredito = {
    da_pra_baixar: daPraBaixar,
    resumo: daPraBaixar
      ? `Downloads funcionando (${entregam.length} caminho(s) entregando bytes: ${entregam.map((r) => r.provider).join(', ')}).`
      : 'NENHUM caminho está entregando bytes — os downloads devem estar falhando pro usuário.',
    camadas_de_reserva: `${entregam.length} de ${results.filter((r) => r.provider !== 'railway_media').length}`,
  };

  // railway_media não é um provedor: é um diagnóstico de rede. O Google
  // bloqueia IP de datacenter na mídia — isso é permanente e esperado, não
  // uma falha nova. Fica separado pra não contaminar a contagem.
  const diagnosticoRede = results.find((r) => r.provider === 'railway_media');

  return res.status(200).json({
    ok: true,
    veredito,
    duracao_ms: Date.now() - startTs,
    test_video_id: TEST_VIDEO_ID,
    diagnostico_rede: diagnosticoRede
      ? { ...diagnosticoRede, nota: 'Esperado ficar vermelho: o Google bloqueia IP de datacenter. Não indica queda.' }
      : null,
    results,
    alertas,
    healthy_providers: entregam.length,
    failed_providers: results.filter((r) => r.status === 'fail' && r.provider !== 'railway_media').length,
  });
};

function renderEmailHtml({ alertas, results, total_checados }) {
  const linhaProvider = (r) => {
    const cor = r.status === 'ok' ? '#86efac' : (r.status === 'fail' ? '#fca5a5' : '#7d92b8');
    const icone = r.status === 'ok' ? '✓' : (r.status === 'fail' ? '✗' : '⏭');
    return `<tr style="border-top:1px solid #1a2740">
      <td style="padding:8px;color:${cor};font-weight:700">${icone} ${escHtml(r.provider)}</td>
      <td style="padding:8px;color:${cor}">${escHtml(r.status)}</td>
      <td style="padding:8px;color:#7d92b8;font-family:monospace;font-size:11px">${r.duration_ms}ms</td>
      <td style="padding:8px;color:#fca5a5;font-size:11px">${escHtml(r.error || '—')}</td>
    </tr>`;
  };
  const linhaAlerta = (a) => `<tr><td style="padding:8px;color:#fca5a5;font-weight:700">${escHtml(a.provider)}</td><td style="padding:8px;color:#fbbf24">${a.consecutive_failures} falhas seguidas</td><td style="padding:8px;color:#7d92b8;font-size:11px">${escHtml(a.error)}</td></tr>`;
  return `<!DOCTYPE html><html><body style="margin:0;padding:30px;background:#020817;font-family:Arial,sans-serif;color:#fff">
    <div style="max-width:720px;margin:0 auto;background:#0a1220;border-radius:12px;padding:28px">
      <div style="font-size:22px;font-weight:800;color:#fbbf24;margin-bottom:6px">🚨 baixaBlue YouTube — Providers caidos</div>
      <div style="font-size:12px;color:#7d92b8;margin-bottom:20px">${total_checados} providers testados · ${alertas.length} com 2+ falhas consecutivas</div>

      <h3 style="color:#fca5a5;font-size:16px;margin:24px 0 8px">🔴 Alertas (acao recomendada)</h3>
      <table cellpadding="6" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;font-size:12px">
        <tr style="background:rgba(255,255,255,.04)"><th align="left" style="padding:8px">Provider</th><th align="left" style="padding:8px">Status</th><th align="left" style="padding:8px">Erro</th></tr>
        ${alertas.map(linhaAlerta).join('')}
      </table>

      <h3 style="color:#7d92b8;font-size:14px;margin:24px 0 8px">Resultado deste run</h3>
      <table cellpadding="6" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;font-size:12px">
        <tr style="background:rgba(255,255,255,.04)"><th align="left" style="padding:8px">Provider</th><th align="left" style="padding:8px">Status</th><th align="left" style="padding:8px">Tempo</th><th align="left" style="padding:8px">Detalhe</th></tr>
        ${results.map(linhaProvider).join('')}
      </table>

      <div style="margin-top:24px;padding:14px;background:rgba(0,170,255,.08);border:1px solid rgba(0,170,255,.3);border-radius:10px;font-size:12px;color:#a5d4ff;line-height:1.5">
        <strong>Investigar:</strong> Cobalt? Railway yt-dlp? RapidAPI subscription? Veja docs/blue-pendencias.md secao baixaBlue.
      </div>
    </div></body></html>`;
}

function escHtml(s) {
  return String(s || '').replace(/[<>"&]/g, c => ({ '<': '&lt;', '>': '&gt;', '"': '&quot;', '&': '&amp;' }[c]));
}
