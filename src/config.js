// ---------------------------------------------------------------------------
// Central env-var loader. Anything that reaches into process.env should go
// through here so we have a single audit point for required vs optional
// configuration. Mirrors the pattern used by claude-agent/src/config.js.
// ---------------------------------------------------------------------------
require('dotenv').config();

module.exports = {
  port: process.env.PORT ? Number(process.env.PORT) : 3100,
  publicHostname: process.env.PUBLIC_HOSTNAME || null,

  supabase: {
    url: process.env.SUPABASE_URL,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  },

  telnyx: {
    apiKey: process.env.TELNYX_API_KEY || '',
    publicKey: process.env.TELNYX_PUBLIC_KEY || '',
    // Telnyx Call Control v2 base URL — unlikely to change but kept
    // overridable for staging environments.
    apiBaseUrl: process.env.TELNYX_API_BASE_URL || 'https://api.telnyx.com/v2',
  },

  openai: {
    apiKey: process.env.OPENAI_API_KEY || '',
    // Realtime model. The alias 'gpt-4o-realtime-preview' always points to
    // the current supported snapshot — safer than pinning a dated version
    // that OpenAI may deprecate without notice.
    realtimeModel:
      process.env.OPENAI_REALTIME_MODEL || 'gpt-4o-realtime-preview',
  },

  // Bridge into claude-agent's existing HTTP API. Voice agent never
  // touches Optima / Google Calendar directly — it goes through these
  // routes so booking semantics stay identical to the WhatsApp flow.
  botApi: {
    url: process.env.BOT_API_URL || '',
    key: process.env.BOT_API_KEY || '',
  },
};
