/**
 * wynback-ingest — per-source mappers (small pure functions).
 *
 * Each mapper takes a provider payload and returns
 *   { ok: true, mapped: { name, phone, service, value, note, externalId, source, branchId } }
 * or { ok: false, error }. A mapper NEVER sets status/assignedTo —
 * the server assigns those after validation + dedupe + routing.
 *
 * Assumptions, stated so the owner can correct them (never invented
 * as fact):
 * - Shopify: order / abandoned-checkout JSON. Customer phone is
 *   tried at customer.phone, then billing/shipping address phone.
 *   Service = first line-item title (the product the lead cares
 *   about); value = order total. externalId = order/checkout id.
 * - Meta: leadgen webhook carries only the lead id; the service
 *   fetches the lead's field_data via Graph API (see meta.js), and
 *   this mapper turns that field_data into a lead. Common field
 *   names are matched case-insensitively (full_name, phone_number,
 *   email, product/service interest, message).
 * - IndiaMART: BL enquiry form fields. IndiaMART's documented BL
 *   form uses SENDER_NAME / SENDER_MOBILE / PRODUCT_NAME / MESSAGE /
 *   ENQUIRY_ID style keys; lowercase aliases are accepted too. If
 *   IndiaMART's live contract differs, ONLY this mapper changes.
 * - Website: the generic JSON body passes through validation as-is.
 */

'use strict'

const { validateInquiry } = require('./validate')

function firstString(obj, keys) {
  if (!obj || typeof obj !== 'object') return ''
  for (const key of keys) {
    const value = obj[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  }
  return ''
}

function finish(source, fields, externalId) {
  if (!externalId) {
    return { ok: false, error: `${source}: missing external id — origin untraceable` }
  }
  const validated = validateInquiry(fields)
  if (!validated.ok) return validated
  return {
    ok: true,
    mapped: {
      ...validated.inquiry,
      externalId: String(externalId),
      source,
    },
  }
}

function mapShopify(payload) {
  if (!payload || typeof payload !== 'object') {
    return { ok: false, error: 'shopify: body must be a JSON object' }
  }
  const customer = payload.customer || {}
  const billing = payload.billing_address || {}
  const shipping = payload.shipping_address || {}
  const fullName = [firstString(customer, ['first_name']), firstString(customer, ['last_name'])]
    .filter(Boolean).join(' ')
  const name = fullName || firstString(billing, ['name']) || firstString(shipping, ['name'])
  const phone = firstString(customer, ['phone']) ||
    firstString(billing, ['phone']) || firstString(shipping, ['phone']) ||
    firstString(payload, ['phone'])
  const items = Array.isArray(payload.line_items) ? payload.line_items : []
  const service = items.length ? firstString(items[0], ['title']) : ''
  const total = payload.total_price ?? payload.current_total_price ?? payload.subtotal_price
  const noteParts = []
  if (items.length > 1) noteParts.push(`+${items.length - 1} more item(s)`)
  if (payload.name) noteParts.push(`Order ${payload.name}`)
  return finish('shopify', {
    name,
    phone,
    service,
    value: total,
    note: noteParts.join(' · '),
  }, payload.id)
}

function mapMetaLead(leadId, leadData) {
  if (!leadData || typeof leadData !== 'object') {
    return { ok: false, error: 'meta: lead data must be a JSON object' }
  }
  const fields = {}
  const fieldData = Array.isArray(leadData.field_data) ? leadData.field_data : []
  for (const entry of fieldData) {
    if (!entry || typeof entry.name !== 'string') continue
    const values = Array.isArray(entry.values) ? entry.values : []
    const value = values.length ? values[0] : ''
    fields[entry.name.toLowerCase()] = typeof value === 'string' ? value : String(value ?? '')
  }
  const name = firstString(fields, ['full_name', 'name', 'first_name']) ||
    [firstString(fields, ['first_name']), firstString(fields, ['last_name'])].filter(Boolean).join(' ')
  const phone = firstString(fields, ['phone_number', 'phone', 'mobile', 'contact_number'])
  const service = firstString(fields, ['product', 'service', 'interested_in', 'interest'])
  const note = firstString(fields, ['message', 'note', 'comments', 'query'])
  return finish('meta', { name, phone, service, note }, leadId)
}

function mapIndiaMart(payload) {
  if (!payload || typeof payload !== 'object') {
    return { ok: false, error: 'indiamart: body must be a JSON object' }
  }
  const name = firstString(payload, ['SENDER_NAME', 'sender_name', 'name', 'SENDER_COMPANY'])
  const phone = firstString(payload, ['SENDER_MOBILE', 'sender_mobile', 'mobile', 'phone', 'SENDER_PHONE'])
  const service = firstString(payload, ['PRODUCT_NAME', 'product_name', 'product', 'service'])
  const note = firstString(payload, ['MESSAGE', 'message', 'QUERY', 'query', 'note'])
  const externalId = firstString(payload, ['ENQUIRY_ID', 'enquiry_id', 'id', 'LEAD_ID'])
  return finish('indiamart', { name, phone, service, note }, externalId)
}

function mapWebsite(body) {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'website: body must be a JSON object' }
  }
  const validated = validateInquiry(body)
  if (!validated.ok) return validated
  // Generic website posts carry no provider id: dedupe on a content
  // hash (name + normalized phone + service) so an identical
  // resubmission does not double-create, while distinct leads do.
  const { sha256Hex } = require('./verify')
  const externalId = 'web-' + sha256Hex(
    `${validated.inquiry.name}|${validated.inquiry.phoneNormalized}|${validated.inquiry.service}`
  ).slice(0, 32)
  return {
    ok: true,
    mapped: { ...validated.inquiry, externalId, source: 'website' },
  }
}

module.exports = { mapShopify, mapMetaLead, mapIndiaMart, mapWebsite }
