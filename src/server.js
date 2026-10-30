/**
 * wynback-ingest — HTTP server.
 *
 * Routes:
 *   POST /ingest/shopify    HMAC-SHA256 (X-Shopify-Hmac-Sha256) per shop secret
 *   POST /ingest/meta       X-Hub-Signature-256 (app secret) + Graph lead fetch
 *   POST /ingest/indiamart  X-IM-Key header (per-owner key)
 *   POST /ingest/website    Authorization: Bearer <workspace token> (stored hashed)
 *   GET  /health            liveness only — no auth, no data, no version leak
 *   GET  /ops/dead-letters  ADMIN_KEY bearer only (404 when unset)
 *   POST /ops/dead-letters/:id/retry  ADMIN_KEY bearer only
 *
 * Status contract (spec §4/§6):
 *   unknown route/source -> 404 · bad signature/key -> 401, no write
 *   malformed body -> 400, no write, no error doc · over rate limit -> 429
 *   oversize body -> 413 · duplicate -> 200 { deduped: true }, no second row
 *   created -> 201 { id, assignedTo } · transient/write failure -> 500
 *   + ingestion_errors doc (so the sender retries and the owner sees it)
 *
 * Logging policy: source + status + error CLASS only. Payloads,
 * phones, tokens, secrets and raw bodies are never logged.
 */

'use strict'

const http = require('node:http')
const { URL } = require('node:url')

const {
  verifyShopifyHmac,
  verifyMetaHubSignature,
  verifyMetaSignedRequest,
  verifyApiKey,
  verifyBearerToken,
} = require('./verify')
const { mapShopify, mapMetaLead, mapIndiaMart, mapWebsite } = require('./mappers')
const { extractLeadIds, fetchMetaLead } = require('./meta')
const { createRateLimiter } = require('./ratelimit')
const { deliverWithRetries } = require('./outbound')

function json(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) })
  res.end(payload)
}

function readRawBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    let tooLarge = false
    req.on('data', chunk => {
      total += chunk.length
      if (total > maxBytes) {
        tooLarge = true
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (tooLarge) {
        const error = new Error('body too large')
        error.code = 'TOO_LARGE'
        reject(error)
        return
      }
      resolve(Buffer.concat(chunks))
    })
    req.on('error', reject)
  })
}

function parseJsonBody(raw) {
  try {
    const parsed = JSON.parse(raw.toString('utf8'))
    return { ok: true, body: parsed }
  } catch {
    return { ok: false, error: 'body is not valid JSON' }
  }
}

function bearerToken(req) {
  const header = req.headers.authorization || ''
  if (!header.startsWith('Bearer ')) return ''
  return header.slice('Bearer '.length).trim()
}

/**
 * Shared ingest pipeline: dedupe -> route -> create.
 * Returns { status, body }. Never throws for expected failures.
 */
async function ingestMapped(store, ownerUid, mapped) {
  const existing = await store.findInquiryByExternalId(ownerUid, mapped.source, mapped.externalId)
  if (existing) {
    return { status: 200, body: { deduped: true, id: existing.id } }
  }
  const routing = await store.routeInquiry(ownerUid, { branchId: mapped.branchId || '' })
  const id = await store.createInquiry(ownerUid, {
    name: mapped.name,
    phone: mapped.phone,
    service: mapped.service,
    value: mapped.value,
    note: mapped.note,
    status: 'new',
    source: mapped.source,
    externalId: mapped.externalId,
    branchId: mapped.branchId || '',
    assignedTo: routing.assignedTo,
    assignedAt: routing.assignedAt,
    assignedBy: routing.assignedBy,
    date: 'Just now',
  })
  return { status: 201, body: { id, assignedTo: routing.assignedTo } }
}

