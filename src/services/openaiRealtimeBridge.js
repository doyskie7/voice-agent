// ---------------------------------------------------------------------------
// OpenAI Realtime ↔ Telnyx Media Streaming bridge.
//
// One bridge instance = one phone call. Two WebSockets:
//
//   Telnyx ──(g711_ulaw, 8kHz)──► us ──(g711_ulaw)──► OpenAI Realtime
//   Telnyx ◄─(g711_ulaw, 8kHz)── us ◄─(g711_ulaw)── OpenAI Realtime
//
// Protocol references:
//   - Telnyx:  https://developers.telnyx.com/docs/voice/programmable-voice/media-streaming
//   - OpenAI:  https://platform.openai.com/docs/guides/realtime
//
// Both sides exchange μ-law base64 audio in ~20ms frames, so no codec
// conversion is needed — we just shuttle base64 strings between two
// JSON WebSocket dialects.
//
// Lifecycle:
//   1. Telnyx connects to us (after we issue streaming_start). It sends
//      `connected` → `start` (with call_control_id, stream_id, encoding).
//   2. We open the OpenAI WS, send session.update with the system
//      prompt + voice + audio formats + tools, then a response.create
//      so the model speaks the greeting first.
//   3. Frames flow until either side disconnects or the call hangs up.
//   4. We close both sockets and let the route handler mark the call
//      session completed.
// ---------------------------------------------------------------------------
const WebSocket = require('ws');
const config = require('../config');
const { findClinicByTelnyxNumber } = require('./clinicLookup');
const repo = require('./callSessionRepo');

