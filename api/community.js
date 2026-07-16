// api/community.js — Comunidade BlueTube (feed estilo X, exclusiva de pagantes)
// Abas: 'dicas' (só moderador posta) e 'comunidade' (todo pagante posta).
// Identidade: community_profiles (display_name único + avatar). Moderador
// (is_moderator) tem selo dourado e controle total: editar/apagar/fixar
// qualquer post/comentário e banir usuário. Mídia: upload direto ao Storage
// com JWT do próprio usuário (mesmo padrão do Blue — sem expor service key);
// vídeo passa pelo transcode do Railway (faststart + thumb).

const { checkBan } = require('./_helpers/checkBan');

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
  let userId = null, userEmail = null, paying = false;
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
            if (v) paying = true;
          }
        }
      }
    } catch (e) {}
  }
  if (!userId) return res.status(401).json({ error: 'Login necessário.', login: true });

  // Perfil da comunidade (pode não existir ainda)
  let profile = null;
  try {
    const pf = await fetch(`${SU}/rest/v1/community_profiles?user_id=eq.${userId}&select=*`, { headers: H });
    if (pf.ok) profile = (await pf.json())[0] || null;
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

  try {
    // ── ME: estado do usuário (perfil, moderador, precisa criar nome?) ──────
    if (action === 'me') {
      return res.status(200).json({
        user_id: userId, paying, is_moderator: isMod,
        profile: profile ? { display_name: profile.display_name, avatar_url: profile.avatar_url, banned: profile.banned } : null,
        needs_profile: !profile?.display_name,
      });
    }

    // ── PROFILE-SET: nome de exibição + avatar (base64 pequeno) ─────────────
    if (action === 'profile-set' && req.method === 'POST') {
      const name = clean(b.display_name, 24);
      if (name && (name.length < 2 || !/^[\p{L}\p{N} ._-]+$/u.test(name))) {
        return res.status(400).json({ error: 'Nome inválido. Use 2-24 caracteres (letras, números, espaço, . _ -).' });
      }
      if (name && hasBlocked(name)) return res.status(400).json({ error: 'Nome não permitido.' });

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

      const patch = {};
      if (name) patch.display_name = name;
      if (avatarUrl) patch.avatar_url = avatarUrl;
      if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nada pra salvar.' });
      patch.updated_at = nowIso();

      let r;
      if (profile) {
        r = await fetch(`${SU}/rest/v1/community_profiles?user_id=eq.${userId}`, {
          method: 'PATCH', headers: { ...H, Prefer: 'return=representation' }, body: JSON.stringify(patch),
        });
      } else {
        if (!name) return res.status(400).json({ error: 'Escolha um nome de exibição.' });
        r = await fetch(`${SU}/rest/v1/community_profiles`, {
          method: 'POST', headers: { ...H, Prefer: 'return=representation' },
          body: JSON.stringify({ user_id: userId, email: userEmail, ...patch }),
        });
      }
      if (r.status === 409) return res.status(409).json({ error: 'Esse nome já está em uso. Escolha outro.' });
      if (!r.ok) return res.status(500).json({ error: 'Erro ao salvar perfil.' });
      const saved = (await r.json())[0];
      return res.status(200).json({ ok: true, profile: { display_name: saved.display_name, avatar_url: saved.avatar_url } });
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
        uids.length ? fetch(`${SU}/rest/v1/community_profiles?user_id=in.(${uids.join(',')})&select=user_id,display_name,avatar_url,is_moderator`, { headers: H }) : null,
        ids.length ? fetch(`${SU}/rest/v1/community_likes?user_id=eq.${userId}&post_id=in.(${ids.join(',')})&select=post_id`, { headers: H }) : null,
      ]);
      if (fr?.ok) profiles = await fr.json();
      if (lr?.ok) myLikes = (await lr.json()).map((l) => l.post_id);
      const pmap = Object.fromEntries(profiles.map((p) => [p.user_id, p]));
      const out = posts.map((p) => ({
        id: p.id, tab: p.tab, content: p.content, media: p.media || [], pinned: p.pinned,
        likes_count: p.likes_count, comments_count: p.comments_count,
        created_at: p.created_at, edited_at: p.edited_at,
        mine: p.user_id === userId, liked: myLikes.includes(p.id),
        author: pmap[p.user_id] ? { name: pmap[p.user_id].display_name, avatar: pmap[p.user_id].avatar_url, mod: pmap[p.user_id].is_moderator } : { name: 'Usuário', avatar: null, mod: false },
        author_id: isMod ? p.user_id : undefined,
      }));
      // Cursor = último post NÃO fixado (fixado tem created_at antigo e pularia posts)
      const lastNonPinned = [...posts].reverse().find((p) => !p.pinned);
      return res.status(200).json({ posts: out, is_moderator: isMod, next: posts.length === limit && lastNonPinned ? lastNonPinned.created_at : null });
    }

    // ── COMMENTS: lista de um post ───────────────────────────────────────────
    if (action === 'comments') {
      const postId = q.post_id;
      if (!postId) return res.status(400).json({ error: 'post_id obrigatório' });
      const cr = await fetch(`${SU}/rest/v1/community_comments?post_id=eq.${encodeURIComponent(postId)}&deleted=eq.false&order=created_at.asc&limit=200&select=*`, { headers: H });
      const comments = cr.ok ? await cr.json() : [];
      const uids = [...new Set(comments.map((c) => c.user_id))];
      let profiles = [];
      if (uids.length) {
        const fr = await fetch(`${SU}/rest/v1/community_profiles?user_id=in.(${uids.join(',')})&select=user_id,display_name,avatar_url,is_moderator`, { headers: H });
        if (fr.ok) profiles = await fr.json();
      }
      const pmap = Object.fromEntries(profiles.map((p) => [p.user_id, p]));
      return res.status(200).json({
        comments: comments.map((c) => ({
          id: c.id, content: c.content, created_at: c.created_at, edited_at: c.edited_at, mine: c.user_id === userId,
          author: pmap[c.user_id] ? { name: pmap[c.user_id].display_name, avatar: pmap[c.user_id].avatar_url, mod: pmap[c.user_id].is_moderator } : { name: 'Usuário', avatar: null, mod: false },
          author_id: isMod ? c.user_id : undefined,
        })),
        is_moderator: isMod,
      });
    }

    // Daqui pra baixo é escrita — exige perfil com nome + respeita ban global do Blue
    const WRITE = ['post-create', 'post-edit', 'post-delete', 'comment-create', 'comment-edit', 'comment-delete', 'like-toggle', 'pin-toggle', 'ban-user', 'get-upload-url', 'transcode'];
    if (WRITE.includes(action)) {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
      if (!profile?.display_name) return res.status(428).json({ error: 'Escolha seu nome antes de participar.', needs_profile: true });
      if (!isMod) {
        const ban = await checkBan(userId, SU, H);
        if (ban) return res.status(403).json({ error: 'Conta suspensa na plataforma.', banned: true });
      }
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

    // ── COMMENT-CREATE ───────────────────────────────────────────────────────
    if (action === 'comment-create') {
      const content = clean(b.content, 600);
      if (!content) return res.status(400).json({ error: 'Comentário vazio.' });
      if (hasBlocked(content)) return res.status(400).json({ error: 'Conteúdo não permitido.' });
      const postId = String(b.post_id || '');
      const pr = await fetch(`${SU}/rest/v1/community_posts?id=eq.${encodeURIComponent(postId)}&deleted=eq.false&select=id,comments_count`, { headers: H });
      const post = pr.ok ? (await pr.json())[0] : null;
      if (!post) return res.status(404).json({ error: 'Post não encontrado.' });

      const hourAgo = new Date(Date.now() - 3600000).toISOString();
      const rl = await fetch(`${SU}/rest/v1/community_comments?user_id=eq.${userId}&created_at=gt.${encodeURIComponent(hourAgo)}&select=id`, { headers: H });
      if (rl.ok && (await rl.json()).length >= 60) return res.status(429).json({ error: 'Limite de comentários por hora atingido.' });

      const id = uuid();
      const ins = await fetch(`${SU}/rest/v1/community_comments`, {
        method: 'POST', headers: { ...H, Prefer: 'return=minimal' },
        body: JSON.stringify({ id, post_id: postId, user_id: userId, content, created_at: nowIso() }),
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
