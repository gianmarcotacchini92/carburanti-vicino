const appRoot = new URL(self.registration.scope)
const appPath = appRoot.pathname

function safeAppUrl(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return appPath
  try {
    const url = new URL(value, self.location.origin)
    return url.origin === self.location.origin && url.pathname.startsWith(appPath)
      ? `${url.pathname}${url.search}${url.hash}` : appPath
  } catch {
    return appPath
  }
}

self.addEventListener('push', (event) => {
  if (!event.data) {
    console.warn('Pieno: ricevuta una notifica push senza dati.')
    return
  }
  let payload
  try { payload = event.data.json() } catch {
    console.warn('Pieno: payload push JSON non valido.')
    return
  }
  if (!payload || typeof payload.title !== 'string' || typeof payload.body !== 'string') {
    console.warn('Pieno: titolo o testo mancanti nel payload push.')
    return
  }
  event.waitUntil(self.registration.showNotification(payload.title, {
    body: payload.body,
    tag: typeof payload.tag === 'string' ? payload.tag : 'pieno-prezzi',
    icon: new URL('icon-192.png', appRoot).href,
    badge: new URL('icon.svg', appRoot).href,
    data: { url: safeAppUrl(payload.url) },
  }))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const path = safeAppUrl(event.notification.data?.url)
  const destination = new URL(path, self.location.origin).href
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    const existing = windows.find((client) => {
      const url = new URL(client.url)
      return url.origin === self.location.origin && url.pathname.startsWith(appPath)
    })
    if (existing) {
      await existing.navigate(destination)
      await existing.focus()
    } else {
      await self.clients.openWindow(destination)
    }
  })())
})
