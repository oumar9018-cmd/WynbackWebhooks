# wynback-ingest — Universal Webhooks & API service

A SEPARATE service that lets Shopify, Meta Ads, IndiaMART and custom
websites push leads straight into the Wynback inbox. It is deliberately
NOT part of the SPA: the SPA bundle ships to every visitor's browser,
so it must never hold a secret. This service holds all secrets
server-side, in environment variables only.

## The zero-mess rule (spec §3)

- The service writes ONLY `users/{ownerUid}/inquiries` (new docs) and
  `users/{ownerUid}/ingestion_errors` (failed payloads), and reads ONLY
  members + the round-robin pointer. It NEVER writes settings, members,
  invites, audit or user docs.
- The SPA gets no webhook code, no secret, no new dependency. If this
  service dies, the app keeps working exactly as today — manual entry
  is the fallback, not a crash.
- No payment code, no paywall, free-forever.

## Run

```sh
npm test          # 39 tests, zero dependencies, no network
npm start         # memory store by default (dev/smoke only)
FIRESTORE_MODE=firestore FIREBASE_SERVICE_ACCOUNT_PATH=/path/to/key.json npm start
# On Render: FIRESTORE_MODE=firestore + FIREBASE_SERVICE_ACCOUNT_JSON=<key JSON> (see DEPLOY.md)
```

Copy `.env.example` to `.env` and fill it in. `.env` is git-ignored.

## Endpoints

| Route | Auth | Notes |
|---|---|---|
| `POST /ingest/shopify` | HMAC-SHA256 over raw body (`X-Shopify-Hmac-Sha256`), per-shop secret; shop from `X-Shopify-Shop-Domain` | Order / abandoned checkout → inquiry; `externalId` = order id |
| `POST /ingest/meta` | `X-Hub-Signature-256` (app secret); handshake via `META_VERIFY_TOKEN` | Webhook carries only the lead id; the service fetches lead data via Graph API with the page token |
| `POST /ingest/indiamart` | `X-IM-Key` header (per-owner key) | BL enquiry fields mapped |
| `POST /ingest/website` | `Authorization: Bearer <workspace token>` (service stores only its sha256) | Generic JSON `{ name, phone, service?, value?, note?, branchId? }` |
| `GET /health` | none | Liveness only |
| `GET /ops/dead-letters` | `ADMIN_KEY` bearer (404 when unset) | Failed outbound deliveries |
| `POST /ops/dead-letters/:id/retry` | `ADMIN_KEY` bearer | Redeliver one dead letter |

Status contract: unknown source → 404 · bad signature/key → 401, no
write · malformed body → 400, no write, no error doc · over rate
limit → 429 · oversize body (>1 MB) → 413 · duplicate
(source + externalId) → 200 `{ deduped: true }`, no second row ·
created → 201 `{ id, assignedTo }` · transient/write failure → 500
+ an `ingestion_errors` doc so the sender retries and the owner sees it.

## Inbound pipeline (every source)

verify → validate (name required; phone must pass the SPA's exact
normalization) → dedupe by (source + externalId) → round-robin route
(least-loaded-first among available reps/admins-taking-leads, pointer
tiebreak, one transaction in Firestore mode; unassigned fallback, never
blocks creation) → create inquiry (`status: 'new'`, `source`,
`externalId`, `assignedBy: 'round-robin'`, `date: 'Just now'`).

Rate limit: 100/min per (source, workspace) by default, token bucket.

## Outbound

New inquiries are fanned out by a poller (`WATCHER_POLL_MS`, default
15s) to env-configured subscriptions (optional branch filter). Each
delivery is HMAC-SHA256 signed (`X-Wynback-Signature`) and carries
`X-Wynback-Delivery-Id` (`inquiryId:subscriptionId`) so receivers can
dedupe. Retries: immediate, 5s, 30s, 5min; after exhaustion the attempt
lands in the dead-letter queue (visible/retryable via `/ops/*`).

