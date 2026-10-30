'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const { MemoryStore } = require('../src/store')
const { DeadLetterQueue } = require('../src/outbound')
const {
  FirestoreDeliveryStore,
  FirestoreDeadLetterQueue,
} = require('../src/delivery-firestore')
const { createWatcher } = require('../src/watcher')
const { createServer } = require('../src/server')
const { loadConfig } = require('../src/config')

const OWNER = 'owner-1'
const SUB = { id: 'crm-1', ownerUid: OWNER, url: 'https://receiver.test/hook', secret: 's', branchId: '' }

/**
 * Minimal Firestore fake implementing ONLY the surface
 * delivery-firestore.js uses: collection().doc().collection().doc()
 * get/set, and collectionGroup().where().limit().get(). Deliberately
 * dumb: a single Map keyed by full document path.
 */
class FakeFirestore {
  constructor() {
    this.docs = new Map() // full path -> data object
  }

  collection(name) {
    return new FakeCollectionRef(this, name)
  }

  collectionGroup(name) {
    return new FakeQuery(this, name)
  }
}

class FakeCollectionRef {
  constructor(db, path) {
    this.db = db
    this.path = path
  }

  doc(id) {
    return new FakeDocRef(this.db, `${this.path}/${id}`)
  }
}

class FakeDocRef {
  constructor(db, path) {
    this.db = db
    this.path = path
    this.id = path.split('/').pop()
  }

  collection(name) {
    return new FakeCollectionRef(this.db, `${this.path}/${name}`)
  }

  async get() {
    const data = this.db.docs.get(this.path)
    return { exists: data !== undefined, data: () => (data ? { ...data } : undefined) }
  }

  async set(data, options = {}) {
    const prev = options.merge ? (this.db.docs.get(this.path) || {}) : {}
    this.db.docs.set(this.path, { ...prev, ...data })
  }
}

class FakeQuery {
  constructor(db, collectionName) {
    this.db = db
    this.collectionName = collectionName
    this.filters = []
    this.limitN = Infinity
  }

  where(field, op, value) {
    this.filters.push({ field, op, value })
    return this
  }

  limit(n) {
    this.limitN = n
    return this
  }

  async get() {
    const docs = []
    for (const [path, data] of this.db.docs) {
      const parts = path.split('/')
      if (parts.length !== 4) continue
      if (parts[0] !== 'users' || parts[2] !== this.collectionName) continue
      if (!this.filters.every(f => f.op === '==' && data[f.field] === f.value)) continue
      docs.push({ id: parts[3], data: () => ({ ...data }) })
    }
    return { docs: docs.slice(0, this.limitN) }
  }
}

async function seedInquiry(store) {
  await store.createInquiry(OWNER, {
    name: 'Asha', phone: '9876543210', service: 'Haircut', value: 500, note: '',
    status: 'new', source: 'website', externalId: 'web-1', branchId: '',
    assignedTo: '', assignedAt: '', assignedBy: '', date: 'Just now',
  })
}

test('durable delivery store: mark-once, scoped per workspace + subscription', async () => {
  const db = new FakeFirestore()
  const store = new FirestoreDeliveryStore({ db })
  assert.equal(await store.hasDelivered(OWNER, 'inq_1', 'crm-1'), false)
  await store.markDelivered(OWNER, 'inq_1', 'crm-1')
  assert.equal(await store.hasDelivered(OWNER, 'inq_1', 'crm-1'), true)
  assert.equal(await store.hasDelivered(OWNER, 'inq_1', 'crm-2'), false)
  assert.equal(await store.hasDelivered(OWNER, 'inq_2', 'crm-1'), false)
  assert.equal(await store.hasDelivered('owner-2', 'inq_1', 'crm-1'), false)
  // A second store instance over the SAME db sees the same mark
  // (this is the restart-survival property).
  const store2 = new FirestoreDeliveryStore({ db })
  assert.equal(await store2.hasDelivered(OWNER, 'inq_1', 'crm-1'), true)
})

test('durable delivery store: hasDelivered fails open on store errors', async () => {
  const broken = { collection: () => { throw new Error('firestore down') } }
  const store = new FirestoreDeliveryStore({ db: broken })
  assert.equal(await store.hasDelivered(OWNER, 'inq_1', 'crm-1'), false)
  // markDelivered must not throw either (watcher never crashes on it).
  await store.markDelivered(OWNER, 'inq_1', 'crm-1')
})

