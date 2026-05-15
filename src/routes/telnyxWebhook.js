// ---------------------------------------------------------------------------
// POST /api/telnyx/webhook
//
// Single entry point for every Telnyx Call Control event for this app.
// Telnyx delivers events for the entire call lifecycle (initiated →
// answered → ... → hangup) and expects a 2xx response within a few
// seconds, otherwise it retries. We acknowledge immediately and run
// any side-effects (REST calls back to Telnyx, Supabase writes) in the
// background so a slow Supabase write never causes Telnyx to re-deliver.
//
// Phase 1 scope:
//   call.initiated → look up clinic by `to`; if found: answer
//   call.answered  → speak the per-clinic Hebrew greeting → hangup
//   call.hangup    → mark call_sessions row completed
//   call.speak.ended → (only when we issued a speak that should end the
//                       call; flagged via an in-memory set)
//
// Phase 2 will swap the speak-on-answered behaviour for
// streaming_start. The handler is structured so that swap is a
// localised change.
// ---------------------------------------------------------------------------
const express = require('express');
const router = express.Router();

const config = require('../config');
const telnyx = require('../services/telnyxClient');
const { verifyTelnyxSignature } = require('../services/telnyxSignature');
const { findClinicByTelnyxNumber } = require('../services/clinicLookup');
const repo = require('../services/callSessionRepo');
const openaiTts = require('../services/openaiTts');

// Calls for which we issued a "farewell speak" — when speak.ended
// fires for these, we should hang up immediately. Cleared on hangup.
const farewellCalls = new Set();

// Default greeting used when a clinic's welcome_message_he is empty.
// Deliberately generic and short.
const DEFAULT_GREETING_HE =
  'שלום, הגעתם לקליניקה. אנא המתינו בקו, נציג ייצור איתכם קשר בקרוב.';
const WRONG_NUMBER_HE =
  'שלום, נראה שהתקשרת לקו שאינו פעיל כרגע. תודה ולהתראות.';

router.post('/webhook', async (req, res) => {
  // Telnyx signature verification — uses the raw body we captured in
  // server.js (express.raw). req.body is a Buffer; convert to string
  // for both verification and JSON parsing.
  const raw = req.body instanceof Buffer ? req.body.toString('utf8') : '';
  const sigOk = verifyTelnyxSignature(raw, req.headers);
  if (!sigOk) {
    console.warn('[telnyx/webhook] signature verification failed');
    // 401 — Telnyx will retry briefly, then give up. That's the right
    // posture: an unverified caller shouldn't be able to drive our
    // Call Control commands.
    return res.status(401).json({ error: 'invalid_signature' });
  }

  let payload;
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch (e) {
    console.warn('[telnyx/webhook] non-JSON body:', e.message);
    return res.status(400).json({ error: 'invalid_json' });
  }

  // Acknowledge fast; do the actual work in the background so Telnyx
  // never retries because Supabase or its own API was slow.
  res.status(200).json({ ok: true });

  processEvent(payload).catch((err) => {
    console.error('[telnyx/webhook] processEvent error:', err.message, err.stack);
  });
});

async function processEvent(payload) {
  const eventType = payload?.data?.event_type;
  const ev = payload?.data?.payload || {};
  const callControlId = ev.call_control_id;
  const callLegId = ev.call_leg_id;

  if (!eventType) {
    console.warn('[telnyx/webhook] event without event_type:', JSON.stringify(payload).slice(0, 300));
    return;
  }

  console.log(`[telnyx/webhook] ${eventType}  ccid=${callControlId?.slice(0, 8) || '?'}…`);

  switch (eventType) {
    case 'call.initiated':
      return handleInitiated(ev, callControlId, callLegId);
    case 'call.answered':
      return handleAnswered(ev, callControlId);
    case 'call.speak.ended':
      return handleSpeakEnded(callControlId);
    case 'call.playback.ended':
      return handleSpeakEnded(callControlId); // same teardown logic
    case 'call.hangup':
      return handleHangup(callControlId);
    default:
      // Many event types fire that we don't care about in Phase 1
      // (call.bridged, call.machine.detection.ended, etc.). Log at
      // debug volume and move on.
      console.log(`[telnyx/webhook] ignoring event ${eventType}`);
  }
}

