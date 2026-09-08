import 'dotenv/config'
import path from 'node:path'
import { z } from 'zod'

const env = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  HOST: z.string().default('127.0.0.1'),
  DATA_DIR: z.string().default('./data'),
  APP_ORIGIN: z.url().optional(),
  VAPID_SUBJECT: z.string().regex(/^(mailto:|https:\/\/)/).default('mailto:operator@example.com'),
  GEOCODER_URL: z.url().default('https://photon.komoot.io/api/'),
  DATA_REFRESH_HOURS: z.coerce.number().min(1).max(24).default(6),
  TRUST_PROXY: z.enum(['0', '1']).default('0'),
}).parse(process.env)

if (env.NODE_ENV === 'production' && (
  !env.APP_ORIGIN?.startsWith('https://') || env.VAPID_SUBJECT === 'mailto:operator@example.com'
)) {
  throw new Error('In produzione configura APP_ORIGIN con HTTPS e VAPID_SUBJECT con un contatto reale.')
}

export const config = {
  ...env,
  dataDir: path.resolve(env.DATA_DIR),
  allowedOrigins: env.APP_ORIGIN
    ? [new URL(env.APP_ORIGIN).origin]
    : [`http://localhost:${env.PORT}`, `http://127.0.0.1:${env.PORT}`, 'http://localhost:5173', 'http://127.0.0.1:5173'],
}
