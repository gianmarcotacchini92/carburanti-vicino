import { z } from 'zod'

export const areaSchema = z.object({
  lat: z.coerce.number().min(35).max(48),
  lon: z.coerce.number().min(6).max(19),
  radius: z.coerce.number().min(1).max(30),
  fuel: z.enum(['benzina', 'gasolio', 'gpl', 'metano']),
  service: z.enum(['self', 'servito', 'all']),
})

export const monitorSchema = areaSchema.extend({ label: z.string().trim().min(1).max(250) })

export function allowedPushEndpoint(endpoint: string): boolean {
  let url: URL
  try { url = new URL(endpoint) } catch { return false }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || (url.port && url.port !== '443')) return false
  return ['fcm.googleapis.com', 'fcm-x.googleapis.com', 'updates.push.services.mozilla.com', 'push.services.mozilla.com', 'web.push.apple.com']
    .includes(url.hostname) || url.hostname.endsWith('.notify.windows.com') || url.hostname.endsWith('.push.apple.com')
}

const base64Key = (bytes: number) => z.string().regex(/^[A-Za-z0-9_-]+={0,2}$/)
  .refine((key) => Buffer.from(key, 'base64url').length === bytes, 'Chiave push non valida.')

export const subscriptionSchema = z.object({
  endpoint: z.string().max(4096).refine(allowedPushEndpoint, 'Servizio push non supportato. Usa Chrome, Edge, Firefox o Safari.'),
  expirationTime: z.number().nullable().optional(),
  keys: z.object({ p256dh: base64Key(65), auth: base64Key(16) }),
})

export const createSubscriptionSchema = z.object({ subscription: subscriptionSchema, monitor: monitorSchema })

export class HttpError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}
