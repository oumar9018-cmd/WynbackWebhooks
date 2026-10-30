/**
 * wynback-ingest — store interface + in-memory implementation.
 *
 * The service's narrow path (spec §3, extended by the 2026-10-30
 * go-live decision): it writes ONLY
 *   users/{ownerUid}/inquiries        (new docs)
 *   users/{ownerUid}/ingestion_errors  (failed payloads)
 *   users/{ownerUid}/webhook_deliveries (delivered marks + dead letters)
 * and reads ONLY members + the round-robin pointer. It NEVER writes
 * settings (other than the round-robin pointer field), members,
 * invites, audit or user docs. The Firestore
 * implementation (store-firestore.js) enforces the same surface;
 * this file's MemoryStore is the test/dev implementation with
 * identical semantics (including transactional routing in a single
 * process — multi-instance deploys MUST use the Firestore store,
 * whose transaction is what makes the pick atomic).
 *
 * Inquiry doc shape written (spec §5 + batch-5 fields):
 *   { name, phone (as typed), service, value, note, status: 'new',
 *     source, externalId, branchId, assignedTo, assignedAt,
 *     assignedBy: 'round-robin' | '', date: 'Just now',
 *     createdAt: server timestamp (ISO string in memory store) }
 */

'use strict'

/**
 * Least-loaded-first pick among available candidates, ties broken by
 * the rotation pointer — a faithful port of the SPA's roundRobin.js.
 * Pure function over (members, pointerUid, branchId) so it is
 * unit-testable without Firestore.
 */
function pickCandidate(members, pointerUid, branchId) {
  const candidates = members
    .filter(m => {
      if (m.available !== true) return false
      if (m.role === 'sales_rep') return true
      if (m.role === 'admin' && m.takesLeads === true) return true
      return false
    })
    .filter(m => !branchId || (m.branchId || '') === branchId)
  if (!candidates.length) return null
  const withCounts = candidates.map(m => ({
    ...m,
    count: typeof m.assignedCount === 'number' ? m.assignedCount : 0,
  }))
  const minCount = Math.min(...withCounts.map(m => m.count))
  const least = withCounts
    .filter(m => m.count === minCount)
    .map(m => m.id)
    .sort()
  if (!pointerUid) return withCounts.find(m => m.id === least[0])
  const after = least.filter(id => id > pointerUid)
  const pickId = after.length ? after[0] : least[0]
  return withCounts.find(m => m.id === pickId)
}

class MemoryStore {
  constructor() {
    this.owners = new Map() // ownerUid -> { inquiries: [], errors: [], members: Map, pointerUid }
  }

  _owner(ownerUid) {
    if (!this.owners.has(ownerUid)) {
      this.owners.set(ownerUid, { inquiries: [], errors: [], members: new Map(), pointerUid: '' })
    }
    return this.owners.get(ownerUid)
  }

  /** Test/dev seeding only — never part of the HTTP path. */
  seedMembers(ownerUid, members) {
    const owner = this._owner(ownerUid)
    for (const member of members) owner.members.set(member.id, { ...member })
  }

  async getMembers(ownerUid) {
    return [...this._owner(ownerUid).members.values()].map(m => ({ ...m }))
  }

  async getPointer(ownerUid) {
    return this._owner(ownerUid).pointerUid
  }

  /** Route one inquiry. Never throws: failures fall back to unassigned. */
  async routeInquiry(ownerUid, { branchId = '' } = {}) {
    const fallback = { assignedTo: '', assignedAt: '', assignedBy: '', assignedEmail: '' }
    try {
      const owner = this._owner(ownerUid)
      const picked = pickCandidate([...owner.members.values()], owner.pointerUid, branchId)
      if (!picked) return fallback
      const member = owner.members.get(picked.id)
      member.assignedCount = (typeof member.assignedCount === 'number' ? member.assignedCount : 0) + 1
      owner.pointerUid = picked.id
      return {
        assignedTo: picked.id,
        assignedAt: new Date().toISOString(),
        assignedBy: 'round-robin',
        assignedEmail: member.email || '',
      }
    } catch {
      return fallback
    }
  }

  async findInquiryByExternalId(ownerUid, source, externalId) {
    return this._owner(ownerUid).inquiries.find(
      doc => doc.source === source && doc.externalId === externalId
    ) || null
  }

  async createInquiry(ownerUid, fields) {
    const owner = this._owner(ownerUid)
    const id = `inq_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    const doc = { id, ...fields, createdAt: new Date().toISOString() }
    owner.inquiries.push(doc)
    return id
  }

  async recordIngestionError(ownerUid, { source, rawPayload, error }) {
    const owner = this._owner(ownerUid)
    const id = `err_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    owner.errors.push({ id, source, rawPayload, error, createdAt: new Date().toISOString() })
    return id
  }

  /** Watcher support: inquiries created after (createdAt, id), oldest first. */
  async listInquiriesAfter(ownerUid, { createdAt = '', lastId = '' } = {}) {
    return this._owner(ownerUid).inquiries
      .filter(doc => doc.createdAt > createdAt || (doc.createdAt === createdAt && doc.id > lastId))
      .sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? -1 : 1) : (a.createdAt < b.createdAt ? -1 : 1)))
      .map(doc => ({ ...doc }))
  }

  async listErrors(ownerUid) {
    return this._owner(ownerUid).errors.map(e => ({ ...e }))
  }
}

module.exports = { MemoryStore, pickCandidate }
