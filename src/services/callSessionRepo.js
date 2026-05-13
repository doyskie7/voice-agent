// ---------------------------------------------------------------------------
// call_sessions persistence helpers. Each inbound call gets one row;
// status transitions over the lifetime: ringing → in_progress → completed
// (or failed / transferred).
// ---------------------------------------------------------------------------
const supabase = require('../supabaseClient');

async function createCallSession({
  clinicId,
  telnyxCallControlId,
  telnyxCallLegId,
  callerNumber,
  toNumber,
}) {
  const { data, error } = await supabase
    .from('call_sessions')
    .insert({
      clinic_id: clinicId,
      telnyx_call_control_id: telnyxCallControlId,
      telnyx_call_leg_id: telnyxCallLegId,
      caller_number: callerNumber,
      to_number: toNumber,
      status: 'ringing',
    })
    .select('id')
    .single();

  if (error) {
    console.error('[callSessionRepo] insert failed:', error.message);
    return null;
  }
  return data.id;
}

async function markAnswered(callControlId) {
  const { error } = await supabase
    .from('call_sessions')
    .update({ status: 'in_progress', answered_at: new Date().toISOString() })
    .eq('telnyx_call_control_id', callControlId);
  if (error) console.error('[callSessionRepo] markAnswered failed:', error.message);
}

async function markCompleted(callControlId, { status = 'completed' } = {}) {
  const endedAt = new Date().toISOString();
  // Compute duration in SQL via answered_at if present — done in a
  // single round-trip by selecting the row, then updating with the
  // computed value.
  const { data: row } = await supabase
    .from('call_sessions')
    .select('id, answered_at')
    .eq('telnyx_call_control_id', callControlId)
    .maybeSingle();

  const update = { status, ended_at: endedAt };
  if (row?.answered_at) {
    update.duration_seconds = Math.max(
      0,
      Math.round((new Date(endedAt).getTime() - new Date(row.answered_at).getTime()) / 1000),
    );
  }

  const { error } = await supabase
    .from('call_sessions')
    .update(update)
    .eq('telnyx_call_control_id', callControlId);
  if (error) console.error('[callSessionRepo] markCompleted failed:', error.message);
}

async function findByCallControlId(callControlId) {
  const { data } = await supabase
    .from('call_sessions')
    .select('*')
    .eq('telnyx_call_control_id', callControlId)
    .maybeSingle();
  return data || null;
}

module.exports = {
  createCallSession,
  markAnswered,
  markCompleted,
  findByCallControlId,
};
