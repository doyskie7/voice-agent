// ---------------------------------------------------------------------------
// OpenAI Realtime ↔ Telnyx Media Streaming bridge.
//
// One bridge instance = one phone call. Two WebSockets:
//
//   Telnyx ──(g711_ulaw 8kHz)──► us ──(g711_ulaw)──► OpenAI Realtime
//   Telnyx ◄─(g711_ulaw 8kHz)── us ◄─(g711_ulaw)── OpenAI Realtime
//
// LATENCY BUDGET
// ==============
// prepare() opens the OpenAI WS immediately (no waiting for DB) so by
// the time Telnyx fires call.answered the handshake is already done.
// DB queries run in parallel. maybeSendGreeting() fires the moment both
// sides are ready; the caller hears the greeting within ~700ms of pickup.
// ---------------------------------------------------------------------------
const WebSocket = require('ws');
const config = require('../config');
const { findClinicByTelnyxNumber } = require('./clinicLookup');
const repo = require('./callSessionRepo');

const bridges = new Map();

// callControlIds we've seen call.hangup for — reject late Telnyx WS arrivals.
const hungUpCallIds = new Map();
function markHungUp(ccid) {
  if (!ccid) return;
  hungUpCallIds.set(ccid, Date.now() + 60_000);
}
function wasHungUp(ccid) {
  const exp = hungUpCallIds.get(ccid);
  if (!exp) return false;
  if (Date.now() > exp) { hungUpCallIds.delete(ccid); return false; }
  return true;
}

const ORPHAN_TTL_MS = 30_000;

const DEFAULT_GREETING_HE =
  'שלום, הגעתם לקליניקה. אנא המתינו בקו, נציג ייצור איתכם קשר בקרוב.';

