// api/blue-reengajar.js — Push que traz o usuário de volta pro app.
//
// POR QUE EXISTE: o app tinha ZERO reengajamento por push. O único cron do
// gênero (reactivation-emails) fala de "roteiros e Shorts" — o produto do
// SITE. Quem baixou o app recebia e-mail de um produto que nunca tocou.
// Medição de 03/08: 90 cadastros em 30 dias viraram 26 ativos em 7 dias.
//
// REGRA DE OURO DESTE ARQUIVO: **toda notificação é VERDADE verificável**.
// Nada de "alguém curtiu seu vídeo" quando ninguém curtiu. Curiosidade se
// constrói com fato interessante, não com isca falsa — isca falsa desinstala
// o app na segunda vez.
//
// Prioridade da mensagem (a primeira que tiver dado real vence):
//   1. O vídeo DELE rendeu       → o gancho mais forte que existe
//   2. Ganhou seguidores          → prova social
//   3. Alguém interagiu           → curtida/comentário acumulado
//   4. O feed andou               → quantos vídeos novos desde que sumiu
//
// PROTEÇÕES
//   - só quem tem token de push registrado (user_push_tokens)
//   - no máximo 1 push de reengajamento a cada 7 dias por pessoa
//   - janelas: 3, 7, 14 e 30 dias de inatividade (fora disso não incomoda)
//   - quem está ativo nas últimas 72h NUNCA recebe
//   - depois de 45 dias parado, para de tentar (respeita quem foi embora)
//   - `?dry=1` simula sem enviar nada (usar sempre antes de soltar)