// Map: callControlId → Bridge instance, so the webhook handler can
// terminate the bridge from the outside on call.hangup if Telnyx hasn't
// closed the WS yet.
const activeBridges = new Map();

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
  constructor(telnyxWs) {
    this.telnyxWs = telnyxWs;
    this.openaiWs = null;
    this.streamId = null;
    this.callControlId = null;
    this.clinic = null;
    this.greeting = DEFAULT_GREETING_HE;
    this.closed = false;

    telnyxWs.on('message', (raw) => this.handleTelnyxMessage(raw));
    telnyxWs.on('close', () => this.shutdown('telnyx_close'));
    telnyxWs.on('error', (err) => {
      console.error('[bridge] telnyx ws error:', err.message);
      this.shutdown('telnyx_error');
    });
  }

  async handleTelnyxMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (_) {
      return;
    }

    switch (msg.event) {
      case 'connected':
        // Initial handshake — nothing to do until `start` arrives.
        return;
      case 'start':
        return this.handleStart(msg);
      case 'media':
        return this.handleTelnyxMedia(msg);
      case 'stop':
        return this.shutdown('telnyx_stop');
      case 'mark':
      case 'dtmf':
        // Phase 2: ignored. We may use marks to track playback completion later.
        return;
      default:
        return;
    }
  }

  async handleStart(msg) {
    this.streamId = msg.stream_id || msg.streamSid || msg.start?.stream_id;
    this.callControlId =
      msg.start?.call_control_id ||
      msg.start?.callControlId ||
      msg.call_control_id;

    if (!this.callControlId) {
      console.error('[bridge] start event missing call_control_id; closing');
      return this.shutdown('missing_ccid');
    }

    activeBridges.set(this.callControlId, this);
    console.log(
      `[bridge] start ccid=${this.callControlId.slice(0, 8)}… stream=${this.streamId?.slice(0, 8) || '?'}…`,
    );

    // Resolve clinic context. The webhook already did this on call.initiated
    // and stored a row in call_sessions; we read it back here to avoid
    // a second Supabase round-trip.
    const session = await repo.findByCallControlId(this.callControlId);
    if (session) {
      const clinic = await findClinicByTelnyxNumber(session.to_number);
      if (clinic) {
        this.clinic = clinic;
        this.greeting = clinic.clinics_digilux?.welcome_message_he || DEFAULT_GREETING_HE;
      }
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
        'OpenAI-Beta': 'realtime=v1',
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
      this.shutdown('openai_error');
    });
  }

  onOpenAIOpen() {
    console.log('[bridge] openai ws connected — sending session.update');
    const clinicName = this.clinic?.clinics_digilux?.name || 'המרפאה';
    const instructions =
      `${FALLBACK_INSTRUCTIONS_HE}\n\nשם המרפאה: ${clinicName}.\n` +
      `ברכת פתיחה לדבר ראשון: "${this.greeting}".`;

    this.sendOpenAI({
      type: 'session.update',
      session: {
        modalities: ['audio', 'text'],
        instructions,
        // 'alloy' / 'shimmer' / 'verse' / 'sage' all support Hebrew via
        // OpenAI Realtime's multilingual training. 'shimmer' tends to
        // sound the warmest in he-IL and works well for clinics.
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
        temperature: 0.8,
      },
    });

    // Trigger the greeting immediately. Without this, OpenAI waits for
    // the caller to speak first — which would feel broken: the caller
    // picks up and hears silence.
    this.sendOpenAI({
      type: 'response.create',
      response: {
        modalities: ['audio'],
        instructions: `אמור עכשיו את ברכת הפתיחה הבאה בעברית בקול חם וטבעי: "${this.greeting}". אל תוסיף דבר אחריה — חכה שהמתקשר ידבר.`,
      },
    });
  }

  handleOpenAIMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (_) {
      return;
    }

    switch (msg.type) {
      case 'response.audio.delta':
        // OpenAI returns base64 g711_ulaw — Telnyx accepts the same
        // format directly, so no transcoding needed.
        this.sendTelnyxMedia(msg.delta);
        return;
      case 'input_audio_buffer.speech_started':
        // Caller started speaking while AI was talking — clear Telnyx's
        // pending playback queue so the AI's voice cuts off and the
        // caller doesn't have to talk over a long monologue.
        this.sendTelnyx({ event: 'clear', stream_id: this.streamId });
        return;
      case 'response.audio.done':
      case 'response.done':
      case 'session.created':
      case 'session.updated':
        return;
      case 'error':
        console.error('[bridge] openai error event:', JSON.stringify(msg.error || msg));
        return;
      case 'conversation.item.input_audio_transcription.completed':
        if (msg.transcript) {
          console.log(`[bridge] caller said: "${msg.transcript}"`);
        }
        return;
      case 'response.audio_transcript.done':
        if (msg.transcript) {
          console.log(`[bridge] AI said: "${msg.transcript}"`);
        }
        return;
      default:
        return;
    }
  }

  handleTelnyxMedia(msg) {
    // Forward inbound audio frames to OpenAI as g711_ulaw.
    const payload = msg.media?.payload;
    if (!payload || !this.openaiWs || this.openaiWs.readyState !== WebSocket.OPEN) {
      return;
    }
    this.sendOpenAI({
      type: 'input_audio_buffer.append',
      audio: payload,
    });
  }

  sendTelnyxMedia(b64ulaw) {
    if (!this.streamId) return;
    this.sendTelnyx({
      event: 'media',
      stream_id: this.streamId,
      media: { payload: b64ulaw },
    });
  }

  sendTelnyx(obj) {
    if (this.telnyxWs.readyState !== WebSocket.OPEN) return;
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
    console.log(`[bridge] shutdown reason=${reason} ccid=${this.callControlId?.slice(0, 8) || '?'}`);
    if (this.callControlId) activeBridges.delete(this.callControlId);
    try { this.openaiWs?.close(); } catch (_) {}
    try { this.telnyxWs.close(); } catch (_) {}
  }
}

function attachToWebSocket(ws) {
  // Telnyx may send an immediate `connected` and we don't want to lose
  // it — wire up the bridge before any messages can arrive.
  return new RealtimeBridge(ws);
}

function getBridgeByCallControlId(ccid) {
  return activeBridges.get(ccid) || null;
}

function shutdownBridgeByCallControlId(ccid, reason = 'external') {
  const b = activeBridges.get(ccid);
  if (b) b.shutdown(reason);
}

module.exports = {
  attachToWebSocket,
  getBridgeByCallControlId,
  shutdownBridgeByCallControlId,
};
