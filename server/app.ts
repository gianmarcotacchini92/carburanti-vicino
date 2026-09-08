import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import express from 'express'
import type { ErrorRequestHandler } from 'express'
import helmet from 'helmet'
import { rateLimit } from 'express-rate-limit'
import { z } from 'zod'
import { config } from './config.ts'
import { createGeocoder } from './geocoder.ts'
import { searchStations } from './storage.ts'
import { areaSchema, HttpError } from './validation.ts'
import type { createPushService } from './push.ts'
import type { StatusResponse } from '../shared/types.ts'

export function createApp(
  db: DatabaseSync,
  push: ReturnType<typeof createPushService>,
  status: () => StatusResponse,
) {
  const app = express()
  const geocode = createGeocoder(db)
  app.disable('x-powered-by')
  if (config.TRUST_PROXY === '1') app.set('trust proxy', 1)
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        'img-src': ["'self'", 'data:', 'blob:', 'https://*.tile.openstreetmap.org', 'https://tile.openstreetmap.org'],
        'connect-src': ["'self'"],
        'style-src': ["'self'", "'unsafe-inline'"],
        'worker-src': ["'self'"],
        'upgrade-insecure-requests': config.NODE_ENV === 'production' ? [] : null,
      },
    },
    crossOriginEmbedderPolicy: false,
    strictTransportSecurity: config.NODE_ENV === 'production' ? undefined : false,
  }))
  app.use('/api', rateLimit({
    windowMs: 60_000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false,
    message: { error: 'Troppe richieste. Riprova tra un minuto.' },
  }))
  app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next() })
  app.use('/api', (req, _res, next) => {
    if (['POST', 'PUT', 'DELETE'].includes(req.method) && !config.allowedOrigins.includes(req.get('origin') ?? '')) {
      next(new HttpError(403, 'Origine della richiesta non consentita. Controlla APP_ORIGIN.'))
      return
    }
    next()
  })
  app.use(express.json({ limit: '16kb' }))
  app.get('/api/status', (_req, res) => res.json(status()))
  app.get('/api/stations', (req, res) => {
    const area = areaSchema.parse(req.query)
    if (!status().ready) throw new HttpError(503, 'Sto caricando i dati ufficiali MIMIT. Attendi il completamento del primo download.')
    res.json(searchStations(db, area))
  })
  app.get('/api/geocode', rateLimit({
    windowMs: 60_000, limit: 15, standardHeaders: 'draft-8', legacyHeaders: false,
    message: { error: 'Troppe ricerche di indirizzi. Riprova tra un minuto.' },
  }), async (req, res) => {
    const query = z.string().trim().min(3).max(200).parse(req.query.q)
    res.json({ results: await geocode(query) })
  })
  app.get('/api/push/public-key', (_req, res) => res.json({ publicKey: push.publicKey }))
  app.post('/api/push/subscriptions', rateLimit({
    windowMs: 60_000, limit: 5, standardHeaders: 'draft-8', legacyHeaders: false,
    message: { error: 'Troppe attivazioni. Riprova tra un minuto.' },
  }), (req, res) => {
    res.status(201).json(push.add(req.body))
    void push.scan().catch((error: unknown) => console.error('Errore nel monitoraggio push:', error))
  })
  app.get('/api/push/subscriptions/:id', (req, res) => res.json(push.get(req.params.id, req.get('authorization'))))
  app.put('/api/push/subscriptions/:id', (req, res) => {
    push.update(req.params.id, req.get('authorization'), req.body)
    res.json(push.get(req.params.id, req.get('authorization')))
    void push.scan().catch((error: unknown) => console.error('Errore nel monitoraggio push:', error))
  })
  app.delete('/api/push/subscriptions/:id', (req, res) => {
    push.remove(req.params.id, req.get('authorization'))
    res.status(204).end()
  })
  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Risorsa non trovata.')))
  const dist = fileURLToPath(new URL('../dist/', import.meta.url))
  if (existsSync(path.join(dist, 'index.html'))) {
    app.use(express.static(dist, {
      setHeaders: (res, filename) => {
        if (filename.endsWith('sw.js')) res.setHeader('Cache-Control', 'no-cache')
      },
    }))
    app.get('/{*path}', (_req, res) => res.sendFile(path.join(dist, 'index.html')))
  } else {
    app.get('/', (_req, res) => res.status(503).type('text').send('Frontend non compilato: in sviluppo apri http://localhost:5173 oppure esegui npm run build.'))
  }
  const errors: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    if (error instanceof HttpError) { res.status(error.status).json({ error: error.message }); return }
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'Parametri non validi.', details: error.issues.map((issue) => issue.message) })
      return
    }
    if (error instanceof SyntaxError && 'status' in error && error.status === 400) {
      res.status(400).json({ error: 'JSON non valido.' })
      return
    }
    if (error instanceof Error && 'status' in error && error.status === 413) {
      res.status(413).json({ error: 'Richiesta troppo grande.' })
      return
    }
    console.error('Errore API:', error instanceof Error ? error.message : 'errore sconosciuto')
    res.status(500).json({ error: 'Errore del server. Riprova tra poco.' })
  }
  app.use(errors)
  return app
}