const JANELAS = [3, 7, 14, 30];
const CAP_DIAS = 7;      // silêncio mínimo entre dois reengajamentos
const DESISTIR_DIAS = 45;

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const SU = process.env.SUPABASE_URL;
  const SK = process.env.SUPABASE_SERVICE_KEY;
  if (!SU || !SK) return res.status(500).json({ error: 'Config missing' });
  const h = { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' };
  const dry = req.query?.dry === '1';
  const agora = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  const g = async (p) => { const r = await fetch(`${SU}/rest/v1/${p}`, { headers: h }); return r.ok ? r.json() : []; };

  try {
    // 1) quem PODE receber: tem aparelho registrado
    const tokens = await g('user_push_tokens?select=user_id&limit=5000');
    const alvos = [...new Set(tokens.map((t) => t.user_id).filter(Boolean))];
    if (!alvos.length) return res.status(200).json({ ok: true, motivo: 'ninguem com push registrado', enviados: 0 });

    // 2) última atividade de cada um
    const perfis = await g(`blue_profiles?user_id=in.(${alvos.join(',')})&select=user_id,username,display_name,status_updated_at&limit=5000`);

    // 3) quem já recebeu reengajamento nos últimos CAP_DIAS
    const recentes = await g(`blue_notificacoes?tipo=eq.reengajamento&created_at=gte.${iso(agora - CAP_DIAS * 864e5)}&select=user_id&limit=5000`);
    const emSilencio = new Set(recentes.map((n) => n.user_id));

    // 4) quantos vídeos entraram nos últimos 30d (usado no fallback)
    const novos30 = await g(`blue_videos?status=eq.active&created_at=gte.${iso(agora - 30 * 864e5)}&select=id&limit=1000`);

    const fila = [];
    for (const p of perfis) {
      if (emSilencio.has(p.user_id)) continue;
      const ultima = p.status_updated_at ? new Date(p.status_updated_at).getTime() : 0;
      if (!ultima) continue;
      const diasFora = Math.floor((agora - ultima) / 864e5);
      if (diasFora < 3 || diasFora > DESISTIR_DIAS) continue;
      // só nas janelas escolhidas (evita mandar todo santo dia)
      if (!JANELAS.some((j) => diasFora === j || (j === 30 && diasFora > 30 && diasFora % 15 === 0))) continue;
      fila.push({ ...p, diasFora, ultima });
    }
    if (!fila.length) return res.status(200).json({ ok: true, candidatos: 0, enviados: 0, dry });

    // ── monta a mensagem de cada um com DADO REAL ────────────────────────
    const montar = async (u) => {
      const desde = iso(u.ultima);

      // (1) o vídeo dele rendeu?
      const meus = await g(`blue_videos?user_id=eq.${u.user_id}&status=eq.active&select=id,title,views,likes&order=views.desc&limit=3`);
      const campeao = meus.find((v) => (v.views || 0) >= 10);
      if (campeao) {
        const t = String(campeao.title || '').trim().slice(0, 40);
        return {
          title: `👀 Seu vídeo já tem ${campeao.views} visualizações`,
          body: t ? `"${t}" continuou rodando enquanto você esteve fora.` : 'Ele continuou rodando enquanto você esteve fora.',
          data: { tipo: 'reengajamento', motivo: 'meu_video', video_id: campeao.id, url: '/blue' },
        };
      }

      // (2) ganhou seguidores desde que sumiu?
      const segs = await g(`blue_follows?following_id=eq.${u.user_id}&created_at=gte.${desde}&select=follower_id&limit=50`);
      if (segs.length > 0) {
        return {
          title: segs.length === 1 ? '✨ Você tem 1 seguidor novo' : `✨ ${segs.length} pessoas começaram a te seguir`,
          body: 'Vem ver quem chegou no seu perfil.',
          data: { tipo: 'reengajamento', motivo: 'seguidores', url: '/blue' },
        };
      }

      // (3) alguma interação parada esperando?
      const notifs = await g(`blue_notificacoes?user_id=eq.${u.user_id}&lida=eq.false&tipo=neq.reengajamento&select=id&limit=20`);
      if (notifs.length > 0) {
        return {
          title: notifs.length === 1 ? '🔔 Você tem 1 novidade não vista' : `🔔 ${notifs.length} novidades te esperando`,
          body: 'Alguém mexeu com o seu conteúdo. Dá uma olhada.',
          data: { tipo: 'reengajamento', motivo: 'notificacoes', url: '/blue' },
        };
      }

      // (4) fallback: o feed andou (sempre verdadeiro, nunca inventa número)
      const desdeSaiu = novos30.length;
      if (desdeSaiu >= 3) {
        return {
          title: `🎬 ${desdeSaiu} vídeos novos desde que você saiu`,
          body: u.diasFora >= 14 ? 'Faz um tempinho. O feed mudou bastante.' : 'Seu feed tá diferente. Vem ver.',
          data: { tipo: 'reengajamento', motivo: 'feed', url: '/blue' },
        };
      }
      return null; // sem nada honesto pra dizer = não incomoda
    };

    let enviados = 0;
    const amostra = [];
    const { sendPushToUser } = require('./_helpers/push.js');
    for (const u of fila) {
      const msg = await montar(u);
      if (!msg) continue;
      if (amostra.length < 8) amostra.push({ user: u.username || u.user_id.slice(0, 8), diasFora: u.diasFora, title: msg.title, motivo: msg.data.motivo });
      if (dry) { enviados++; continue; }

      // registra ANTES de enviar: se o push falhar, ainda assim respeita o
      // cap de 7 dias — melhor perder um envio que bombardear alguém
      await fetch(`${SU}/rest/v1/blue_notificacoes`, {
        method: 'POST', headers: { ...h, Prefer: 'return=minimal' },
        body: JSON.stringify({
          user_id: u.user_id, tipo: 'reengajamento',
          titulo: msg.title, mensagem: msg.body, dados: msg.data,
        }),
      }).catch(() => null);
      await sendPushToUser(u.user_id, { title: msg.title, body: msg.body, data: msg.data }).catch(() => null);
      enviados++;
    }

    return res.status(200).json({
      ok: true, dry, com_push: alvos.length, candidatos: fila.length,
      em_silencio: emSilencio.size, enviados, amostra,
    });
  } catch (e) {
    return res.status(200).json({ ok: false, error: e.message });
  }
};
