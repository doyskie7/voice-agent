// ---------------------------------------------------------------------------
// POST /api/telnyx/webhook
//
// Phase 1 scope:
//   call.initiated      → look up clinic; kick off TTS pre-fetch; answer
//   call.answered       → await pre-fetched audio; playback_start immediately
//   call.playback.ended → hangup (farewell calls only)
//   call.hangup         → mark call_sessions row completed
// ---------------------------------------------------------------------------
const express = require('express');
const router = express.Router();

const config = require('../config');
const telnyx = require('../services/telnyxClient');
const { verifyTelnyxSignature } = require('../services/telnyxSignature');
const { findClinicByTelnyxNumber } = require('../services/clinicLookup');
const repo = require('../services/callSessionRepo');
const openaiTts = require('../services/openaiTts');

// Calls for which we issued a farewell playback — hang up when playback ends.
const farewellCalls = new Set();

// TTS is pre-generated during call.initiated so it's ready by call.answered.
// Key: callControlId → Promise<{ key: string }>
const pendingAudio = new Map();

const DEFAULT_GREETING_HE =
  'שלום, הגעתם לקליניקה. אנא המתינו בקו, נציג ייצור איתכם קשר בקרוב.';
const WRONG_NUMBER_HE =
  'שלום, נראה שהתקשרת לקו שאינו פעיל כרגע. תודה ולהתראות.';

router.post('/webhook', async (req, res) => {
  const raw = req.body instanceof Buffer ? req.body.toString('utf8') : '';
  const sigOk = verifyTelnyxSignature(raw, req.headers);
  if (!sigOk) {
    console.warn('[telnyx/webhook] signature verification failed');
    return res.status(401).json({ error: 'invalid_signature' });
  }

  let payload;
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch (e) {
    console.warn('[telnyx/webhook] non-JSON body:', e.message);
    return res.status(400).json({ error: 'invalid_json' });
  }

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
    case 'call.playback.ended':
    case 'call.speak.ended':
      return handlePlaybackEnded(callControlId);
    case 'call.hangup':
      return handleHangup(callControlId);
    default:
      console.log(`[telnyx/webhook] ignoring event ${eventType}`);
  }
}

async function handleInitiated(ev, callControlId, callLegId) {
  if (ev.direction !== 'incoming') {
    console.log('[telnyx/webhook] ignoring non-incoming initiated event');
    return;
  }

  const toNumber = ev.to;
  const fromNumber = ev.from;
  const clinic = await findClinicByTelnyxNumber(toNumber);

  if (!clinic) {
    console.warn(`[telnyx/webhook] no clinic mapping for ${toNumber} — answering with wrong-number greeting`);
    // Pre-fetch wrong-number audio in parallel with answering.
    pendingAudio.set(callControlId, openaiTts.generateSpeech(WRONG_NUMBER_HE));
    try {
      await telnyx.answer(callControlId);
    } catch (err) {
      console.error('[telnyx/webhook] answer failed for unmapped number:', err.response?.data || err.message);
      pendingAudio.delete(callControlId);
    }
    return;
  }

  const greeting = clinic.clinics_digilux?.welcome_message_he || DEFAULT_GREETING_HE;

  // Kick off TTS generation NOW, in parallel with the DB write + answer,
  // so the audio is ready (or nearly ready) by the time call.answered fires.
  pendingAudio.set(callControlId, openaiTts.generateSpeech(greeting));

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
    pendingAudio.delete(callControlId);
    await repo.markCompleted(callControlId, { status: 'failed' });
  }
}

async function handleAnswered(ev, callControlId) {
  await repo.markAnswered(callControlId);

  // Retrieve the pre-fetched TTS promise (started during call.initiated).
  const audioPromise = pendingAudio.get(callControlId);
  pendingAudio.delete(callControlId);

  // Fallback if call.answered fires without a prior call.initiated (unlikely).
  const session = await repo.findByCallControlId(callControlId);
  const fallbackText = session
    ? null  // will use audioPromise which already has the right text
    : WRONG_NUMBER_HE;

  farewellCalls.add(callControlId);
  try {
    const { key } = await (audioPromise || openaiTts.generateSpeech(fallbackText || DEFAULT_GREETING_HE));
    const audioUrl = `https://${config.publicHostname}/api/audio/${key}`;
    await telnyx.playAudio(callControlId, audioUrl);
  } catch (err) {
    console.error('[telnyx/webhook] playback failed:', JSON.stringify(err.response?.data ?? err.message, null, 2));
    await telnyx.hangup(callControlId).catch(() => {});
  }
}

async function handlePlaybackEnded(callControlId) {
  if (!farewellCalls.has(callControlId)) return;
  farewellCalls.delete(callControlId);
  try {
    await telnyx.hangup(callControlId);
  } catch (err) {
    if (err.response?.status !== 404) {
      console.error('[telnyx/webhook] hangup failed:', err.response?.data || err.message);
    }
  }
}

async function handleHangup(callControlId) {
  farewellCalls.delete(callControlId);
  pendingAudio.delete(callControlId);
  await repo.markCompleted(callControlId, { status: 'completed' });
}

module.exports = router;
