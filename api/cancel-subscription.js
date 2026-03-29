// api/cancel-subscription.js
// Allows an authenticated user to cancel their own subscription.
// Verifies the user's token, then downgrades their plan to 'free' in Supabase.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { token } = req.body;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
  const ANON_KEY = process.env.SUPABASE_ANON_KEY || SUPABASE_KEY;

  if (!token) return res.status(401).json({ error: 'Token required' });

  try {
    // Verify the user's token and get their email
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { 'apikey': ANON_KEY, 'Authorization': `Bearer ${token}` }
    });
    if (!userRes.ok) return res.status(401).json({ error: 'Invalid token' });
    const user = await userRes.json();
    const email = user.email;
    if (!email) return res.status(401).json({ error: 'Could not identify user' });

    // Downgrade to free in Supabase
    const patch = await fetch(
      `${SUPABASE_URL}/rest/v1/subscribers?email=eq.${encodeURIComponent(email)}`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Prefer': 'return=representation'
        },
        body: JSON.stringify({
          plan: 'free',
          plan_expires_at: null,
          updated_at: new Date().toISOString()
        })
      }
    );

    const patchData = await patch.json();
    console.log(`Cancel for ${email} - status: ${patch.status} - data:`, JSON.stringify(patchData).slice(0,300));

    if(!patch.ok){
      return res.status(500).json({ error: 'Failed to update: ' + JSON.stringify(patchData) });
    }

    // If no rows updated (user not in subscribers table), insert as free
    if(Array.isArray(patchData) && patchData.length === 0){
      console.log(`No rows found for ${email}, inserting as free`);
      await fetch(`${SUPABASE_URL}/rest/v1/subscribers`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify({
          email, plan: 'free',
          is_manual: false,
          updated_at: new Date().toISOString()
        })
      });
    }

    return res.status(200).json({ success: true, email, plan: 'free' });
  } catch (err) {
    console.error('Cancel subscription error:', err);
    return res.status(500).json({ error: 'Failed to cancel subscription' });
  }
}