test('watcher restart simulation: re-instantiated watcher never redelivers marked pairs', async () => {
  const store = new MemoryStore()
  await seedInquiry(store)
  const db = new FakeFirestore()
  const deliveryStore = new FirestoreDeliveryStore({ db })
  const calls = []
  const fetchFn = async (url, opts) => {
    calls.push(JSON.parse(opts.body))
    return { ok: true, status: 200 }
  }
  const watcher1 = createWatcher({
    store, deliveryStore, deadLetters: new DeadLetterQueue(),
    subscriptions: [SUB], fetchFn, sleep: async () => {}, pollMs: 0,
  })
  const first = await watcher1.pollOnce()
  assert.equal(first.deliveredCount, 1)
  assert.equal(calls.length, 1)
  // "Restart": fresh watcher, fresh watermarks, SAME durable store.
  const watcher2 = createWatcher({
    store, deliveryStore, deadLetters: new DeadLetterQueue(),
    subscriptions: [SUB], fetchFn, sleep: async () => {}, pollMs: 0,
  })
  const second = await watcher2.pollOnce()
  assert.equal(second.deliveredCount, 0)
  assert.equal(calls.length, 1) // no redelivery across the restart
})

test('durable dead-letter queue: push/list/get/resolve survive re-instantiation', async () => {
  const db = new FakeFirestore()
  const q1 = new FirestoreDeadLetterQueue({ db })
  const record = await q1.push(OWNER, {
    inquiryId: 'inq_9', subscriptionId: 'crm-1', url: SUB.url,
    payload: { inquiryId: 'inq_9' }, attempts: 4, lastError: 'down',
  })
  assert.match(record.id, /^dl:/)
  // A repeat failure for the same pair upserts, never duplicates.
  await q1.push(OWNER, {
    inquiryId: 'inq_9', subscriptionId: 'crm-1', url: SUB.url,
    payload: { inquiryId: 'inq_9' }, attempts: 4, lastError: 'still down',
  })
  const q2 = new FirestoreDeadLetterQueue({ db })
  const listed = await q2.list()
  assert.equal(listed.length, 1)
  assert.equal(listed[0].lastError, 'still down')
  assert.equal((await q2.get(record.id)).inquiryId, 'inq_9')
  assert.equal(await q2.remove(record.id), true)
  assert.equal((await q2.list()).length, 0) // resolved letters leave the queue
  assert.equal(await q2.remove(record.id), false) // already resolved
})

test('watcher failure lands the dead letter in the durable queue', async () => {
  const store = new MemoryStore()
  await seedInquiry(store)
  const db = new FakeFirestore()
  const deadLetters = new FirestoreDeadLetterQueue({ db })
  const watcher = createWatcher({
    store, deliveryStore: new FirestoreDeliveryStore({ db }), deadLetters,
    subscriptions: [SUB], fetchFn: async () => { throw new Error('down') },
    sleep: async () => {}, pollMs: 0,
  })
  const result = await watcher.pollOnce()
  assert.equal(result.deliveredCount, 0)
  const listed = await deadLetters.list()
  assert.equal(listed.length, 1)
  assert.match(listed[0].lastError, /down/)
})

test('ops retry over durable state: redeliver, mark delivered, resolve letter', async () => {
  const db = new FakeFirestore()
  const deadLetters = new FirestoreDeadLetterQueue({ db })
  const deliveryStore = new FirestoreDeliveryStore({ db })
  const record = await deadLetters.push(OWNER, {
    inquiryId: 'inq_7', subscriptionId: 'crm-1', url: SUB.url,
    payload: { inquiryId: 'inq_7', name: 'Asha' }, attempts: 4, lastError: 'down',
  })
  const config = loadConfig({
    ADMIN_KEY: 'admin-secret',
    OUTBOUND_SUBSCRIPTIONS_JSON: JSON.stringify([SUB]),
  })
  let delivered = 0
  const fetchFn = async () => {
    delivered += 1
    return { ok: true, status: 200 }
  }
  const server = createServer({
    config, store: new MemoryStore(), deadLetters, deliveryStore, fetchFn,
  })
  await new Promise(resolve => server.listen(0, resolve))
  const port = server.address().port
  try {
    const get = path => new Promise((resolve, reject) => {
      http.get({ port, path, headers: { Authorization: 'Bearer admin-secret' } }, res => {
        let body = ''
        res.on('data', c => { body += c })
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }))
      }).on('error', reject)
    })
    const post = path => new Promise((resolve, reject) => {
      const req = http.request({ port, path, method: 'POST', headers: { Authorization: 'Bearer admin-secret' } }, res => {
        let body = ''
        res.on('data', c => { body += c })
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }))
      })
      req.on('error', reject)
      req.end()
    })
    const before = await get('/ops/dead-letters')
    assert.equal(before.body.deadLetters.length, 1)
    const retry = await post(`/ops/dead-letters/${encodeURIComponent(record.id)}/retry`)
    assert.equal(retry.status, 200)
    assert.equal(retry.body.redelivered, true)
    assert.equal(delivered, 1)
    const after = await get('/ops/dead-letters')
    assert.equal(after.body.deadLetters.length, 0)
    // The retry marked the pair delivered, so a restarted watcher
    // would not resend it either.
    assert.equal(await deliveryStore.hasDelivered(OWNER, 'inq_7', 'crm-1'), true)
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})
