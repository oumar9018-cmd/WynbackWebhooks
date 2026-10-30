/**
 * wynback-ingest — entrypoint.
 *
 * Builds config (fail-fast), picks the store (memory by default,
 * Firestore when FIRESTORE_MODE=firestore), starts the HTTP server
 * and the outbound watcher. Nothing here touches the SPA repo.
 * Shutdown is graceful on SIGINT/SIGTERM.
 */

'use strict'

const { loadConfig } = require('./config')
const { MemoryStore } = require('./store')
const { DeadLetterQueue, MemoryDeliveryStore } = require('./outbound')
const { createWatcher } = require('./watcher')
const { createServer } = require('./server')

async function main() {
  const config = loadConfig()

  let store
  let deliveryStore
  let deadLetters
  if (config.firestoreMode === 'firestore') {
    // Lazy require: memory-mode runs never need firebase-admin.
    // eslint-disable-next-line global-require
    const { FirestoreStore } = require('./store-firestore')
    // eslint-disable-next-line global-require
    const { FirestoreDeliveryStore, FirestoreDeadLetterQueue } = require('./delivery-firestore')
    store = new FirestoreStore({
      serviceAccountPath: config.serviceAccountPath,
      serviceAccountJson: config.serviceAccountJson,
    })
    // Durable outbound state (go-live decision): marks + dead
    // letters live in users/{ownerUid}/webhook_deliveries.
    deliveryStore = new FirestoreDeliveryStore({ db: store.db })
    deadLetters = new FirestoreDeadLetterQueue({ db: store.db })
  } else {
    store = new MemoryStore()
    deliveryStore = new MemoryDeliveryStore()
    deadLetters = new DeadLetterQueue()
  }

  const watcher = createWatcher({
    store,
    deliveryStore,
    deadLetters,
    subscriptions: config.subscriptions,
    pollMs: config.watcherPollMs,
  })
  const server = createServer({ config, store, deadLetters, deliveryStore })

  await new Promise(resolve => server.listen(config.port, resolve))
  watcher.start()
  // eslint-disable-next-line no-console
  console.log(`wynback-ingest listening on :${config.port} (store=${config.firestoreMode})`)

  const shutdown = () => {
    watcher.stop()
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 5000).unref()
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

if (require.main === module) {
  main().catch(error => {
    // eslint-disable-next-line no-console
    console.error(`wynback-ingest failed to start: ${error && error.message || error}`)
    process.exit(1)
  })
}

module.exports = { main }
