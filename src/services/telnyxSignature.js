// ---------------------------------------------------------------------------
// Telnyx webhook signature verification.
//
// Telnyx signs every webhook with Ed25519. They send two headers:
//   telnyx-signature-ed25519   — base64 signature
//   telnyx-timestamp           — unix seconds (string)
// The message-to-verify is `${timestamp}|${rawBody}`. The public key is
// distributed once per portal user (TELNYX_PUBLIC_KEY env var).
//
// We use Node's built-in `crypto.verify` so no extra dependency is
// needed. Reference:
//   https://developers.telnyx.com/docs/v2/development/webhooks
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const config = require('../config');

// Reject events older than 5 minutes — defends against replayed webhooks.
const MAX_AGE_SECONDS = 5 * 60;

function verifyTelnyxSignature(rawBody, headers) {
  // In development you may run without the public key set; refuse to
  // verify silently — log and return true so local testing isn't
  // blocked, but in production the missing key should be loud.
  if (!config.telnyx.publicKey) {
    console.warn('[telnyxSignature] TELNYX_PUBLIC_KEY not set — skipping verification');
    return true;
  }

  const signature = headers['telnyx-signature-ed25519'];
  const timestamp = headers['telnyx-timestamp'];
  if (!signature || !timestamp) return false;

  const tsNum = Number(timestamp);
  if (!Number.isFinite(tsNum)) return false;
  const ageSec = Math.abs(Date.now() / 1000 - tsNum);
  if (ageSec > MAX_AGE_SECONDS) {
    console.warn(`[telnyxSignature] timestamp too old (${ageSec.toFixed(1)}s)`);
    return false;
  }

  const message = Buffer.from(`${timestamp}|${rawBody}`, 'utf8');
  try {
    // Telnyx provides a raw 32-byte Ed25519 public key in base64. Node's
    // createPublicKey requires DER/SPKI format, which prepends a fixed
    // 12-byte algorithm identifier header to the raw key bytes.
    const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
    const rawKey = Buffer.from(config.telnyx.publicKey, 'base64');
    const derKey = Buffer.concat([ED25519_SPKI_PREFIX, rawKey]);
    const publicKey = crypto.createPublicKey({ key: derKey, format: 'der', type: 'spki' });
    const sigBuf = Buffer.from(signature, 'base64');
    return crypto.verify(null, message, publicKey, sigBuf);
  } catch (err) {
    console.error('[telnyxSignature] verify error:', err.message);
    return false;
  }
}

module.exports = { verifyTelnyxSignature };
