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

/**
 * Pre-generate TTS audio for every active clinic's greeting at server
 * startup. Without this, the first inbound call after each deploy pays
 * a 3-5s OpenAI TTS round-trip; callers hear silence and hang up,
 * which surfaces as Telnyx error 90018 "Call has already ended" when
 * our delayed playAudio request finally lands.
 */
async function prewarmGreetings() {
  try {
    const supabase = require('../supabaseClient');
    const { data, error } = await supabase
      .from('telnyx_numbers')
      .select('clinics_digilux:clinic_id ( welcome_message_he )')
      .eq('is_active', true);
    if (error) {
      console.warn('[openaiTts] prewarm: Supabase error:', error.message);
      return;
    }
    const greetings = new Set();
    for (const row of data || []) {
      const g = row?.clinics_digilux?.welcome_message_he;
      if (g) greetings.add(g);
    }
    // Always pre-warm the default + wrong-number greetings too so the
    // unmapped-number path is also instant.
    greetings.add('שלום, הגעתם לקליניקה. אנא המתינו בקו, נציג ייצור איתכם קשר בקרוב.');
    greetings.add('שלום, נראה שהתקשרת לקו שאינו פעיל כרגע. תודה ולהתראות.');

    if (!config.openai?.apiKey) {
      console.warn('[openaiTts] prewarm: OPENAI_API_KEY missing — skipping');
      return;
    }
    console.log(`[openaiTts] prewarming ${greetings.size} greeting(s)…`);
    const start = Date.now();
    await Promise.all(
      [...greetings].map((t) =>
        generateSpeech(t).catch((err) =>
          console.warn('[openaiTts] prewarm one greeting failed:', err.message),
        ),
      ),
    );
    console.log(`[openaiTts] prewarm complete in ${Date.now() - start}ms`);
  } catch (err) {
    console.warn('[openaiTts] prewarm error:', err.message);
  }
}

module.exports = { generateSpeech, getCached, prewarmGreetings };