const FALLBACK_INSTRUCTIONS_HE = [
  'אתה עוזר טלפוני קולי של מרפאה רפואית בישראל.',
  'דבר אך ורק בעברית ברורה ונעימה.',
  'תפקידך לקבל את הפונה, להבין מה הוא צריך, ולעזור לו לקבוע, להזיז, או לבטל תור.',
  'דבר באופן טבעי וקצר. אל תקריא מספרים ארוכים אלא אם נשאלת.',
  'אם אינך יודע משהו ספציפי, הצע להעביר את השיחה לנציג אנושי.',
  'אל תמציא שעות זמינות — שאל את המתקשר או השתמש בכלים.',
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
    this.pendingInboundAudio = [];
  }

  // -------------------------------------------------------------------------
  // Phase A — called from webhook on call.answered.
  // OpenAI WS opens FIRST (no waiting for DB) so it's ready by the time
  // Telnyx connects. DB query runs in parallel.
  // -------------------------------------------------------------------------
  async prepare() {
    // Start OpenAI connection immediately — every ms we delay is silence.
    this.connectOpenAI();

    // Load clinic context in parallel — if it resolves before OpenAI's
    // session.created we update greeting/instructions in time for the ACK.
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
  }

  connectOpenAI() {
    if (!config.openai.apiKey) {
      console.error('[bridge] OPENAI_API_KEY missing');
      return this.shutdown('no_openai_key');
    }
    const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(config.openai.realtimeModel)}`;
    this.openaiWs = new WebSocket(url, {
      headers: { Authorization: `Bearer ${config.openai.apiKey}` },
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
    // Exposes the real HTTP status/body when the upgrade is rejected (401, 403, 404, etc.)
    this.openaiWs.on('unexpected-response', (_req, res) => {
      let body = '';
      res.on('data', (c) => { body += c.toString(); });
      res.on('end', () => {
        console.error(
          `[bridge] openai upgrade rejected status=${res.statusCode} body=${body.slice(0, 500)} model=${config.openai.realtimeModel}`,
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

    // Correct OpenAI Realtime session.update shape.
    // - modalities / voice / input_audio_format / output_audio_format at session root
    // - input_audio_transcription + turn_detection also at session root
    // - audio format string: 'g711_ulaw' (PCMU μ-law 8kHz) — native to Telnyx,
    //   no resampling needed on either side.
    this.sendOpenAI({
      type: 'session.update',
      session: {
        modalities: ['audio'],
        instructions,
        voice: 'shimmer',
        input_audio_format: 'g711_ulaw',
        output_audio_format: 'g711_ulaw',
        input_audio_transcription: { model: 'whisper-1' },
        turn_detection: {
          type: 'server_vad',
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 500,
        },
      },
    });

    this.openaiReady = true;

    // Flush any Telnyx audio that arrived before OpenAI was ready.
    if (this.pendingInboundAudio.length > 0) {
      for (const b64 of this.pendingInboundAudio) {
        this.sendOpenAI({ type: 'input_audio_buffer.append', audio: b64 });
      }
      this.pendingInboundAudio.length = 0;
    }

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
        modalities: ['audio'],
        instructions: `אמור עכשיו את ברכת הפתיחה הבאה בעברית בקול חם וטבעי: "${this.greeting}". אל תוסיף דבר אחריה — חכה שהמתקשר ידבר.`,
      },
    });
  }

  // -------------------------------------------------------------------------
  // Phase B — /ws/media WS arrives. server.js parses the start event
  // (which carries call_control_id) then calls attachTelnyxWebSocket().
  // -------------------------------------------------------------------------
  attachTelnyxWebSocket(ws, startMsg) {
    this.telnyxWs = ws;
    this.streamId =
      startMsg.stream_id ||
      startMsg.streamSid ||
      startMsg.start?.stream_id ||
      null;
    console.log(
      `[bridge] telnyx ws attached ccid=${this.callControlId.slice(0, 8)}… stream=${this.streamId?.slice(0, 8) || '?'}…`,
    );

    ws.on('message', (raw) => this.handleTelnyxMessage(raw));
    ws.on('close', () => this.shutdown('telnyx_close'));
    ws.on('error', (err) => {
      console.error('[bridge] telnyx ws error:', err.message);
      this.shutdown('telnyx_error');
    });

    // Send μ-law silence immediately so Telnyx/carrier sees an active media
    // path. Stops the moment OpenAI sends its first real audio frame.
    this.startComfortNoise();
    this.maybeSendGreeting();
  }

  startComfortNoise() {
    if (this.comfortNoiseTimer) return;
    if (!RealtimeBridge.silenceFrameB64) {
      RealtimeBridge.silenceFrameB64 = Buffer.alloc(160, 0xff).toString('base64');
    }
    const frame = RealtimeBridge.silenceFrameB64;
    this.comfortNoiseTimer = setInterval(() => {
      if (!this.telnyxWs || this.telnyxWs.readyState !== WebSocket.OPEN) return;
      if (!this.streamId) return;
      this.sendTelnyx({ event: 'media', stream_id: this.streamId, media: { payload: frame } });
    }, 20);
    this.comfortNoiseTimer.unref?.();
  }

  stopComfortNoise() {
    if (!this.comfortNoiseTimer) return;
    clearInterval(this.comfortNoiseTimer);
    this.comfortNoiseTimer = null;
  }

  handleTelnyxMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (_) { return; }
    switch (msg.event) {
      case 'media':   return this.handleTelnyxMedia(msg);
      case 'stop':    return this.shutdown('telnyx_stop');
      default:        return;
    }
  }

  handleTelnyxMedia(msg) {
    const payload = msg.media?.payload;
    if (!payload) return;
    if (!this.openaiWs || this.openaiWs.readyState !== WebSocket.OPEN || !this.openaiReady) {
      if (this.pendingInboundAudio.length < 100) this.pendingInboundAudio.push(payload);
      return;
    }
    this.sendOpenAI({ type: 'input_audio_buffer.append', audio: payload });
  }

  handleOpenAIMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (_) { return; }
    switch (msg.type) {
      case 'response.audio.delta':
        this.sendTelnyxMedia(msg.delta);
        return;
      case 'input_audio_buffer.speech_started':
        // Caller interrupted — cut off the AI's current audio immediately.
        this.sendTelnyx({ event: 'clear', stream_id: this.streamId });
        return;
      case 'error':
        console.error('[bridge] openai error event:', JSON.stringify(msg.error || msg));
        return;
      case 'conversation.item.input_audio_transcription.completed':
        if (msg.transcript) console.log(`[bridge] caller: "${msg.transcript}"`);
        return;
      case 'response.audio_transcript.done':
        if (msg.transcript) console.log(`[bridge] AI: "${msg.transcript}"`);
        return;
      // Informational — no action needed.
      case 'session.created':
      case 'session.updated':
      case 'response.done':
      case 'response.audio.done':
      case 'response.created':
      case 'response.output_item.added':
      case 'response.output_item.done':
      case 'response.content_part.added':
      case 'response.content_part.done':
      case 'conversation.item.created':
      case 'input_audio_buffer.committed':
      case 'input_audio_buffer.cleared':
      case 'input_audio_buffer.speech_stopped':
        return;
      default:
        return;
    }
  }

  sendTelnyxMedia(b64ulaw) {
    if (!this.streamId) return;
    // First real audio from OpenAI — stop the silence filler.
    if (this.comfortNoiseTimer) this.stopComfortNoise();
    this.sendTelnyx({ event: 'media', stream_id: this.streamId, media: { payload: b64ulaw } });
  }

  sendTelnyx(obj) {
    if (!this.telnyxWs || this.telnyxWs.readyState !== WebSocket.OPEN) return;
    try { this.telnyxWs.send(JSON.stringify(obj)); } catch (err) {
      console.error('[bridge] telnyx send error:', err.message);
    }
  }

  sendOpenAI(obj) {
    if (!this.openaiWs || this.openaiWs.readyState !== WebSocket.OPEN) return;
    try { this.openaiWs.send(JSON.stringify(obj)); } catch (err) {
      console.error('[bridge] openai send error:', err.message);
    }
  }

  shutdown(reason) {
    if (this.closed) return;
    this.closed = true;
    console.log(`[bridge] shutdown reason=${reason} ccid=${this.callControlId?.slice(0, 8) || '?'}…`);
    this.stopComfortNoise();
    bridges.delete(this.callControlId);
    try { this.openaiWs?.close(); } catch (_) {}
    try { this.telnyxWs?.close(); } catch (_) {}
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

async function prepare(callControlId) {
  if (!callControlId) return null;
  if (bridges.has(callControlId)) return bridges.get(callControlId);
  const b = new RealtimeBridge(callControlId);
  bridges.set(callControlId, b);
  setTimeout(() => {
    if (!b.closed && !b.telnyxWs) {
      console.warn(`[bridge] orphaned bridge timeout ccid=${callControlId.slice(0, 8)}…`);
      b.shutdown('orphan_timeout');
    }
  }, ORPHAN_TTL_MS).unref();
  await b.prepare();
  return b;
}

function attachToWebSocket(ws) {
  let attached = false;

  const onMessage = async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (_) { return; }
    if (msg.event !== 'start') return;
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
      console.warn(`[bridge] ws arrived for hung-up call ccid=${ccid.slice(0, 8)}… — closing`);
      try { ws.close(); } catch (_) {}
      return;
    }

    let bridge = bridges.get(ccid);
    if (!bridge) {
      console.warn(`[bridge] no prepared bridge for ccid=${ccid.slice(0, 8)}… — creating lazily`);
      bridge = new RealtimeBridge(ccid);
      bridges.set(ccid, bridge);
      bridge.prepare();
    }

    ws.removeListener('message', onMessage);
    bridge.attachTelnyxWebSocket(ws, msg);
  };

  ws.on('message', onMessage);
  ws.on('close', () => { if (!attached) console.warn('[bridge] ws closed before start event'); });
  ws.on('error', (err) => console.error('[bridge] /ws/media early error:', err.message));
}

function shutdownBridgeByCallControlId(ccid, reason = 'external') {
  if (reason === 'call_hangup') markHungUp(ccid);
  const b = bridges.get(ccid);
  if (b) b.shutdown(reason);
}

module.exports = { prepare, attachToWebSocket, shutdownBridgeByCallControlId };
