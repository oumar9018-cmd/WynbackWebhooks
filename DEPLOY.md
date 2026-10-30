# DEPLOY.md — wynback-ingest on Render (free tier)

Owner decision (2026-10-30, delegated): hosting = **Render free-tier
web service**, plain Node (`npm install && npm start`). No Cloud Run,
no Functions. This doc is the exact click-path. Nothing here deploys
itself — the owner (or an operator with the Render login) performs
the taps below. The service code never contains a secret; every
secret is a Render env var set in the dashboard.

## 0. Before you start (one-time, in order)

1. **Create the repo (owner tap — automated creation is blocked).**
   The build machine's GitHub connection cannot create repositories
   (attempt returned 403 "Resource not accessible by integration",
   and a search confirms `WynbackWebhooks` does not exist yet), so
   this step is manual: on GitHub, **New repository** → owner
   `oumar9018-cmd`, name `WynbackWebhooks`, **Private**, do NOT add
   a README/license/.gitignore (an empty repo avoids a merge on
   first push). After that, tell the assistant "repo ready" and it
   will push this code on the next turn — or push manually with the
   commands in §6. Render deploys from that repo — never from the
   LeadBack SPA repo.
2. **Create the dedicated narrow service account** — follow
   `SERVICE_ACCOUNT.md` exactly. You will end with a service-account
   JSON key. Do NOT reuse the app's broad admin key.

## 1. Create the Render service (dashboard clicks)

1. Sign in at https://dashboard.render.com (the account that already
   hosts the suspended `leadback-payment` service — this is a NEW
   service, not a revival of that one).
2. Click **New +** → **Web Service**.
3. **Connect a repository**: pick `oumar9018-cmd/WynbackWebhooks`
   (if it is not listed, connect the GitHub account to Render first
   via Account Settings → GitHub, then come back).
4. Fill in:
   - **Name**: `wynback-webhooks`
   - **Region**: closest to your users (Singapore is the usual pick
     for India-first traffic; any region works).
   - **Branch**: `main`
   - **Runtime**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: `Free`
   - **Health Check Path**: `/health`
   - **Auto-Deploy**: `Yes` (each push to `main` redeploys).
5. Click **Create Web Service**. The first build runs with no secrets
   yet — it will boot, fail fast on missing Firestore config, and
   refuse traffic. That is the safe default; proceed to step 2 before
   judging the deploy.

Alternative: **New +** → **Blueprint**, point it at this repo — the
included `render.yaml` creates the same service with the same
settings. Either path ends at the same service; the manual path
above is written out because it shows every setting explicitly.

## 2. Set environment variables (dashboard, never in the repo)

On the service page → **Environment** → **Add Environment Variable**,
one row per variable below. Paste values exactly; JSON values go in
as one line (no line breaks inside the value box).

| Variable | Value |
|---|---|
| `FIRESTORE_MODE` | `firestore` |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | The ENTIRE service-account JSON from step 0 (single line; keep the `private_key` newlines as `\n` inside the JSON string, exactly as downloaded) |
| `ADMIN_KEY` | A long random string you generate (e.g. `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`) — the bearer key for `/ops/*` |
| `SHOPIFY_SECRETS_JSON` | Only when a shop is connected: `{"shop.myshopify.com":{"ownerUid":"<uid>","secret":"<shared-secret>"}}` |
| `META_PAGES_JSON` | Only when a page is connected: `{"<page-id>":{"ownerUid":"<uid>","pageToken":"<token>","appSecret":"<secret>"}}` |
| `META_VERIFY_TOKEN` | Only when Meta is connected: the token you type into the Meta app dashboard for the webhook handshake |
| `INDIAMART_KEYS_JSON` | Only when IndiaMART is connected: `{"owner-a":{"ownerUid":"<uid>","key":"<key>"}}` |
| `WEBSITE_TOKENS_JSON` | Only when a website form is connected: `{"<uid>":"<sha256-hex-of-token>"}` — generate with `node -e "console.log(require('crypto').createHash('sha256').update('TOKEN').digest('hex'))"` and hand the raw token to the site owner once |
| `OUTBOUND_SUBSCRIPTIONS_JSON` | Only when outbound is wanted: `[{"id":"crm-1","ownerUid":"<uid>","url":"https://example.com/hook","secret":"<shared-secret>","branchId":""}]` |
| `RATE_LIMIT_PER_MINUTE` | `100` |
| `MAX_BODY_BYTES` | `1048576` |
| `WATCHER_POLL_MS` | `15000` |

