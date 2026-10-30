/**
 * wynback-ingest — Firestore-backed outbound delivery state (go-live).
 *
 * Owner decision (2026-10-30, delegated): durable outbound state is
 * APPROVED. Delivery marks + dead letters live in
 *   users/{ownerUid}/webhook_deliveries
 * under the workspace, replacing the in-memory state in Firestore
 * mode. Memory mode keeps the in-memory store for local tests only.
 *
 * Document shapes:
 * - Delivered mark: doc id = X-Wynback-Delivery-Id exactly
 *   (`${inquiryId}:${subscriptionId}`), fields { inquiryId,
 *   subscriptionId, deliveryId, status: 'delivered', deliveredAt }.
 *   Same id as the header, so a mark and a receiver-side dedupe key
 *   can always be correlated.
 * - Dead letter: doc id = `dl:${inquiryId}:${subscriptionId}` (one
 *   live dead letter per delivery pair; a repeat failure upserts it),
 *   fields { inquiryId, subscriptionId, url, payload, attempts,
 *   lastError, ownerUid, status: 'dead-letter', createdAt }.
 *
 * No-delete rule (deliberate): the narrow service-account spec grants
 * webhook_deliveries create/update/read but NOT delete, so "remove"
 * RESOLVES a dead letter (status -> 'resolved', resolvedAt set)
 * instead of deleting it. The /ops list filters status ==
 * 'dead-letter', so resolved letters disappear from the queue while
 * the audit trail stays. Resolved docs are tiny; purge them from the
 * console only if the collection ever grows large.
 *
 * Failure semantics (at-least-once, never silently drop):
 * - hasDelivered failing open (false) on a transient error may cause
 *   one duplicate delivery; receivers dedupe on
 *   X-Wynback-Delivery-Id. It must never fail closed (true), which
 *   would silently drop a delivery.
 * - markDelivered failing is swallowed: the next poll resends and the
 *   receiver dedupes. The watcher never crashes on delivery-store
 *   errors.
 *
 * This module takes a Firestore `db` instance (real admin.firestore()
 * in production, a fake in tests) — it never requires firebase-admin
 * itself, so tests run with zero dependencies.
 */

'use strict'

const { deliveryIdFor } = require('./outbound')

class FirestoreDeliveryStore {
  constructor({ db }) {
    if (!db) throw new Error('FirestoreDeliveryStore requires a db instance')
    this.db = db
  }

  _col(ownerUid) {
    return this.db.collection('users').doc(ownerUid).collection('webhook_deliveries')
  }

  async hasDelivered(ownerUid, inquiryId, subscriptionId) {
    try {
      const snap = await this._col(ownerUid).doc(deliveryIdFor(inquiryId, subscriptionId)).get()
      return snap.exists && snap.data().status === 'delivered'
    } catch {
      return false // fail open: redelivery beats silent drop (see header)
    }
  }

  async markDelivered(ownerUid, inquiryId, subscriptionId) {
    try {
      await this._col(ownerUid).doc(deliveryIdFor(inquiryId, subscriptionId)).set({
        inquiryId,
        subscriptionId,
        deliveryId: deliveryIdFor(inquiryId, subscriptionId),
        status: 'delivered',
        deliveredAt: new Date().toISOString(),
      }, { merge: true })
    } catch {
      // Swallowed by design: next poll resends, receiver dedupes.
    }
  }
}

class FirestoreDeadLetterQueue {
  constructor({ db, capacity = 500 }) {
    if (!db) throw new Error('FirestoreDeadLetterQueue requires a db instance')
    this.db = db
    this.capacity = capacity
  }

  _col(ownerUid) {
    return this.db.collection('users').doc(ownerUid).collection('webhook_deliveries')
  }

  _dlId(entry) {
    return `dl:${deliveryIdFor(entry.inquiryId, entry.subscriptionId)}`
  }

  async push(ownerUid, entry) {
    const record = {
      id: this._dlId(entry),
      ...entry,
      ownerUid,
      status: 'dead-letter',
      createdAt: new Date().toISOString(),
    }
    await this._col(ownerUid).doc(record.id).set(record, { merge: true })
    return { ...record }
  }

  async list() {
    const snap = await this.db.collectionGroup('webhook_deliveries')
      .where('status', '==', 'dead-letter')
      .limit(this.capacity)
      .get()
    return snap.docs.map(d => ({ id: d.id, ...d.data() }))
  }

  async get(id) {
    const all = await this.list()
    return all.find(e => e.id === id) || null
  }

  /** Resolve (not delete): the narrow spec grants no delete permission. */
  async remove(id) {
    const all = await this.list()
    const record = all.find(e => e.id === id)
    if (!record) return false
    await this._col(record.ownerUid).doc(id).set({
      status: 'resolved',
      resolvedAt: new Date().toISOString(),
    }, { merge: true })
    return true
  }
}

module.exports = { FirestoreDeliveryStore, FirestoreDeadLetterQueue }
