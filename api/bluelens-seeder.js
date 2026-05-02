// api/bluelens-seeder.js
//
// Cron diário 4h UTC (1h BRT) que pega top virais detectados pelo
// virais-coletor e indexa fingerprint visual no DB. Cresce a base de
// comparação automaticamente — quanto mais cresce, mais matches o
// BlueLens detecta.
//
// Estratégia conservadora pra não estourar Railway:
//   - 30 vídeos por execução (1 a cada 10s = ~5min total)
//   - Limita a virais com >= 100k views (sinal de relevância)
//   - Pula vídeos já indexados (source_url UNIQUE)
//   - index_source = 'viral_seeder' (pra distinguir de user_analysis)
//
// Falhas individuais não param o lote — log + segue.

const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY;
const SITE_URL = process.env.SITE_URL || 'https://bluetubeviral.com';
const supaH = SUPA_KEY ? { apikey: SUPA_KEY, Authorization: 'Bearer ' + SUPA_KEY } : null;

const BATCH_SIZE = 30;
const MIN_VIEWS = 100000;

module.exports = async function handler(req, res) {
  if (!supaH) return res.status(500).json({ error: 'config_missing' });
  const startTs = Date.now();
  const log = { processed: 0, indexed: 0, skipped_existing: 0, failed: 0, errors: [] };

  try {
    // 1. Pega top virais não-indexados
    const virR = await fetch(
      `${SUPA_URL}/rest/v1/virais_banco?views=gte.${MIN_VIEWS}&select=youtube_id,url,views&order=views.desc&limit=${BATCH_SIZE}`,
      { headers: supaH }
    );
    const virais = virR.ok ? await virR.json() : [];

    // 2. Filtra os que já estão indexados (evita reprocessar)
    if (virais.length > 0) {
      const ids = virais.map(v => v.youtube_id).filter(Boolean);
      const indexedR = await fetch(
        `${SUPA_URL}/rest/v1/video_visual_fingerprints?video_id_external=in.(${ids.map(encodeURIComponent).join(',')})&select=video_id_external`,
        { headers: supaH }
      );
      const indexedSet = new Set((indexedR.ok ? await indexedR.json() : []).map(x => x.video_id_external));
      const toIndex = virais.filter(v => !indexedSet.has(v.youtube_id));
      log.skipped_existing = virais.length - toIndex.length;

      // 3. Pra cada video, chama bluelens-fingerprint internamente (que extrai
      //    via Railway + salva no DB). Espaca 8s entre cada pra nao sobrecarregar.
      for (const v of toIndex) {
        log.processed++;
        try {
          const fpR = await fetch(`${SITE_URL}/api/bluelens-fingerprint?url=${encodeURIComponent(v.url)}`, {
            signal: AbortSignal.timeout(150000),
          });
          if (!fpR.ok) throw new Error('HTTP ' + fpR.status);
          const fp = await fpR.json();
          if (!fp.ok) throw new Error(fp.error || 'falha desconhecida');
          log.indexed++;

          // Marca este video como vindo do seeder (vs user_analysis default)
          if (fp.fingerprint?.id) {
            fetch(`${SUPA_URL}/rest/v1/video_visual_fingerprints?id=eq.${fp.fingerprint.id}`, {
              method: 'PATCH',
              headers: { ...supaH, 'Content-Type': 'application/json' },
              body: JSON.stringify({ index_source: 'viral_seeder' }),
            }).catch(() => {});
          }
        } catch (e) {
          log.failed++;
          log.errors.push({ url: v.url, error: e.message.slice(0, 100) });
        }
        // Espaca 8s entre videos (rate limit defensivo)
        await new Promise(r => setTimeout(r, 8000));
      }
    }

    return res.status(200).json({
      ok: true,
      duration_ms: Date.now() - startTs,
      total_virais_lidos: virais.length,
      ...log,
    });
  } catch (e) {
    console.error('[bluelens-seeder]', e.message);
    return res.status(500).json({ error: e.message, ...log });
  }
};
