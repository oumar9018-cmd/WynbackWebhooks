/**
 * wynback-ingest — per-source verification.
 *
 * Every function returns a boolean and never throws on malformed
 * input: a bad signature is a 401, never a 500. Comparisons are
 * constant-time over equal-length digests so a timing probe learns
 * nothing. Secrets are never logged anywhere in this service.
 */

'use strict'

const crypto = require('node:crypto')

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex')
}

/** Constant-time equality for two hex digests (false on length mismatch). */
function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const bufA = Buffer.from(a, 'utf8')
  const bufB = Buffer.from(b, 'utf8')
  if (bufA.length !== bufB.length) return false
  return crypto.timingSafeEqual(bufA, bufB)
}

/**
 * Shopify: HMAC-SHA256 (base64) over the RAW body with the shop's
 * shared secret. Compared against the X-Shopify-Hmac-Sha256 header.
 */
function verifyShopifyHmac(rawBody, hmacHeader, secret) {
  if (!Buffer.isBuffer(rawBody) || typeof hmacHeader !== 'string' || !hmacHeader ||
      typeof secret !== 'string' || !secret) return false
  const digest = crypto.createHmac('sha256', secret).update(rawBody).digest('base64')
  const a = Buffer.from(digest, 'utf8')
  const b = Buffer.from(hmacHeader, 'utf8')
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

/**
 * Meta webhooks: X-Hub-Signature-256, i.e. "sha256=<hex HMAC-SHA256
 * of the raw body with the app secret>". This is Meta's real webhook
 * verification mechanism; the spec's phrase "signed request" names a
 * different Meta flow (canvas/login), so the service implements the
 * webhook mechanism and documents the correction. A signed_request
 * body parameter, if ever sent, is also accepted via
 * verifyMetaSignedRequest below.
 */
function verifyMetaHubSignature(rawBody, signatureHeader, appSecret) {
  if (!Buffer.isBuffer(rawBody) || typeof signatureHeader !== 'string' ||
      !signatureHeader.startsWith('sha256=') ||
      typeof appSecret !== 'string' || !appSecret) return false
  const expected = crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex')
  return safeEqualHex(expected, signatureHeader.slice('sha256='.length))
}

/** base64url decode (Meta signed_request parts). Returns null on garbage. */
function base64urlDecode(part) {
  if (typeof part !== 'string' || !/^[A-Za-z0-9_-]+$/.test(part)) return null
  try {
    return Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
  } catch {
    return null
  }
}

/**
 * Meta signed_request: "<base64url(sig)>.<base64url(payload JSON)>".
 * Signature = HMAC-SHA256 of the payload PART (the encoded string,
 * not the decoded JSON) with the app secret. Returns the payload
 * object on success, null on any failure.
 */
function verifyMetaSignedRequest(signedRequest, appSecret) {
  if (typeof signedRequest !== 'string' || typeof appSecret !== 'string' || !appSecret) return null
  const [sigPart, payloadPart] = signedRequest.split('.')
  if (!sigPart || !payloadPart) return null
  const sig = base64urlDecode(sigPart)
  const payloadRaw = base64urlDecode(payloadPart)
  if (!sig || !payloadRaw) return null
  const expected = crypto.createHmac('sha256', appSecret).update(payloadPart).digest()
  if (sig.length !== expected.length || !crypto.timingSafeEqual(sig, expected)) return null
  try {
    const payload = JSON.parse(payloadRaw.toString('utf8'))
    return payload && typeof payload === 'object' ? payload : null
  } catch {
    return null
  }
}

/**
 * IndiaMART API-key header: compare sha256(provided) against
 * sha256(expected) so the check is constant-time and the stored key
 * is never compared raw.
 */
function verifyApiKey(provided, expected) {
  if (typeof provided !== 'string' || !provided ||
      typeof expected !== 'string' || !expected) return false
  return safeEqualHex(sha256Hex(provided), sha256Hex(expected))
}

/**
 * Website bearer token: the service stores ONLY sha256 hex digests
 * (see config). Compare sha256(provided) against the stored digest.
 */
function verifyBearerToken(provided, expectedHash) {
  if (typeof provided !== 'string' || !provided ||
      typeof expectedHash !== 'string' || !expectedHash) return false
  return safeEqualHex(sha256Hex(provided), expectedHash)
}

module.exports = {
  sha256Hex,
  verifyShopifyHmac,
  verifyMetaHubSignature,
  verifyMetaSignedRequest,
  verifyApiKey,
  verifyBearerToken,
}
