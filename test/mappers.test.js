'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { mapShopify, mapMetaLead, mapIndiaMart, mapWebsite } = require('../src/mappers')

test('shopify order maps to an inquiry with order id as external id', () => {
  const result = mapShopify({
    id: 98765,
    name: '#1001',
    total_price: '750.00',
    customer: { first_name: 'Asha', last_name: 'Sharma', phone: '9876543210' },
    line_items: [{ title: 'Haircut' }, { title: 'Colour' }],
  })
  assert.equal(result.ok, true)
  assert.equal(result.mapped.name, 'Asha Sharma')
  assert.equal(result.mapped.phoneNormalized, '919876543210')
  assert.equal(result.mapped.service, 'Haircut')
  assert.equal(result.mapped.value, 750)
  assert.equal(result.mapped.externalId, '98765')
  assert.equal(result.mapped.source, 'shopify')
  assert.ok(result.mapped.note.includes('Order #1001'))
})

test('shopify without a phone anywhere fails validation, never half-maps', () => {
  const result = mapShopify({ id: 1, customer: { first_name: 'No' }, line_items: [] })
  assert.equal(result.ok, false)
})

test('meta field_data maps common field names', () => {
  const result = mapMetaLead('lead-9', {
    field_data: [
      { name: 'full_name', values: ['Rahul Verma'] },
      { name: 'phone_number', values: ['+91 98100 12345'] },
      { name: 'product', values: ['Bridal package'] },
      { name: 'message', values: ['Need pricing'] },
    ],
  })
  assert.equal(result.ok, true)
  assert.equal(result.mapped.name, 'Rahul Verma')
  assert.equal(result.mapped.phoneNormalized, '919810012345')
  assert.equal(result.mapped.service, 'Bridal package')
  assert.equal(result.mapped.note, 'Need pricing')
  assert.equal(result.mapped.externalId, 'lead-9')
  assert.equal(result.mapped.source, 'meta')
})

test('indiamart maps BL caps fields and lowercase aliases', () => {
  const caps = mapIndiaMart({
    SENDER_NAME: 'Meera', SENDER_MOBILE: '9988776655',
    PRODUCT_NAME: 'Facial', MESSAGE: 'Bulk enquiry', ENQUIRY_ID: 'IM-42',
  })
  assert.equal(caps.ok, true)
  assert.equal(caps.mapped.externalId, 'IM-42')
  assert.equal(caps.mapped.service, 'Facial')
  const lower = mapIndiaMart({ name: 'Meera', mobile: '9988776655', product: 'Facial', id: 'IM-43' })
  assert.equal(lower.ok, true)
  assert.equal(lower.mapped.externalId, 'IM-43')
})

test('website posts get a stable content-hash external id (dedupe works)', () => {
  const a = mapWebsite({ name: 'Asha', phone: '9876543210', service: 'Haircut' })
  const b = mapWebsite({ name: 'Asha', phone: '+91 98765 43210', service: 'Haircut' })
  const c = mapWebsite({ name: 'Asha', phone: '9876543210', service: 'Colour' })
  assert.equal(a.ok, true)
  assert.equal(a.mapped.externalId, b.mapped.externalId) // same lead, retyped phone
  assert.notEqual(a.mapped.externalId, c.mapped.externalId) // different service = different lead
  assert.equal(a.mapped.source, 'website')
})

test('mappers never set status or assignedTo', () => {
  const result = mapWebsite({ name: 'Asha', phone: '9876543210' })
  assert.equal('status' in result.mapped, false)
  assert.equal('assignedTo' in result.mapped, false)
})
