import 'dotenv/config'
import { randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import webpush from 'web-push'
import { z } from 'zod'
import { database, getMetadata, setMetadata } from '../server/storage.ts'

const repo = 'gianmarcotacchini92/carburanti-vicino'
const appUrl = 'https://gianmarcotacchini92.github.io/carburanti-vicino/'
const apiUrl = z.url().parse(process.env.API_URL)
if (new URL(apiUrl).protocol !== 'https:') throw new Error('API_URL deve essere HTTPS.')

function command(executable: string, args: string[], input?: string): string {
  const result = spawnSync(executable, args, { input, encoding: 'utf8', windowsHide: true })
  if (result.error || result.status !== 0) {
    throw new Error(`Configurazione interrotta: ${path.basename(executable)} ${args.slice(0, 3).join(' ')} (codice ${result.status}). Nessuna credenziale viene stampata.`)
  }
  return result.stdout.trim()
}

const login = command('gh', ['api', 'user', '--jq', '.login'])
if (login !== 'gianmarcotacchini92') throw new Error('Account GitHub errato: interrompo senza trasferire segreti.')
const db = database()
const stored = getMetadata(db, 'vapidKeys')
const keys = stored
  ? z.object({ publicKey: z.string(), privateKey: z.string() }).parse(JSON.parse(stored))
  : webpush.generateVAPIDKeys()
if (!stored) setMetadata(db, 'vapidKeys', JSON.stringify(keys))
const token = getMetadata(db, 'cloudJobToken') ?? randomBytes(32).toString('hex')
setMetadata(db, 'cloudJobToken', token)

for (const [name, value] of Object.entries({
  JOB_TOKEN: token, VAPID_PUBLIC_KEY: keys.publicKey, VAPID_PRIVATE_KEY: keys.privateKey,
})) {
  command('gh', ['secret', 'set', name, '--repo', repo], value)
  console.info(`Segreto GitHub configurato: ${name}`)
}
const wrangler = path.resolve('node_modules', 'wrangler', 'bin', 'wrangler.js')
for (const [name, value] of Object.entries({ JOB_TOKEN: token, VAPID_PUBLIC_KEY: keys.publicKey })) {
  command(process.execPath, [wrangler, 'secret', 'put', name], `${value}\n`)
  console.info(`Segreto Worker configurato: ${name}`)
}
command('gh', ['variable', 'set', 'API_URL', '--repo', repo, '--body', apiUrl])
for (let attempt = 0; ; attempt++) {
  const response = await fetch(new URL('/internal/snapshot', apiUrl), {
    headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000),
  })
  if (response.status === 200 || response.status === 404) break
  if (![401, 502, 503, 504].includes(response.status) || attempt >= 14) {
    throw new Error(`Il Worker non ha confermato la propagazione dei segreti (HTTP ${response.status}).`)
  }
  await new Promise((resolve) => setTimeout(resolve, 2000))
}
console.info('Configurazione privata completata. Avvio della prima importazione cloud.')
const job = spawnSync(process.execPath, ['--import', 'tsx', 'jobs/run.ts'], {
  stdio: 'inherit',
  env: {
    ...process.env, API_URL: apiUrl, APP_URL: appUrl, JOB_TOKEN: token,
    VAPID_PUBLIC_KEY: keys.publicKey, VAPID_PRIVATE_KEY: keys.privateKey,
  },
})
if (job.error || job.status !== 0) throw new Error('Primo aggiornamento non riuscito. Il bootstrap puo essere rieseguito senza cambiare le chiavi.')
