import { useCallback, useEffect, useState } from 'react'
import { Bell, BellOff, Check, ChevronRight, LoaderCircle, MapPin, RefreshCw, ShieldCheck, X } from 'lucide-react'
import type { Monitor, PushCredentials, SearchArea } from '../shared/types'
import { api, ApiError, appBase, areaQuery, cloudCatalog, errorMessage, fuelLabel, serviceLabel } from './lib'

const STORAGE_KEY = appBase === '/' ? 'pieno.push.v1' : `pieno.push.v1:${appBase}`
const supportsPush = () => window.isSecureContext && 'serviceWorker' in navigator
  && 'PushManager' in window && 'Notification' in window

function decodeKey(key: string) {
  const padded = `${key}${'='.repeat((4 - key.length % 4) % 4)}`.replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(padded)
  return Uint8Array.from(raw, (character) => character.charCodeAt(0))
}

function readCredentials(): PushCredentials | null {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null')
    if (saved && typeof saved === 'object' && 'id' in saved && 'token' in saved
      && typeof saved.id === 'string' && typeof saved.token === 'string') return { id: saved.id, token: saved.token }
  } catch { /* Storage can be unavailable in private browsing. */ }
  return null
}

function removeCredentials() {
  try { localStorage.removeItem(STORAGE_KEY) } catch { /* The server record is already gone. */ }
}

