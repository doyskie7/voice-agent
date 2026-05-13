// ---------------------------------------------------------------------------
// telnyx_numbers → clinic_id resolver.
//
// Every inbound call carries the dialled number under `to`. We use it
// to find which clinic owns this Telnyx line. If no row matches the
// call is from an unprovisioned number — caller hears a polite
// "wrong number" greeting and the call ends.
//
// Cached in-process for 30s to avoid hitting Supabase on every webhook
// (Telnyx fires several events per call: initiated, answered, hangup).
// ---------------------------------------------------------------------------
const supabase = require('../supabaseClient');

const CACHE_TTL_MS = 30_000;
const cache = new Map(); // phone → { fetchedAt, row | null }

/**
 * Normalise a phone number to E.164 with leading "+".
 * Telnyx delivers numbers in E.164 already (e.g. "+972521234567") but
 * we strip whitespace + force the leading "+" for safety.
 */
function normaliseE164(raw) {
  if (!raw) return null;
  const trimmed = String(raw).trim().replace(/\s+/g, '');
  if (!trimmed) return null;
  return trimmed.startsWith('+') ? trimmed : `+${trimmed.replace(/\D/g, '')}`;
}

/**
 * Look up the clinic that owns `phoneNumber`. Returns the full
 * telnyx_numbers row joined with the clinic name + welcome message,
 * or null if no active mapping exists.
 */
async function findClinicByTelnyxNumber(phoneNumber) {
  const normalised = normaliseE164(phoneNumber);
  if (!normalised) return null;

  const cached = cache.get(normalised);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.row;
  }

  const { data, error } = await supabase
    .from('telnyx_numbers')
    .select(
      `
      id,
      clinic_id,
      phone_number,
      telnyx_connection_id,
      is_active,
      clinics_digilux:clinic_id (
        id,
        name,
        welcome_message_he,
        welcome_message_en,
        transfer_phone_number,
        operating_hours
      )
    `,
    )
    .eq('phone_number', normalised)
    .eq('is_active', true)
    .maybeSingle();

  if (error) {
    console.error('[clinicLookup] Supabase error:', error.message);
    return null;
  }

  const row = data || null;
  cache.set(normalised, { fetchedAt: Date.now(), row });
  return row;
}

function invalidateCache() {
  cache.clear();
}

module.exports = { findClinicByTelnyxNumber, normaliseE164, invalidateCache };
