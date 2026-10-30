/**
 * wynback-ingest — core validation + phone normalization.
 *
 * normalizePhone is a faithful port of the SPA's whatsapp.js
 * normalizePhone (the spec forbids inventing a second one):
 *   10 digits            -> '91' + digits
 *   12 digits starting 91 -> as-is
 *   11 digits starting 0  -> '91' + digits without the 0
 *   anything else >= 10 digits -> digits as-is (international)
 *   fewer than 10 digits -> null (invalid)
 *
 * A mapper may NOT set status/assignedTo: the server assigns those.
 * Validation failure => 4xx, no write, no error doc (sender's fault).
 */

'use strict'

function normalizePhone(raw) {
  if (raw === undefined || raw === null) return null
  const digits = String(raw).replace(/\D/g, '')
  if (digits.length === 10) return '91' + digits
  if (digits.length === 12 && digits.startsWith('91')) return digits
  if (digits.length === 11 && digits.startsWith('0')) return '91' + digits.slice(1)
  return digits.length >= 10 ? digits : null
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

/**
 * Validate a normalized inquiry shape. Returns
 *   { ok: true, inquiry: { name, phone, phoneNormalized, service, value, note, branchId } }
 * or { ok: false, error } with a sender-facing reason (no internals).
 */
function validateInquiry(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'body must be a JSON object' }
  }
  if (!isNonEmptyString(input.name)) {
    return { ok: false, error: 'name is required' }
  }
  const phoneNormalized = normalizePhone(input.phone)
  if (!phoneNormalized) {
    return { ok: false, error: 'phone is invalid' }
  }
  if (input.service !== undefined && input.service !== null && typeof input.service !== 'string') {
    return { ok: false, error: 'service must be a string' }
  }
  if (input.note !== undefined && input.note !== null && typeof input.note !== 'string') {
    return { ok: false, error: 'note must be a string' }
  }
  if (input.branchId !== undefined && input.branchId !== null && typeof input.branchId !== 'string') {
    return { ok: false, error: 'branchId must be a string' }
  }
  let value = 0
  if (input.value !== undefined && input.value !== null && input.value !== '') {
    value = Number(input.value)
    if (!Number.isFinite(value) || value < 0) {
      return { ok: false, error: 'value must be a non-negative number' }
    }
  }
  return {
    ok: true,
    inquiry: {
      name: String(input.name).trim(),
      phone: String(input.phone).trim(),
      phoneNormalized,
      service: typeof input.service === 'string' ? input.service.trim() : '',
      value,
      note: typeof input.note === 'string' ? input.note.trim() : '',
      branchId: typeof input.branchId === 'string' ? input.branchId : '',
    },
  }
}

module.exports = { normalizePhone, validateInquiry }