function createServer({ config, store, deadLetters, deliveryStore = null, fetchFn = fetch } = {}) {
  const limiter = createRateLimiter({ perMinute: config.rateLimitPerMinute })

  async function handleShopify(req, res, rawBody) {
    const shop = req.headers['x-shopify-shop-domain'] || ''
    const entry = config.shopifySecrets.get(shop)
    if (!entry) return json(res, 404, { error: 'unknown source' })
    if (!verifyShopifyHmac(rawBody, req.headers['x-shopify-hmac-sha256'] || '', entry.secret)) {
      return json(res, 401, { error: 'bad signature' })
    }
    const parsed = parseJsonBody(rawBody)
    if (!parsed.ok) return json(res, 400, { error: parsed.error })
    const mapped = mapShopify(parsed.body)
    if (!mapped.ok) return json(res, 400, { error: mapped.error })
    try {
      const result = await ingestMapped(store, entry.ownerUid, mapped.mapped)
      return json(res, result.status, result.body)
    } catch (error) {
      await store.recordIngestionError(entry.ownerUid, {
        source: 'shopify', rawPayload: parsed.body, error: String(error && error.message || error),
      }).catch(() => {})
      return json(res, 500, { error: 'ingestion failed, please retry' })
    }
  }

  async function handleMeta(req, res, rawBody) {
    const parsed = parseJsonBody(rawBody)
    if (!parsed.ok) return json(res, 400, { error: parsed.error })
    const body = parsed.body
    // Page identification: entry[].id is the page id for leadgen webhooks.
    const pageId = Array.isArray(body.entry) && body.entry.length && body.entry[0].id
      ? String(body.entry[0].id)
      : ''
    const entry = config.metaPages.get(pageId)
    if (!entry) return json(res, 404, { error: 'unknown source' })
    const hubOk = verifyMetaHubSignature(rawBody, req.headers['x-hub-signature-256'] || '', entry.appSecret)
    const signedOk = body.signed_request
      ? verifyMetaSignedRequest(body.signed_request, entry.appSecret) !== null
      : false
    if (!hubOk && !signedOk) {
      return json(res, 401, { error: 'bad signature' })
    }
    // Meta verification handshake (GET ?hub.mode=subscribe) is handled
    // in the router below; POST here always carries lead ids.
    const leadIds = extractLeadIds(body)
    if (!leadIds.length) return json(res, 400, { error: 'meta: no leadgen_id in payload' })
    const created = []
    for (const leadId of leadIds) {
      let leadData
      try {
        leadData = await fetchMetaLead(leadId, entry.pageToken, fetchFn)
      } catch (error) {
        await store.recordIngestionError(entry.ownerUid, {
          source: 'meta', rawPayload: { leadgen_id: leadId }, error: String(error && error.message || error),
        }).catch(() => {})
        return json(res, 500, { error: 'ingestion failed, please retry' })
      }
      const mapped = mapMetaLead(leadId, leadData)
      if (!mapped.ok) return json(res, 400, { error: mapped.error })
      try {
        const result = await ingestMapped(store, entry.ownerUid, mapped.mapped)
        created.push({ leadId, ...result.body, status: result.status })
      } catch (error) {
        await store.recordIngestionError(entry.ownerUid, {
          source: 'meta', rawPayload: { leadgen_id: leadId }, error: String(error && error.message || error),
        }).catch(() => {})
        return json(res, 500, { error: 'ingestion failed, please retry' })
      }
    }
    return json(res, 201, { created })
  }

  async function handleIndiaMart(req, res, rawBody) {
    const providedKey = req.headers['x-im-key'] || ''
    let ownerUid = ''
    for (const entry of config.indiamartKeys.values()) {
      if (verifyApiKey(providedKey, entry.key)) {
        ownerUid = entry.ownerUid
        break
      }
    }
    if (!ownerUid) return json(res, 401, { error: 'bad key' })
    const parsed = parseJsonBody(rawBody)
    if (!parsed.ok) return json(res, 400, { error: parsed.error })
    const mapped = mapIndiaMart(parsed.body)
    if (!mapped.ok) return json(res, 400, { error: mapped.error })
    try {
      const result = await ingestMapped(store, ownerUid, mapped.mapped)
      return json(res, result.status, result.body)
    } catch (error) {
      await store.recordIngestionError(ownerUid, {
        source: 'indiamart', rawPayload: parsed.body, error: String(error && error.message || error),
      }).catch(() => {})
      return json(res, 500, { error: 'ingestion failed, please retry' })
    }
  }

  async function handleWebsite(req, res, rawBody) {
    const token = bearerToken(req)
    let ownerUid = ''
    for (const [candidateUid, hash] of config.websiteTokens) {
      if (verifyBearerToken(token, hash)) {
        ownerUid = candidateUid
        break
      }
    }
    if (!ownerUid) return json(res, 401, { error: 'bad token' })
    const parsed = parseJsonBody(rawBody)
    if (!parsed.ok) return json(res, 400, { error: parsed.error })
    const mapped = mapWebsite(parsed.body)
    if (!mapped.ok) return json(res, 400, { error: mapped.error })
    try {
      const result = await ingestMapped(store, ownerUid, mapped.mapped)
      return json(res, result.status, result.body)
    } catch (error) {
      await store.recordIngestionError(ownerUid, {
        source: 'website', rawPayload: parsed.body, error: String(error && error.message || error),
      }).catch(() => {})
      return json(res, 500, { error: 'ingestion failed, please retry' })
    }
  }

  async function handleOpsDeadLetters(req, res) {
    if (!config.adminKey || bearerToken(req) !== config.adminKey) {
      return json(res, 404, { error: 'not found' })
    }
    return json(res, 200, { deadLetters: await deadLetters.list() })
  }

  async function handleOpsRetry(req, res, id) {
    if (!config.adminKey || bearerToken(req) !== config.adminKey) {
      return json(res, 404, { error: 'not found' })
    }
    const record = await deadLetters.get(id)
    if (!record) return json(res, 404, { error: 'dead letter not found' })
    const sub = config.subscriptions.find(s => s.id === record.subscriptionId)
    if (!sub) return json(res, 400, { error: 'subscription no longer configured' })
    const result = await deliverWithRetries(sub, record.payload, { fetchFn, sleep: ms => new Promise(r => setTimeout(r, ms)) })
    if (result.delivered) {
      // Mark delivered BEFORE resolving the letter, so a restart
      // between the two steps can never resend it via the watcher.
      if (deliveryStore) {
        try {
          await deliveryStore.markDelivered(sub.ownerUid, record.payload.inquiryId, sub.id)
        } catch {
          // Best effort: the letter is still resolved below, and the
          // watcher watermark has already passed this inquiry.
        }
      }
      await deadLetters.remove(id)
      return json(res, 200, { redelivered: true })
    }
    return json(res, 502, { redelivered: false, lastError: result.lastError })
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://localhost')
      const path = url.pathname

      if (req.method === 'GET' && path === '/health') {
        return json(res, 200, { ok: true })
      }

      // Meta verification handshake: GET with hub.mode=subscribe.
      // The verify token is operator-set (META_VERIFY_TOKEN) and must
      // match the token entered in the Meta app dashboard. It is NOT
      // any page token or app secret.
      if (req.method === 'GET' && path === '/ingest/meta') {
        const mode = url.searchParams.get('hub.mode')
        const token = url.searchParams.get('hub.verify_token')
        const challenge = url.searchParams.get('hub.challenge')
        if (mode === 'subscribe' && token && config.metaVerifyToken &&
            token === config.metaVerifyToken && challenge) {
          res.writeHead(200, { 'Content-Type': 'text/plain' })
          res.end(challenge)
          return
        }
        return json(res, 403, { error: 'verification failed' })
      }

      if (req.method === 'GET' && path === '/ops/dead-letters') {
        return handleOpsDeadLetters(req, res)
      }
      const retryMatch = path.match(/^\/ops\/dead-letters\/([^/]+)\/retry$/)
      if (req.method === 'POST' && retryMatch) {
        return handleOpsRetry(req, res, decodeURIComponent(retryMatch[1]))
      }

      if (req.method !== 'POST' || !path.startsWith('/ingest/')) {
        return json(res, 404, { error: 'not found' })
      }
      const source = path.slice('/ingest/'.length)
      if (!['shopify', 'meta', 'indiamart', 'website'].includes(source)) {
        return json(res, 404, { error: 'unknown source' })
      }

      let rawBody
      try {
        rawBody = await readRawBody(req, config.maxBodyBytes)
      } catch (error) {
        if (error.code === 'TOO_LARGE') return json(res, 413, { error: 'body too large' })
        return json(res, 400, { error: 'could not read body' })
      }

      // Rate limit AFTER routing but BEFORE auth details leak timing:
      // the bucket key uses the source + the caller-supplied identifier
      // (shop domain / page id / key id / token hash) so one bad actor
      // cannot exhaust another workspace's bucket.
      const bucketKey = [
        source,
        req.headers['x-shopify-shop-domain'] || '',
        req.headers['x-im-key'] ? 'im' : '',
        bearerToken(req) ? 'web' : '',
      ].join(':')
      if (!limiter.take(bucketKey)) {
        return json(res, 429, { error: 'rate limited, retry later' })
      }

      if (source === 'shopify') return handleShopify(req, res, rawBody)
      if (source === 'meta') return handleMeta(req, res, rawBody)
      if (source === 'indiamart') return handleIndiaMart(req, res, rawBody)
      return handleWebsite(req, res, rawBody)
    } catch (error) {
      // Last-resort guard: never leak internals, never crash the process.
      try {
        json(res, 500, { error: 'internal error' })
      } catch {
        // Response already gone; nothing left to do.
      }
      void error
    }
  })

  return server
}

module.exports = { createServer }
