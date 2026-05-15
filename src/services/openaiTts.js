// ---------------------------------------------------------------------------
// OpenAI TTS helper. Used in Phase 1 to generate Hebrew greeting audio
// because Telnyx's built-in speak command does not support he-IL.
//
// Audio buffers are cached in-memory keyed by a hash of the text so
// repeated calls to the same clinic don't hit the OpenAI API twice.
// ---------------------------------------------------------------------------
const axios = require('axios');
const crypto = require('crypto');
const config = require('../config');

const cache = new Map();

/**
 * Generate speech for `text` using OpenAI TTS. Returns the cache key and
 * the audio buffer (MP3). Subsequent calls with the same text return the
 * cached buffer without hitting the API again.
 */
async function generateSpeech(text, voice = 'nova') {
  const key = crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
  if (cache.has(key)) return { key, buffer: cache.get(key) };

  const response = await axios.post(
    'https://api.openai.com/v1/audio/speech',
    { model: 'tts-1', input: text, voice, response_format: 'mp3' },
    {
      headers: {
        Authorization: `Bearer ${config.openai.apiKey}`,
        'Content-Type': 'application/json',
      },
      responseType: 'arraybuffer',
      timeout: 15_000,
    },
  );

  const buffer = Buffer.from(response.data);
  cache.set(key, buffer);
  return { key, buffer };
}

function getCached(key) {
  return cache.get(key) ?? null;
}

module.exports = { generateSpeech, getCached };
