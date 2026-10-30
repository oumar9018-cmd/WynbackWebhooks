# SERVICE_ACCOUNT.md — dedicated narrow service account for wynback-ingest

Owner decision (2026-10-30, delegated): the service uses a
**dedicated NARROW key — never the app's broad admin key**. The key
cannot be created by the build machine (no console access), so this
doc is the exact spec + click-path for the owner. Nothing in this doc
is a secret; the key itself is created in the console and pasted
directly into Render env vars, never into the repo, never into chat.

## What the service actually touches (the whole allow-list)

Firestore project: `leadback-3345f` (the same project the SPA uses).
The service's Admin SDK bypasses Firestore security rules — IAM on
this service account IS the access boundary, which is why the account
must be dedicated and narrow.

| Collection path | Operations the code performs | Permission needed |
|---|---|---|
| `users/{ownerUid}/inquiries` | create new inquiry docs; read for dedupe (`source` + `externalId` query) and for the watcher poll | create, read |
| `users/{ownerUid}/ingestion_errors` | create error docs on transient failures | create |
| `users/{ownerUid}/members` | read (round-robin candidate list) | read |
| `users/{ownerUid}/settings/workspace` | read the round-robin pointer; write ONLY the `roundRobin` pointer field (transactional, merged) | read, write (pointer field only) |
| `users/{ownerUid}/webhook_deliveries` | create + update delivered marks; create + update dead letters; read for `/ops` | create, update, read |

**NOT granted, on purpose:** delete on ANY collection (dead letters
are resolved with an update, never deleted); write to members,
invites, audit, or any other settings field; read or write to any
other user's data (the code only ever addresses the workspace in the
request, but IAM is the backstop — see the hardening note below).

## Honest IAM note (read before you pick the role)

Firestore IAM roles are project-wide, not per-collection: there is no
off-the-shelf role that says "only these five collections". The
practical narrow setup is:

1. A **dedicated service account** used by nothing else (so a leak
   can be revoked by disabling one account, and its usage is
   auditable on its own).
2. A **custom role** with only the Datastore permissions the code
   uses (below) — no `Editor`, no `Owner`, no `roles/datastore.user`
   (that role also grants delete + import/export + index admin).
3. Optional hardening — **IAM conditions** on the grant scoping
   `resource.name` to the `users/` document tree. Condition syntax
   for Firestore document paths varies by project setup; treat it as
   hardening to attempt in the console, not as a guaranteed gate.
   The code-level narrow path (it only ever builds those five
   collection paths) is the primary control; IAM is the backstop.

Custom-role permissions (create the role, then grant it — nothing else):

```
datastore.entities.create
datastore.entities.get
datastore.entities.list
datastore.entities.update
datastore.databases.get
```

That is the full set: `create` (inquiries, errors, delivery docs),
`get` + `list` (dedupe query, member list, watcher poll, dead-letter
list), `update` (pointer write, delivery marks, dead-letter resolve),
`databases.get` (client bootstrap). Deliberately absent:
`datastore.entities.delete`, `datastore.importExport`,
`datastore.indexes.*`, `datastore.operations.*`, `iam.*`,
`resourcemanager.*`.

## Console click-path (Google Cloud Console)

1. Open https://console.cloud.google.com and switch to project
   **leadback-3345f** (top bar project picker; if it is not listed,
   you are signed into the wrong Google account — this project is
   visible only to the oumar9018 account, not the mockgril account).
2. **IAM & Admin → Roles** → **Create Role**:
   - Title: `Wynback Ingest Narrow`
   - ID: `wynback_ingest_narrow` (auto-filled from the title)
   - Role launch stage: General Availability
   - Add the five permissions above, one by one, then **Create**.
3. **IAM & Admin → Service Accounts** → **Create Service Account**:
   - Name: `wynback-ingest` (ID auto-fills)
   - Description: `Wynback webhooks service only — narrow role, never the app admin key`
   - **Create and Continue** → grant access: select the
     `Wynback Ingest Narrow` custom role → **Continue** → **Done**.
     (Do NOT grant users access to this service account.)
4. Back on the service-account list, click `wynback-ingest` →
   **Keys** → **Add Key** → **Create new key** → **JSON** →
   **Create**. A JSON file downloads. **This file is the only copy
   of the key — treat it like a password.**
5. Open the JSON file, copy its ENTIRE contents (one line when
   pasted — the `private_key` newlines stay as `\n` inside the JSON
   string, exactly as downloaded).
6. In the Render dashboard, service `wynback-webhooks` →
   **Environment** → add `FIREBASE_SERVICE_ACCOUNT_JSON` with the
   pasted JSON → **Save Changes** (Render redeploys).
7. Delete the downloaded JSON file from your machine after pasting
   (or store it in a password manager — never in the repo, never in
   Drive as a plain file, never in chat).

## Verify the key is narrow (do this once, right after deploy)

1. Render Logs show `wynback-ingest listening on :<port>
   (store=firestore)` — if it says `store=memory`, the env var did
   not land; fix it before connecting providers.
2. `GET /health` on the service URL returns `{"ok":true}`.
3. An unauthenticated website POST returns `401 {"error":"bad
   token"}` (see DEPLOY.md step 3).
4. In the console, **IAM & Admin → Service Accounts** →
   `wynback-ingest` → **Permissions** shows ONLY the custom role.
   If it shows Editor/Owner/datastore.user, remove that grant
   immediately — the service must never run with it.

## If this key ever leaks

1. Console → **IAM & Admin → Service Accounts** → `wynback-ingest`
   → **Keys** → delete the leaked key (the service stops working
   until a replacement is pasted — that is the point).
2. Create a new key, paste it into Render env vars, redeploy.
3. Check Firestore usage in the console for unexpected reads/writes
   during the exposure window. The narrow role bounds the blast
   radius to the five paths above even in the worst case.
