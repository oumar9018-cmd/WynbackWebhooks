'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { MemoryStore } = require('../src/store')
const { DeadLetterQueue } = require('../src/outbound')
const { createServer } = require('../src/server')
const { sha256Hex } = require('../src/verify')

const OWNER = 'owner-1'
const SHOP = 'test.myshopify.com'
const SHOP_SECRET = 'shpss_secret'
const PAGE_ID = '111'
const APP_SECRET = 'app-secret'
const PAGE_TOKEN = 'page-token'
const IM_KEY = 'im-key-123'
const WEB_TOKEN = 'workspace-token-abc'

function baseConfig(overrides = {}) {
  return {
    port: 0,
    firestoreMode: 'memory',
    serviceAccountPath: '',
    shopifySecrets: new Map([[SHOP, { ownerUid: OWNER, secret: SHOP_SECRET }]]),
    metaPages: new Map([[PAGE_ID, { ownerUid: OWNER, pageToken: PAGE_TOKEN, appSecret: APP_SECRET }]]),
    indiamartKeys: new Map([['owner-a', { ownerUid: OWNER, key: IM_KEY }]]),
    websiteTokens: new Map([[OWNER, sha256Hex(WEB_TOKEN)]]),
    subscriptions: [],
    adminKey: '',
    metaVerifyToken: 'verify-me',
    rateLimitPerMinute: 1000,
    maxBodyBytes: 1048576,
    watcherPollMs: 0,
    ...overrides,
  }
}

async function startServer(config, store, deadLetters, fetchFn) {
  const server = createServer({ config, store, deadLetters, fetchFn })
  await new Promise(resolve => server.listen(0, resolve))
  const { port } = server.address()
  return { server, base: `http://127.0.0.1:${port}` }
}

async function post(base, path, body, headers = {}) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body)
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: raw,
  })
  const text = await res.text()
  let parsed = null
  try { parsed = JSON.parse(text) } catch { /* non-JSON */ }
  return { status: res.status, body: parsed, text }
}

function shopifyHeaders(rawBody, shop = SHOP, secret = SHOP_SECRET) {
  return {
    'X-Shopify-Shop-Domain': shop,
    'X-Shopify-Hmac-Sha256': crypto.createHmac('sha256', secret).update(rawBody).digest('base64'),
  }
}

const ORDER = {
  id: 555,
  name: '#2002',
  total_price: '900',
  customer: { first_name: 'Asha', last_name: 'Sharma', phone: '9876543210' },
  line_items: [{ title: 'Haircut' }],
}

test('server: health ok, unknown source 404', async t => {
  const store = new MemoryStore()
  const { server, base } = await startServer(baseConfig(), store, new DeadLetterQueue())
  t.after(() => server.close())
  const health = await fetch(base + '/health')
  assert.equal(health.status, 200)
  assert.deepEqual(await health.json(), { ok: true })
  const unknown = await post(base, '/ingest/tiktok', {})
  assert.equal(unknown.status, 404)
  const badRoute = await post(base, '/nope', {})
  assert.equal(badRoute.status, 404)
})

test('server: shopify happy path creates, repost dedupes, no second row', async t => {
  const store = new MemoryStore()
  store.seedMembers(OWNER, [
    { id: 'rep-a', email: 'a@salon.test', role: 'sales_rep', available: true, assignedCount: 0 },
  ])
  const { server, base } = await startServer(baseConfig(), store, new DeadLetterQueue())
  t.after(() => server.close())
  const raw = JSON.stringify(ORDER)
  const first = await post(base, '/ingest/shopify', raw, shopifyHeaders(raw))
  assert.equal(first.status, 201)
  assert.equal(first.body.assignedTo, 'rep-a')
  const second = await post(base, '/ingest/shopify', raw, shopifyHeaders(raw))
  assert.equal(second.status, 200)
  assert.equal(second.body.deduped, true)
  const rows = await store.listInquiriesAfter(OWNER, {})
  assert.equal(rows.length, 1)
  assert.equal(rows[0].source, 'shopify')
  assert.equal(rows[0].externalId, '555')
  assert.equal(rows[0].status, 'new')
  assert.equal(rows[0].date, 'Just now')
})