async function handleInitiated(ev, callControlId, callLegId) {
  // Only act on inbound calls — outbound legs we initiate (future) will
  // also generate call.initiated events that we MUST ignore here.
  if (ev.direction !== 'incoming') {
    console.log('[telnyx/webhook] ignoring non-incoming initiated event');
    return;
  }

  const toNumber = ev.to;
  const fromNumber = ev.from;
  const clinic = await findClinicByTelnyxNumber(toNumber);

  if (!clinic) {
    console.warn(
      `[telnyx/webhook] no clinic mapping for ${toNumber} — answering with wrong-number greeting`,
    );
    // Still create a session row (clinic_id null is rejected by FK,
    // so we just skip the DB write here — operations can still see
    // the orphan via Telnyx logs).
    try {
      await telnyx.answer(callControlId);
      // call.answered will fire and we'll speak the wrong-number message there.
      farewellCalls.add(callControlId);
    } catch (err) {
      console.error('[telnyx/webhook] answer failed for unmapped number:', err.response?.data || err.message);
    }
    return;
  }

  // Persist the call row BEFORE answering so an immediate hangup still
  // leaves a trace.
  await repo.createCallSession({
    clinicId: clinic.clinic_id,
    telnyxCallControlId: callControlId,
    telnyxCallLegId: callLegId,
    callerNumber: fromNumber,
    toNumber,
  });

  try {
    await telnyx.answer(callControlId);
  } catch (err) {
    console.error('[telnyx/webhook] answer failed:', err.response?.data || err.message);
    await repo.markCompleted(callControlId, { status: 'failed' });
  }
}

async function handleAnswered(ev, callControlId) {
  await repo.markAnswered(callControlId);

  // Resolve clinic from session (don't re-query Telnyx number — the
  // session row already has clinic_id).
  const session = await repo.findByCallControlId(callControlId);
  // If this was an unmapped number we marked above, just speak the
  // wrong-number text and hang up.
  if (!session) {
    farewellCalls.add(callControlId);
    try {
      const { key } = await openaiTts.generateSpeech(WRONG_NUMBER_HE);
      const audioUrl = `https://${config.publicHostname}/api/audio/${key}`;
      await telnyx.playAudio(callControlId, audioUrl);
    } catch (err) {
      console.error('[telnyx/webhook] wrong-number playback failed:', JSON.stringify(err.response?.data ?? err.message, null, 2));
      await telnyx.hangup(callControlId).catch(() => {});
    }
    return;
  }

  // Look up the clinic's Hebrew greeting via the cached lookup.
  const clinicRow = await findClinicByTelnyxNumber(session.to_number);
  const greeting =
    clinicRow?.clinics_digilux?.welcome_message_he ||
    DEFAULT_GREETING_HE;

  // PHASE 1 behaviour: speak the greeting, then hang up when speak ends.
  // PHASE 2 will replace this block with a call to telnyx.startMediaStreaming(...)
  // pointing at our wss:// audio bridge.
  farewellCalls.add(callControlId);
  try {
    const { key } = await openaiTts.generateSpeech(greeting);
    const audioUrl = `https://${config.publicHostname}/api/audio/${key}`;
    await telnyx.playAudio(callControlId, audioUrl);
  } catch (err) {
    console.error('[telnyx/webhook] greeting playback failed:', JSON.stringify(err.response?.data ?? err.message, null, 2));
    await telnyx.hangup(callControlId).catch(() => {});
  }
}

async function handleSpeakEnded(callControlId) {
  // Only hang up if this call was flagged as a one-shot speak (Phase 1
  // greetings + wrong-number). In Phase 2+ most calls won't be in this
  // set, so speak.ended is a no-op.
  if (!farewellCalls.has(callControlId)) return;
  farewellCalls.delete(callControlId);
  try {
    await telnyx.hangup(callControlId);
  } catch (err) {
    // 404 just means the call already ended — fine.
    if (err.response?.status !== 404) {
      console.error('[telnyx/webhook] hangup failed:', err.response?.data || err.message);
    }
  }
}

async function handleHangup(callControlId) {
  farewellCalls.delete(callControlId);
  await repo.markCompleted(callControlId, { status: 'completed' });
}

module.exports = router;
