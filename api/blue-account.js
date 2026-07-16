// api/blue-account.js — Exclusão de conta (exigência Google Play).
// POST { action:'delete', token }
//   - Assinatura paga ATIVA → 409 (cancele antes; jamais mexemos em dinheiro
//     sem autorização explícita — a exclusão não cancela cobrança sozinha).
//   - Livre: apaga/anonimiza dados do Blue + Comunidade e deleta o usuário
//     do Supabase Auth (conta única site+app — o aviso no app deixa claro).
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (req.body?.action !== 'delete') return res.status(400).json({ error: 'Ação inválida.' });

  const SU = process.env.SUPABASE_URL;
  const SK = process.env.SUPABASE_SERVICE_KEY;
  const AK = process.env.SUPABASE_ANON_KEY || SK;
  const H = { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' };

  const token = req.body?.token;
  if (!token) return res.status(401).json({ error: 'Login necessário.' });

  let userId = null, email = null;
  try {
    const ur = await fetch(`${SU}/auth/v1/user`, { headers: { apikey: AK, Authorization: 'Bearer ' + token } });
    if (ur.ok) { const u = await ur.json(); userId = u.id; email = u.email; }
  } catch (e) {}
  if (!userId) return res.status(401).json({ error: 'Sessão inválida. Faça login de novo.' });

  try {
    // Assinatura paga ativa bloqueia (não cancelamos cobrança automaticamente)
    const sr = await fetch(`${SU}/rest/v1/subscribers?email=eq.${encodeURIComponent(email)}&select=plan,plan_expires_at,is_manual,stripe_subscription_id`, { headers: H });
    const sub = sr.ok ? (await sr.json())[0] : null;
    const paga = sub && sub.plan && sub.plan !== 'free' &&
      (sub.is_manual || !sub.plan_expires_at || new Date(sub.plan_expires_at) > new Date());
    if (paga) {
      return res.status(409).json({
        error: 'Você tem uma assinatura ativa. Cancele a assinatura primeiro (no site, em Perfil → Gerenciar assinatura) e depois exclua a conta.',
        active_subscription: true,
      });
    }

    console.log('[blue-account] delete solicitado:', userId, (email || '').replace(/(.{3}).*(@.*)/, '$1***$2'));

    // Conteúdo do Blue: vídeos somem do feed (soft), rastros pessoais apagam
    const del = (path) => fetch(`${SU}/rest/v1/${path}`, { method: 'DELETE', headers: { ...H, Prefer: 'return=minimal' } }).catch(() => {});
    await Promise.allSettled([
      fetch(`${SU}/rest/v1/blue_videos?user_id=eq.${userId}`, { method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify({ status: 'deleted' }) }),
      del(`blue_comments?user_id=eq.${userId}`),
      del(`blue_profiles?user_id=eq.${userId}`),
      del(`blue_stickers?user_id=eq.${userId}`),
      del(`blue_bloqueios?user_id=eq.${userId}`),
      del(`blue_follows?follower_id=eq.${userId}`),
      del(`blue_follows?following_id=eq.${userId}`),
      // Comunidade do site (mesma conta): perfil sai, posts somem (soft)
      fetch(`${SU}/rest/v1/community_posts?user_id=eq.${userId}`, { method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify({ deleted: true }) }),
      del(`community_profiles?user_id=eq.${userId}`),
      del(`community_comment_likes?user_id=eq.${userId}`),
      del(`community_likes?user_id=eq.${userId}`),
    ]);

    // Subscriber free: apaga o registro (dado pessoal)
    if (sub) await fetch(`${SU}/rest/v1/subscribers?email=eq.${encodeURIComponent(email)}`, { method: 'DELETE', headers: { ...H, Prefer: 'return=minimal' } }).catch(() => {});

    // Por fim, o usuário do Auth — login deixa de existir
    const ar = await fetch(`${SU}/auth/v1/admin/users/${userId}`, { method: 'DELETE', headers: { apikey: SK, Authorization: 'Bearer ' + SK } });
    if (!ar.ok) {
      const t = await ar.text().catch(() => '');
      console.error('[blue-account] auth delete falhou:', ar.status, t.slice(0, 150));
      return res.status(500).json({ error: 'Não foi possível concluir a exclusão. Tente novamente ou fale com o suporte.' });
    }

    return res.status(200).json({ ok: true, message: 'Conta excluída.' });
  } catch (e) {
    console.error('[blue-account]', e.message);
    return res.status(500).json({ error: 'Erro interno. Tente novamente.' });
  }
};
