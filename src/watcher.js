/**
 * wynback-ingest — outbound watcher.
 *
 * Polls the store for newly created inquiries (per workspace) and
 * fans each one out to that workspace's outbound subscriptions whose
 * branch filter matches (empty filter = all branches). Delivery
 * state lives in the delivery store (durable in Firestore mode:
 * users/{ownerUid}/webhook_deliveries); failures after retries land
 * in the dead-letter queue. pollOnce() is the testable unit; start()
 * is the production loop. The watcher only READS inquiries — it
 * never writes inquiry docs.
 */

'use strict'

const { deliverWithRetries } = require('./outbound')

function createWatcher({
  store,
  deliveryStore,
  deadLetters,
  subscriptions,
  fetchFn = fetch,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  pollMs = 15000,
  deliver = deliverWithRetries,
} = {}) {
  const watermarks = new Map() // ownerUid -> { createdAt, lastId }
  let timer = null
  let running = false

  async function pollOnce() {
    const ownerUids = [...new Set(subscriptions.map(s => s.ownerUid))]
    let deliveredCount = 0
    for (const ownerUid of ownerUids) {
      const watermark = watermarks.get(ownerUid) || { createdAt: '', lastId: '' }
      let docs
      try {
        docs = await store.listInquiriesAfter(ownerUid, watermark)
      } catch {
        continue // transient store error: retry next poll, never crash the loop
      }
      for (const doc of docs) {
        watermarks.set(ownerUid, { createdAt: doc.createdAt, lastId: doc.id })
        const payload = {
          event: 'inquiry.created',
          inquiryId: doc.id,
          name: doc.name,
          phone: doc.phone,
          service: doc.service,
          value: doc.value,
          source: doc.source,
          externalId: doc.externalId,
          branchId: doc.branchId || '',
          assignedTo: doc.assignedTo || '',
          createdAt: doc.createdAt,
        }
        for (const sub of subscriptions.filter(s => s.ownerUid === ownerUid)) {
          if (sub.branchId && sub.branchId !== (doc.branchId || '')) continue
          // Awaited: the Firestore store is async, the memory store
          // returns plain values (awaiting those is a no-op).
          if (await deliveryStore.hasDelivered(ownerUid, doc.id, sub.id)) continue
          const result = await deliver(sub, payload, { fetchFn, sleep })
          if (result.delivered) {
            await deliveryStore.markDelivered(ownerUid, doc.id, sub.id)
            deliveredCount += 1
          } else {
            await deadLetters.push(ownerUid, {
              inquiryId: doc.id,
              subscriptionId: sub.id,
              url: sub.url,
              payload,
              attempts: result.attempts,
              lastError: result.lastError,
            })
          }
        }
      }
    }
    return { deliveredCount }
  }

  function start() {
    if (running || !pollMs) return
    running = true
    const loop = async () => {
      if (!running) return
      try {
        await pollOnce()
      } catch {
        // Never let the loop die on an unexpected error.
      }
      if (running) timer = setTimeout(loop, pollMs)
    }
    timer = setTimeout(loop, pollMs)
  }

  function stop() {
    running = false
    if (timer) clearTimeout(timer)
    timer = null
  }

  return { pollOnce, start, stop }
}

module.exports = { createWatcher }
