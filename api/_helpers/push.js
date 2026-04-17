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

module.exports = { sendPushToUser };
