// api/community.js — Comunidade BlueTube (feed estilo X, exclusiva de pagantes)
// Abas: 'dicas' (só moderador posta) e 'comunidade' (todo pagante posta).
// Identidade: community_profiles (display_name único + avatar). Moderador
// (is_moderator) tem selo dourado e controle total: editar/apagar/fixar
// qualquer post/comentário e banir usuário. Mídia: upload direto ao Storage
// com JWT do próprio usuário (mesmo padrão do Blue — sem expor service key);
// vídeo passa pelo transcode do Railway (faststart + thumb).

const { checkBan } = require('./_helpers/checkBan');
const AM = require('./_helpers/amizade'); // regras puras das amizades (uma linha por par)

const BLOCKED_WORDS = ['porn','xxx','nude','nudes','onlyfans','xvideos','pornhub','hentai','gore','suicidio'];
const MIME = {
  image: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
  video: ['video/mp4', 'video/quicktime', 'video/webm'],
  audio: ['audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/ogg', 'audio/webm', 'audio/wav'],
};

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const SU = process.env.SUPABASE_URL;
  const SK = process.env.SUPABASE_SERVICE_KEY;
  const AK = process.env.SUPABASE_ANON_KEY || SK;
  if (!SU || !SK) return res.status(500).json({ error: 'Config missing' });

  const H = { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' };
  const q = req.query || {};
  const b = req.body || {};
  const action = q.action || b.action;
  const token = q.token || b.token;

  // ── AUTH: login + plano pago (moderador entra mesmo sem plano) ────────────
  let userId = null, userEmail = null, paying = false, planName = null;
  if (token) {
    try {
      const ur = await fetch(`${SU}/auth/v1/user`, { headers: { apikey: AK, Authorization: 'Bearer ' + token } });
      if (ur.ok) {
        const u = await ur.json(); userId = u.id; userEmail = u.email;
        const pr = await fetch(`${SU}/rest/v1/subscribers?email=eq.${encodeURIComponent(userEmail)}&select=plan,plan_expires_at,is_manual`, { headers: H });
        if (pr.ok) {
          const sub = (await pr.json())[0];
          // Comunidade é benefício dos planos Full e Master (o básico não tem)
          if (sub && ['full', 'master'].includes(sub.plan)) {
            const v = sub.is_manual || !sub.plan_expires_at || new Date(sub.plan_expires_at) > new Date();
            if (v) { paying = true; planName = sub.plan; }
          }
        }
      }
    } catch (e) {}
  }
  if (!userId) return res.status(401).json({ error: 'Login necessário.', login: true });

  // Perfil da comunidade — auto-provisionado com o USERNAME da conta (prefixo
  // do email, igual ao mostrado na home). Nome NÃO é editável; só a foto.
  let profile = null;
  try {
    const pf = await fetch(`${SU}/rest/v1/community_profiles?user_id=eq.${userId}&select=*`, { headers: H });
    if (pf.ok) profile = (await pf.json())[0] || null;
    if (!profile) {
      const base = (userEmail || 'user').split('@')[0].replace(/[^a-z0-9._-]/gi, '').slice(0, 20) || 'criador';
      for (const name of [base, base + Math.floor(10 + Math.random() * 90), base + '-' + userId.slice(0, 4)]) {
        const ins = await fetch(`${SU}/rest/v1/community_profiles`, {
          method: 'POST', headers: { ...H, Prefer: 'return=representation' },
          body: JSON.stringify({ user_id: userId, email: userEmail, display_name: name }),
        });
        if (ins.ok) { profile = (await ins.json())[0]; break; }
        if (ins.status !== 409) break; // 409 = nome em uso → tenta variação
      }
    }
  } catch (e) {}
  const isMod = !!profile?.is_moderator;
  if (!paying && !isMod) return res.status(403).json({ error: 'A Comunidade é exclusiva de assinantes.', upgrade: true });
  if (profile?.banned && !isMod) return res.status(403).json({ error: 'Você foi banido da Comunidade.', banned: true });

  const clean = (s, max) => String(s || '').replace(/<[^>]*>/g, '').trim().slice(0, max);
  const hasBlocked = (s) => { const t = ' ' + String(s).toLowerCase() + ' '; return BLOCKED_WORDS.some((w) => t.includes(w)); };
  const uuid = () => require('crypto').randomUUID();
  const nowIso = () => new Date().toISOString();
  // Mídia: UID como PRIMEIRA pasta (política de storage do bucket) — de quebra
  // amarra a mídia ao dono: só dá pra postar arquivo do próprio prefixo.
  const isMediaUrl = (u) => typeof u === 'string' && u.startsWith(`${SU}/storage/v1/object/public/blue-videos/${userId}/community/`) && !u.includes('..');

  // ── AMIZADES: acesso ao banco (as REGRAS ficam em _helpers/amizade.js) ─────
  const FCOLS = 'user_a,user_b,requested_by,status,strikes_a,strikes_b,cooldown_a,cooldown_b,removed_by,requested_at,responded_at,rejected_at,removed_at,created_at,updated_at';
  const meId = String(userId).toLowerCase();

  // Linhas do par entre EU e cada um dos uids. São DUAS queries porque eu tanto
  // posso ser o lado A quanto o B — um filtro só cobriria metade dos pares.
  const linhasComigo = async (uids) => {
    const lista = [...new Set((uids || []).map((u) => String(u || '').toLowerCase()))]
      .filter((u) => AM.ehUuid(u) && u !== meId);
    if (!lista.length) return {};
    const inList = `(${lista.join(',')})`;
    const [ra, rb] = await Promise.all([
      fetch(`${SU}/rest/v1/community_friendships?user_a=eq.${meId}&user_b=in.${inList}&select=${FCOLS}`, { headers: H }),
      fetch(`${SU}/rest/v1/community_friendships?user_b=eq.${meId}&user_a=in.${inList}&select=${FCOLS}`, { headers: H }),
    ]);
    const rows = [...(ra.ok ? await ra.json() : []), ...(rb.ok ? await rb.json() : [])];
    const map = {};
    for (const r of rows) { const o = AM.outroDoPar(r, meId); if (o) map[String(o).toLowerCase()] = r; }
    return map;
  };

  const linhaDoPar = async (alvoId) => {
    const par = AM.parCanonico(meId, alvoId);
    if (!par) return null;
    const r = await fetch(`${SU}/rest/v1/community_friendships?user_a=eq.${par.user_a}&user_b=eq.${par.user_b}&select=${FCOLS}`, { headers: H });
    return r.ok ? ((await r.json())[0] || null) : null;
  };

  // O alvo é identificado pelo display_name (que é UNIQUE) — assim a UI nunca
  // precisa receber o uuid de ninguém. author_id segue exclusivo do moderador.
  const acharPorNome = async (name) => {
    const n = String(name == null ? '' : name).trim().slice(0, 40);
    if (!n) return null;
    const r = await fetch(`${SU}/rest/v1/community_profiles?display_name=eq.${encodeURIComponent(n)}&select=user_id,display_name,avatar_url,is_moderator,plan,banned`, { headers: H });
    return r.ok ? ((await r.json())[0] || null) : null;
  };

  const perfisPorIds = async (ids) => {
    const lista = [...new Set((ids || []).map((u) => String(u || '').toLowerCase()))].filter(AM.ehUuid);
    if (!lista.length) return {};
    const r = await fetch(`${SU}/rest/v1/community_profiles?user_id=in.(${lista.join(',')})&select=user_id,display_name,avatar_url,is_moderator,plan`, { headers: H });
    const rows = r.ok ? await r.json() : [];
    return Object.fromEntries(rows.map((p) => [String(p.user_id).toLowerCase(), p]));
  };

  const pubPerfil = (p) => (p
    ? { name: p.display_name, avatar: p.avatar_url || null, mod: !!p.is_moderator, plan: p.plan || null }
    : { name: 'Usuário', avatar: null, mod: false, plan: null });

  // Notificação de amizade. AWAIT obrigatório: em serverless, promise não
  // aguardada antes do res é DESCARTADA (foi o bug dos 28 follows → 0 avisos).
  // Dedupe de 24h impede que cancelar/pedir em loop vire metralhadora de sino.
  const notificarAmizade = async (kind, paraId) => {
    try {
      const n = AM.notificacao(kind, { deId: meId, deNome: profile?.display_name, paraId: String(paraId).toLowerCase() });
      if (!n) return;
      const since = new Date(Date.now() - AM.NOTIF_JANELA_HORAS * 3600000).toISOString();
      let ultima = null;
      try {
        const rr = await fetch(`${SU}/rest/v1/blue_notificacoes?user_id=eq.${n.user_id}&tipo=eq.amizade&created_at=gt.${encodeURIComponent(since)}&dados->>from_user_id=eq.${meId}&dados->>kind=eq.${kind}&select=created_at&order=created_at.desc&limit=1`, { headers: H });
        if (rr.ok) ultima = (await rr.json())[0]?.created_at || null;
      } catch (e) {}
      if (!AM.deveNotificar(ultima)) return;
      await fetch(`${SU}/rest/v1/blue_notificacoes`, {
        method: 'POST', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify(n),
      }).catch(() => null);
      try {
        const { sendPushToUser } = require('./_helpers/push.js');
        await sendPushToUser(n.user_id, {
          title: n.titulo, body: n.mensagem,
          data: { tipo: 'amizade', kind, from_user_id: meId, url: AM.URL_AMIGOS },
        }).catch(() => null);
      } catch (e) {}
    } catch (e) { /* notificação nunca derruba a ação principal */ }
  };

  // Executa a decisão. O PATCH carrega `status=eq.<status lido>` como guarda de
  // corrida: se alguém mexeu no par no meio do caminho, 0 linhas são afetadas
  // e quem chamou relê e decide de novo em vez de sobrescrever às cegas.
  const aplicarDecisao = async (dec, par, statusLido) => {
    if (dec.acao === 'nenhuma') return { ok: true };
    if (dec.acao === 'criar') {
      const ins = await fetch(`${SU}/rest/v1/community_friendships`, {
        method: 'POST', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify(dec.linha),
      });
      return { ok: ins.ok, conflito: ins.status === 409 };
    }
    const r = await fetch(`${SU}/rest/v1/community_friendships?user_a=eq.${par.user_a}&user_b=eq.${par.user_b}&status=eq.${statusLido}`, {
      method: 'PATCH', headers: { ...H, Prefer: 'return=representation' }, body: JSON.stringify(dec.patch),
    });
    const rows = r.ok ? await r.json() : [];
    return { ok: r.ok && rows.length > 0, conflito: r.ok && rows.length === 0 };
  };

  // Pedir/aceitar/recusar/cancelar/desfazer: lê → decide → aplica, com 1
  // retentativa se o par mudou embaixo (corrida de pedidos cruzados).
  const executarAmizade = async (decisor, alvoId) => {
    const par = AM.parCanonico(meId, alvoId);
    if (!par) return { ok: false, http: 400, erro: 'Você não pode pedir amizade pra si mesmo.' };
    for (let tentativa = 0; tentativa < 2; tentativa++) {
      const linha = await linhaDoPar(alvoId);
      const dec = decisor(linha);
      if (!dec.ok) return dec;
      const res = await aplicarDecisao(dec, par, linha?.status);
      if (res.ok) return dec;
      if (!res.conflito) return { ok: false, http: 500, erro: 'Não deu pra salvar agora. Tente de novo.' };
    }
    return { ok: false, http: 409, erro: 'Esse pedido acabou de mudar. Recarregue e tente de novo.' };
  };

  try {
    // ── ME: estado do usuário (perfil, moderador, sino de novidades) ────────
    if (action === 'me') {
      // Mantém o plano gravado no perfil em dia (alimenta os anéis ⚡/👑)
      if (profile && (profile.plan || null) !== planName) {
        fetch(`${SU}/rest/v1/community_profiles?user_id=eq.${userId}`, {
          method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify({ plan: planName }),
        }).catch(() => {});
      }
      // Sino: posts de OUTROS criados depois da última visita a cada aba
      const unseen = { dicas: 0, comunidade: 0 };
      try {
        const count = async (tab, since) => {
          let u = `${SU}/rest/v1/community_posts?tab=eq.${tab}&deleted=eq.false&user_id=neq.${userId}&select=id&limit=100`;
          if (since) u += `&created_at=gt.${encodeURIComponent(since)}`;
          const r = await fetch(u, { headers: { ...H, Prefer: 'count=exact' } });
          return r.ok ? (parseInt((r.headers.get('content-range') || '').split('/')[1]) || 0) : 0;
        };
        const [d, c] = await Promise.all([
          count('dicas', profile?.last_seen_dicas), count('comunidade', profile?.last_seen_comunidade),
        ]);
        unseen.dicas = d; unseen.comunidade = c;
      } catch (e) {}
      return res.status(200).json({
        user_id: userId, paying, plan: planName, is_moderator: isMod, unseen,
        gifs: !!process.env.GIPHY_API_KEY,
        profile: profile ? { display_name: profile.display_name, avatar_url: profile.avatar_url, banned: profile.banned } : null,
        needs_profile: false,
      });
    }

    // ── SEEN: marca a aba como vista (zera o sino dela) ─────────────────────
    if (action === 'seen' && req.method === 'POST') {
      const tab = b.tab === 'dicas' ? 'dicas' : 'comunidade';
      if (profile) {
        await fetch(`${SU}/rest/v1/community_profiles?user_id=eq.${userId}`, {
          method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' },
          body: JSON.stringify({ ['last_seen_' + tab]: nowIso() }),
        });
      }
      return res.status(200).json({ ok: true });
    }

    // ── PROFILE-SET: SÓ a foto (nome é o username da conta, não muda) ───────
    if (action === 'profile-set' && req.method === 'POST') {
      if (!profile) return res.status(500).json({ error: 'Perfil indisponível.' });
      let avatarUrl;
      if (b.avatar_data && typeof b.avatar_data === 'string' && b.avatar_data.length < 2_500_000) {
        const m = b.avatar_data.match(/^data:(image\/(?:jpeg|png|webp));base64,(.+)$/);
        if (!m) return res.status(400).json({ error: 'Foto inválida (use JPG/PNG/WebP).' });
        const path = `community/avatars/${userId}.jpg`;
        const up = await fetch(`${SU}/storage/v1/object/blue-videos/${path}`, {
          method: 'POST', headers: { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': m[1], 'x-upsert': 'true' },
          body: Buffer.from(m[2], 'base64'),
        });
        if (up.ok) avatarUrl = `${SU}/storage/v1/object/public/blue-videos/${path}?v=${Date.now()}`;
      }
      if (!avatarUrl) return res.status(400).json({ error: 'Envie uma foto (JPG/PNG/WebP até ~1,5MB).' });
      const r = await fetch(`${SU}/rest/v1/community_profiles?user_id=eq.${userId}`, {
        method: 'PATCH', headers: { ...H, Prefer: 'return=representation' },
        body: JSON.stringify({ avatar_url: avatarUrl, updated_at: nowIso() }),
      });
      if (!r.ok) return res.status(500).json({ error: 'Erro ao salvar foto.' });
      const saved = (await r.json())[0];
      return res.status(200).json({ ok: true, profile: { display_name: saved.display_name, avatar_url: saved.avatar_url } });
    }

    // ── GIF-SEARCH: proxy do GIPHY (mesma fonte do Instagram). Sem chave
    // configurada, devolve disabled — o botão de GIF fica oculto no front.
    if (action === 'gif-search') {
      const GK = process.env.GIPHY_API_KEY;
      if (!GK) return res.status(200).json({ gifs: [], disabled: true });
      const qq = clean(q.q, 60);
      const gu = qq
        ? `https://api.giphy.com/v1/gifs/search?api_key=${GK}&q=${encodeURIComponent(qq)}&limit=24&rating=pg-13&lang=pt`
        : `https://api.giphy.com/v1/gifs/trending?api_key=${GK}&limit=24&rating=pg-13`;
      const gr = await fetch(gu);
      if (!gr.ok) return res.status(200).json({ gifs: [] });
      const gd = await gr.json();
      return res.status(200).json({
        gifs: (gd.data || []).map((g) => ({
          url: g.images?.fixed_height?.url || g.images?.original?.url,
          preview: g.images?.fixed_height_small?.url || g.images?.fixed_height?.url,
        })).filter((g) => g.url),
      });
    }

    // ── FEED: posts de uma aba, com autor, curtidas e "curti?" ───────────────
    if (action === 'feed') {
      const tab = q.tab === 'dicas' ? 'dicas' : 'comunidade';
      const limit = 20;
      let url = `${SU}/rest/v1/community_posts?tab=eq.${tab}&deleted=eq.false&order=pinned.desc,created_at.desc&limit=${limit}&select=*`;
      if (q.before) url += `&pinned=eq.false&created_at=lt.${encodeURIComponent(q.before)}`;
      const pr = await fetch(url, { headers: H });
      const posts = pr.ok ? await pr.json() : [];

      const ids = posts.map((p) => p.id);
      const uids = [...new Set(posts.map((p) => p.user_id))];
      let profiles = [], myLikes = [];
      const [fr, lr] = await Promise.all([
        uids.length ? fetch(`${SU}/rest/v1/community_profiles?user_id=in.(${uids.join(',')})&select=user_id,display_name,avatar_url,is_moderator,plan`, { headers: H }) : null,
        ids.length ? fetch(`${SU}/rest/v1/community_likes?user_id=eq.${userId}&post_id=in.(${ids.join(',')})&select=post_id`, { headers: H }) : null,
      ]);
      if (fr?.ok) profiles = await fr.json();
      if (lr?.ok) myLikes = (await lr.json()).map((l) => l.post_id);
      const pmap = Object.fromEntries(profiles.map((p) => [p.user_id, p]));
      // Estado de amizade com cada autor do lote (1 par de queries pro feed todo)
      const fmap = await linhasComigo(uids).catch(() => ({}));
      const out = posts.map((p) => ({
        id: p.id, tab: p.tab, content: p.content, media: p.media || [], pinned: p.pinned,
        likes_count: p.likes_count, comments_count: p.comments_count,
        created_at: p.created_at, edited_at: p.edited_at,
        mine: p.user_id === userId, liked: myLikes.includes(p.id),
        author: pmap[p.user_id] ? { name: pmap[p.user_id].display_name, avatar: pmap[p.user_id].avatar_url, mod: pmap[p.user_id].is_moderator, plan: pmap[p.user_id].plan || null } : { name: 'Usuário', avatar: null, mod: false, plan: null },
        author_id: isMod ? p.user_id : undefined,
        amizade: p.user_id === userId ? null : AM.estadoParaMim(fmap[String(p.user_id).toLowerCase()] || null, meId),
      }));
      // Cursor = último post NÃO fixado (fixado tem created_at antigo e pularia posts)
      const lastNonPinned = [...posts].reverse().find((p) => !p.pinned);
      return res.status(200).json({ posts: out, is_moderator: isMod, next: posts.length === limit && lastNonPinned ? lastNonPinned.created_at : null });
    }

    // ── COMMENTS: lista de um post (com curtidas, respostas e fixado) ────────
    if (action === 'comments') {
      const postId = q.post_id;
      if (!postId) return res.status(400).json({ error: 'post_id obrigatório' });
      const cr = await fetch(`${SU}/rest/v1/community_comments?post_id=eq.${encodeURIComponent(postId)}&deleted=eq.false&order=created_at.asc&limit=300&select=*`, { headers: H });
      const comments = cr.ok ? await cr.json() : [];
      const uids = [...new Set(comments.map((c) => c.user_id))];
      const cids = comments.map((c) => c.id);
      let profiles = [], myLikes = [];
      const [fr, lr] = await Promise.all([
        uids.length ? fetch(`${SU}/rest/v1/community_profiles?user_id=in.(${uids.join(',')})&select=user_id,display_name,avatar_url,is_moderator,plan`, { headers: H }) : null,
        cids.length ? fetch(`${SU}/rest/v1/community_comment_likes?user_id=eq.${userId}&comment_id=in.(${cids.join(',')})&select=comment_id`, { headers: H }) : null,
      ]);
      if (fr?.ok) profiles = await fr.json();
      if (lr?.ok) myLikes = (await lr.json()).map((l) => l.comment_id);
      const pmap = Object.fromEntries(profiles.map((p) => [p.user_id, p]));
      const fmap = await linhasComigo(uids).catch(() => ({}));
      return res.status(200).json({
        comments: comments.map((c) => ({
          id: c.id, content: c.content, created_at: c.created_at, edited_at: c.edited_at, mine: c.user_id === userId,
          parent_id: c.parent_id || null, likes_count: c.likes_count || 0, liked: myLikes.includes(c.id), pinned: !!c.pinned,
          author: pmap[c.user_id] ? { name: pmap[c.user_id].display_name, avatar: pmap[c.user_id].avatar_url, mod: pmap[c.user_id].is_moderator, plan: pmap[c.user_id].plan || null } : { name: 'Usuário', avatar: null, mod: false, plan: null },
          author_id: isMod ? c.user_id : undefined,
          amizade: c.user_id === userId ? null : AM.estadoParaMim(fmap[String(c.user_id).toLowerCase()] || null, meId),
        })),
        is_moderator: isMod,
      });
    }

    // ── AMIZADES (leitura): minhas listas ────────────────────────────────────
    // Uma linha por par, então "amigos" é só status=accepted em qualquer lado.
    if (action === 'amizades') {
      const r = await fetch(`${SU}/rest/v1/community_friendships?or=(user_a.eq.${meId},user_b.eq.${meId})&status=in.(${AM.STATUS.ACEITO},${AM.STATUS.PENDENTE})&order=updated_at.desc&limit=500&select=${FCOLS}`, { headers: H });
      const rows = r.ok ? await r.json() : [];
      const outros = rows.map((l) => AM.outroDoPar(l, meId)).filter(Boolean);
      const perfis = await perfisPorIds(outros);
      const item = (l) => {
        const outro = String(AM.outroDoPar(l, meId) || '').toLowerCase();
        return {
          user: pubPerfil(perfis[outro]),
          estado: AM.estadoParaMim(l, meId),
          desde: l.status === AM.STATUS.ACEITO ? (l.responded_at || l.updated_at) : (l.requested_at || l.created_at),
        };
      };
      const amigos = [], recebidos = [], enviados = [];
      for (const l of rows) {
        if (!AM.outroDoPar(l, meId)) continue;
        const it = item(l);
        if (it.estado.estado === 'amigos') amigos.push(it);
        else if (it.estado.estado === 'pendente_recebido') recebidos.push(it);
        else if (it.estado.estado === 'pendente_enviado') enviados.push(it);
      }
      return res.status(200).json({ amigos, recebidos, enviados, is_moderator: isMod });
    }

    // ── AMIZADES (leitura): estado com UMA pessoa ────────────────────────────
    if (action === 'amizade-estado') {
      const alvo = await acharPorNome(q.name || b.name);
      if (!alvo) return res.status(404).json({ error: 'Usuário não encontrado.' });
      if (String(alvo.user_id).toLowerCase() === meId) {
        return res.status(200).json({ user: pubPerfil(alvo), estado: { estado: 'eu', pode_pedir: false, bloqueado: false, espera_ate: null, dias_espera: 0 } });
      }
      const linha = await linhaDoPar(alvo.user_id);
      return res.status(200).json({ user: pubPerfil(alvo), estado: AM.estadoParaMim(linha, meId) });
    }

    // Daqui pra baixo é escrita — exige perfil com nome + respeita ban global do Blue
    const AMIZADE_WRITE = ['amizade-pedir', 'amizade-aceitar', 'amizade-recusar', 'amizade-cancelar', 'amizade-desfazer'];
    const WRITE = ['post-create', 'post-edit', 'post-delete', 'comment-create', 'comment-edit', 'comment-delete', 'comment-like-toggle', 'comment-pin-toggle', 'like-toggle', 'pin-toggle', 'ban-user', 'get-upload-url', 'transcode', ...AMIZADE_WRITE];
    if (WRITE.includes(action)) {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
      if (!profile?.display_name) return res.status(428).json({ error: 'Escolha seu nome antes de participar.', needs_profile: true });
      if (!isMod) {
        const ban = await checkBan(userId, SU, H);
        if (ban) return res.status(403).json({ error: 'Conta suspensa na plataforma.', banned: true });
      }
    }

    // ── AMIZADES (escrita) ───────────────────────────────────────────────────
    // Já passaram pelo portão Full/Master lá em cima (:75), pelo ban da
    // Comunidade (:76) e pelo ban global (acima). O alvo é resolvido pelo
    // display_name, então nenhum uuid de usuário sai daqui.
    if (AMIZADE_WRITE.includes(action)) {
      const alvo = await acharPorNome(b.name);
      if (!alvo) return res.status(404).json({ error: 'Usuário não encontrado.' });
      const alvoId = String(alvo.user_id).toLowerCase();
      if (alvoId === meId) return res.status(400).json({ error: 'Você não pode pedir amizade pra si mesmo.' });
      if (alvo.banned) return res.status(403).json({ error: 'Esse usuário não está mais na Comunidade.' });

      const agora = new Date();
      const decisor = {
        'amizade-pedir': (linha) => AM.decidirPedido({ eu: meId, alvo: alvoId, linha, agora }),
        'amizade-aceitar': (linha) => AM.decidirAceite({ eu: meId, linha, agora }),
        'amizade-recusar': (linha) => AM.decidirRecusa({ eu: meId, linha, agora }),
        'amizade-cancelar': (linha) => AM.decidirCancelamento({ eu: meId, linha, agora }),
        'amizade-desfazer': (linha) => AM.decidirDesfazer({ eu: meId, linha, agora }),
      }[action];

      const dec = await executarAmizade(decisor, alvoId);
      if (!dec.ok) {
        return res.status(dec.http || 400).json({
          error: dec.erro, estado: dec.estado || null,
          bloqueado: dec.bloqueado || undefined, espera_ate: dec.espera_ate || undefined,
          dias_espera: dec.dias_espera || undefined,
        });
      }
      // Notifica só quando algo REALMENTE mudou (acao 'nenhuma' = idempotente)
      if (dec.notificar && dec.acao !== 'nenhuma' && dec.para) await notificarAmizade(dec.notificar, dec.para);
      return res.status(200).json({
        ok: true, estado: dec.estado, ja_existia: !!dec.ja_existia, cruzado: !!dec.cruzado,
        user: pubPerfil(alvo),
      });
    }

    // ── GET-UPLOAD-URL: destino pra upload direto com o JWT do usuário ──────
    if (action === 'get-upload-url') {
      // NUNCA devolver a service key: se a anon não estiver configurada, aborta
      if (!process.env.SUPABASE_ANON_KEY) return res.status(500).json({ error: 'Upload indisponível (config).' });
      const kind = ['image', 'video', 'audio'].includes(b.kind) ? b.kind : null;
      if (!kind) return res.status(400).json({ error: 'kind inválido' });
      if (!MIME[kind].includes(b.content_type)) return res.status(400).json({ error: 'Formato não suportado.' });
      const extMap = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/ogg': 'ogg', 'audio/webm': 'weba', 'audio/wav': 'wav' };
      const ext = extMap[b.content_type] || 'bin';
      // UID na primeira pasta = mesma convenção do Blue (política do bucket)
      const storagePath = `${userId}/community/${Date.now()}/${kind}.${ext}`;
      return res.status(200).json({
        supabase_url: SU, anon_key: AK, storage_path: storagePath,
        public_url: `${SU}/storage/v1/object/public/blue-videos/${storagePath}`,
        max_mb: kind === 'video' ? 200 : kind === 'audio' ? 30 : 10,
      });
    }

    // ── TRANSCODE: vídeo da comunidade → faststart + thumb (Railway) ────────
    if (action === 'transcode') {
      const RW = process.env.RAILWAY_FFMPEG_URL;
      const sp = String(b.storage_path || '');
      if (!sp.startsWith(`${userId}/community/`) || sp.includes('..')) return res.status(400).json({ error: 'storage_path inválido' });
      if (!RW) return res.status(200).json({ ok: false });
      const jr = await fetch(RW.replace(/\/$/, '') + '/blue-transcode', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          video_url: `${SU}/storage/v1/object/public/blue-videos/${sp}`,
          storage_path: sp, backup: false, gen_thumb: true,
          supabase_url: SU, supabase_key: SK,
        }),
      });
      const jd = await jr.json().catch(() => ({}));
      return res.status(200).json({ ok: jr.ok, job_id: jd.job_id || null, thumb_url: `${SU}/storage/v1/object/public/blue-videos/${sp.replace(/[^/]+$/, 'thumb.jpg')}` });
    }

    // ── POST-CREATE ──────────────────────────────────────────────────────────
    if (action === 'post-create') {
      const tab = b.tab === 'dicas' ? 'dicas' : 'comunidade';
      if (tab === 'dicas' && !isMod) return res.status(403).json({ error: 'Só o moderador posta em Dicas.' });
      const content = clean(b.content, 2000);
      const media = (Array.isArray(b.media) ? b.media : []).slice(0, 4)
        .filter((m) => m && ['image', 'video', 'audio'].includes(m.type) && isMediaUrl(m.url))
        .map((m) => ({ type: m.type, url: m.url, thumb: isMediaUrl(m.thumb) ? m.thumb : null }));
      // Dicas (moderador): aceita vídeo do YouTube embedado — treinamentos
      if (b.youtube && tab === 'dicas' && isMod) {
        const ym = String(b.youtube).match(/(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{6,15})/);
        if (!ym) return res.status(400).json({ error: 'Link do YouTube inválido.' });
        media.unshift({ type: 'youtube', id: ym[1] });
      }
      if (!content && !media.length) return res.status(400).json({ error: 'Escreva algo ou anexe uma mídia.' });
      if (hasBlocked(content)) return res.status(400).json({ error: 'Conteúdo não permitido.' });

      // Rate limit: 15 posts/hora
      const hourAgo = new Date(Date.now() - 3600000).toISOString();
      const rl = await fetch(`${SU}/rest/v1/community_posts?user_id=eq.${userId}&created_at=gt.${encodeURIComponent(hourAgo)}&select=id`, { headers: H });
      if (rl.ok && (await rl.json()).length >= 15) return res.status(429).json({ error: 'Calma aí! Limite de 15 posts por hora.' });

      const id = uuid();
      const ins = await fetch(`${SU}/rest/v1/community_posts`, {
        method: 'POST', headers: { ...H, Prefer: 'return=minimal' },
        body: JSON.stringify({ id, user_id: userId, tab, content, media, created_at: nowIso() }),
      });
      if (!ins.ok) return res.status(500).json({ error: 'Erro ao publicar.' });
      return res.status(200).json({ ok: true, id });
    }

    // ── POST-EDIT (dono ou moderador) ────────────────────────────────────────
    if (action === 'post-edit') {
      const content = clean(b.content, 2000);
      if (!content) return res.status(400).json({ error: 'Texto vazio.' });
      if (hasBlocked(content)) return res.status(400).json({ error: 'Conteúdo não permitido.' });
      const filter = isMod ? '' : `&user_id=eq.${userId}`;
      const r = await fetch(`${SU}/rest/v1/community_posts?id=eq.${encodeURIComponent(b.post_id)}${filter}`, {
        method: 'PATCH', headers: { ...H, Prefer: 'return=representation' },
        body: JSON.stringify({ content, edited_at: nowIso() }),
      });
      const rows = r.ok ? await r.json() : [];
      if (!rows.length) return res.status(404).json({ error: 'Post não encontrado (ou sem permissão).' });
      return res.status(200).json({ ok: true });
    }

    // ── POST-DELETE (dono ou moderador, soft) ────────────────────────────────
    if (action === 'post-delete') {
      const filter = isMod ? '' : `&user_id=eq.${userId}`;
      const r = await fetch(`${SU}/rest/v1/community_posts?id=eq.${encodeURIComponent(b.post_id)}${filter}`, {
        method: 'PATCH', headers: { ...H, Prefer: 'return=representation' },
        body: JSON.stringify({ deleted: true }),
      });
      const rows = r.ok ? await r.json() : [];
      if (!rows.length) return res.status(404).json({ error: 'Post não encontrado (ou sem permissão).' });
      return res.status(200).json({ ok: true });
    }

    // ── PIN-TOGGLE (moderador) ───────────────────────────────────────────────
    if (action === 'pin-toggle') {
      if (!isMod) return res.status(403).json({ error: 'Só moderador.' });
      const gr = await fetch(`${SU}/rest/v1/community_posts?id=eq.${encodeURIComponent(b.post_id)}&select=pinned`, { headers: H });
      const cur = gr.ok ? (await gr.json())[0] : null;
      if (!cur) return res.status(404).json({ error: 'Post não encontrado.' });
      await fetch(`${SU}/rest/v1/community_posts?id=eq.${encodeURIComponent(b.post_id)}`, {
        method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify({ pinned: !cur.pinned }),
      });
      return res.status(200).json({ ok: true, pinned: !cur.pinned });
    }

    // ── BAN-USER (moderador) ─────────────────────────────────────────────────
    if (action === 'ban-user') {
      if (!isMod) return res.status(403).json({ error: 'Só moderador.' });
      if (!b.user_id || b.user_id === userId) return res.status(400).json({ error: 'user_id inválido' });
      const r = await fetch(`${SU}/rest/v1/community_profiles?user_id=eq.${encodeURIComponent(b.user_id)}&is_moderator=eq.false`, {
        method: 'PATCH', headers: { ...H, Prefer: 'return=representation' },
        body: JSON.stringify({ banned: b.banned !== false, updated_at: nowIso() }),
      });
      const rows = r.ok ? await r.json() : [];
      if (!rows.length) return res.status(404).json({ error: 'Usuário não encontrado.' });
      return res.status(200).json({ ok: true, banned: rows[0].banned });
    }

    // ── LIKE-TOGGLE ──────────────────────────────────────────────────────────
    if (action === 'like-toggle') {
      const postId = String(b.post_id || '');
      if (!postId) return res.status(400).json({ error: 'post_id obrigatório' });
      const px = await fetch(`${SU}/rest/v1/community_posts?id=eq.${encodeURIComponent(postId)}&deleted=eq.false&select=id`, { headers: H });
      if (!px.ok || !(await px.json()).length) return res.status(404).json({ error: 'Post não encontrado.' });
      const ins = await fetch(`${SU}/rest/v1/community_likes`, {
        method: 'POST', headers: { ...H, Prefer: 'return=minimal' },
        body: JSON.stringify({ post_id: postId, user_id: userId }),
      });
      let liked;
      if (ins.ok) liked = true;
      else if (ins.status === 409) {
        const del = await fetch(`${SU}/rest/v1/community_likes?post_id=eq.${encodeURIComponent(postId)}&user_id=eq.${userId}`, { method: 'DELETE', headers: H });
        if (!del.ok) return res.status(500).json({ error: 'Erro ao descurtir.' });
        liked = false;
      } else return res.status(500).json({ error: 'Erro ao curtir.' });
      // Atualiza contador com o total real (evita drift de read-modify-write)
      const cr = await fetch(`${SU}/rest/v1/community_likes?post_id=eq.${encodeURIComponent(postId)}&select=user_id`, { headers: { ...H, Prefer: 'count=exact' } });
      const total = parseInt((cr.headers.get('content-range') || '').split('/')[1]) || 0;
      await fetch(`${SU}/rest/v1/community_posts?id=eq.${encodeURIComponent(postId)}`, {
        method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify({ likes_count: total }),
      });
      return res.status(200).json({ ok: true, liked, likes_count: total });
    }

    // ── COMMENT-CREATE (texto, ou GIF via marcador [gif]url-do-giphy) ────────
    if (action === 'comment-create') {
      let content;
      if (typeof b.content === 'string' && b.content.startsWith('[gif]')) {
        const gm = b.content.match(/^\[gif\](https:\/\/media\d*\.giphy\.com\/[^\s"'<>]+)$/);
        if (!gm) return res.status(400).json({ error: 'GIF inválido.' });
        content = '[gif]' + gm[1];
      } else {
        content = clean(b.content, 600);
        if (!content) return res.status(400).json({ error: 'Comentário vazio.' });
        if (hasBlocked(content)) return res.status(400).json({ error: 'Conteúdo não permitido.' });
      }
      const postId = String(b.post_id || '');
      const pr = await fetch(`${SU}/rest/v1/community_posts?id=eq.${encodeURIComponent(postId)}&deleted=eq.false&select=id,comments_count`, { headers: H });
      const post = pr.ok ? (await pr.json())[0] : null;
      if (!post) return res.status(404).json({ error: 'Post não encontrado.' });

      const hourAgo = new Date(Date.now() - 3600000).toISOString();
      const rl = await fetch(`${SU}/rest/v1/community_comments?user_id=eq.${userId}&created_at=gt.${encodeURIComponent(hourAgo)}&select=id`, { headers: H });
      if (rl.ok && (await rl.json()).length >= 60) return res.status(429).json({ error: 'Limite de comentários por hora atingido.' });

      // Resposta: 1 nível só — responder uma resposta cai na thread do pai
      let parentId = null;
      if (b.parent_id) {
        const pr2 = await fetch(`${SU}/rest/v1/community_comments?id=eq.${encodeURIComponent(b.parent_id)}&post_id=eq.${encodeURIComponent(postId)}&deleted=eq.false&select=id,parent_id`, { headers: H });
        const parent = pr2.ok ? (await pr2.json())[0] : null;
        if (!parent) return res.status(404).json({ error: 'Comentário respondido não existe mais.' });
        parentId = parent.parent_id || parent.id;
      }

      const id = uuid();
      const ins = await fetch(`${SU}/rest/v1/community_comments`, {
        method: 'POST', headers: { ...H, Prefer: 'return=minimal' },
        body: JSON.stringify({ id, post_id: postId, user_id: userId, content, parent_id: parentId, created_at: nowIso() }),
      });
      if (!ins.ok) return res.status(500).json({ error: 'Erro ao comentar.' });
      // Contador via count real (mesmo padrão do delete — sem drift em concorrência)
      const cr = await fetch(`${SU}/rest/v1/community_comments?post_id=eq.${encodeURIComponent(postId)}&deleted=eq.false&select=id`, { headers: { ...H, Prefer: 'count=exact' } });
      const total = parseInt((cr.headers.get('content-range') || '').split('/')[1]) || 0;
      await fetch(`${SU}/rest/v1/community_posts?id=eq.${encodeURIComponent(postId)}`, {
        method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify({ comments_count: total }),
      });
      return res.status(200).json({ ok: true, id });
    }

    // ── COMMENT-LIKE-TOGGLE ──────────────────────────────────────────────────
    if (action === 'comment-like-toggle') {
      const cid = String(b.comment_id || '');
      if (!cid) return res.status(400).json({ error: 'comment_id obrigatório' });
      const cx = await fetch(`${SU}/rest/v1/community_comments?id=eq.${encodeURIComponent(cid)}&deleted=eq.false&select=id`, { headers: H });
      if (!cx.ok || !(await cx.json()).length) return res.status(404).json({ error: 'Comentário não encontrado.' });
      const ins = await fetch(`${SU}/rest/v1/community_comment_likes`, {
        method: 'POST', headers: { ...H, Prefer: 'return=minimal' },
        body: JSON.stringify({ comment_id: cid, user_id: userId }),
      });
      let liked;
      if (ins.ok) liked = true;
      else if (ins.status === 409) {
        const del = await fetch(`${SU}/rest/v1/community_comment_likes?comment_id=eq.${encodeURIComponent(cid)}&user_id=eq.${userId}`, { method: 'DELETE', headers: H });
        if (!del.ok) return res.status(500).json({ error: 'Erro ao descurtir.' });
        liked = false;
      } else return res.status(500).json({ error: 'Erro ao curtir.' });
      const cr2 = await fetch(`${SU}/rest/v1/community_comment_likes?comment_id=eq.${encodeURIComponent(cid)}&select=user_id`, { headers: { ...H, Prefer: 'count=exact' } });
      const total = parseInt((cr2.headers.get('content-range') || '').split('/')[1]) || 0;
      await fetch(`${SU}/rest/v1/community_comments?id=eq.${encodeURIComponent(cid)}`, {
        method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify({ likes_count: total }),
      });
      return res.status(200).json({ ok: true, liked, likes_count: total });
    }

    // ── COMMENT-PIN-TOGGLE (moderador) ───────────────────────────────────────
    if (action === 'comment-pin-toggle') {
      if (!isMod) return res.status(403).json({ error: 'Só moderador.' });
      const cid = String(b.comment_id || '');
      const gr = await fetch(`${SU}/rest/v1/community_comments?id=eq.${encodeURIComponent(cid)}&select=pinned`, { headers: H });
      const cur = gr.ok ? (await gr.json())[0] : null;
      if (!cur) return res.status(404).json({ error: 'Comentário não encontrado.' });
      await fetch(`${SU}/rest/v1/community_comments?id=eq.${encodeURIComponent(cid)}`, {
        method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify({ pinned: !cur.pinned }),
      });
      return res.status(200).json({ ok: true, pinned: !cur.pinned });
    }

    // ── COMMENT-EDIT / COMMENT-DELETE (dono ou moderador) ────────────────────
    if (action === 'comment-edit' || action === 'comment-delete') {
      const filter = isMod ? '' : `&user_id=eq.${userId}`;
      const patch = action === 'comment-edit'
        ? { content: clean(b.content, 600), edited_at: nowIso() }
        : { deleted: true };
      if (action === 'comment-edit' && (!patch.content || hasBlocked(patch.content))) return res.status(400).json({ error: 'Comentário inválido.' });
      const r = await fetch(`${SU}/rest/v1/community_comments?id=eq.${encodeURIComponent(b.comment_id)}${filter}`, {
        method: 'PATCH', headers: { ...H, Prefer: 'return=representation' }, body: JSON.stringify(patch),
      });
      const rows = r.ok ? await r.json() : [];
      if (!rows.length) return res.status(404).json({ error: 'Comentário não encontrado (ou sem permissão).' });
      if (action === 'comment-delete') {
        const postId = rows[0].post_id;
        const cr = await fetch(`${SU}/rest/v1/community_comments?post_id=eq.${encodeURIComponent(postId)}&deleted=eq.false&select=id`, { headers: { ...H, Prefer: 'count=exact' } });
        const total = parseInt((cr.headers.get('content-range') || '').split('/')[1]) || 0;
        await fetch(`${SU}/rest/v1/community_posts?id=eq.${encodeURIComponent(postId)}`, {
          method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify({ comments_count: total }),
        });
      }
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'Invalid action' });
  } catch (e) {
    console.error('[community]', e.message);
    return res.status(500).json({ error: 'Erro interno.' });
  }
};
