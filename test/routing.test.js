'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { MemoryStore, pickCandidate } = require('../src/store')

const OWNER = 'owner-1'

function seededStore() {
  const store = new MemoryStore()
  store.seedMembers(OWNER, [
    { id: 'rep-a', email: 'a@salon.test', role: 'sales_rep', available: true, branchId: '', assignedCount: 0 },
    { id: 'rep-b', email: 'b@salon.test', role: 'sales_rep', available: true, branchId: '', assignedCount: 0 },
    { id: 'rep-off', email: 'off@salon.test', role: 'sales_rep', available: false, branchId: '', assignedCount: 0 },
    { id: 'mgr', email: 'mgr@salon.test', role: 'branch_manager', available: true, branchId: '', assignedCount: 0 },
    { id: 'admin-no', email: 'admin@salon.test', role: 'admin', available: true, takesLeads: false, branchId: '', assignedCount: 0 },
  ])
  return store
}

test('routing: 10 inquiries split 5/5 across available reps; unavailable, manager, non-taking admin get 0', async () => {
  const store = seededStore()
  const counts = {}
  for (let i = 0; i < 10; i++) {
    const routing = await store.routeInquiry(OWNER, {})
    counts[routing.assignedTo] = (counts[routing.assignedTo] || 0) + 1
    assert.equal(routing.assignedBy, 'round-robin')
  }
  assert.equal(counts['rep-a'], 5)
  assert.equal(counts['rep-b'], 5)
  assert.equal(counts['rep-off'], undefined)
  assert.equal(counts.mgr, undefined)
  assert.equal(counts['admin-no'], undefined)
})

test('routing: admin with takesLeads joins the pool; branch filter scopes', async () => {
  const store = new MemoryStore()
  store.seedMembers(OWNER, [
    { id: 'rep-a', email: 'a@salon.test', role: 'sales_rep', available: true, branchId: 'andheri', assignedCount: 0 },
    { id: 'admin-yes', email: 'admin@salon.test', role: 'admin', available: true, takesLeads: true, branchId: 'andheri', assignedCount: 0 },
    { id: 'rep-other', email: 'o@salon.test', role: 'sales_rep', available: true, branchId: 'bandra', assignedCount: 0 },
  ])
  const first = await store.routeInquiry(OWNER, { branchId: 'andheri' })
  assert.ok(['rep-a', 'admin-yes'].includes(first.assignedTo))
  const second = await store.routeInquiry(OWNER, { branchId: 'andheri' })
  assert.notEqual(second.assignedTo, first.assignedTo) // least-loaded alternates
  const bandra = await store.routeInquiry(OWNER, { branchId: 'bandra' })
  assert.equal(bandra.assignedTo, 'rep-other')
})

test('routing: solo workspace and no candidates fall back to unassigned, never throw', async () => {
  const store = new MemoryStore()
  const solo = await store.routeInquiry(OWNER, {})
  assert.deepEqual(solo, { assignedTo: '', assignedAt: '', assignedBy: '', assignedEmail: '' })
  const empty = await store.routeInquiry('', {})
  assert.equal(empty.assignedTo, '')
})

test('pickCandidate: pointer breaks ties circularly', () => {
  const members = [
    { id: 'm1', role: 'sales_rep', available: true, assignedCount: 0 },
    { id: 'm2', role: 'sales_rep', available: true, assignedCount: 0 },
    { id: 'm3', role: 'sales_rep', available: true, assignedCount: 0 },
  ]
  assert.equal(pickCandidate(members, '', '').id, 'm1')
  assert.equal(pickCandidate(members, 'm1', '').id, 'm2')
  assert.equal(pickCandidate(members, 'm3', '').id, 'm1') // wraps around
  // Least-loaded beats the pointer.
  const loaded = [
    { id: 'm1', role: 'sales_rep', available: true, assignedCount: 5 },
    { id: 'm2', role: 'sales_rep', available: true, assignedCount: 0 },
  ]
  assert.equal(pickCandidate(loaded, 'm1', '').id, 'm2')
})
