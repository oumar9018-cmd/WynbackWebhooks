'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { MemoryStore } = require('../src/store')
const { DeadLetterQueue } = require('../src/outbound')
const { createServer } = require('../src/server')
const { MemoryWebsiteTokenStore } = require('../src/tokens')
const { sha256Hex } = require('../src/verify')

const OWNER = 'owner-1'
const OTHER = 'owner-2'

function baseConfig(overrides = {}) {
  return {
    port: 0,
    firestoreMode: 'memory',
    serviceAccountPath: '',
    shopifySecrets: new Map(),
    metaPages: new Map(),
    indiamartKeys: new Map(),
    websiteTokens: new Map(),
    subscriptions: [],
    adminKey: '',
    metaVerifyToken: 'verify-me',
    rateLimitPerMinute: 1000,
    maxBodyBytes: 1048576,
    watcherPollMs: 0,
    ...overrides,
  }
}

async function verifyIdToken(token) {
  if (token === 'good-id-token') return { uid: OWNER }
  if (token === 'other-id-token') return { uid: OTHER }
  throw new Error('bad token')
}

async function startServer(config, store, tokenStore, verifier) {
  const server = createServer({
    config,
    store,
    deadLetters: new DeadLetterQueue(),
    tokenStore,
    verifyIdToken: verifier,
  })
  await new Promise(resolve => server.listen(0, resolve))
  const { port } = server.address()
  return { server, base: `http://127.0.0.1:${port}` }
}

async function req(base, method, path, headers = {}, body) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let parsed = null
  try { parsed = JSON.parse(text) } catch { /* non-JSON */ }
  return { status: res.status, body: parsed }
}

const auth = token => ({ Authorization: `Bearer ${token}` })

test('api tokens: mint requires auth, returns raw token once', async t => {
  const tokenStore = new MemoryWebsiteTokenStore()
  const { server, base } = await startServer(baseConfig(), new MemoryStore(), tokenStore, verifyIdToken)
  t.after(() => server.close())

  const noAuth = await req(base, 'POST', '/api/website-tokens', {}, { label: 'Site' })
  assert.equal(noAuth.status, 401)
  const badAuth = await req(base, 'POST', '/api/website-tokens', auth('nope'), { label: 'Site' })
  assert.equal(badAuth.status, 401)

  const minted = await req(base, 'POST', '/api/website-tokens', auth('good-id-token'), { label: 'My Site' })
  assert.equal(minted.status, 201)
  assert.equal(minted.body.label, 'My Site')
  assert.ok(minted.body.token.startsWith('wb_'))
  assert.ok(minted.body.id)
  assert.notEqual(minted.body.token, minted.body.id)
  // Only the hash is stored: the stored doc id IS the hash.
  assert.equal(minted.body.id, sha256Hex(minted.body.token))
})

test('api tokens: minted token ingests, list hides secrets, revoke kills it', async t => {
  const tokenStore = new MemoryWebsiteTokenStore()
  const { server, base } = await startServer(baseConfig(), new MemoryStore(), tokenStore, verifyIdToken)
  t.after(() => server.close())

  const minted = await req(base, 'POST', '/api/website-tokens', auth('good-id-token'), { label: 'Site A' })
  const raw = minted.body.token

  const ingest = await req(base, 'POST', '/ingest/website', { Authorization: `Bearer ${raw}` },
    { name: 'Web Lead', phone: '9810012345' })
  assert.equal(ingest.status, 201)

  const list = await req(base, 'GET', '/api/website-tokens', auth('good-id-token'))
  assert.equal(list.status, 200)
  assert.equal(list.body.tokens.length, 1)
  assert.equal(list.body.tokens[0].label, 'Site A')
  assert.equal(list.body.tokens[0].revoked, false)
  assert.equal(list.body.tokens[0].token, undefined)
  assert.equal(list.body.tokens[0].tokenHash, undefined)

  const otherList = await req(base, 'GET', '/api/website-tokens', auth('other-id-token'))
  assert.deepEqual(otherList.body.tokens, [])

  const revokeOther = await req(base, 'DELETE', `/api/website-tokens/${minted.body.id}`, auth('other-id-token'))
  assert.equal(revokeOther.status, 404)

  const revoked = await req(base, 'DELETE', `/api/website-tokens/${minted.body.id}`, auth('good-id-token'))
  assert.equal(revoked.status, 200)
  assert.equal(revoked.body.revoked, true)

  const afterRevoke = await req(base, 'POST', '/ingest/website', { Authorization: `Bearer ${raw}` },
    { name: 'Web Lead 2', phone: '9810012346' })
  assert.equal(afterRevoke.status, 401)
})

test('api tokens: CORS preflight + headers on api responses', async t => {
  const tokenStore = new MemoryWebsiteTokenStore()
  const { server, base } = await startServer(baseConfig(), new MemoryStore(), tokenStore, verifyIdToken)
  t.after(() => server.close())

  const preflight = await fetch(base + '/api/website-tokens', {
    method: 'OPTIONS',
    headers: {
      Origin: 'https://oumar9018-cmd.github.io',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'authorization, content-type',
    },
  })
  assert.equal(preflight.status, 204)
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://oumar9018-cmd.github.io')
  assert.match(preflight.headers.get('access-control-allow-methods') || '', /POST/)

  const list = await fetch(base + '/api/website-tokens', {
    headers: { Authorization: 'Bearer good-id-token', Origin: 'https://oumar9018-cmd.github.io' },
  })
  assert.equal(list.status, 200)
  assert.equal(list.headers.get('access-control-allow-origin'), 'https://oumar9018-cmd.github.io')
})

test('api tokens: no verifier wired means the routes 404', async t => {
  const tokenStore = new MemoryWebsiteTokenStore()
  const { server, base } = await startServer(baseConfig(), new MemoryStore(), tokenStore, null)
  t.after(() => server.close())

  const list = await req(base, 'GET', '/api/website-tokens', auth('good-id-token'))
  assert.equal(list.status, 404)
  const mint = await req(base, 'POST', '/api/website-tokens', auth('good-id-token'), { label: 'X' })
  assert.equal(mint.status, 404)
})

test('tokens store: revoked and unknown hashes never resolve', async () => {
  const store = new MemoryWebsiteTokenStore()
  const hash = sha256Hex('wb_secret')
  await store.mint(OWNER, { tokenHash: hash, label: 'Site' })
  assert.ok(await store.findByHash(hash))
  assert.equal(await store.findByHash('nope'), null)
  assert.equal(await store.revoke(OTHER, hash), false)
  assert.equal(await store.revoke(OWNER, hash), true)
  assert.equal(await store.findByHash(hash), null)
})
