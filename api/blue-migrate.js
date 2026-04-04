// api/blue-migrate.js — Adds columns to blue_variations for Shotstack rendering
// Uses Supabase's internal SQL execution via database connection
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const secret = req.body?.secret || req.query?.secret;
  if (secret !== 'bluehorizon-migrate-2026') return res.status(403).json({ error: 'Invalid secret' });

  const SU = process.env.SUPABASE_URL;
  const SK = process.env.SUPABASE_SERVICE_KEY;
  if (!SU || !SK) return res.status(500).json({ error: 'Config missing' });
  const h = { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' };

  // Test if columns exist
  const testR = await fetch(`${SU}/rest/v1/blue_variations?select=shotstack_render_id&limit=0`, { headers: h });
  if (testR.ok) return res.status(200).json({ message: 'Columns already exist' });

  // Columns don't exist — we need to add them
  // Try using a database function if it exists, or guide the user
  // Attempt: create an RPC function that runs the ALTER
  const createFnSql = `
    CREATE OR REPLACE FUNCTION public.run_migration()
    RETURNS text LANGUAGE plpgsql SECURITY DEFINER AS $$
    BEGIN
      ALTER TABLE blue_variations ADD COLUMN IF NOT EXISTS shotstack_render_id TEXT;
      ALTER TABLE blue_variations ADD COLUMN IF NOT EXISTS render_status TEXT DEFAULT 'pending';
      RETURN 'done';
    END;
    $$;
  `;

  // We can't create functions via REST either, so let's try a workaround:
  // Use the Supabase Management API to execute SQL
  const ref = 'pokpfvjrccviwgguwuck';

  // Try the database/query endpoint (requires service role or management key)
  const sqlR = await fetch(`${SU}/rest/v1/rpc/run_migration`, {
    method: 'POST',
    headers: h,
    body: '{}'
  });

  if (sqlR.ok) {
    return res.status(200).json({ message: 'Migration completed via RPC' });
  }

  return res.status(200).json({
    message: 'Cannot run ALTER TABLE via REST API. Please run this SQL in Supabase Dashboard > SQL Editor:',
    sql: "ALTER TABLE blue_variations ADD COLUMN IF NOT EXISTS shotstack_render_id TEXT;\nALTER TABLE blue_variations ADD COLUMN IF NOT EXISTS render_status TEXT DEFAULT 'pending';",
    dashboard_url: `https://supabase.com/dashboard/project/${ref}/sql`
  });
};
