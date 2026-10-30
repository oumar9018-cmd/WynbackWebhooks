/**
 * wynback-ingest — outbound signed deliveries with retries + dead letter.
 *
 * Semantics (honest, by design):
 * - At-least-once. A delivery carries X-Wynback-Delivery-Id
 *   (inquiry id + subscription id) so receivers can dedupe; a
 *   service restart may redeliver, never silently drop.
 * - Every delivery is HMAC-SHA256 signed (X-Wynback-Signature) over
 *   the exact JSON body, so the receiver can trust the sender.
 * - Retry schedule: immediate, 5s, 30s, 5min (injectable sleep and
 *   schedule for tests). After exhaustion the attempt lands in the
 *   dead-letter queue — visible via /ops/dead-letters, retryable
 *   via /ops/dead-letters/:id/retry — and is never lost silently.
 * - Durability caveat: the default delivery store is in-memory.
 *   In Firestore mode the durable store (delivery-firestore.js)
 *   keeps marks + dead letters in users/{ownerUid}/webhook_deliveries,
 *   so a restart never redelivers a marked delivery and dead letters
 *   survive restarts. The in-memory store below is for memory mode
 *   (local tests/dev) only.
 */

'use strict'

const crypto = require('node:crypto')

const DEFAULT_SCHEDULE_MS = [0, 5000, 30000, 300000]

function signPayload(bodyString, secret) {
  return crypto.createHmac('sha256', secret).update(bodyString).digest('hex')
}

function deliveryIdFor(inquiryId, subscriptionId) {
  return `${inquiryId}:${subscriptionId}`
}

/** One signed POST attempt. Returns { ok, status } or throws a wrapped error. */
async function deliverOnce(subscription, payload, fetchFn = fetch) {
  const bodyString = JSON.stringify(payload)
  let res
  try {
    res = await fetchFn(subscription.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Wynback-Signature': signPayload(bodyString, subscription.secret),
        'X-Wynback-Delivery-Id': deliveryIdFor(payload.inquiryId, subscription.id),
        'X-Wynback-Event': 'inquiry.created',
      },
      body: bodyString,
    })
  } catch (error) {
    throw new Error(`outbound: delivery failed (${error && error.message || error})`)
  }
  if (!res || typeof res.ok !== 'boolean' || !res.ok) {
    throw new Error(`outbound: delivery failed (${res ? res.status : 'no-response'})`)
  }
  return { ok: true, status: res.status }
}

/**
 * Deliver with retries. Returns { delivered: true, attempts } or
 * { delivered: false, attempts, lastError }. Never throws: the caller
 * decides dead-lettering from the result.
 */
async function deliverWithRetries(subscription, payload, {
  fetchFn = fetch,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  scheduleMs = DEFAULT_SCHEDULE_MS,
} = {}) {
  let lastError = null
  for (let attempt = 0; attempt < scheduleMs.length; attempt++) {
    if (scheduleMs[attempt] > 0) await sleep(scheduleMs[attempt])
    try {
      await deliverOnce(subscription, payload, fetchFn)
      return { delivered: true, attempts: attempt + 1 }
    } catch (error) {
      lastError = error
    }
  }
  return { delivered: false, attempts: scheduleMs.length, lastError: String(lastError && lastError.message || lastError) }
}

/** Bounded in-memory dead-letter queue (oldest dropped past the cap). */
class DeadLetterQueue {
  constructor(capacity = 500) {
    this.capacity = capacity
    this.entries = []
    this.seq = 0
  }

  // Accepts push(entry) or push(ownerUid, entry); the ownerUid is
  // stored on the record so the memory queue mirrors the Firestore
  // queue's shape. Callers may await this safely (returns a value,
  // not a promise — awaiting a non-promise is a no-op).
  push(ownerUidOrEntry, maybeEntry) {
    const entry = maybeEntry || ownerUidOrEntry
    const ownerUid = maybeEntry ? ownerUidOrEntry : (entry.ownerUid || '')
    this.seq += 1
    const record = { id: `dl_${this.seq}`, ...entry, ownerUid, createdAt: new Date().toISOString() }
    this.entries.push(record)
    while (this.entries.length > this.capacity) this.entries.shift()
    return record
  }

  list() {
    return this.entries.map(e => ({ ...e }))
  }

  get(id) {
    return this.entries.find(e => e.id === id) || null
  }

  remove(id) {
    const before = this.entries.length
    this.entries = this.entries.filter(e => e.id !== id)
    return this.entries.length < before
  }
}

/**
 * In-memory delivered-marks store (memory mode / tests only).
 * Accepts (ownerUid, inquiryId, subscriptionId) or the legacy
 * 2-arg form (inquiryId, subscriptionId); the key includes the
 * ownerUid when given, matching the Firestore store's per-workspace
 * scoping.
 */
class MemoryDeliveryStore {
  constructor() {
    this.delivered = new Set()
  }

  _key(ownerUid, inquiryId, subscriptionId) {
    if (subscriptionId === undefined) {
      // Legacy 2-arg call: (inquiryId, subscriptionId).
      return deliveryIdFor(ownerUid, inquiryId)
    }
    return `${ownerUid}:${deliveryIdFor(inquiryId, subscriptionId)}`
  }

  hasDelivered(ownerUid, inquiryId, subscriptionId) {
    return this.delivered.has(this._key(ownerUid, inquiryId, subscriptionId))
  }

  markDelivered(ownerUid, inquiryId, subscriptionId) {
    this.delivered.add(this._key(ownerUid, inquiryId, subscriptionId))
  }
}

module.exports = {
  DEFAULT_SCHEDULE_MS,
  signPayload,
  deliveryIdFor,
  deliverOnce,
  deliverWithRetries,
  DeadLetterQueue,
  MemoryDeliveryStore,
}
