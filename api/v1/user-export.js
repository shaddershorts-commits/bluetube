// api/v1/user-export.js — User data export endpoint (Fix 3 - Gap 1)
// LGPD Art. 18 (portabilidade) + GDPR Art. 20 (data portability).
//
// Retorna TODOS os dados do user logado em JSON estruturado.
// Auth via Bearer token. Rate-limit 1/hora por user (blue_rate_limits).
// User_id NUNCA vem do body — sempre do token. Imune a IDOR por construcao.
//
// 10 secoes do payload: account, content, interactions, communications, groups,
// monetization, personalization, moderation, affiliate, email_and_push.
// Limites em feed_historico (5k) e feed_seen (10k) — declarados no metadata.
//
// Auditoria: console.log no Vercel (retencao 30 dias). Migrar pra tabela
// dedicada quando volume > 50/mes (ver docs/blue-pendencias.md).
//
// Fix 5 (Gap 3): chave_pix em affiliates + affiliate_saques esta encrypted
// at-rest. Decrypt aqui antes de retornar — LGPD garante acesso legivel
// aos proprios dados do dono.

const { decryptSafe } = require('../_helpers/crypto');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const startedAt = Date.now();
  const SU = process.env.SUPABASE_URL;
  const SK = process.env.SUPABASE_SERVICE_KEY;
  const AK = process.env.SUPABASE_ANON_KEY || SK;
  if (!SU || !SK) return res.status(500).json({ error: 'Config missing' });

  // Token: header Authorization OU body.token (compat). user_id NUNCA do body.
  const authHeader = req.headers.authorization || '';
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const token = bearer || (req.body && req.body.token);
  if (!token) return res.status(401).json({ error: 'Token obrigatorio' });

  const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
  const h = { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' };

  // ── AUTORIZACAO ──────────────────────────────────────────────────────────
  let userId, email;
  try {
    const ur = await fetch(`${SU}/auth/v1/user`, { headers: { apikey: AK, Authorization: 'Bearer ' + token } });
    if (!ur.ok) {
      console.log(`[user-export] auth_failed ip=${ip} status=${ur.status}`);
      return res.status(401).json({ error: 'Token invalido' });
    }
    const u = await ur.json();
    userId = u.id;
    email = u.email;
    if (!userId || !email) return res.status(400).json({ error: 'User nao encontrado' });
  } catch (e) {
    console.log(`[user-export] auth_error ip=${ip} msg=${e.message}`);
    return res.status(500).json({ error: 'Erro na verificacao do token' });
  }

  // ── RATE LIMIT (1/hora por user via blue_rate_limits) ────────────────────
  try {
    const rlId = `user-export:${userId}`;
    const rlEndpoint = 'user-export';
    const windowMin = 60;
    const max = 1;
    const janela = new Date(Date.now() - windowMin * 60000).toISOString();
    const rr = await fetch(
      `${SU}/rest/v1/blue_rate_limits?identificador=eq.${encodeURIComponent(rlId)}&endpoint=eq.${rlEndpoint}&select=requests,janela_inicio`,
      { headers: h }
    );
    const rows = rr.ok ? await rr.json() : [];
    const row = rows[0];
    if (row && new Date(row.janela_inicio) >= new Date(janela)) {
      if (row.requests >= max) {
        const retryAfter = Math.max(60, Math.ceil((new Date(row.janela_inicio).getTime() + windowMin * 60000 - Date.now()) / 1000));
        res.setHeader('Retry-After', String(retryAfter));
        console.log(`[user-export] rate_limited user_id=${userId} ip=${ip} retry_after=${retryAfter}`);
        return res.status(429).json({ error: 'Rate limit: 1 export por hora. Aguarde.', retry_after: retryAfter });
      }
      // dentro da janela mas nao atingiu o max — incrementa
      fetch(`${SU}/rest/v1/blue_rate_limits?identificador=eq.${encodeURIComponent(rlId)}&endpoint=eq.${rlEndpoint}`, {
        method: 'PATCH',
        headers: { ...h, Prefer: 'return=minimal' },
        body: JSON.stringify({ requests: row.requests + 1 }),
      }).catch(() => {});
    } else {
      // janela expirada ou inexistente — cria/zera (upsert)
      fetch(`${SU}/rest/v1/blue_rate_limits`, {
        method: 'POST',
        headers: { ...h, Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({ identificador: rlId, endpoint: rlEndpoint, requests: 1, janela_inicio: new Date().toISOString() }),
      }).catch(() => {});
    }
  } catch (e) {
    // fail-open: rate-limit infra fora nao deve bloquear export legitimo
  }

  // ── HELPERS ──────────────────────────────────────────────────────────────
  // q(): retorna [] em qualquer falha (uma tabela ausente nao quebra o export inteiro)
  const q = async (path) => {
    try {
      const r = await fetch(`${SU}/rest/v1/${path}`, { headers: h, signal: AbortSignal.timeout(8000) });
      if (!r.ok) return [];
      return await r.json();
    } catch (e) { return []; }
  };
  const qOne = async (path) => {
    const arr = await q(path);
    return Array.isArray(arr) && arr.length ? arr[0] : null;
  };

  const uidEnc = encodeURIComponent(userId);
  const emailEnc = encodeURIComponent(email);

  try {
    // SECAO A — Conta & Perfil
    const [subscriber, profile] = await Promise.all([
      qOne(`subscribers?email=eq.${emailEnc}&select=*&limit=1`),
      qOne(`blue_profiles?user_id=eq.${uidEnc}&select=*&limit=1`),
    ]);

    // SECAO B — Conteudo criado
    const [videos, comments, stories, videoAnalytics, customVoices] = await Promise.all([
      q(`blue_videos?user_id=eq.${uidEnc}&select=*&order=created_at.desc&limit=10000`),
      q(`blue_comments?user_id=eq.${uidEnc}&select=*&order=created_at.desc&limit=10000`),
      q(`blue_stories?user_id=eq.${uidEnc}&select=*&order=created_at.desc&limit=10000`),
      q(`blue_video_analytics?user_id=eq.${uidEnc}&select=*&order=created_at.desc&limit=10000`),
      q(`blue_custom_voices?user_id=eq.${uidEnc}&select=*&limit=1000`),
    ]);

    // SECAO C — Interacoes
    const [likes, saved, interactions, following, followers, storyReacoes, storyReplies, feedHistorico, feedSeen] = await Promise.all([
      q(`blue_likes?user_id=eq.${uidEnc}&select=*&order=created_at.desc&limit=10000`),
      q(`blue_salvos?user_id=eq.${uidEnc}&select=*&order=created_at.desc&limit=10000`),
      q(`blue_interactions?user_id=eq.${uidEnc}&select=*&order=created_at.desc&limit=10000`),
      q(`blue_follows?follower_id=eq.${uidEnc}&select=*&limit=10000`),
      q(`blue_follows?following_id=eq.${uidEnc}&select=*&limit=10000`),
      q(`blue_story_reacoes?user_id=eq.${uidEnc}&select=*&limit=10000`),
      q(`blue_story_replies?user_id=eq.${uidEnc}&select=*&limit=10000`),
      q(`blue_feed_historico?user_id=eq.${uidEnc}&select=*&order=created_at.desc&limit=5000`),
      q(`blue_feed_seen?user_id=eq.${uidEnc}&select=*&order=created_at.desc&limit=10000`),
    ]);

    // SECAO D — Comunicacoes
    const [messagesSent, messagesReceived, conversations, notificationsEN, notificationsPT] = await Promise.all([
      q(`blue_messages?sender_id=eq.${uidEnc}&select=*&order=created_at.desc&limit=10000`),
      q(`blue_messages?receiver_id=eq.${uidEnc}&select=*&order=created_at.desc&limit=10000`),
      q(`blue_conversations?or=(user1_id.eq.${uidEnc},user2_id.eq.${uidEnc})&select=*&order=last_message_at.desc&limit=2000`),
      q(`blue_notifications?user_id=eq.${uidEnc}&select=*&order=created_at.desc&limit=5000`),
      q(`blue_notificacoes?user_id=eq.${uidEnc}&select=*&order=created_at.desc&limit=5000`),
    ]);

    // SECAO E — Grupos
    const [gruposCriados, gruposMembro, grupoMensagens] = await Promise.all([
      q(`blue_grupos?created_by=eq.${uidEnc}&select=*&limit=1000`),
      q(`blue_grupo_membros?user_id=eq.${uidEnc}&select=*&limit=1000`),
      q(`blue_grupo_mensagens?user_id=eq.${uidEnc}&select=*&order=created_at.desc&limit=10000`),
    ]);

    // SECAO F — Monetizacao
    const [bluecoins, bluecoinsTransacoes, canalPlanosCriados, canalAssinaturas, creatorAccount, creatorSaques, gorjetasEnviadas, gorjetasRecebidas, pedidos] = await Promise.all([
      qOne(`blue_bluecoins?user_id=eq.${uidEnc}&select=*&limit=1`),
      q(`blue_bluecoins_transacoes?user_id=eq.${uidEnc}&select=*&order=created_at.desc&limit=10000`),
      q(`blue_canal_planos?creator_id=eq.${uidEnc}&select=*&limit=100`),
      q(`blue_canal_assinaturas?assinante_id=eq.${uidEnc}&select=*&limit=1000`),
      qOne(`blue_creator_accounts?user_id=eq.${uidEnc}&select=*&limit=1`),
      q(`blue_creator_saques?user_id=eq.${uidEnc}&select=*&order=created_at.desc&limit=1000`),
      q(`blue_gorjetas?sender_id=eq.${uidEnc}&select=*&order=created_at.desc&limit=5000`),
      q(`blue_gorjetas?receiver_id=eq.${uidEnc}&select=*&order=created_at.desc&limit=5000`),
      q(`blue_pedidos?user_id=eq.${uidEnc}&select=*&order=created_at.desc&limit=5000`),
    ]);

    // SECAO G — ML & Personalizacao
    const [interests, profileEmbeddingRow, mlFeatures] = await Promise.all([
      q(`blue_user_interests?user_id=eq.${uidEnc}&select=*&limit=200`),
      qOne(`blue_user_profile_embeddings?user_id=eq.${uidEnc}&select=baseado_em,updated_at,created_at&limit=1`),
      qOne(`blue_ml_user_features?user_id=eq.${uidEnc}&select=*&limit=1`),
    ]);
    // Embedding: so metadata. Vetor 1536-dim omitido por brevidade (declarado no metadata).
    const profileEmbeddingSummary = profileEmbeddingRow
      ? { ...profileEmbeddingRow, _note: 'vetor 1536-dim omitido — solicite via suporte se necessario' }
      : null;

    // SECAO H — Moderacao visivel ao user
    const [avisos, banimentos, blocksByMe, blocksOnMe, reports, verifications] = await Promise.all([
      q(`blue_avisos?user_id=eq.${uidEnc}&select=*&order=created_at.desc&limit=1000`),
      q(`blue_banimentos?user_id=eq.${uidEnc}&select=*&limit=100`),
      q(`blue_bloqueios?blocker_id=eq.${uidEnc}&select=*&limit=1000`),
      q(`blue_bloqueios?blocked_id=eq.${uidEnc}&select=*&limit=1000`),
      q(`blue_reports?reporter_id=eq.${uidEnc}&select=*&order=created_at.desc&limit=1000`),
      q(`blue_verificacao_solicitacoes?user_id=eq.${uidEnc}&select=*&limit=100`),
    ]);

    // SECAO I — Programa de Afiliados (sequencial: precisa do affiliate.id)
    let affiliateData = { profile: null, clicks: [], commissions: [], conversions: [], saques: [], milestones: [], nivel_historico: [], attribution_log: [] };
    const affiliate = await qOne(`affiliates?user_id=eq.${uidEnc}&select=*&limit=1`);
    if (affiliate) {
      const aidEnc = encodeURIComponent(affiliate.id);
      const [clicks, commissions, conversions, saques, milestones, nivelHist, attribLog] = await Promise.all([
        q(`affiliate_clicks?affiliate_id=eq.${aidEnc}&select=*&order=landed_at.desc&limit=10000`),
        q(`affiliate_commissions?affiliate_id=eq.${aidEnc}&select=*&order=created_at.desc&limit=10000`),
        q(`affiliate_conversions?affiliate_id=eq.${aidEnc}&select=*&order=created_at.desc&limit=10000`),
        q(`affiliate_saques?affiliate_id=eq.${aidEnc}&select=*&order=created_at.desc&limit=1000`),
        q(`affiliate_milestones_vistos?affiliate_id=eq.${aidEnc}&select=*&limit=1000`),
        q(`affiliate_nivel_historico?affiliate_id=eq.${aidEnc}&select=*&order=created_at.desc&limit=1000`),
        q(`affiliate_attribution_log?affiliate_id=eq.${aidEnc}&select=*&limit=10000`),
      ]);
      // Fix 5 (Gap 3): chave_pix vem encrypted do DB. Decrypt antes de retornar
      // pro dono — LGPD garante acesso legivel aos proprios dados.
      const profileDec = { ...affiliate };
      if (profileDec.chave_pix) profileDec.chave_pix = decryptSafe(profileDec.chave_pix);
      const saquesDec = saques.map(s => s.chave_pix ? { ...s, chave_pix: decryptSafe(s.chave_pix) } : s);
      affiliateData = { profile: profileDec, clicks, commissions, conversions, saques: saquesDec, milestones, nivel_historico: nivelHist, attribution_log: attribLog };
    }

    // SECAO J — Email & Push
    const [marketing, reactivationLog, feedback, pushTokens] = await Promise.all([
      qOne(`email_marketing?email=eq.${emailEnc}&select=*&limit=1`),
      q(`reactivation_emails?email=eq.${emailEnc}&select=*&limit=1000`),
      q(`user_feedback?email=eq.${emailEnc}&select=*&order=created_at.desc&limit=1000`),
      q(`user_push_tokens?user_id=eq.${uidEnc}&select=*&limit=100`),
    ]);

    // ── PAYLOAD ──────────────────────────────────────────────────────────────
    const exportedAt = new Date().toISOString();
    const yyyymmdd = exportedAt.slice(0, 10).replace(/-/g, '');
    const payload = {
      metadata: {
        format_version: '1.0',
        api_version: 'v1',
        api_endpoint: '/api/v1/user-export',
        exported_at: exportedAt,
        user_id: userId,
        email,
        lgpd_art: '18 (portabilidade)',
        gdpr_art: '20 (data portability)',
        support_email: 'bluetubeoficial@gmail.com',
        limits_applied: {
          blue_feed_historico: 'ultimos 5000 registros - solicite arquivo completo via suporte se necessario',
          blue_feed_seen: 'ultimos 10000 registros - solicite arquivo completo via suporte se necessario',
          blue_user_profile_embeddings: 'vetor 1536-dim omitido (apenas metadata) - solicite via suporte',
        },
      },
      account: {
        user: { id: userId, email, exported_via: 'self-service' },
        subscriber,
        profile,
      },
      content: {
        videos, comments, stories,
        video_analytics: videoAnalytics,
        custom_voices: customVoices,
      },
      interactions: {
        likes, saved, interactions,
        following, followers,
        story_reactions: storyReacoes,
        story_replies: storyReplies,
        feed_historico: feedHistorico,
        feed_seen: feedSeen,
      },
      communications: {
        messages_sent: messagesSent,
        messages_received: messagesReceived,
        conversations,
        notifications_en: notificationsEN,
        notifications_pt: notificationsPT,
      },
      groups: {
        created: gruposCriados,
        memberships: gruposMembro,
        messages: grupoMensagens,
      },
      monetization: {
        bluecoins,
        bluecoins_transacoes: bluecoinsTransacoes,
        canal_planos_criados: canalPlanosCriados,
        canal_assinaturas: canalAssinaturas,
        creator_account: creatorAccount,
        creator_saques: creatorSaques,
        tips_sent: gorjetasEnviadas,
        tips_received: gorjetasRecebidas,
        pedidos,
      },
      personalization: {
        interests,
        profile_embedding_summary: profileEmbeddingSummary,
        ml_features: mlFeatures,
      },
      moderation: {
        warnings: avisos,
        bans: banimentos,
        blocks_by_me: blocksByMe,
        blocks_on_me: blocksOnMe,
        reports_filed: reports,
        verifications,
      },
      affiliate: affiliateData,
      email_and_push: {
        marketing,
        reactivation_log: reactivationLog,
        feedback,
        push_tokens: pushTokens,
      },
    };

    const json = JSON.stringify(payload);
    const bytes = Buffer.byteLength(json, 'utf8');
    const ms = Date.now() - startedAt;

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="bluetube-export-${userId}-${yyyymmdd}.json"`);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    console.log(`[user-export] user_id=${userId} ip=${ip} status=200 bytes=${bytes} ms=${ms}`);
    return res.status(200).send(json);
  } catch (e) {
    const ms = Date.now() - startedAt;
    console.error(`[user-export] user_id=${userId} ip=${ip} status=500 ms=${ms} error=${e.message}`);
    return res.status(500).json({ error: 'Erro ao gerar export. Tente novamente.' });
  }
};
