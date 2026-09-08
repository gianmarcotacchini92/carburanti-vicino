export async function fetchBytes(url: string | URL, maxBytes: number, timeout: number): Promise<Uint8Array> {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'Pieno/1.0 (fuel-price-map)', Accept: '*/*' },
    signal: AbortSignal.timeout(timeout),
  })
  if (!response.ok) throw new Error(`Servizio remoto non disponibile (HTTP ${response.status}).`)
  if (!response.body) throw new Error('Il servizio remoto ha restituito una risposta vuota.')
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body.cancel()
    throw new Error('La risposta remota supera il limite consentito.')
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel()
        throw new Error('La risposta remota supera il limite consentito.')
      }
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  return Buffer.concat(chunks, total)
}
