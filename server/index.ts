import { config } from './config.ts'
import { database } from './storage.ts'
import { createDataService } from './data.ts'
import { createPushService } from './push.ts'
import { createApp } from './app.ts'

const db = database()
const data = createDataService(db)
const push = createPushService(db)
const app = createApp(db, push, data.status)
const server = app.listen(config.PORT, config.HOST, () => {
  console.info(`Pieno API: http://${config.HOST}:${config.PORT}`)
  console.info(`Archivio persistente: ${config.dataDir}`)
})
server.on('error', (error) => { console.error('Avvio server fallito:', error.message); process.exit(1) })

async function tick() {
  db.prepare('DELETE FROM geocode_cache WHERE created_at < ?').run(Date.now() - 7 * 86_400_000)
  await data.refreshIfDue()
  await push.scan()
}
void tick().catch((error: unknown) => console.error('Ciclo iniziale fallito:', error))
const timer = setInterval(() => {
  void tick().catch((error: unknown) => console.error('Monitoraggio periodico fallito:', error))
}, 15 * 60_000)

function shutdown() {
  clearInterval(timer)
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 10_000).unref()
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