test('server: shopify bad signature => 401 and zero writes; bad phone => 400 and zero writes', async t => {
  const store = new MemoryStore()
  const { server, base } = await startServer(baseConfig(), store, new DeadLetterQueue())
  t.after(() => server.close())
  const raw = JSON.stringify(ORDER)
  const badSig = await post(base, '/ingest/shopify', raw, shopifyHeaders(raw, SHOP, 'wrong-secret'))
  assert.equal(badSig.status, 401)
  const unknownShop = await post(base, '/ingest/shopify', raw, shopifyHeaders(raw, 'other.myshopify.com'))
  assert.equal(unknownShop.status, 404)
  const badPhoneOrder = { ...ORDER, id: 556, customer: { first_name: 'X', phone: '12' } }
  const badPhoneRaw = JSON.stringify(badPhoneOrder)
  const badPhone = await post(base, '/ingest/shopify', badPhoneRaw, shopifyHeaders(badPhoneRaw))
  assert.equal(badPhone.status, 400)
  const malformed = await post(base, '/ingest/shopify', '{not json', shopifyHeaders('{not json'))
  assert.equal(malformed.status, 400)
  assert.equal((await store.listInquiriesAfter(OWNER, {})).length, 0)
  assert.equal((await store.listErrors(OWNER)).length, 0) // 4xx => no error doc
})

test('server: indiamart key auth and website bearer auth', async t => {
  const store = new MemoryStore()
  const { server, base } = await startServer(baseConfig(), store, new DeadLetterQueue())
  t.after(() => server.close())
  const imBody = { SENDER_NAME: 'Meera', SENDER_MOBILE: '9988776655', PRODUCT_NAME: 'Facial', ENQUIRY_ID: 'IM-7' }
  const imOk = await post(base, '/ingest/indiamart', imBody, { 'X-IM-Key': IM_KEY })
  assert.equal(imOk.status, 201)
  const imBad = await post(base, '/ingest/indiamart', imBody, { 'X-IM-Key': 'nope' })
  assert.equal(imBad.status, 401)
  const webOk = await post(base, '/ingest/website', { name: 'Web Lead', phone: '9810012345' },
    { Authorization: `Bearer ${WEB_TOKEN}` })
  assert.equal(webOk.status, 201)
  const webBad = await post(base, '/ingest/website', { name: 'Web Lead', phone: '9810012345' },
    { Authorization: 'Bearer wrong' })
  assert.equal(webBad.status, 401)
  assert.equal((await store.listInquiriesAfter(OWNER, {})).length, 2)
})

test('server: rate limit 429 and oversize 413, neither writes', async t => {
  const store = new MemoryStore()
  const limited = await startServer(
    baseConfig({ rateLimitPerMinute: 2 }), store, new DeadLetterQueue())
  t.after(() => limited.server.close())
  const raw = JSON.stringify(ORDER)
  assert.equal((await post(limited.base, '/ingest/shopify', raw, shopifyHeaders(raw))).status, 201)
  const dupRaw = JSON.stringify({ ...ORDER, id: 556 })
  assert.equal((await post(limited.base, '/ingest/shopify', dupRaw, shopifyHeaders(dupRaw))).status, 201)
  const thirdRaw = JSON.stringify({ ...ORDER, id: 557 })
  const limitedRes = await post(limited.base, '/ingest/shopify', thirdRaw, shopifyHeaders(thirdRaw))
  assert.equal(limitedRes.status, 429)

  const small = await startServer(baseConfig({ maxBodyBytes: 10 }), store, new DeadLetterQueue())
  t.after(() => small.server.close())
  const big = await post(small.base, '/ingest/shopify', raw, shopifyHeaders(raw))
  assert.equal(big.status, 413)
})

