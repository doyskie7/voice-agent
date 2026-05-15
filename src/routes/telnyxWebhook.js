// ---------------------------------------------------------------------------
// POST /api/telnyx/webhook
//
// Phase 2 scope (streaming):
//   call.initiated  → look up clinic, persist call_sessions row, answer
//   call.answered   → streaming_start — Telnyx opens WS to /ws/media
//                     where the OpenAI Realtime bridge takes over. The
//                     bridge speaks the greeting itself (no playAudio).
//   call.hangup     → mark call_sessions completed; bridge teardown is
//                     driven by the WS close from Telnyx
// ---------------------------------------------------------------------------
const express = require('express');
const router = express.Router();

const config = require('../config');
const telnyx = require('../services/telnyxClient');
const { verifyTelnyxSignature } = require('../services/telnyxSignature');
const { findClinicByTelnyxNumber } = require('../services/clinicLookup');
const repo = require('../services/callSessionRepo');
const realtimeBridge = require('../services/openaiRealtimeBridge');

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
    case 'call.hangup':
      return handleHangup(callControlId);
    case 'streaming.started':
    case 'streaming.stopped':
    case 'streaming.failed':
      console.log(
        `[telnyx/webhook] ${eventType}:`,
        JSON.stringify({
          stream_id: ev.stream_id,
          stream_url: ev.stream_url,
          reason: ev.reason || ev.failure_reason,
        }),
      );
      return;
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
    console.warn(`[telnyx/webhook] no clinic mapping for ${toNumber} — hanging up`);
    // Without a clinic we have no system prompt and no booking context.
    // Reject early instead of streaming silence — the caller hears the
    // line drop, which is the right UX for a wrong number.
    try {
      await telnyx.hangup(callControlId);
    } catch (err) {
      // Best-effort — if hangup fails the call will time out anyway.
    }
    return;
  }

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

  if (!config.publicHostname) {
    console.error('[telnyx/webhook] PUBLIC_HOSTNAME missing — cannot start media streaming');
    await telnyx.hangup(callControlId).catch(() => {});
    return;
  }

  // Telnyx will dial this URL to push/pull audio frames. The path must
  // match the WS upgrade handler in server.js.
  const streamUrl = `wss://${config.publicHostname}/ws/media`;

  // Open the OpenAI Realtime WS NOW, in parallel with streaming_start,
  // so by the time Telnyx connects to /ws/media the AI is already
  // configured and can start speaking immediately. This shaves ~1s of
  // silence after pickup, which is the difference between callers
  // hearing the greeting vs. hanging up thinking the line is dead.
  realtimeBridge.prepare(callControlId).catch((err) =>
    console.error('[telnyx/webhook] bridge prepare failed:', err.message),
  );

  try {
    console.log(`[telnyx/webhook] streaming_start → ${streamUrl}`);
    await telnyx.startMediaStreaming(callControlId, streamUrl);
  } catch (err) {
    console.error(
      '[telnyx/webhook] streaming_start failed:',
      JSON.stringify(err.response?.data ?? err.message, null, 2),
    );
    realtimeBridge.shutdownBridgeByCallControlId(callControlId, 'streaming_start_failed');
    await telnyx.hangup(callControlId).catch(() => {});
  }
}

async function handleHangup(callControlId) {
  // Tear down the bridge if it's still alive (Telnyx normally closes
  // the WS first, but on abrupt disconnects this is the backstop).
  realtimeBridge.shutdownBridgeByCallControlId(callControlId, 'call_hangup');
  await repo.markCompleted(callControlId, { status: 'completed' });
}

module.exports = router;
