// api/_helpers/push.js — Envio de push via Expo Push API (CommonJS)
// Doc: https://docs.expo.dev/push-notifications/sending-notifications/
// Expo Push não exige auth, a segurança vem do token do dispositivo.

const EXPO_URL = 'https://exp.host/--/api/v2/push/send';

async function sendPushToUser(userId, { title, body, data, sound, priority } = {}) {
  const SU = process.env.SUPABASE_URL;
  const SK = process.env.SUPABASE_SERVICE_KEY;
  if (!SU || !SK) return { ok: false, error: 'config_missing' };

  const h = { apikey: SK, Authorization: 'Bearer ' + SK };
  const tR = await fetch(
    `${SU}/rest/v1/user_push_tokens?user_id=eq.${userId}&select=expo_push_token`,
    { headers: h }
  );
  if (!tR.ok) return { ok: false, error: 'db_fail', status: tR.status };
  const rows = await tR.json();
  if (!rows.length) return { ok: true, sent: 0 };

  const messages = rows
    .map((r) => r.expo_push_token)
    .filter((t) => typeof t === 'string' && t.startsWith('ExponentPushToken'))
    .map((to) => ({
      to,
      sound: sound || 'default',
      title: title || 'BlueTube',
      body: body || '',
      data: data || {},
      priority: priority || 'high',
    }));

  if (!messages.length) return { ok: true, sent: 0 };

  try {
    const r = await fetch(EXPO_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(messages),
    });
    const d = await r.json().catch(() => ({}));
    // Tokens com status=error + DeviceNotRegistered são limpos do banco
    const invalid = [];
    if (Array.isArray(d.data)) {
      d.data.forEach((receipt, i) => {
        if (receipt.status === 'error' && receipt.details && receipt.details.error === 'DeviceNotRegistered') {
          invalid.push(messages[i].to);
        }
      });
    }
    if (invalid.length) {
      const inList = invalid.map((t) => `"${t}"`).join(',');
      await fetch(`${SU}/rest/v1/user_push_tokens?expo_push_token=in.(${inList})`, {
        method: 'DELETE',
        headers: h,
      }).catch(() => {});
    }
    return { ok: true, sent: messages.length - invalid.length, invalid: invalid.length };
  } catch (e) {
    console.error('[push] envio falhou:', e.message);
    return { ok: false, error: e.message };
  }
}

// Envio em LOTE (fan-out: "criador que você segue postou"). 1 query pega os
// tokens de TODOS os userIds; Expo aceita até 100 mensagens por request.
async function sendPushToUsers(userIds, { title, body, data, sound, priority } = {}) {
  const SU = process.env.SUPABASE_URL;
  const SK = process.env.SUPABASE_SERVICE_KEY;
  if (!SU || !SK || !Array.isArray(userIds) || !userIds.length) return { ok: false, sent: 0 };
  const h = { apikey: SK, Authorization: 'Bearer ' + SK };
  const ids = userIds.slice(0, 1000).map(encodeURIComponent).join(',');
  const tR = await fetch(`${SU}/rest/v1/user_push_tokens?user_id=in.(${ids})&select=expo_push_token`, { headers: h });
  if (!tR.ok) return { ok: false, error: 'db_fail' };
  const tokens = (await tR.json())
    .map((r) => r.expo_push_token)
    .filter((t) => typeof t === 'string' && t.startsWith('ExponentPushToken'));
  if (!tokens.length) return { ok: true, sent: 0 };
  let sent = 0;
  for (let i = 0; i < tokens.length; i += 100) {
    const messages = tokens.slice(i, i + 100).map((to) => ({
      to, sound: sound || 'default', title: title || 'BlueTube', body: body || '',
      data: data || {}, priority: priority || 'high',
    }));
    try {
      const r = await fetch(EXPO_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(messages),
      });
      const d = await r.json().catch(() => ({}));
      const invalid = [];
      if (Array.isArray(d.data)) {
        d.data.forEach((receipt, k) => {
          if (receipt.status === 'error' && receipt.details && receipt.details.error === 'DeviceNotRegistered') {
            invalid.push(messages[k].to);
          }
        });
      }
      if (invalid.length) {
        const inList = invalid.map((t) => `"${t}"`).join(',');
        await fetch(`${SU}/rest/v1/user_push_tokens?expo_push_token=in.(${inList})`, { method: 'DELETE', headers: h }).catch(() => {});
      }
      sent += messages.length - invalid.length;
    } catch (e) { /* chunk falhou: segue os próximos */ }
  }
  return { ok: true, sent };
}

module.exports = { sendPushToUser, sendPushToUsers };
