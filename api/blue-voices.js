// api/blue-voices.js — Vozes customizadas do BlueVoice salvas no Supabase
// com metadados reais de idioma/sotaque/gênero/estilo do ElevenLabs

// ── HELPERS DE NORMALIZAÇÃO DE METADADOS ELEVENLABS ─────────────────────────
const LANG_MAP = [
  // [matcher (lowercase substring ou regex), code, flag, label]
  [/pt[-_]?br|brazilian|brasil|portuguese \(brazil\)/, 'pt-BR', '🇧🇷', 'Português (Brasil)'],
  [/pt[-_]?pt|european portuguese|portuguese \(portugal\)/, 'pt-PT', '🇵🇹', 'Português (Portugal)'],
  [/^portugu|portuguese/, 'pt-BR', '🇧🇷', 'Português (Brasil)'],
  [/en[-_]?gb|british|england/, 'en-GB', '🇬🇧', 'English (UK)'],
  [/en[-_]?us|american english|american|en-us/, 'en-US', '🇺🇸', 'English (US)'],
  [/australian/, 'en-AU', '🇦🇺', 'English (AU)'],
  [/^english/, 'en-US', '🇺🇸', 'English (US)'],
  [/es[-_]?mx|mexican|méxico|mexico/, 'es-MX', '🇲🇽', 'Español (México)'],
  [/es[-_]?es|castilian|spanish \(spain\)/, 'es-ES', '🇪🇸', 'Español (España)'],
  [/^spanish|español|espanhol/, 'es-ES', '🇪🇸', 'Español'],
  [/fr[-_]?fr|french|français|france/, 'fr-FR', '🇫🇷', 'Français'],
  [/de[-_]?de|german|deutsch|germany/, 'de-DE', '🇩🇪', 'Deutsch'],
  [/it[-_]?it|italian|italiano|italy/, 'it-IT', '🇮🇹', 'Italiano'],
  [/ja[-_]?jp|japanese|japan|日本/, 'ja-JP', '🇯🇵', '日本語'],
  [/ko[-_]?kr|korean|korea|한국/, 'ko-KR', '🇰🇷', '한국어'],
  [/zh[-_]?cn|mandarin|chinese|中文|中国/, 'zh-CN', '🇨🇳', '中文'],
  [/arabic|العربية/, 'ar', '🇸🇦', 'العربية'],
  [/hindi|हिन्दी/, 'hi', '🇮🇳', 'हिन्दी'],
  [/turkish|türkçe/, 'tr', '🇹🇷', 'Türkçe'],
  [/indonesian|bahasa/, 'id', '🇮🇩', 'Bahasa Indonesia'],
];

// Normaliza labels + verified_languages + nome em metadados padronizados
function normalizeVoice(v) {
  const labels = v.labels || {};
  const verified = Array.isArray(v.verified_languages) ? v.verified_languages : [];
  const hay = [
    labels.accent || '', labels.language || '', labels.description || '',
    labels.use_case || '', v.name || '', v.category || '',
    ...verified.map(x => typeof x === 'string' ? x : (x?.language || x?.locale || ''))
  ].join(' ').toLowerCase();

  let langCode = null, langFlag = null, langLabel = null;
  for (const [rx, code, flag, label] of LANG_MAP) {
    if (rx.test(hay)) { langCode = code; langFlag = flag; langLabel = label; break; }
  }

  // Gênero
  const g = (labels.gender || '').toLowerCase();
  const genero = g.includes('female') || g.includes('fem') ? 'Feminino'
              : g.includes('male') || g.includes('masc') ? 'Masculino'
              : '';

  // Idade
  const a = (labels.age || '').toLowerCase();
  const idade = a.includes('young') ? 'Jovem'
             : a.includes('middle') ? 'Adulto'
             : a.includes('old') ? 'Sênior'
             : '';

  // Estilo (use_case + description)
  const style = `${labels.use_case || ''} ${labels.description || ''}`.toLowerCase();
  const estilo = style.includes('narrat') ? 'Narração'
              : style.includes('conversation') || style.includes('casual') ? 'Conversacional'
              : style.includes('news') || style.includes('professional') ? 'Profissional'
              : style.includes('dramatic') || style.includes('intense') ? 'Dramático'
              : style.includes('young') || style.includes('social') ? 'Jovem'
              : 'Narração';

  // Multilingual: mais de 1 idioma verificado OU use_case/description contém "multilingual"
  const multilingual = verified.length > 1
    || /multiling/.test(style)
    || /multiling/.test(hay);

  return {
    idioma_real: langLabel,
    lang_code: langCode,
    lang_flag: langFlag,
    sotaque: labels.accent || '',
    genero,
    idade,
    estilo,
    descricao: labels.description || '',
    multilingual,
    metadata: {
      raw_labels: labels,
      verified_languages: verified,
      category: v.category || '',
      preview_url: v.preview_url || ''
    }
  };
}

