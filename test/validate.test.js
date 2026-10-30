'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { normalizePhone, validateInquiry } = require('../src/validate')

test('normalizePhone ports the SPA semantics exactly', () => {
  assert.equal(normalizePhone('9876543210'), '919876543210')
  assert.equal(normalizePhone('+91 98765 43210'), '919876543210')
  assert.equal(normalizePhone('91-9876543210'), '919876543210')
  assert.equal(normalizePhone('09876543210'), '919876543210')
  assert.equal(normalizePhone('+1 415 555 0132'), '14155550132')
  assert.equal(normalizePhone('123'), null)
  assert.equal(normalizePhone(''), null)
  assert.equal(normalizePhone(null), null)
})

test('validateInquiry accepts a full lead, defaults the rest', () => {
  const result = validateInquiry({ name: '  Asha  ', phone: '9876543210', service: 'Haircut', value: '500' })
  assert.equal(result.ok, true)
  assert.equal(result.inquiry.name, 'Asha')
  assert.equal(result.inquiry.phoneNormalized, '919876543210')
  assert.equal(result.inquiry.service, 'Haircut')
  assert.equal(result.inquiry.value, 500)
  assert.equal(result.inquiry.note, '')
  assert.equal(result.inquiry.branchId, '')
})

test('validateInquiry rejects missing name, bad phone, bad value', () => {
  assert.equal(validateInquiry({ name: ' ', phone: '9876543210' }).ok, false)
  assert.equal(validateInquiry({ name: 'Asha', phone: '123' }).ok, false)
  assert.equal(validateInquiry({ name: 'Asha', phone: '9876543210', value: 'abc' }).ok, false)
  assert.equal(validateInquiry({ name: 'Asha', phone: '9876543210', value: -5 }).ok, false)
  assert.equal(validateInquiry(null).ok, false)
  assert.equal(validateInquiry('nope').ok, false)
})
