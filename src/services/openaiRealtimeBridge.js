// ---------------------------------------------------------------------------
// OpenAI Realtime ↔ Telnyx Media Streaming bridge.
//
// One bridge instance = one phone call. Two WebSockets:
//
//   Telnyx ──(g711_ulaw, 8kHz)──► us ──(g711_ulaw)──► OpenAI Realtime
//   Telnyx ◄─(g711_ulaw, 8kHz)── us ◄─(g711_ulaw)── OpenAI Realtime
//
// LATENCY BUDGET — why we prepare() early
// =======================================
// In the naive design (open OpenAI WS only after Telnyx WS sends the
// start event), the caller hears 2-3 seconds of silence after pickup:
//
//   t=0      call.answered
//   t≈0.05   streaming_start command sent
//   t≈1.2    Telnyx connects to /ws/media and emits `start`
//   t≈1.2    we open OpenAI WS         ◄─ TLS + handshake (~600ms)
//   t≈1.8    OpenAI ready, session.update + response.create
//   t≈2.5    first audio frame reaches caller
//
// Most callers give up around 1.5s of silence. So the webhook now calls
// `prepare(callControlId)` immediately after answering — that opens the
// OpenAI WS in parallel with streaming_start. By the time the Telnyx
// WS arrives, OpenAI has already received session.update and can
// generate audio the instant we say `response.create`. This collapses
// the silence to ~Telnyx WS connect time + first-token (~700ms total).
//
// Protocol references:
//   Telnyx:  https://developers.telnyx.com/docs/voice/programmable-voice/media-streaming
//   OpenAI:  https://platform.openai.com/docs/guides/realtime
// ---------------------------------------------------------------------------
const WebSocket = require('ws');
const config = require('../config');
const { findClinicByTelnyxNumber } = require('./clinicLookup');
const repo = require('./callSessionRepo');

// callControlId → Bridge — populated by prepare(), drained by the WS
// upgrade handler when Telnyx connects, or by call.hangup if the call
// ends before the WS arrives.
const bridges = new Map();

// callControlIds we've already seen call.hangup for. If Telnyx's media
// WS races and arrives AFTER the hangup webhook, the lazy-create path
// would otherwise spin up an orphan bridge that has no hangup signal
// and sits open until Telnyx times out the stream (observed: 11 min).
// Retain for 60s — long enough to catch the race, short enough to free
// memory on a long-running process.
const hungUpCallIds = new Map(); // ccid → expiry timestamp ms
function markHungUp(ccid) {
  if (!ccid) return;
  hungUpCallIds.set(ccid, Date.now() + 60_000);
}
function wasHungUp(ccid) {
  const exp = hungUpCallIds.get(ccid);
  if (!exp) return false;
  if (Date.now() > exp) {
    hungUpCallIds.delete(ccid);
    return false;
  }
  return true;
}

// Bridges that have prepared OpenAI but haven't seen a Telnyx WS yet,
// in arrival order. Telnyx's `start` event carries the call_control_id
// so we don't actually need this fallback, but keep a short retention
// in case Telnyx ever omits it.
const orphanBridges = [];
const ORPHAN_TTL_MS = 30_000;

const DEFAULT_GREETING_HE =
  'שלום, הגעתם לקליניקה. אנא המתינו בקו, נציג ייצור איתכם קשר בקרוב.';

const FALLBACK_INSTRUCTIONS_HE = [
  'אתה עוזר טלפוני קולי של מרפאה רפואית בישראל.',
  'דבר אך ורק בעברית ברורה ונעימה.',
  'תפקידך לקבל את הפונה, להבין מה הוא צריך, ולעזור לו לקבוע, להזיז, או לבטל תור.',
  'דבר באופן טבעי וקצר. אל תקריא מספרים ארוכים אלא אם נשאלת.',
  'אם אינך יודע משהו ספציפי, הצע להעביר את השיחה לנציג אנושי.',
  'אל תמציא שעות זמינות או פרטים שאינם ידועים לך — שאל את המשתמש או השתמש בכלים.',
].join(' ');

