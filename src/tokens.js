/**
 * wynback-ingest — website bearer <redacted> (owner-minted).
 *
 * Env-map tokens (WEBSITE_TOKENS_JSON) stay supported; this store adds
 * owner-minted tokens so the SPA's API & Webhooks section can mint and
 * revoke without a Render env edit + redeploy.
 *
 * Storage: TOP-LEVEL collection `websiteTokens`, doc id = sha256 hex
 * of the raw token. Only the hash is stored — the raw token is shown
 * to the owner exactly once at mint time and never stored or logged.
 * A doc carries { ownerUid, label, createdAt, revoked }.
 *
 * IAM note: the narrow service-account role already grants
 * datastore.entities create/get/list/update, which covers this
 * collection — no role change is needed. The code still touches ONLY
 * this collection for tokens (narrow-path discipline).
 *
 * No collectionGroup query is used on purpose: a single doc get by
 * id needs no composite index and no extra IAM scope.
 */

'use strict'

class MemoryWebsiteTokenStore {
  constructor() {
    this.docs = new Map()
  }

  async findByHash(hash) {
    const doc = this.docs.get(hash)
    if (!doc || doc.revoked) return null
    return { id: hash, ...doc }
  }

  async mint(ownerUid, { tokenHash, label }) {
    const record = {
      ownerUid,
      label: String(label || 'Website'),
      createdAt: new Date().toISOString(),
      revoked: false,
    }
    this.docs.set(tokenHash, record)
    return { id: tokenHash, ...record }
  }

  async revoke(ownerUid, id) {
    const doc = this.docs.get(id)
    if (!doc || doc.ownerUid !== ownerUid || doc.revoked) return false
    doc.revoked = true
    return true
  }

  async list(ownerUid) {
    return [...this.docs.entries()]
      .filter(([, d]) => d.ownerUid === ownerUid)
      .map(([id, d]) => ({
        id,
        ownerUid: d.ownerUid,
        label: d.label,
        createdAt: d.createdAt,
        revoked: d.revoked,
      }))
  }
}

class FirestoreWebsiteTokenStore {
  constructor({ db }) {
    if (!db) throw new Error('FirestoreWebsiteTokenStore requires a db instance')
    this.db = db
  }

  _col() {
    return this.db.collection('websiteTokens')
  }

  async findByHash(hash) {
    const snap = await this._col().doc(hash).get()
    if (!snap.exists) return null
    const data = snap.data()
    if (data.revoked) return null
    return { id: snap.id, ...data }
  }

  async mint(ownerUid, { tokenHash, label }) {
    const record = {
      ownerUid,
      label: String(label || 'Website'),
      createdAt: new Date().toISOString(),
      revoked: false,
    }
    await this._col().doc(tokenHash).set(record)
    return { id: tokenHash, ...record }
  }

  async revoke(ownerUid, id) {
    const ref = this._col().doc(id)
    const snap = await ref.get()
    if (!snap.exists || snap.data().ownerUid !== ownerUid || snap.data().revoked) return false
    await ref.set({ revoked: true }, { merge: true })
    return true
  }

  async list(ownerUid) {
    const snap = await this._col().where('ownerUid', '==', ownerUid).get()
    return snap.docs.map(d => ({
      id: d.id,
      ownerUid: d.data().ownerUid,
      label: d.data().label,
      createdAt: d.data().createdAt,
      revoked: d.data().revoked,
    }))
  }
}

module.exports = { MemoryWebsiteTokenStore, FirestoreWebsiteTokenStore }
