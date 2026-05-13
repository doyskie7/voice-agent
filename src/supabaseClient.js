// ---------------------------------------------------------------------------
// Single Supabase service-role client for the whole voice-agent process.
// Service role is required because we write into call_sessions /
// call_messages without an authenticated user context (Telnyx is the
// caller, not a clinic admin).
// ---------------------------------------------------------------------------
const { createClient } = require('@supabase/supabase-js');
const config = require('./config');

if (!config.supabase.url || !config.supabase.serviceRoleKey) {
  // We don't crash at import time so `node -c` and unit tests still run;
  // the first DB call will fail loudly with a clearer error.
  console.warn(
    '[voice-agent] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing — Supabase calls will fail.',
  );
}

const supabase = createClient(
  config.supabase.url || 'http://placeholder',
  config.supabase.serviceRoleKey || 'placeholder',
  {
    auth: { persistSession: false, autoRefreshToken: false },
  },
);

module.exports = supabase;
