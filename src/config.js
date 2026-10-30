/**
 * wynback-ingest — configuration.
 *
 * Every secret lives in the ENVIRONMENT, never in this repo, never in
 * the SPA bundle. Values are never logged. Startup fails fast on
 * malformed config so a misconfigured deploy refuses traffic instead
 * of silently accepting unsigned webhooks.
 *
 * Env vars (see .env.example for shapes, placeholders only):
 *   PORT                          HTTP port (default 3000)
 *   FIRESTORE_MODE                'memory' (default, tests/dev) or 'firestore'
 *   FIREBASE_SERVICE_ACCOUNT_PATH path to a service-account JSON file
 *                                 (only read by firebase-admin, never logged)
 *   FIREBASE_SERVICE_ACCOUNT_JSON the same key JSON as an env var
 *                                 (Render path — paste the whole JSON;
 *                                 exactly one of PATH / JSON must be
 *                                 set in Firestore mode)
 *   SHOPIFY_SECRETS_JSON          {"<shop-domain>": {"ownerUid": "...", "secret": "..."}}
 *   META_PAGES_JSON               {"<page-id>": {"ownerUid": "...", "pageToken": "...", "appSecret": "..."}}
 *   INDIAMART_KEYS_JSON           {"<key-id>": {"ownerUid": "...", "key": "..."}}
 *   WEBSITE_TOKENS_JSON           {"<ownerUid>": "<sha256 hex of the bearer token>"}
 *   OUTBOUND_SUBSCRIPTIONS_JSON   [{"id": "...", "ownerUid": "...", "url": "...", "secret": "...", "branchId": ""}]
 *   ADMIN_KEY                     bearer key for /ops/* endpoints; unset => /ops/* returns 404
 *   RATE_LIMIT_PER_MINUTE         per (source, workspace) bucket (default 100)
 *   MAX_BODY_BYTES                raw body cap (default 1048576 = 1 MB)
 *   WATCHER_POLL_MS               outbound watcher interval (default 15000; 0 disables)
 *
 * NOTE on website tokens: the spec's "token minted by the owner in
 * Settings phase 2" does not exist yet — there is no Settings UI for
 * it. Until that phase ships, website tokens are provisioned by the
 * operator: generate a random token, store ONLY its sha256 hex in
 * WEBSITE_TOKENS_JSON, and hand the raw token to the workspace owner
 * once over a trusted channel. The service never stores raw tokens.
 */

'use strict'

function parseJsonMap(name, raw) {
  if (!raw) return new Map()
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`config: ${name} is not valid JSON`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`config: ${name} must be a JSON object`)
  }
  return new Map(Object.entries(parsed))
}

function parseJsonArray(name, raw) {
  if (!raw) return []
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`config: ${name} is not valid JSON`)
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`config: ${name} must be a JSON array`)
  }
  return parsed
}

