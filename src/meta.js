/**
 * wynback-ingest — Meta lead-ads fetch.
 *
 * The webhook itself carries only the lead id — never the phone.
 * The service fetches the lead server-side via Graph API with the
 * page token. The token is passed in, used once, and never logged.
 * fetchFn is injectable so tests never touch the network.
 */

'use strict'

const GRAPH_VERSION = 'v21.0'

/**
 * Extract leadgen ids from a Meta webhook body:
 * entry[].changes[].value.leadgen_id (field === 'leadgen').
 */
function extractLeadIds(body) {
  const ids = []
  if (!body || typeof body !== 'object' || !Array.isArray(body.entry)) return ids
  for (const entry of body.entry) {
    if (!entry || !Array.isArray(entry.changes)) continue
    for (const change of entry.changes) {
      const value = change && change.value
      if (value && typeof value.leadgen_id === 'string' && value.leadgen_id) {
        ids.push(value.leadgen_id)
      }
    }
  }
  return ids
}

/**
 * Fetch one lead's field_data. Throws on non-2xx so the caller can
 * record an ingestion error and return 500 (sender retries).
 */
async function fetchMetaLead(leadId, pageToken, fetchFn = fetch) {
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(leadId)}?fields=field_data&access_token=${encodeURIComponent(pageToken)}`
  const res = await fetchFn(url, { method: 'GET' })
  if (!res || typeof res.ok !== 'boolean' || !res.ok) {
    const status = res ? res.status : 'no-response'
    throw new Error(`meta: Graph API fetch failed (${status})`)
  }
  const data = await res.json()
  if (!data || typeof data !== 'object') {
    throw new Error('meta: Graph API returned an unexpected body')
  }
  return data
}

module.exports = { extractLeadIds, fetchMetaLead }