After saving, Render redeploys automatically. **PORT is set by
Render itself — do not set it.**

## 3. Verify the deploy (do this before giving the URL to anyone)

1. On the service page, wait for **Live** (green) and check the Logs
   tab for `wynback-ingest listening on :<port> (store=firestore)`.
   If it says `store=memory`, `FIRESTORE_MODE` is wrong — fix it and
   redeploy; memory mode drops delivery state on restart.
2. Open `https://wynback-webhooks.onrender.com/health` (replace with
   your actual service URL from the dashboard). It must return
   `{"ok":true}`. If it does not, the deploy is not Live yet — do
   not proceed.
3. Send one unauthenticated website webhook and confirm it is
   rejected with no write:
   ```sh
   curl -X POST https://wynback-webhooks.onrender.com/ingest/website \
     -H 'Content-Type: application/json' \
     -d '{"name":"Smoke","phone":"9876543210"}'
   ```
   Expected: `401 {"error":"bad token"}`. A `201` here would mean
   auth is misconfigured — stop and fix it before connecting any
   real provider.

## 4. Connect providers (give them these URLs)

Replace `wynback-webhooks.onrender.com` with your actual service URL:

- **Shopify**: Admin → Settings → Notifications → Webhooks →
  create webhook, event "Order creation" (and "Checkout abandonment"
  if wanted), URL `https://wynback-webhooks.onrender.com/ingest/shopify`,
  format JSON. Copy the webhook's shared secret into
  `SHOPIFY_SECRETS_JSON` for that shop domain.
- **Meta**: app dashboard → Webhooks → Lead Ads → subscribe, callback
  URL `https://wynback-webhooks.onrender.com/ingest/meta`, verify
  token = your `META_VERIFY_TOKEN`. Add the page id + page token +
  app secret to `META_PAGES_JSON`.
- **IndiaMART**: set the push URL to
  `https://wynback-webhooks.onrender.com/ingest/indiamart` and the
  `X-IM-Key` to your key in `INDIAMART_KEYS_JSON`.
- **Custom website**: POST JSON to
  `https://wynback-webhooks.onrender.com/ingest/website` with
  `Authorization: Bearer <raw-token>`; the service stores only the
  sha256 of that token in `WEBSITE_TOKENS_JSON`.

## 5. Free-tier behaviour (read this before promising real-time)

- Render free web services **sleep after inactivity**. The first
  webhook after a sleep pays a cold-start delay (tens of seconds);
  the webhook still arrives because Render wakes the service. The
  outbound watcher poller does NOT keep the service awake.
- If cold-start delay ever matters, the fix is a paid instance
  type — not a code change. Do not add a "keep-alive pinger" that
  burns the free tier; it does not make delivery real-time either.

## 6. Operate

- **Dead letters**: `GET /ops/dead-letters` and
  `POST /ops/dead-letters/:id/retry`, both with
  `Authorization: Bearer <ADMIN_KEY>`. Dead letters now persist in
  `users/{ownerUid}/webhook_deliveries` (status `dead-letter`);
  retrying one marks it delivered and resolves the letter.
- **Logs**: Render Logs tab only. The service logs source + status +
  error class — never payloads, phones, tokens, or raw bodies.
- **Rotate a secret**: change the value in Render Environment, save,
  Render redeploys. Never edit a secret into the repo.

## If repo creation was unavailable (fallback — read only if the repo step failed)

This fallback is ACTIVE, not hypothetical: automated creation of
`oumar9018-cmd/WynbackWebhooks` was attempted and failed with 403
"Resource not accessible by integration" (the GitHub connection
lacks repository-creation permission), and a search confirms the
repo does not exist yet. Nothing was pushed anywhere — in
particular, nothing was pushed into the LeadBack SPA repo. Follow
this manual path:
1. On GitHub, **New repository** → name `WynbackWebhooks`, owner
   `oumar9018-cmd`, **Private**, do NOT add a README/license/
   .gitignore (an empty repo avoids a merge on first push).
2. On the build machine, from the service directory:
   ```sh
   git init -b main
   git add -A   # after verifying: no .env, no *.json key file, no secret
   git commit -m "wynback-ingest: webhooks + API service (go-live)"
   git remote add origin git@github.com:oumar9018-cmd/WynbackWebhooks.git
   git push -u origin main
   ```
3. Verify on GitHub that no `.env` and no service-account JSON is in
   the repo, then continue at step 1 above.