function loadConfig(env = process.env) {
  const shopifySecrets = parseJsonMap('SHOPIFY_SECRETS_JSON', env.SHOPIFY_SECRETS_JSON)
  for (const [shop, entry] of shopifySecrets) {
    if (!entry || typeof entry.ownerUid !== 'string' || !entry.ownerUid ||
        typeof entry.secret !== 'string' || !entry.secret) {
      throw new Error(`config: SHOPIFY_SECRETS_JSON entry for shop is missing ownerUid/secret`)
    }
    void shop
  }

  const metaPages = parseJsonMap('META_PAGES_JSON', env.META_PAGES_JSON)
  for (const [pageId, entry] of metaPages) {
    if (!entry || typeof entry.ownerUid !== 'string' || !entry.ownerUid ||
        typeof entry.pageToken !== 'string' || !entry.pageToken ||
        typeof entry.appSecret !== 'string' || !entry.appSecret) {
      throw new Error(`config: META_PAGES_JSON entry for page is missing ownerUid/pageToken/appSecret`)
    }
    void pageId
  }

  const indiamartKeys = parseJsonMap('INDIAMART_KEYS_JSON', env.INDIAMART_KEYS_JSON)
  for (const [keyId, entry] of indiamartKeys) {
    if (!entry || typeof entry.ownerUid !== 'string' || !entry.ownerUid ||
        typeof entry.key !== 'string' || !entry.key) {
      throw new Error(`config: INDIAMART_KEYS_JSON entry is missing ownerUid/key`)
    }
    void keyId
  }

  const websiteTokens = parseJsonMap('WEBSITE_TOKENS_JSON', env.WEBSITE_TOKENS_JSON)
  for (const [ownerUid, hash] of websiteTokens) {
    if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) {
      throw new Error(`config: WEBSITE_TOKENS_JSON entry for a workspace is not a sha256 hex digest`)
    }
    void ownerUid
  }

  const subscriptions = parseJsonArray('OUTBOUND_SUBSCRIPTIONS_JSON', env.OUTBOUND_SUBSCRIPTIONS_JSON)
  for (const sub of subscriptions) {
    if (!sub || typeof sub.id !== 'string' || !sub.id ||
        typeof sub.ownerUid !== 'string' || !sub.ownerUid ||
        typeof sub.url !== 'string' || !/^https?:\/\//.test(sub.url) ||
        typeof sub.secret !== 'string' || !sub.secret) {
      throw new Error('config: OUTBOUND_SUBSCRIPTIONS_JSON entry is missing id/ownerUid/url/secret')
    }
  }

  const rateLimitPerMinute = env.RATE_LIMIT_PER_MINUTE ? Number(env.RATE_LIMIT_PER_MINUTE) : 100
  if (!Number.isFinite(rateLimitPerMinute) || rateLimitPerMinute <= 0) {
    throw new Error('config: RATE_LIMIT_PER_MINUTE must be a positive number')
  }
  const maxBodyBytes = env.MAX_BODY_BYTES ? Number(env.MAX_BODY_BYTES) : 1048576
  if (!Number.isFinite(maxBodyBytes) || maxBodyBytes <= 0) {
    throw new Error('config: MAX_BODY_BYTES must be a positive number')
  }
  const watcherPollMs = env.WATCHER_POLL_MS ? Number(env.WATCHER_POLL_MS) : 15000
  if (!Number.isFinite(watcherPollMs) || watcherPollMs < 0) {
    throw new Error('config: WATCHER_POLL_MS must be >= 0')
  }

  const firestoreMode = env.FIRESTORE_MODE || 'memory'
  if (firestoreMode !== 'memory' && firestoreMode !== 'firestore') {
    throw new Error("config: FIRESTORE_MODE must be 'memory' or 'firestore'")
  }
  let serviceAccountJson = null
  if (env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    try {
      serviceAccountJson = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_JSON)
    } catch {
      throw new Error('config: FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON')
    }
    if (!serviceAccountJson || typeof serviceAccountJson !== 'object' ||
        typeof serviceAccountJson.private_key !== 'string' ||
        typeof serviceAccountJson.client_email !== 'string') {
      throw new Error('config: FIREBASE_SERVICE_ACCOUNT_JSON is not a service-account key (missing private_key/client_email)')
    }
  }
  if (firestoreMode === 'firestore' && !env.FIREBASE_SERVICE_ACCOUNT_PATH && !serviceAccountJson) {
    throw new Error('config: FIRESTORE_MODE=firestore requires FIREBASE_SERVICE_ACCOUNT_PATH or FIREBASE_SERVICE_ACCOUNT_JSON')
  }

  return {
    port: env.PORT ? Number(env.PORT) : 3000,
    firestoreMode,
    serviceAccountPath: env.FIREBASE_SERVICE_ACCOUNT_PATH || '',
    serviceAccountJson,
    shopifySecrets,
    metaPages,
    indiamartKeys,
    websiteTokens,
    subscriptions,
    adminKey: env.ADMIN_KEY || '',
    metaVerifyToken: env.META_VERIFY_TOKEN || '',
    rateLimitPerMinute,
    maxBodyBytes,
    watcherPollMs,
  }
}

module.exports = { loadConfig }