async function fetchElevenMetadata(voiceId, xiKey) {
  try {
    const r = await fetch(`https://api.elevenlabs.io/v1/voices/${voiceId}?with_settings=false`, {
      headers: { 'xi-api-key': xiKey }
    });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) { return null; }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const SU = process.env.SUPABASE_URL;
  const SK = process.env.SUPABASE_SERVICE_KEY;
  const AK = process.env.SUPABASE_ANON_KEY || SK;
  const EL = process.env.ELEVENLABS_API_KEY;
  if (!SU || !SK) return res.status(500).json({ error: 'Config missing' });
  const h = { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' };

  // ── GET ?action=premade-previews — metadata + preview_url dos 20 premade ─
  // Busca as vozes premade oficiais do ElevenLabs e retorna preview_url + metadata.
  // Frontend cacheia em localStorage com TTL de 7 dias.
  if (req.method === 'GET' && req.query.action === 'premade-previews') {
    if (!EL) return res.status(500).json({ error: 'ElevenLabs não configurado' });
    try {
      // /v1/voices retorna todas as vozes da conta (premade + clonadas)
      const r = await fetch('https://api.elevenlabs.io/v1/voices', {
        headers: { 'xi-api-key': EL }
      });
      if (!r.ok) {
        return res.status(r.status).json({ error: 'ElevenLabs API: ' + r.status });
      }
      const data = await r.json();
      // Filtra só premade e só as com preview_url
      const premade = (data.voices || [])
        .filter(v => v.category === 'premade' && v.preview_url)
        .map(v => ({
          id: v.voice_id,
          name: v.name,
          preview_url: v.preview_url,
          labels: v.labels || {},
          verified_languages: v.verified_languages || [],
          high_quality_base_model_ids: v.high_quality_base_model_ids || []
        }));
      return res.status(200).json({
        voices: premade,
        count: premade.length,
        ts: Date.now()
      });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── GET ?action=library — vozes da Shared Library do ElevenLabs ───────────
  if (req.method === 'GET' && req.query.action === 'library') {
    if (!EL) return res.status(500).json({ error: 'ElevenLabs não configurado' });
    try {
      const langs = ['pt', 'en', 'es', 'fr', 'de', 'it'];
      const allVoices = [];

      for (const lang of langs) {
        try {
          const r = await fetch(`https://api.elevenlabs.io/v1/shared-voices?page_size=10&language=${lang}&sort=trending`, {
            headers: { 'xi-api-key': EL }
          });
          if (!r.ok) continue;
          const data = await r.json();
          (data.voices || []).forEach(v => {
            if (v.preview_url && !allVoices.find(x => x.id === v.voice_id)) {
              const norm = normalizeVoice({
                name: v.name, labels: { accent: v.accent, language: v.language || lang, gender: v.gender, age: v.age, use_case: v.use_case, description: v.description },
                verified_languages: v.verified_languages, category: v.category
              });
              allVoices.push({
                id: v.voice_id, name: v.name, preview_url: v.preview_url,
                labels: { language: lang, gender: v.gender || '', age: v.age || '', use_case: v.use_case || v.category || '', description: v.description || '' },
                category: v.category || '',
                ...norm
              });
            }
          });
        } catch (e) { continue; }
      }

      if (allVoices.length > 0) return res.status(200).json({ voices: allVoices });

      // Fallback: endpoint clássico
      const r2 = await fetch('https://api.elevenlabs.io/v1/voices', {
        headers: { 'xi-api-key': EL }
      });
      if (r2.ok) {
        const data2 = await r2.json();
        const voices2 = (data2.voices || []).filter(v => v.preview_url).map(v => ({
          id: v.voice_id, name: v.name, preview_url: v.preview_url,
          labels: v.labels || {}, category: v.category || '',
          ...normalizeVoice(v)
        }));
        if (voices2.length > 0) return res.status(200).json({ voices: voices2 });
      }

      return res.status(200).json({ voices: [] });
    } catch (e) {
      console.error('blue-voices library error:', e.message);
      return res.status(500).json({ error: e.message });
    }
  }

  const token = req.method === 'GET' ? req.query.token : req.body?.token;
  if (!token) return res.status(401).json({ error: 'Login necessário' });

  // Valida usuário
  let userId;
  try {
    const uR = await fetch(`${SU}/auth/v1/user`, { headers: { apikey: AK, Authorization: 'Bearer ' + token } });
    if (!uR.ok) return res.status(401).json({ error: 'Token inválido' });
    userId = (await uR.json()).id;
  } catch (e) { return res.status(401).json({ error: 'Token inválido' }); }

  // ── GET ?action=sync-all — re-busca metadados no ElevenLabs e popula DB ───
  if (req.method === 'GET' && req.query.action === 'sync-all') {
    if (!EL) return res.status(500).json({ error: 'ElevenLabs não configurado' });
    try {
      const r = await fetch(`${SU}/rest/v1/blue_custom_voices?user_id=eq.${userId}&select=voice_id,name,lang_code`, { headers: h });
      const rows = r.ok ? await r.json() : [];
      const results = [];
      for (const row of rows) {
        if (row.lang_code) { results.push({ id: row.voice_id, skipped: true }); continue; }
        const vd = await fetchElevenMetadata(row.voice_id, EL);
        if (!vd) { results.push({ id: row.voice_id, ok: false, reason: 'not found' }); continue; }
        const meta = normalizeVoice(vd);
        const patch = await fetch(`${SU}/rest/v1/blue_custom_voices?user_id=eq.${userId}&voice_id=eq.${row.voice_id}`, {
          method: 'PATCH',
          headers: { ...h, Prefer: 'return=minimal' },
          body: JSON.stringify(meta)
        });
        results.push({ id: row.voice_id, ok: patch.ok });
      }
      return res.status(200).json({ ok: true, synced: results.length, results });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // GET — lista vozes do usuário + comunidade (com metadados completos)
  if (req.method === 'GET') {
    try {
      const r = await fetch(
        `${SU}/rest/v1/blue_custom_voices?user_id=eq.${userId}&order=created_at.asc&select=*`,
        { headers: h }
      );
      const myVoices = r.ok ? await r.json() : [];
      const myIds = new Set(myVoices.map(v => v.voice_id));

      let communityVoices = [];
      try {
        const cr = await fetch(
          `${SU}/rest/v1/blue_custom_voices?user_id=neq.${userId}&order=created_at.desc&limit=50&select=*`,
          { headers: h }
        );
        if (cr.ok) {
          const all = await cr.json();
          const seen = new Set();
          communityVoices = all.filter(v => {
            if (myIds.has(v.voice_id) || seen.has(v.voice_id)) return false;
            seen.add(v.voice_id);
            return true;
          }).map(v => ({ ...v, community: true }));
        }
      } catch (e) {}

      return res.status(200).json({ voices: myVoices, community: communityVoices });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  // POST — adiciona voz com metadados reais do ElevenLabs
  if (req.method === 'POST') {
    const { voice_id, name, user_xi_key } = req.body || {};
    if (!voice_id) return res.status(400).json({ error: 'voice_id obrigatório' });

    const finalName = name || 'Voz personalizada';
    const xiKey = user_xi_key || EL;

    let realName = '';
    let previewB64 = '';
    let meta = null;

    if (xiKey) {
      try {
        const vd = await fetchElevenMetadata(voice_id, xiKey);
        if (vd) {
          realName = vd.name || '';
          meta = normalizeVoice(vd);
          // Preview
          if (vd.preview_url) {
            try {
              const pr = await fetch(vd.preview_url);
              if (pr.ok) previewB64 = Buffer.from(await pr.arrayBuffer()).toString('base64');
            } catch (e) {}
          }
          if (!previewB64) {
            try {
              const ttsR = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice_id}`, {
                method: 'POST',
                headers: { 'xi-api-key': xiKey, 'Content-Type': 'application/json', 'Accept': 'audio/mpeg' },
                body: JSON.stringify({ text: 'Olá! Essa é uma prévia da minha voz.', model_id: 'eleven_multilingual_v2', voice_settings: { stability: 0.5, similarity_boost: 0.75 } })
              });
              if (ttsR.ok) previewB64 = Buffer.from(await ttsR.arrayBuffer()).toString('base64');
            } catch (e) {}
          }
        } else {
          console.log('[blue-voices] Voice not accessible via API:', voice_id);
        }
      } catch (e) { console.log('[blue-voices] Check error:', e.message); }
    }

    // Salva com metadados reais (upsert)
    try {
      const payload = {
        user_id: userId,
        voice_id,
        name: realName || finalName,
        ...(meta || {})
      };
      const r = await fetch(`${SU}/rest/v1/blue_custom_voices`, {
        method: 'POST',
        headers: { ...h, Prefer: 'resolution=merge-duplicates,return=representation' },
        body: JSON.stringify(payload)
      });
      const saved = await r.json();
      return res.status(200).json({
        ok: true,
        voice: Array.isArray(saved) ? saved[0] : saved,
        real_name: realName || finalName,
        meta: meta || null,
        preview: previewB64 || null
      });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  // DELETE
  if (req.method === 'DELETE') {
    const { voice_id } = req.body || {};
    if (!voice_id) return res.status(400).json({ error: 'voice_id obrigatório' });
    try {
      await fetch(`${SU}/rest/v1/blue_custom_voices?user_id=eq.${userId}&voice_id=eq.${voice_id}`, {
        method: 'DELETE', headers: h
      });
      return res.status(200).json({ ok: true });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  return res.status(405).end();
};