class RealtimeBridge {
  constructor(callControlId) {
    this.callControlId = callControlId;
    this.telnyxWs = null;
    this.openaiWs = null;
    this.openaiReady = false;
    this.streamId = null;
    this.clinic = null;
    this.greeting = DEFAULT_GREETING_HE;
    this.closed = false;
    this.greetingSent = false;
    // Inbound audio frames that arrive before OpenAI's session is
    // configured — buffered and flushed once openaiReady=true.
    this.pendingInboundAudio = [];
  }

  // -----------------------------------------------------------------------
  // Phase A — called from the webhook on call.answered. Resolves clinic
  // context and opens the OpenAI WS in parallel with streaming_start.
  // -----------------------------------------------------------------------
  async prepare() {
    try {
      const session = await repo.findByCallControlId(this.callControlId);
      if (session) {
        const clinic = await findClinicByTelnyxNumber(session.to_number);
        if (clinic) {
          this.clinic = clinic;
          this.greeting = clinic.clinics_digilux?.welcome_message_he || DEFAULT_GREETING_HE;
        }
      }
    } catch (err) {
      console.warn('[bridge] prepare clinic lookup failed:', err.message);
    }
    this.connectOpenAI();
  }

  connectOpenAI() {
    if (!config.openai.apiKey) {
      console.error('[bridge] OPENAI_API_KEY missing — cannot start Realtime session');
      return this.shutdown('no_openai_key');
    }
    const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(config.openai.realtimeModel)}`;
    this.openaiWs = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${config.openai.apiKey}`,
        // No `OpenAI-Beta: realtime=v1` — Realtime is GA. Sending the
        // beta header is now rejected with beta_api_shape_disabled.
      },
    });
    this.openaiWs.on('open', () => this.onOpenAIOpen());
    this.openaiWs.on('message', (raw) => this.handleOpenAIMessage(raw));
    this.openaiWs.on('close', (code, reason) => {
      console.log(`[bridge] openai ws closed code=${code} reason=${reason?.toString() || ''}`);
      this.shutdown('openai_close');
    });
    this.openaiWs.on('error', (err) => {
      console.error('[bridge] openai ws error:', err.message);
    });
    // The default 'error' event for a handshake rejection just says
    // "closed before established", which hides the real reason. The
    // 'unexpected-response' event exposes the HTTP status and body so
    // we can see e.g. 401 (bad key), 403 (no Realtime access), 404
    // (unknown model). Without this listener we'd be flying blind.
    this.openaiWs.on('unexpected-response', (_req, res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk.toString(); });
      res.on('end', () => {
        console.error(
          `[bridge] openai ws upgrade rejected status=${res.statusCode} body=${body.slice(0, 500)} model=${config.openai.realtimeModel}`,
        );
      });
    });
  }

  onOpenAIOpen() {
    console.log(`[bridge] openai ws open ccid=${this.callControlId.slice(0, 8)}…`);
    const clinicName = this.clinic?.clinics_digilux?.name || 'המרפאה';
    const instructions =
      `${FALLBACK_INSTRUCTIONS_HE}\n\nשם המרפאה: ${clinicName}.\n` +
      `ברכת פתיחה לדבר ראשון: "${this.greeting}".`;

    // GA Realtime session shape (post Aug 2025). Major differences
    // from the beta shape used previously:
    //   - audio.input.format / audio.output.format are OBJECTS, not
    //     plain strings. PCMU = { type: 'audio/pcmu' }.
    //   - voice lives under audio.output.voice
    //   - transcription + turn_detection move under audio.input.*
    //   - modalities → output_modalities (audio-only here; text comes
    //     back via response.output_audio_transcript.* events)
    this.sendOpenAI({
      type: 'session.update',
      session: {
        // GA requires a `type` discriminator on the session object —
        // 'realtime' is the only value for the Realtime API. Omitting
        // it returns: Missing required parameter: 'session.type'.
        type: 'realtime',
        instructions,
        output_modalities: ['audio'],
        audio: {
          input: {
            format: { type: 'audio/pcmu' },
            transcription: { model: 'whisper-1' },
            turn_detection: {
              type: 'server_vad',
              threshold: 0.5,
              prefix_padding_ms: 300,
              silence_duration_ms: 500,
            },
          },
          output: {
            format: { type: 'audio/pcmu' },
            // 'shimmer' tends to sound the warmest in he-IL among the
            // OpenAI Realtime voices and works well for clinic UX.
            voice: 'shimmer',
          },
        },
      },
    });
    this.openaiReady = true;

    // Flush any audio frames that arrived from Telnyx while we were
    // still negotiating with OpenAI.
    if (this.pendingInboundAudio.length > 0) {
      for (const b64 of this.pendingInboundAudio) {
        this.sendOpenAI({ type: 'input_audio_buffer.append', audio: b64 });
      }
      this.pendingInboundAudio.length = 0;
    }

    // If Telnyx's WS is already attached and we know the stream_id, we
    // can fire the greeting now. Otherwise this is deferred until
    // attachTelnyxWebSocket runs (whichever comes second triggers it).
    this.maybeSendGreeting();
  }

  maybeSendGreeting() {
    if (this.greetingSent) return;
    if (!this.openaiReady) return;
    if (!this.telnyxWs || !this.streamId) return;
    this.greetingSent = true;
    this.sendOpenAI({
      type: 'response.create',
      response: {
        // GA: output_modalities (was `modalities` in beta).
        output_modalities: ['audio'],
        instructions: `אמור עכשיו את ברכת הפתיחה הבאה בעברית בקול חם וטבעי: "${this.greeting}". אל תוסיף דבר אחריה — חכה שהמתקשר ידבר.`,
      },
    });
  }

  // -----------------------------------------------------------------------
  // Phase B — Telnyx Media Streaming WS arrives at /ws/media. The WS
  // upgrade handler in server.js parses the first `start` event to get
  // the call_control_id, then calls attachTelnyxWebSocket().
  // -----------------------------------------------------------------------
  attachTelnyxWebSocket(ws, startMsg) {
    this.telnyxWs = ws;
    this.streamId = startMsg.stream_id || startMsg.streamSid || startMsg.start?.stream_id || null;
    console.log(
      `[bridge] telnyx ws attached ccid=${this.callControlId.slice(0, 8)}… stream=${this.streamId?.slice(0, 8) || '?'}…`,
    );

    ws.on('message', (raw) => this.handleTelnyxMessage(raw));
    ws.on('close', () => this.shutdown('telnyx_close'));
    ws.on('error', (err) => {
      console.error('[bridge] telnyx ws error:', err.message);
      this.shutdown('telnyx_error');
    });

    // Start streaming μ-law silence immediately so the carrier sees an
    // active media path. Observed behaviour without this: the call gets
    // dropped at ~1.5-2s before OpenAI produces real audio, presumably
    // because either the carrier or Telnyx's own watchdog terminates a
    // leg that has no outbound media activity. The interval is canceled
    // by sendTelnyxMedia() the moment the first real OpenAI audio
    // frame arrives.
    this.startComfortNoise();

    this.maybeSendGreeting();
  }

  startComfortNoise() {
    if (this.comfortNoiseTimer) return;
    // 20ms of μ-law silence = 160 bytes of 0xFF (μ-law silence value).
    // Pre-encoded once so we're not allocating each tick.
    if (!RealtimeBridge.silenceFrameB64) {
      RealtimeBridge.silenceFrameB64 = Buffer.alloc(160, 0xff).toString('base64');
    }
    const frame = RealtimeBridge.silenceFrameB64;
    this.comfortNoiseTimer = setInterval(() => {
      if (!this.telnyxWs || this.telnyxWs.readyState !== WebSocket.OPEN) return;
      if (!this.streamId) return;
      // Use raw send (NOT sendTelnyxMedia) so we don't accidentally
      // cancel the timer from inside its own tick.
      this.sendTelnyx({
        event: 'media',
        stream_id: this.streamId,
        media: { payload: frame },
      });
    }, 20);
    // unref so it doesn't keep the process alive during shutdown.
    this.comfortNoiseTimer.unref?.();
  }

  stopComfortNoise() {
    if (!this.comfortNoiseTimer) return;
    clearInterval(this.comfortNoiseTimer);
    this.comfortNoiseTimer = null;
  }

  handleTelnyxMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (_) {
      return;
    }
    switch (msg.event) {
      case 'media':
        return this.handleTelnyxMedia(msg);
      case 'stop':
        return this.shutdown('telnyx_stop');
      case 'mark':
      case 'dtmf':
      case 'connected':
      case 'start':
        return;
      default:
        return;
    }
  }

  handleTelnyxMedia(msg) {
    const payload = msg.media?.payload;
    if (!payload) return;
    if (!this.openaiWs || this.openaiWs.readyState !== WebSocket.OPEN || !this.openaiReady) {
      // Buffer until OpenAI session is ready — drop oldest if it grows
      // unreasonably (>2s of audio, 100 frames of 20ms each).
      if (this.pendingInboundAudio.length < 100) {
        this.pendingInboundAudio.push(payload);
      }
      return;
    }
    this.sendOpenAI({ type: 'input_audio_buffer.append', audio: payload });
  }

  handleOpenAIMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (_) {
      return;
    }
    switch (msg.type) {
      // GA event names. The old beta names (response.audio.delta,
      // response.audio.done, response.audio_transcript.done) were
      // renamed during the GA migration — keep the old names too as
      // a fallback in case OpenAI ever ships compatibility events.
      case 'response.output_audio.delta':
      case 'response.audio.delta':
        this.sendTelnyxMedia(msg.delta);
        return;
      case 'input_audio_buffer.speech_started':
        // Caller started speaking while AI was still talking — clear
        // Telnyx's outbound audio queue so the AI cuts off and the
        // caller doesn't have to talk over a long monologue.
        this.sendTelnyx({ event: 'clear', stream_id: this.streamId });
        return;
      case 'response.done':
      case 'response.output_audio.done':
      case 'response.audio.done':
      case 'session.created':
      case 'session.updated':
        return;
      case 'error':
        console.error('[bridge] openai error:', JSON.stringify(msg.error || msg));
        return;
      case 'conversation.item.input_audio_transcription.completed':
        if (msg.transcript) console.log(`[bridge] caller said: "${msg.transcript}"`);
        return;
      case 'response.output_audio_transcript.done':
      case 'response.audio_transcript.done':
        if (msg.transcript) console.log(`[bridge] AI said: "${msg.transcript}"`);
        return;
      default:
        return;
    }
  }

  sendTelnyxMedia(b64ulaw) {
    if (!this.streamId) return;
    // First real audio from OpenAI — stop pumping silence so we don't
    // mix comfort frames in with the AI's voice (Telnyx will play
    // every frame we send in order).
    if (this.comfortNoiseTimer) this.stopComfortNoise();
    this.sendTelnyx({
      event: 'media',
      stream_id: this.streamId,
      media: { payload: b64ulaw },
    });
  }

  sendTelnyx(obj) {
    if (!this.telnyxWs || this.telnyxWs.readyState !== WebSocket.OPEN) return;
    try {
      this.telnyxWs.send(JSON.stringify(obj));
    } catch (err) {
      console.error('[bridge] telnyx send error:', err.message);
    }
  }

  sendOpenAI(obj) {
    if (!this.openaiWs || this.openaiWs.readyState !== WebSocket.OPEN) return;
    try {
      this.openaiWs.send(JSON.stringify(obj));
    } catch (err) {
      console.error('[bridge] openai send error:', err.message);
    }
  }

  shutdown(reason) {
    if (this.closed) return;
    this.closed = true;
    console.log(
      `[bridge] shutdown reason=${reason} ccid=${this.callControlId?.slice(0, 8) || '?'}…`,
    );
    this.stopComfortNoise();
    bridges.delete(this.callControlId);
    try { this.openaiWs?.close(); } catch (_) {}
    try { this.telnyxWs?.close(); } catch (_) {}
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Phase A — webhook calls this on call.answered, BEFORE telnyx.streaming_start
 * (or in parallel). Opens the OpenAI Realtime WS so it's already configured
 * by the time Telnyx connects. Idempotent per callControlId.
 */
async function prepare(callControlId) {
  if (!callControlId) return null;
  if (bridges.has(callControlId)) return bridges.get(callControlId);
  const b = new RealtimeBridge(callControlId);
  bridges.set(callControlId, b);
  // Reap stale bridges if Telnyx never connects (e.g. caller hangs up
  // during streaming_start).
  setTimeout(() => {
    if (!b.closed && !b.telnyxWs) {
      console.warn(`[bridge] orphaned bridge timeout ccid=${callControlId.slice(0, 8)}…`);
      b.shutdown('orphan_timeout');
    }
  }, ORPHAN_TTL_MS).unref();
  await b.prepare();
  return b;
}

/**
 * Phase B — server.js WS upgrade handler invokes this for every incoming
 * /ws/media connection. We wait for Telnyx's `start` event (which
 * carries call_control_id), then attach the WS to the matching prepared
 * bridge. If no bridge was prepared (Telnyx connected before our
 * handleAnswered ran), we lazily prepare one here as a fallback.
 */
function attachToWebSocket(ws) {
  let attached = false;

  const onMessage = async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (_) {
      return;
    }
    if (msg.event !== 'start') {
      // Telnyx sends `connected` first, then `start`. Drop anything
      // until start so we have the call_control_id.
      return;
    }
    if (attached) return;
    attached = true;

    const ccid =
      msg.start?.call_control_id ||
      msg.start?.callControlId ||
      msg.call_control_id ||
      null;

    if (!ccid) {
      console.error('[bridge] start event missing call_control_id; closing ws');
      try { ws.close(); } catch (_) {}
      return;
    }

    if (wasHungUp(ccid)) {
      // Race: call.hangup webhook arrived before Telnyx's media WS.
      // Without this guard the lazy-create branch below would build a
      // brand-new bridge that has no hangup signal and would survive
      // until Telnyx times out the stream (observed: 11 minutes).
      console.warn(`[bridge] ws arrived for hung-up call ccid=${ccid.slice(0, 8)}… — closing`);
      try { ws.close(); } catch (_) {}
      return;
    }

    let bridge = bridges.get(ccid);
    if (!bridge) {
      // Late attach: webhook handler hasn't created the bridge yet.
      // Create it and start the OpenAI connection now.
      console.warn(`[bridge] no prepared bridge for ccid=${ccid.slice(0, 8)}… — creating lazily`);
      bridge = new RealtimeBridge(ccid);
      bridges.set(ccid, bridge);
      // Don't await — we want to attach the WS first so audio buffering works.
      bridge.prepare();
    }

    // Drop the temp listener and let the bridge own the WS now.
    ws.removeListener('message', onMessage);
    bridge.attachTelnyxWebSocket(ws, msg);
  };

  ws.on('message', onMessage);
  ws.on('close', () => {
    if (!attached) {
      console.warn('[bridge] ws closed before start event arrived');
    }
  });
  ws.on('error', (err) => {
    console.error('[bridge] /ws/media early error:', err.message);
  });
}

function shutdownBridgeByCallControlId(ccid, reason = 'external') {
  // Record the hangup regardless of whether a bridge currently exists,
  // so a late-arriving Telnyx WS for this call is rejected by the
  // attach handler instead of spinning up an orphan bridge.
  if (reason === 'call_hangup') markHungUp(ccid);
  const b = bridges.get(ccid);
  if (b) b.shutdown(reason);
}

module.exports = {
  prepare,
  attachToWebSocket,
  shutdownBridgeByCallControlId,
};
