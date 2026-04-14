// Lipy Meta — helper + endpoint utilitário
// (webhook Meta está em lipy-webhook-meta.js)
const { ok, fail, readJson, cors } = require('./_lipy/http');

const GRAPH = 'https://graph.facebook.com/v18.0';

async function publicarInstagram({ instagram_id, access_token, image_url, caption }) {
  const token = access_token || process.env.META_ACCESS_TOKEN;
  if (!token || !instagram_id || !image_url) {
    console.log('[lipy/meta-mock] publicarInstagram');
    return `mock_ig_${Date.now()}`;
  }
  try {
    const r1 = await fetch(`${GRAPH}/${instagram_id}/media`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image_url, caption, access_token: token })
    });
    const { id: creation_id } = await r1.json();
    if (!creation_id) return null;
    const r2 = await fetch(`${GRAPH}/${instagram_id}/media_publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ creation_id, access_token: token })
    });
    const j = await r2.json();
    return j.id || null;
  } catch (e) {
    console.error('[lipy/meta-ig]', e);
    return null;
  }
}

async function publicarFacebook({ page_id, access_token, message, image_url }) {
  const token = access_token || process.env.META_ACCESS_TOKEN;
  if (!token || !page_id) {
    console.log('[lipy/meta-mock] publicarFacebook');
    return `mock_fb_${Date.now()}`;
  }
  try {
    const endpoint = image_url ? `${GRAPH}/${page_id}/photos` : `${GRAPH}/${page_id}/feed`;
    const body = image_url
      ? { url: image_url, caption: message, access_token: token }
      : { message, access_token: token };
    const r = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const j = await r.json();
    return j.id || j.post_id || null;
  } catch (e) {
    console.error('[lipy/meta-fb]', e);
    return null;
  }
}

async function responderComentario({ comment_id, access_token, message }) {
  const token = access_token || process.env.META_ACCESS_TOKEN;
  if (!token || !comment_id) return { mock: true };
  try {
    const r = await fetch(`${GRAPH}/${comment_id}/replies`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, access_token: token })
    });
    return await r.json();
  } catch (e) {
    return { erro: e.message };
  }
}

async function buscarInsights({ instagram_id, access_token, since, until }) {
  const token = access_token || process.env.META_ACCESS_TOKEN;
  if (!token || !instagram_id) {
    return {
      mock: true,
      alcance: 12500, impressoes: 18400, seguidores_novos: 87,
      engajamento: 4.2, curtidas: 940, comentarios: 62, salvamentos: 110
    };
  }
  try {
    const metrics = 'reach,impressions,follower_count,profile_views';
    const r = await fetch(`${GRAPH}/${instagram_id}/insights?metric=${metrics}&period=day&since=${since}&until=${until}&access_token=${token}`);
    return await r.json();
  } catch (e) {
    return { erro: e.message };
  }
}

// Endpoint utilitário: GET /api/lipy-meta?action=insights&...
module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  try {
    if (req.method === 'GET' && req.query?.action === 'insights') {
      const j = await buscarInsights({
        instagram_id: req.query.instagram_id,
        access_token: req.query.access_token,
        since: req.query.since,
        until: req.query.until
      });
      return ok(res, { insights: j });
    }
    return ok(res, { service: 'lipy-meta' });
  } catch (err) {
    return fail(res, 500, err.message);
  }
};

module.exports.publicarInstagram = publicarInstagram;
module.exports.publicarFacebook = publicarFacebook;
module.exports.responderComentario = responderComentario;
module.exports.buscarInsights = buscarInsights;
