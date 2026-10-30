/**
 * wynback-ingest — per-(source, workspace) token-bucket rate limiter.
 * Spec §6: over-limit => 429, no write. Pure class with an injectable
 * clock so tests never sleep. A spammy source cannot flood the inbox
 * or the bill; legitimate bursts up to the bucket size pass.
 */

'use strict'

class TokenBucket {
  constructor({ capacity, refillPerMs, now = () => Date.now() }) {
    this.capacity = capacity
    this.refillPerMs = refillPerMs
    this.now = now
    this.buckets = new Map() // key -> { tokens, updatedAt }
  }

  /** Returns true when one token was consumed, false when over limit. */
  take(key) {
    const now = this.now()
    let bucket = this.buckets.get(key)
    if (!bucket) {
      bucket = { tokens: this.capacity, updatedAt: now }
      this.buckets.set(key, bucket)
    }
    const elapsed = Math.max(0, now - bucket.updatedAt)
    bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsed * this.refillPerMs)
    bucket.updatedAt = now
    if (bucket.tokens < 1) return false
    bucket.tokens -= 1
    return true
  }
}

/** One bucket per minute per key (spec default: 100/min). */
function createRateLimiter({ perMinute = 100, now } = {}) {
  return new TokenBucket({
    capacity: perMinute,
    refillPerMs: perMinute / 60000,
    now,
  })
}

module.exports = { TokenBucket, createRateLimiter }
