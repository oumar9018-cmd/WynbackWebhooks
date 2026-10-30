'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { MemoryStore } = require('../src/store')
const { DeadLetterQueue, MemoryDeliveryStore } = require('../src/outbound')
const { createWatcher } = require('./../src/watcher')

const OWNER = 'owner-1'

async function seed(store) {
  await store.createInquiry(OWNER, {
    name: 'Asha', phone: '9876543210', service: 'Haircut', value: 500, note: '',
    status: 'new', source: 'website', externalId: 'web-1', branchId: 'andheri',
    assignedTo: '', assignedAt: '', assignedBy: '', date: 'Just now',
  })
  await store.createInquiry(OWNER, {
    name: 'Rahul', phone: '9810012345', service: 'Colour', value: 0, note: '',
    status: 'new', source: 'website', externalId: 'web-2', branchId: 'bandra',
    assignedTo: '', assignedAt: '', assignedBy: '', date: 'Just now',
  })
}

test('watcher: delivers new inquiries once, respects branch filter, skips delivered', async () => {
  const store = new MemoryStore()
  await seed(store)
  const delivered = []
  const fetchFn = async (url, opts) => {
    delivered.push(JSON.parse(opts.body))
    return { ok: true, status: 200 }
  }
  const watcher = createWatcher({
    store,
    deliveryStore: new MemoryDeliveryStore(),
    deadLetters: new DeadLetterQueue(),
    subscriptions: [
      { id: 'all', ownerUid: OWNER, url: 'https://crm.test/all', secret: 's1', branchId: '' },
      { id: 'andheri-only', ownerUid: OWNER, url: 'https://crm.test/and', secret: 's2', branchId: 'andheri' },
    ],
    fetchFn,
    sleep: async () => {},
    pollMs: 0,
  })
  const first = await watcher.pollOnce()
  assert.equal(first.deliveredCount, 3) // 2 to 'all' + 1 to 'andheri-only'
  assert.equal(delivered.length, 3)
  const second = await watcher.pollOnce()
  assert.equal(second.deliveredCount, 0) // nothing new, nothing redelivered
  assert.equal(delivered.length, 3)
})

test('watcher: failed deliveries land in the dead-letter queue', async () => {
  const store = new MemoryStore()
  await seed(store)
  const deadLetters = new DeadLetterQueue()
  const watcher = createWatcher({
    store,
    deliveryStore: new MemoryDeliveryStore(),
    deadLetters,
    subscriptions: [{ id: 'down', ownerUid: OWNER, url: 'https://down.test/', secret: 's', branchId: '' }],
    fetchFn: async () => { throw new Error('down') },
    sleep: async () => {},
    pollMs: 0,
  })
  const result = await watcher.pollOnce()
  assert.equal(result.deliveredCount, 0)
  assert.equal(deadLetters.list().length, 2)
  assert.match(deadLetters.list()[0].lastError, /down/)
})
