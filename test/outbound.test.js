'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const {
  signPayload,
  deliverOnce,
  deliverWithRetries,
  DeadLetterQueue,
  MemoryDeliveryStore,
} = require('../src/outbound')

const SUB = { id: 'crm-1', url: 'https://receiver.test/hook', secret: 'shared-secret' }
const PAYLOAD = { inquiryId: 'inq_1', name: 'Asha' }

test('outbound signature is HMAC-SHA256 over the exact JSON body', async () => {
  let seen = null
  const fetchFn = async (url, opts) => {
    seen = opts
    return { ok: true, status: 200 }
  }
  await deliverOnce(SUB, PAYLOAD, fetchFn)
  const expected = crypto.createHmac('sha256', SUB.secret).update(JSON.stringify(PAYLOAD)).digest('hex')
  assert.equal(seen.headers['X-Wynback-Signature'], expected)
  assert.equal(seen.headers['X-Wynback-Delivery-Id'], 'inq_1:crm-1')
  assert.equal(seen.headers['X-Wynback-Event'], 'inquiry.created')
})

test('retries: two failures then success delivers on attempt 3 without real sleeps', async () => {
  let calls = 0
  const sleeps = []
  const fetchFn = async () => {
    calls += 1
    if (calls < 3) return { ok: false, status: 500 }
    return { ok: true, status: 200 }
  }
  const result = await deliverWithRetries(SUB, PAYLOAD, {
    fetchFn,
    sleep: async ms => { sleeps.push(ms) },
  })
  assert.equal(result.delivered, true)
  assert.equal(result.attempts, 3)
  assert.deepEqual(sleeps, [5000, 30000]) // schedule: 0, 5s, 30s, 5min
})

test('exhaustion: all attempts fail => delivered false with last error', async () => {
  const fetchFn = async () => { throw new Error('connection refused') }
  const result = await deliverWithRetries(SUB, PAYLOAD, {
    fetchFn,
    sleep: async () => {},
    scheduleMs: [0, 0],
  })
  assert.equal(result.delivered, false)
  assert.equal(result.attempts, 2)
  assert.match(result.lastError, /connection refused/)
})

test('dead-letter queue: bounded, list/get/remove work', () => {
  const queue = new DeadLetterQueue(2)
  queue.push({ inquiryId: 'a' })
  queue.push({ inquiryId: 'b' })
  queue.push({ inquiryId: 'c' }) // evicts 'a'
  const listed = queue.list()
  assert.equal(listed.length, 2)
  assert.equal(listed[0].inquiryId, 'b')
  assert.equal(queue.get(listed[0].id).inquiryId, 'b')
  assert.equal(queue.remove(listed[0].id), true)
  assert.equal(queue.list().length, 1)
})

test('delivery store marks and remembers', () => {
  const store = new MemoryDeliveryStore()
  assert.equal(store.hasDelivered('inq_1', 'crm-1'), false)
  store.markDelivered('inq_1', 'crm-1')
  assert.equal(store.hasDelivered('inq_1', 'crm-1'), true)
  assert.equal(store.hasDelivered('inq_2', 'crm-1'), false)
})