export default function MonitorPanel({ area, label }: { area: SearchArea; label: string }) {
  const [credentials, setCredentials] = useState<PushCredentials | null>(readCredentials)
  const [monitor, setMonitor] = useState<Monitor | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [expanded, setExpanded] = useState(false)
  const [cleanupNeeded, setCleanupNeeded] = useState(false)
  const [permission, setPermission] = useState<NotificationPermission | null>(
    () => 'Notification' in window ? Notification.permission : null,
  )
  const supported = supportsPush()
  const isiOS = /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  const standalone = window.matchMedia('(display-mode: standalone)').matches
  const currentMonitor = { ...area, label }
  const changed = monitor !== null && areaQuery(monitor) !== areaQuery(area)

  const restore = useCallback(async (saved: PushCredentials, signal?: AbortSignal) => {
    setBusy(true)
    setError('')
    try {
      const result = await api<{ monitor: Monitor }>(`/api/push/subscriptions/${encodeURIComponent(saved.id)}`, {
        headers: { Authorization: `Bearer ${saved.token}` }, signal,
      })
      if (!signal?.aborted) setMonitor(result.monitor)
    } catch (reason) {
      if (signal?.aborted) return
      if (reason instanceof ApiError && (reason.status === 404 || reason.status === 401)) {
        removeCredentials()
        setCredentials(null)
        setMonitor(null)
        setNotice('Il monitoraggio salvato è scaduto o non è più disponibile. Puoi riattivarlo.')
      } else {
        setError(`Non è stato possibile verificare gli avvisi salvati. ${errorMessage(reason)}`)
      }
    } finally {
      if (!signal?.aborted) setBusy(false)
    }
  }, [])

  useEffect(() => {
    const saved = readCredentials()
    const controller = new AbortController()
    queueMicrotask(() => {
      if (saved && !controller.signal.aborted) void restore(saved, controller.signal)
    })
    return () => controller.abort()
  }, [restore])

  async function enable() {
    if (!supported || busy) return
    setBusy(true)
    setError('')
    setNotice('')
    let subscription: PushSubscription | null = null
    let newlyCreated = false
    let serverSaved = false
    try {
      const granted = await Notification.requestPermission()
      setPermission(granted)
      if (granted !== 'granted') {
        throw new Error(granted === 'denied'
          ? 'Notifiche bloccate. Consenti le notifiche nelle impostazioni del browser e riprova.'
          : 'Permesso non concesso. Nessun avviso è stato attivato.')
      }
      const { publicKey } = await api<{ publicKey: string }>('/api/push/public-key')
      if (!publicKey) throw new Error('Il server non ha configurato il servizio di notifiche.')
      await navigator.serviceWorker.register(`${appBase}sw.js`, { scope: appBase })
      const ready = await navigator.serviceWorker.ready
      subscription = await ready.pushManager.getSubscription()
      if (!subscription) {
        subscription = await ready.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: decodeKey(publicKey),
        })
        newlyCreated = true
      }
      const saved = await api<PushCredentials>('/api/push/subscriptions', {
        method: 'POST', body: JSON.stringify({ subscription: subscription.toJSON(), monitor: currentMonitor }),
      })
      serverSaved = true
      setCredentials(saved)
      setMonitor(currentMonitor)
      setCleanupNeeded(false)
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(saved))
        setNotice('Avvisi attivati per questa zona. Nessun tracciamento in background.')
      } catch {
        setError('Avvisi attivi, ma il browser non permette di salvare le credenziali. Disattivali prima di chiudere questa pagina per poterli gestire.')
      }
    } catch (reason) {
      let cleanupError = false
      const conflict = reason instanceof ApiError && reason.status === 409
      if (subscription && !serverSaved && (newlyCreated || conflict)) {
        try { await cleanupBrowser() } catch { cleanupError = true; setCleanupNeeded(true) }
      }
      setError(conflict
        ? cleanupError
          ? 'Esiste una vecchia iscrizione senza credenziali. Rimuovi prima l’iscrizione dal browser, poi riattiva gli avvisi.'
          : 'La vecchia iscrizione non era più gestibile ed è stata rimossa dal browser. Premi di nuovo “Attiva avvisi” per crearne una nuova.'
        : `${errorMessage(reason)}${cleanupError ? ' Non è stato possibile annullare l’iscrizione del browser: usa “Rimuovi iscrizione browser”.' : ''}`)
    } finally { setBusy(false) }
  }

  async function update() {
    if (!credentials || busy) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await api(`/api/push/subscriptions/${encodeURIComponent(credentials.id)}`, {
        method: 'PUT', headers: { Authorization: `Bearer ${credentials.token}` },
        body: JSON.stringify({ monitor: currentMonitor }),
      })
      setMonitor(currentMonitor)
      setNotice('Zona monitorata aggiornata con la ricerca corrente.')
    } catch (reason) { setError(`Zona monitorata non modificata. ${errorMessage(reason)}`) }
    finally { setBusy(false) }
  }

  async function cleanupBrowser() {
    if (!('serviceWorker' in navigator)) return
    const registration = await navigator.serviceWorker.getRegistration()
    const subscription = await registration?.pushManager.getSubscription()
    if (subscription) {
      const removed = await subscription.unsubscribe()
      if (!removed && await registration?.pushManager.getSubscription()) {
        throw new Error('Il browser non ha rimosso la propria iscrizione.')
      }
    }
    setCleanupNeeded(false)
  }

  async function disable() {
    if (!credentials || busy) return
    setBusy(true)
    setError('')
    setNotice('')
    let serverDeleted = false
    try {
      await api(`/api/push/subscriptions/${encodeURIComponent(credentials.id)}`, {
        method: 'DELETE', headers: { Authorization: `Bearer ${credentials.token}` },
      })
      serverDeleted = true
      removeCredentials()
      setCredentials(null)
      setMonitor(null)
      await cleanupBrowser()
      setNotice('Avvisi disattivati. La zona è stata eliminata dal server.')
    } catch (reason) {
      if (serverDeleted) setCleanupNeeded(true)
      setError(serverDeleted
        ? `Monitoraggio eliminato dal server, ma iscrizione browser non rimossa. ${errorMessage(reason)}`
        : `Avvisi non disattivati: il monitoraggio è ancora sul server. ${errorMessage(reason)}`)
    } finally { setBusy(false) }
  }

  async function retryCleanup() {
    setBusy(true)
    setError('')
    try {
      await cleanupBrowser()
      setNotice('Iscrizione browser rimossa. Puoi riattivare gli avvisi.')
    } catch (reason) { setError(errorMessage(reason)) }
    finally { setBusy(false) }
  }

  return (
    <section className={`monitor-panel${monitor ? ' monitor-active' : ''}`} id="avvisi" aria-labelledby="monitor-title">
      <div className="monitor-icon"><Bell size={23} strokeWidth={1.7} /></div>
      <div className="monitor-content">
        <div className="eyebrow">{monitor ? 'IL TUO MONITORAGGIO' : 'UN OCCHIO AI PREZZI, ANCHE DOPO'}</div>
        <h2 id="monitor-title">{monitor ? 'Avvisi attivi per la zona salvata' : 'Un prezzo insolito? Ti avvisiamo.'}</h2>
        <p>Ricevi un avviso quando rileviamo un prezzo insolitamente basso. Potrebbe essere un errore: verifica sempre alla pompa.</p>
        {monitor && (
          <div className="saved-monitor" data-testid="saved-monitor">
            <span><MapPin size={14} /><strong>{monitor.label}</strong></span>
            <span>{fuelLabel(monitor.fuel)} · {serviceLabel(monitor.service)} · {monitor.radius} km</span>
            <span className="coordinates">{monitor.lat.toFixed(4)}, {monitor.lon.toFixed(4)} · zona salvata, distinta dalla ricerca</span>
          </div>
        )}
        {!monitor && <p className="monitor-current">Zona da monitorare: <strong>{label}</strong> · {fuelLabel(area.fuel)} · {serviceLabel(area.service)} · {area.radius} km</p>}
        {changed && <p className="monitor-change">Stai esplorando un’altra zona o altri filtri. Gli avvisi non sono cambiati.</p>}
        <p className="monitor-conditions">{cloudCatalog
          ? 'Avvisi anche a pagina chiusa: controlli programmati ogni 30 minuti tramite GitHub Actions, con possibili ritardi. Browser e sistema operativo devono consentire le notifiche. Una zona per browser.'
          : 'Funzionano anche a pagina chiusa solo se il server rimane attivo e il browser e il sistema operativo lo consentono. Una zona per browser.'}</p>
        {(!supported || (isiOS && !standalone)) && (
          <p className="inline-warning">
            {isiOS && !standalone
              ? 'Su iPhone e iPad, aggiungi Pieno alla schermata Home da Safari e aprilo da lì per abilitare gli avvisi (iOS 16.4 o successivo).'
              : !window.isSecureContext
                ? 'Gli avvisi richiedono una connessione HTTPS (oppure localhost in sviluppo).'
                : 'Questo browser non supporta le notifiche push. Puoi continuare a cercare i prezzi.'}
          </p>
        )}
        {permission === 'denied' && <p className="inline-warning">Le notifiche sono bloccate nelle impostazioni del browser. Il permesso va riabilitato manualmente.</p>}
        <div className="monitor-actions">
          {credentials ? (
            <>
              {monitor && <button className="button button-teal" disabled={busy || !changed} onClick={() => void update()}>
                {busy ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}Aggiorna zona monitorata
              </button>}
              {!monitor && <button className="button button-teal" disabled={busy} onClick={() => void restore(credentials)}>
                <RefreshCw size={15} />Verifica avvisi salvati
              </button>}
              <button className="button button-ghost" disabled={busy} onClick={() => void disable()}><BellOff size={15} />Disattiva avvisi</button>
            </>
          ) : (
            <button className="button button-teal" disabled={!supported || busy || cleanupNeeded || (isiOS && !standalone)} onClick={() => void enable()}>
              {busy ? <LoaderCircle className="spin" size={16} /> : <Bell size={16} />}Attiva avvisi<ChevronRight size={16} />
            </button>
          )}
          <button className="text-button light-text" onClick={() => setExpanded(!expanded)} aria-expanded={expanded} aria-controls="monitor-help">
            Come funziona?
          </button>
          {cleanupNeeded && <button className="button button-ghost" disabled={busy} onClick={() => void retryCleanup()}><X size={15} />Rimuovi iscrizione browser</button>}
        </div>
        {expanded && (
          <div className="monitor-help" id="monitor-help">
            <ShieldCheck size={18} />
            <p>La soglia è almeno il 25% sotto la mediana di almeno 5 <strong>altri</strong> distributori con lo stesso carburante e la stessa modalità di servizio, entro il raggio scelto. Sono esclusi i prezzi più vecchi di 7 giorni. È un segnale di possibile anomalia, non la garanzia di un affare. Inviamo al server le coordinate della zona salvata e l’iscrizione push, non seguiamo i tuoi spostamenti.</p>
          </div>
        )}
        {notice && <p className="monitor-notice" role="status"><Check size={16} />{notice}</p>}
        {error && <p className="monitor-error" role="alert">{error}</p>}
      </div>
      <span className="monitor-decoration" aria-hidden="true"><Bell size={116} strokeWidth={0.8} /></span>
    </section>
  )
}