test('server: meta flow — hub signature, Graph fetch, mapping, dedupe', async t => {
  const store = new MemoryStore()
  const graphFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      field_data: [
        { name: 'full_name', values: ['Rahul'] },
        { name: 'phone_number', values: ['9810012345'] },
      ],
    }),
  })
  const { server, base } = await startServer(baseConfig(), store, new DeadLetterQueue(), graphFetch)
  t.after(() => server.close())
  const webhook = { entry: [{ id: PAGE_ID, changes: [{ value: { leadgen_id: 'lead-1' } }] }] }
  const raw = JSON.stringify(webhook)
  const sig = 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(raw).digest('hex')
  const ok = await post(base, '/ingest/meta', raw, { 'X-Hub-Signature-256': sig })
  assert.equal(ok.status, 201)
  assert.equal(ok.body.created.length, 1)
  const again = await post(base, '/ingest/meta', raw, { 'X-Hub-Signature-256': sig })
  assert.equal(again.body.created[0].deduped, true)
  const bad = await post(base, '/ingest/meta', raw, { 'X-Hub-Signature-256': 'sha256=deadbeef' })
  assert.equal(bad.status, 401)
  assert.equal((await store.listInquiriesAfter(OWNER, {})).length, 1)

  // Meta verification handshake.
  const handshake = await fetch(`${base}/ingest/meta?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=CHALLENGE123`)
  assert.equal(handshake.status, 200)
  assert.equal(await handshake.text(), 'CHALLENGE123')
  const badHandshake = await fetch(`${base}/ingest/meta?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=X`)
  assert.equal(badHandshake.status, 403)
})

test('server: meta Graph failure => 500 + ingestion error doc for owner review', async t => {
  const store = new MemoryStore()
  const failingFetch = async () => ({ ok: false, status: 500, json: async () => ({}) })
  const { server, base } = await startServer(baseConfig(), store, new DeadLetterQueue(), failingFetch)
  t.after(() => server.close())
  const webhook = { entry: [{ id: PAGE_ID, changes: [{ value: { leadgen_id: 'lead-9' } }] }] }
  const raw = JSON.stringify(webhook)
  const sig = 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(raw).digest('hex')
  const res = await post(base, '/ingest/meta', raw, { 'X-Hub-Signature-256': sig })
  assert.equal(res.status, 500)
  const errors = await store.listErrors(OWNER)
  assert.equal(errors.length, 1)
  assert.equal(errors[0].source, 'meta')
  assert.equal((await store.listInquiriesAfter(OWNER, {})).length, 0)
})

test('server: ops endpoints hidden without ADMIN_KEY, usable with it', async t => {
  const store = new MemoryStore()
  const deadLetters = new DeadLetterQueue()
  const hidden = await startServer(baseConfig(), store, deadLetters)
  t.after(() => hidden.server.close())
  const noKey = await fetch(hidden.base + '/ops/dead-letters')
  assert.equal(noKey.status, 404)

  const dl = deadLetters.push({ inquiryId: 'inq_x', subscriptionId: 'gone', url: 'https://x.test/', payload: {}, attempts: 4, lastError: 'down' })
  const guarded = await startServer(baseConfig({ adminKey: 'admin-secret' }), store, deadLetters)
  t.after(() => guarded.server.close())
  const list = await fetch(guarded.base + '/ops/dead-letters', { headers: { Authorization: 'Bearer admin-secret' } })
  assert.equal(list.status, 200)
  assert.equal((await list.json()).deadLetters.length, 1)
  const noAuthList = await fetch(guarded.base + '/ops/dead-letters')
  assert.equal(noAuthList.status, 404)
  // Retry fails cleanly when the subscription no longer exists.
  const retry = await fetch(`${guarded.base}/ops/dead-letters/${dl.id}/retry`, {
    method: 'POST',
    headers: { Authorization: 'Bearer admin-secret' },
  })
  assert.equal(retry.status, 400)
})
