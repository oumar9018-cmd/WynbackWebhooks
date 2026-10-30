'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const {
  verifyShopifyHmac,
  verifyMetaHubSignature,
  verifyMetaSignedRequest,
  verifyApiKey,
  verifyBearerToken,
  sha256Hex,
} = require('../src/verify')

test('shopify HMAC: valid passes, tampered body or secret fails', () => {
  const body = Buffer.from('{"id":1}', 'utf8')
  const secret = 'shpss_secret'
  const good = crypto.createHmac('sha256', secret).update(body).digest('base64')
  assert.equal(verifyShopifyHmac(body, good, secret), true)
  assert.equal(verifyShopifyHmac(Buffer.from('{"id":2}', 'utf8'), good, secret), false)
  assert.equal(verifyShopifyHmac(body, good, 'wrong'), false)
  assert.equal(verifyShopifyHmac(body, '', secret), false)
  assert.equal(verifyShopifyHmac(body, good, ''), false)
})

test('meta hub signature: valid passes, wrong secret or garbage fails', () => {
  const body = Buffer.from('{"entry":[]}', 'utf8')
  const secret = 'app-secret'
  const good = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex')
  assert.equal(verifyMetaHubSignature(body, good, secret), true)
  assert.equal(verifyMetaHubSignature(body, good, 'other'), false)
  assert.equal(verifyMetaHubSignature(body, 'sha256=deadbeef', secret), false)
  assert.equal(verifyMetaHubSignature(body, 'not-a-signature', secret), false)
})

test('meta signed_request: valid payload decodes, tampered fails', () => {
  const secret = 'app-secret'
  const payload = Buffer.from(JSON.stringify({ user_id: '42' }), 'utf8')
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  const sig = crypto.createHmac('sha256', secret).update(payload).digest()
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  const signed = `${sig}.${payload}`
  assert.deepEqual(verifyMetaSignedRequest(signed, secret), { user_id: '42' })
  assert.equal(verifyMetaSignedRequest(`${sig}.e30`, secret), null) // tampered payload
  assert.equal(verifyMetaSignedRequest('garbage', secret), null)
  assert.equal(verifyMetaSignedRequest(signed, 'wrong'), null)
})

test('api key and bearer token: constant-time digest comparison', () => {
  assert.equal(verifyApiKey('im-key-123', 'im-key-123'), true)
  assert.equal(verifyApiKey('im-key-123', 'im-key-124'), false)
  assert.equal(verifyApiKey('', 'im-key-123'), false)
  const hash = sha256Hex('workspace-token')
  assert.equal(verifyBearerToken('workspace-token', hash), true)
  assert.equal(verifyBearerToken('other-token', hash), false)
  assert.equal(verifyBearerToken('', hash), false)
})
