// ---------------------------------------------------------------------------
// Telnyx Call Control v2 REST helpers.
//
// Telnyx is asymmetric: it sends WEBHOOKS to us when call events occur,
// and we send COMMANDS back via REST. The webhook payload carries a
// `call_control_id` for the leg — that's the only thing every command
// below needs to address the right call. Reference:
//   https://developers.telnyx.com/api/call-control/answer-call
// ---------------------------------------------------------------------------
const axios = require('axios');
const config = require('../config');

const http = axios.create({
  baseURL: config.telnyx.apiBaseUrl,
  timeout: 10_000,
  headers: {
    Authorization: `Bearer ${config.telnyx.apiKey}`,
    'Content-Type': 'application/json',
  },
});

function ensureKey() {
  if (!config.telnyx.apiKey) {
    throw new Error('TELNYX_API_KEY not set — cannot issue Call Control commands');
  }
}

async function answer(callControlId) {
  ensureKey();
  const { data } = await http.post(
    `/calls/${encodeURIComponent(callControlId)}/actions/answer`,
    {},
  );
  return data;
}

/**
 * Speak text to the caller using Telnyx-hosted TTS. Used in Phase 1 for
 * the static greeting and end-of-call farewell. In Phase 2+ we replace
 * this with OpenAI Realtime audio streamed over media WS.
 *
 * @param {string}  callControlId
 * @param {string}  text     — what to say
 * @param {string}  language — Telnyx voice locale, e.g. 'he-IL', 'en-US', 'ar-XA'
 * @param {string}  voice    — Telnyx voice, e.g. 'female', 'male', or a specific Polly voice
 */
async function speak(callControlId, text, language = 'he-IL', voice = 'Shlomo') {
  ensureKey();
  const { data } = await http.post(
    `/calls/${encodeURIComponent(callControlId)}/actions/speak`,
    { payload: text, language, voice, service_level: 'basic' },
  );
  return data;
}

async function hangup(callControlId) {
  ensureKey();
  const { data } = await http.post(
    `/calls/${encodeURIComponent(callControlId)}/actions/hangup`,
    {},
  );
  return data;
}

/**
 * Start bidirectional media streaming for the call. Telnyx will open a
 * WebSocket to `streamUrl` and pump μ-law 8 kHz audio frames in both
 * directions. Used in Phase 2 to bridge into OpenAI Realtime.
 *
 * @param {string} callControlId
 * @param {string} streamUrl     — wss:// URL of this service's audio bridge
 */
async function startMediaStreaming(callControlId, streamUrl) {
  ensureKey();
  const { data } = await http.post(
    `/calls/${encodeURIComponent(callControlId)}/actions/streaming_start`,
    {
      stream_url: streamUrl,
      stream_track: 'both_tracks',
      // Default codec is PCMU (μ-law 8 kHz) which OpenAI Realtime
      // accepts natively as 'g711_ulaw' — no resampling required.
    },
  );
  return data;
}

/**
 * Transfer the call to a human (the clinic's transfer_phone_number).
 * Used in Phase 3 when the AI calls the `transfer_to_human` tool.
 */
async function transfer(callControlId, toNumber) {
  ensureKey();
  const { data } = await http.post(
    `/calls/${encodeURIComponent(callControlId)}/actions/transfer`,
    { to: toNumber },
  );
  return data;
}

/**
 * Play a remote audio file (MP3/WAV URL) to the caller.
 * Used instead of speak() for languages Telnyx TTS doesn't support (e.g. he-IL).
 * Fires call.playback.ended when done.
 */
async function playAudio(callControlId, audioUrl) {
  ensureKey();
  const { data } = await http.post(
    `/calls/${encodeURIComponent(callControlId)}/actions/playback_start`,
    { audio_url: audioUrl },
  );
  return data;
}

module.exports = { answer, speak, hangup, startMediaStreaming, transfer, playAudio };
