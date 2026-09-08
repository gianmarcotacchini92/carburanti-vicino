import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { config } from './config.ts'
import { fetchBytes } from './http.ts'
import { HttpError } from './validation.ts'
import type { Place } from '../shared/types.ts'

const photonSchema = z.object({
  features: z.array(z.object({
    geometry: z.object({ coordinates: z.tuple([z.number(), z.number()]) }),
    properties: z.object({
      name: z.string().optional(), street: z.string().optional(), housenumber: z.string().optional(),
      city: z.string().optional(), district: z.string().optional(), state: z.string().optional(),
      postcode: z.string().optional(), countrycode: z.string().optional(),
    }),
  })),
})

export function createGeocoder(db: DatabaseSync) {
  let queue: Promise<unknown> = Promise.resolve()
  let pending = 0
  let lastStarted = 0

  return async function geocode(query: string): Promise<Place[]> {
    const key = query.toLocaleLowerCase('it-IT').trim()
    const cached = db.prepare('SELECT response FROM geocode_cache WHERE query = ? AND created_at > ?')
      .get(key, Date.now() - 7 * 86_400_000)
    if (cached) return z.array(z.object({ lat: z.number(), lon: z.number(), label: z.string() })).parse(JSON.parse(String(cached.response)))
    if (pending >= 10) throw new HttpError(429, 'Troppe ricerche di indirizzi. Riprova tra qualche secondo.')
    pending++
    const run = queue.then(async () => {
      const delay = Math.max(0, 1100 - (Date.now() - lastStarted))
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay))
      lastStarted = Date.now()
      const url = new URL(config.GEOCODER_URL)
      url.search = new URLSearchParams({ q: query, limit: '6', bbox: '6.0,35.0,19.0,48.0' }).toString()
      let json: unknown
      try {
        const bytes = await fetchBytes(url, 1_000_000, 10_000)
        json = JSON.parse(new TextDecoder().decode(bytes))
      } catch (error) {
        console.error('Geocodifica non disponibile:', error instanceof Error ? error.message : 'errore remoto')
        throw new HttpError(502, 'Il servizio di ricerca indirizzi non risponde. Riprova o usa la posizione GPS.')
      }
      const parsed = photonSchema.safeParse(json)
      if (!parsed.success) throw new HttpError(502, 'Il servizio di ricerca indirizzi ha restituito dati non validi.')
      const places = parsed.data.features
        .filter((feature) => feature.properties.countrycode?.toUpperCase() === 'IT')
        .map(({ properties: p, geometry }) => ({
          lat: geometry.coordinates[1], lon: geometry.coordinates[0],
          label: [...new Set([p.name, [p.street, p.housenumber].filter(Boolean).join(' '), p.postcode, p.city || p.district, p.state].filter(Boolean))].join(', '),
        }))
        .filter((place) => place.lat >= 35 && place.lat <= 48 && place.lon >= 6 && place.lon <= 19 && place.label)
      db.prepare('INSERT INTO geocode_cache(query,response,created_at) VALUES(?,?,?) ON CONFLICT(query) DO UPDATE SET response=excluded.response, created_at=excluded.created_at')
        .run(key, JSON.stringify(places), Date.now())
      db.prepare('DELETE FROM geocode_cache WHERE created_at < ?').run(Date.now() - 7 * 86_400_000)
      return places
    })
    // Settle the queue without hiding the error returned to this request.
    queue = run.then(() => undefined, () => undefined)
    try { return await run } finally { pending-- }
  }
}