**Semantics: at-least-once, durably in Firestore mode.** Delivery
marks + dead letters live in `users/{ownerUid}/webhook_deliveries`
(go-live decision, 2026-10-30): a restart never redelivers a marked
delivery, and dead letters survive restarts. Dead letters are
RESOLVED on retry success (status → `resolved`), never deleted —
the narrow service-account spec grants no delete permission. Memory
mode keeps in-memory state for local tests/dev only.

## Spec corrections made while building (not papered over)

1. **Meta verification:** the spec says "signed request verification
   with the app secret", but Meta's real webhook mechanism is
   `X-Hub-Signature-256` (HMAC over the raw body). The service
   implements the real mechanism and ALSO accepts a `signed_request`
   body parameter if one is ever sent. Both paths are tested.
2. **IndiaMART field names:** the BL form contract is mapped from the
   documented `SENDER_NAME / SENDER_MOBILE / PRODUCT_NAME / MESSAGE /
   ENQUIRY_ID` shape plus lowercase aliases. If IndiaMART's live
   contract differs, only `src/mappers.js` changes — confirm against
   IndiaMART's docs at onboarding time.
3. **Website tokens:** the spec's "token minted by the owner in
   Settings phase 2" does not exist yet (no Settings UI for it). Until
   then, website tokens are operator-provisioned: generate a random
   token, store ONLY its sha256 hex in `WEBSITE_TOKENS_JSON`, hand the
   raw token to the workspace owner once over a trusted channel.

## Deployment (decided 2026-10-30, owner-delegated)

**Hosting: Render free-tier web service** (`npm install && npm
start`), plain Node — no Cloud Run, no Functions. Full click-path:
`DEPLOY.md`. Free-tier caveat: Render free services sleep when idle
(the watcher poller does not keep them awake), so the first webhook
after a sleep pays a cold-start delay; webhooks still arrive.

**Dedicated service account (required for Firestore mode):** see
`SERVICE_ACCOUNT.md` for the exact narrow custom role (inquiries
create+read, ingestion_errors create, members read,
settings/workspace read + pointer write, webhook_deliveries
create+update+read — NO delete) and the console click-path. The key
goes into Render as `FIREBASE_SERVICE_ACCOUNT_JSON` (or a file path
in `FIREBASE_SERVICE_ACCOUNT_PATH` on other hosts). Never reuse the
app's broad admin key. The service-account JSON itself is never
committed, never logged, never copied into chat.

## Owner decisions — resolved vs still open

Decided (2026-10-30, owner-delegated, implemented in this repo):
1. ~~Hosting target~~ → Render free tier (`DEPLOY.md`, `render.yaml`).
2. ~~Dedicated narrow service account~~ → spec + click-path in
   `SERVICE_ACCOUNT.md`; the owner creates the key (no console
   access from the build machine).
3. ~~Durable outbound delivery state~~ → APPROVED and implemented:
   `users/{ownerUid}/webhook_deliveries` (see Outbound above).
4. ~~Website token minting UI~~ → operator provisioning for v1
   (random token, only its sha256 in env).
5. ~~IndiaMART live field contract~~ → stays as mapped; confirm at
   first onboarding (only `src/mappers.js` would change).

Still open (needs a real onboarding, not a decision):
- IndiaMART live field confirmation at first onboarding.
- Outbound subscriptions per workspace (URLs + shared secrets) —
  none configured by default; the watcher is inert with none.

## What is NOT verified (honest)

- No live provider traffic: no real Shopify/Meta/IndiaMART webhook
  has hit this code. The verification gate (bad sig → 401 zero
  writes, double-post → one row, bad phone → 400 zero writes) is
  proven in tests + memory store, not against live providers.
- No deployed endpoint exists yet. Firestore mode is code-reviewed
  and syntax-checked but has never run against leadback-3345f
  (deliberately: no live writes in this build).
- The 1,000-Meta-leads/hour fairness gate needs a live run with real
  members once deployed.
