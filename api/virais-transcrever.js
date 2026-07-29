// api/virais-transcrever.js — Transcrição do acervo em BACKGROUND (2026-07-29)
// =============================================================================
// POR QUE ISTO EXISTE
//
// O Blublu confirma "vídeo onde SE FALA de X" lendo a transcrição. Só que ele
// transcrevia na hora da pergunta, com teto de 10 vídeos e orçamento de 20
// segundos, contra ~100 candidatos. Resultado medido nos logs: só 6% das
// entregas eram confirmadas por fala — o recurso estava prometido e não
// entregue, e caía em match de título.
//
// O acervo é finito e cresce devagar. Transcrevendo continuamente por fora, a
// confirmação por fala vira instantânea e REAL na hora da conversa: o chat só
// consulta o cache que já existe.
//
// Só LÊ do YouTube via Railway (/yt-subs) e grava em virais_transcricoes.
// Não mexe em vídeo, não apaga nada, e é idempotente: rodar duas vezes seguidas
// não refaz o que já está pronto.

const LOTE_PADRAO = 60;      // vídeos por rodada
const PARALELAS = 4;         // mesma concorrência que o chat já usava no Railway
const TIMEOUT_MS = 12000;    // por vídeo
const ORCAMENTO_MS = 240000; // teto da rodada (Vercel corta em 300s)

module.exports = async function handler(req, res) {
  const SU = process.env.SUPABASE_URL;
  const SK = process.env.SUPABASE_SERVICE_KEY;
  const RW = (process.env.RAILWAY_FFMPEG_URL || '').replace(/\/$/, '');
  const ADMIN = process.env.ADMIN_SECRET;

  const segredo = req.query?.admin_secret || req.body?.admin_secret;
  if (!ADMIN || segredo !== ADMIN) return res.status(403).json({ error: 'proibido' });
  if (!SU || !SK) return res.status(500).json({ error: 'config' });
  if (!RW) return res.status(200).json({ ok: false, motivo: 'RAILWAY_FFMPEG_URL ausente' });

  const H = { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' };
  const t0 = Date.now();
  const lote = Math.min(200, parseInt(req.query?.lote, 10) || LOTE_PADRAO);

  try {
    // Quem já tem transcrição (ou já foi marcado como sem legenda) sai da fila.
    // Busco os ids conhecidos e excluo — mais barato que um NOT EXISTS por linha.
    const jaR = await fetch(`${SU}/rest/v1/virais_transcricoes?select=youtube_id&limit=20000`, { headers: H });
    const ja = new Set(jaR.ok ? (await jaR.json()).map((r) => r.youtube_id) : []);

    // Prioridade: mais views primeiro — é o que o Blublu tende a devolver, então
    // é onde a transcrição rende mais rápido na experiência de quem pergunta.
    const candR = await fetch(`${SU}/rest/v1/virais_banco?select=youtube_id,views&order=views.desc&limit=3000`, { headers: H });
    if (!candR.ok) return res.status(200).json({ ok: false, motivo: 'falha ao ler acervo', status: candR.status });
    const fila = (await candR.json()).map((v) => v.youtube_id).filter((id) => id && !ja.has(id)).slice(0, lote);

    if (!fila.length) {
      return res.status(200).json({ ok: true, transcritos: 0, sem_legenda: 0, falhas: 0, restam: 0, nota: 'acervo em dia' });
    }

    let transcritos = 0, semLegenda = 0, falhas = 0;
    const pendentes = [...fila];

    await Promise.all(Array.from({ length: PARALELAS }, async () => {
      while (pendentes.length && Date.now() - t0 < ORCAMENTO_MS) {
        const id = pendentes.shift();
        try {
          const r = await fetch(`${RW}/yt-subs?v=${encodeURIComponent(id)}&seg=1`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
          const row = { youtube_id: id, fonte: 'railway' };
          if (r.ok) {
            const d = await r.json();
            row.transcript = d.content || '';
            row.segments = d.segments || null;
            row.lang = d.lang || null;
            row.sem_legenda = !d.content;
            if (d.content) transcritos++; else semLegenda++;
          } else {
            // Sem legenda disponível é RESPOSTA, não erro: grava pra não ficar
            // tentando o mesmo vídeo em toda rodada, pra sempre.
            row.sem_legenda = true;
            semLegenda++;
          }
          await fetch(`${SU}/rest/v1/virais_transcricoes`, {
            method: 'POST',
            headers: { ...H, Prefer: 'resolution=merge-duplicates,return=minimal' },
            body: JSON.stringify(row),
          });
        } catch (e) {
          // Falha de rede/timeout NÃO vira registro: o vídeo volta pra fila na
          // próxima rodada (senão um blip do Railway condenaria o vídeo).
          falhas++;
        }
      }
    }));

    return res.status(200).json({
      ok: true,
      transcritos, sem_legenda: semLegenda, falhas,
      processados: fila.length - pendentes.length,
      restam_no_lote: pendentes.length,
      ja_no_cache: ja.size,
      duracao_ms: Date.now() - t0,
    });
  } catch (e) {
    console.error('[virais-transcrever]', e.message);
    return res.status(500).json({ error: e.message.slice(0, 200) });
  }
};
