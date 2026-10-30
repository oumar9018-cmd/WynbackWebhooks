'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createRateLimiter } = require('../src/ratelimit')

test('token bucket: capacity enforced, refill over time, keys isolated', () => {
  let now = 0
  const limiter = createRateLimiter({ perMinute: 2, now: () => now })
  assert.equal(limiter.take('a'), true)
  assert.equal(limiter.take('a'), true)
  assert.equal(limiter.take('a'), false) // over limit
  assert.equal(limiter.take('b'), true) // other key unaffected
  now += 30000 // half a minute refills 1 token
  assert.equal(limiter.take('a'), true)
  assert.equal(limiter.take('a'), false)
  now += 60000 // full minute refills to capacity
  assert.equal(limiter.take('a'), true)
  assert.equal(limiter.take('a'), true)
  assert.equal(limiter.take('a'), false)
})
