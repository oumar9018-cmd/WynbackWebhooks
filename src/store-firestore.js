/**
 * wynback-ingest — Firestore store (deployed mode only).
 *
 * Loaded LAZILY and only when FIRESTORE_MODE=firestore, so local
 * tests and memory-mode runs never need firebase-admin installed.
 * Requires `npm install` (firebase-admin is a declared dependency)
 * plus EITHER FIREBASE_SERVICE_ACCOUNT_PATH (path to a dedicated
 * service-account key file) OR FIREBASE_SERVICE_ACCOUNT_JSON (the key
 * JSON pasted as an env var — the Render deployment path, so no
 * secret file ever has to exist on the host). The key's IAM role
 * allows ONLY:
 *   users/{ownerUid}/inquiries (create + read for dedupe/watch)
 *   users/{ownerUid}/ingestion_errors (create)
 *   users/{ownerUid}/members (read)
 *   users/{ownerUid}/settings/workspace (read + round-robin pointer write)
 *   users/{ownerUid}/webhook_deliveries (create + update + read:
 *     delivered marks + dead letters; NO delete — dead letters are
 *     resolved, not deleted)
 * The service NEVER writes other settings/members/invites/audit/user
 * docs. If that narrow IAM role is not in place, do NOT deploy this
 * store.
 *
 * The routing transaction mirrors the SPA's roundRobin.js exactly:
 * least-loaded first, pointer tiebreak, pick + count + pointer in
 * ONE transaction. createdAt uses a server timestamp (the memory
 * store uses ISO strings — both order identically for the watcher).
 */

'use strict'

const { pickCandidate } = require('./store')

function loadAdmin() {
  try {
    // eslint-disable-next-line global-require
    return require('firebase-admin')
  } catch {
    throw new Error(
      'firestore store requires firebase-admin: run `npm install` in the service directory first'
    )
  }
}

class FirestoreStore {
  constructor({ serviceAccountPath, serviceAccountJson }) {
    const admin = loadAdmin()
    if (!admin.apps.length) {
      // JSON env var wins when both are set (Render path); the file
      // path is the local/VPS path. Exactly one must be configured
      // (config.js enforces this before we get here).
      const credential = serviceAccountJson
        ? admin.credential.cert(serviceAccountJson)
        : admin.credential.cert(serviceAccountPath)
      admin.initializeApp({ credential })
    }
    this.db = admin.firestore()
    this.FieldValue = admin.firestore.FieldValue
  }

  _user(ownerUid) {
    return this.db.collection('users').doc(ownerUid)
  }

  async getMembers(ownerUid) {
    const snap = await this._user(ownerUid).collection('members').get()
    return snap.docs.map(d => ({ id: d.id, ...d.data() }))
  }

  async getPointer(ownerUid) {
    const snap = await this._user(ownerUid).collection('settings').doc('workspace').get()
    return snap.exists ? (snap.data()?.roundRobin?.pointerUid || '') : ''
  }

  async routeInquiry(ownerUid, { branchId = '' } = {}) {
    const fallback = { assignedTo: '', assignedAt: '', assignedBy: '', assignedEmail: '' }
    try {
      const userRef = this._user(ownerUid)
      const settingsRef = userRef.collection('settings').doc('workspace')
      const membersRef = userRef.collection('members')
      const pickedId = await this.db.runTransaction(async tx => {
        const settingsSnap = await tx.get(settingsRef)
        const pointerUid = settingsSnap.exists
          ? (settingsSnap.data()?.roundRobin?.pointerUid || '')
          : ''
        const membersSnap = await tx.get(membersRef)
        const members = membersSnap.docs.map(d => ({ id: d.id, ...d.data() }))
        const picked = pickCandidate(members, pointerUid, branchId)
        if (!picked) return null
        tx.update(membersRef.doc(picked.id), {
          assignedCount: (typeof picked.count === 'number' ? picked.count : 0) + 1,
        })
        tx.set(settingsRef, {
          roundRobin: { pointerUid: picked.id, updatedAt: new Date().toISOString() },
        }, { merge: true })
        return picked.id
      })
      if (!pickedId) return fallback
      let assignedEmail = ''
      try {
        const snap = await membersRef.doc(pickedId).get()
        assignedEmail = snap.exists ? (snap.data()?.email || '') : ''
      } catch {
        // Email lookup must never block the assignment.
      }
      return {
        assignedTo: pickedId,
        assignedAt: new Date().toISOString(),
        assignedBy: 'round-robin',
        assignedEmail,
      }
    } catch {
      return fallback
    }
  }

  async findInquiryByExternalId(ownerUid, source, externalId) {
    const snap = await this._user(ownerUid).collection('inquiries')
      .where('source', '==', source)
      .where('externalId', '==', externalId)
      .limit(1)
      .get()
    if (snap.empty) return null
    const doc = snap.docs[0]
    return { id: doc.id, ...doc.data() }
  }

  async createInquiry(ownerUid, fields) {
    const ref = await this._user(ownerUid).collection('inquiries').add({
      ...fields,
      createdAt: this.FieldValue.serverTimestamp(),
    })
    return ref.id
  }

  async recordIngestionError(ownerUid, { source, rawPayload, error }) {
    const ref = await this._user(ownerUid).collection('ingestion_errors').add({
      source,
      rawPayload,
      error,
      createdAt: this.FieldValue.serverTimestamp(),
    })
    return ref.id
  }

  async listInquiriesAfter(ownerUid, { createdAt = '', lastId = '' } = {}) {
    // Server-timestamp ordering: fetch a bounded recent window and
    // filter in code (createdAt may be a Timestamp object here).
    const snap = await this._user(ownerUid).collection('inquiries')
      .orderBy('createdAt', 'asc')
      .limit(500)
      .get()
    const toMillis = value => {
      if (!value) return 0
      if (typeof value.toMillis === 'function') return value.toMillis()
      const parsed = Date.parse(value)
      return Number.isFinite(parsed) ? parsed : 0
    }
    const watermarkMs = Date.parse(createdAt) || 0
    return snap.docs
      .map(d => {
        const data = d.data()
        return {
          id: d.id,
          ...data,
          createdAt: data.createdAt && typeof data.createdAt.toDate === 'function'
            ? data.createdAt.toDate().toISOString()
            : data.createdAt,
        }
      })
      .filter(doc => {
        const ms = toMillis(doc.createdAt)
        return ms > watermarkMs || (ms === watermarkMs && doc.id > lastId)
      })
      .sort((a, b) => (a.createdAt === b.createdAt
        ? (a.id < b.id ? -1 : 1)
        : (a.createdAt < b.createdAt ? -1 : 1)))
  }
}

module.exports = { FirestoreStore }
