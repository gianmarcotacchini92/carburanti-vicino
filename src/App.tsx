import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ArrowDownUp, ArrowRight, ArrowUpRight, Bell, Calculator, Check, ChevronDown,
  CircleHelp, Clock3, Compass, Database, ExternalLink, Fuel as FuelIcon, Info,
  List, LoaderCircle, LocateFixed, Map as MapIcon, MapPin, Navigation, RefreshCw,
  Search, ShieldCheck, SlidersHorizontal, TriangleAlert, X,
} from 'lucide-react'
import type { LiveStationDetail, Place, SearchArea, ServiceMode, StationResult, StationsResponse, StatusResponse } from '../shared/types'
import { applyLiveDetail } from '../shared/live-details'
import MapView from './MapView'
import MonitorPanel from './MonitorPanel'
import {
  api, appBase, areaQuery, dateFormat, distanceFormat, errorMessage, fetchStations, FUELS, fuelLabel,
  initialSearch, moneyFormat, priceFormat, RADII, refreshIntervalMs, serviceLabel, snapshotLabel, stationKey, unitFor,
} from './lib'
import './App.css'

const initial = initialSearch()

function CalculatorPanel({ station, median, fuel }: {
  station: StationResult | undefined; median: number | null; fuel: SearchArea['fuel']
}) {
  const [quantity, setQuantity] = useState('30')
  const unit = unitFor(fuel)
  const amount = Number(quantity.replace(',', '.'))
  const valid = quantity.trim() !== '' && Number.isFinite(amount) && amount > 0 && amount <= 1000
  const comparison = station && median !== null && valid ? (median - station.price) * amount : null
  return (
    <section className="calculator-card" aria-labelledby="calculator-title">
      <div className="section-icon"><Calculator size={21} /></div>
      <div className="calculator-copy">
        <div className="eyebrow">PRIMA DI RIPARTIRE</div>
        <h2 id="calculator-title">Quanto ti costa il pieno?</h2>
        <p>{station ? <>Da <strong>{station.name}</strong></> : 'Seleziona un distributore per fare due conti.'}</p>
        {fuel === 'metano' && <p className="unit-note">Il metano si vende a kg, non a litri.</p>}
      </div>
      <div className="quantity-field">
        <label htmlFor="quantity">{unit === 'kg' ? 'Quantità in kg' : 'Quantità in litri'}</label>
        <div className={`quantity-input${!valid ? ' invalid' : ''}`}>
          <input id="quantity" inputMode="decimal" type="number" min="0.1" max="1000" step="0.1"
            value={quantity} onChange={(event) => setQuantity(event.target.value)}
            aria-invalid={!valid} aria-describedby={!valid ? 'quantity-error' : undefined} />
          <span>{unit}</span>
        </div>
      </div>
      <div className="calculator-result" aria-live="polite">
        <span>Spesa stimata</span>
        <strong data-testid="estimated-cost">{station && valid ? moneyFormat(station.price * amount) : '—'}</strong>
        {comparison !== null && <small className={comparison > 0 ? 'saving' : ''}>
          {Math.abs(comparison) < 0.005
            ? 'In linea con la mediana di zona'
            : `${moneyFormat(Math.abs(comparison))} ${comparison > 0 ? 'in meno' : 'in più'} della mediana di zona`}
        </small>}
      </div>
      {!valid && <p id="quantity-error" className="calculator-error" role="alert">Inserisci una quantità valida, maggiore di 0 e fino a 1.000 {unit}. Non è stato calcolato alcun importo.</p>}
      <p className="calculator-footnote">Stima sul prezzo comunicato, non un preventivo. La mediana di zona considera i prezzi freschi dei filtri selezionati.</p>
    </section>
  )
}

function StationCard({ station, selected, onSelect }: { station: StationResult; selected: boolean; onSelect: () => void }) {
  return (
    <article className={`station-card${selected ? ' selected' : ''}`} id={`station-${stationKey(station)}`} data-testid="station-card">
      <button className="station-select" aria-pressed={selected} onClick={onSelect}
        aria-label={`Seleziona ${station.name}, ${priceFormat(station.price)} euro al ${station.unit === 'kg' ? 'chilogrammo' : 'litro'}`}>
        <div className="station-topline">
          <span className="brand-mark" aria-hidden="true"><FuelIcon size={20} strokeWidth={1.7} /></span>
          <span className="station-title"><strong>{station.name}</strong><span>{station.brand || 'Distributore indipendente'}</span></span>
          <span className="station-distance"><Navigation size={11} />{distanceFormat(station.distanceKm)}</span>
        </div>
        <span className="station-address">{[station.address, station.town].filter(Boolean).join(', ') || 'Seleziona per consultare indirizzo e dettaglio MIMIT'}</span>
        <span className="station-price-row">
          <span className="service-pill">{station.self ? 'Self service' : 'Servito'}</span>
          <span className="station-price">{priceFormat(station.price)}<small>€/{station.unit}</small></span>
        </span>
        <span className="station-date"><Clock3 size={12} />{station.reportedAtScope === 'station' ? 'Ultima comunicazione impianto' : 'Comunicazione prezzo'} {dateFormat(station.reportedAt, true)} · MIMIT</span>
        {(station.isStale || station.isAnomaly) && <span className="station-badges">
          {station.isStale && <span className="badge badge-stale"><Clock3 size={12} />Dato oltre 7 giorni</span>}
          {station.isAnomaly && <span className="badge badge-anomaly"><TriangleAlert size={12} />Possibile anomalia</span>}
        </span>}
      </button>
      {selected && <div className="station-detail">
        {station.isAnomaly && <p>Prezzo insolitamente basso, possibile errore di comunicazione. Verifica alla pompa.</p>}
        {station.isStale && <p>Questo prezzo non è recente ed è escluso dall’analisi delle anomalie.</p>}
        <a href={`https://www.google.com/maps/dir/?api=1&destination=${station.lat},${station.lon}`}
          target="_blank" rel="noreferrer" className="directions-link"><Navigation size={13} />Indicazioni su Google Maps<ArrowUpRight size={14} /><span className="sr-only"> (si apre in una nuova scheda)</span></a>
        <span className="selected-label"><Check size={12} />Selezionato</span>
      </div>}
    </article>
  )
}

function App() {
  const [area, setArea] = useState<SearchArea>(initial.area)
  const [label, setLabel] = useState(initial.label)
  const [query, setQuery] = useState('')
  const [places, setPlaces] = useState<Place[] | null>(null)
  const [geocoding, setGeocoding] = useState(false)
  const [searchError, setSearchError] = useState('')
  const [locating, setLocating] = useState(false)
  const [status, setStatus] = useState<StatusResponse | null>(null)
  const [statusError, setStatusError] = useState('')
  const [searchResult, setResult] = useState<StationsResponse | null>(null)
  const [detailState, setDetailState] = useState<{
    key: string; detail?: LiveStationDetail; error?: string; loading: boolean
  } | null>(null)
  const [loading, setLoading] = useState(true)
  const [stationError, setStationError] = useState('')
  const [reload, setReload] = useState(0)
  const [selectedKey, setSelectedKey] = useState<string | null>(initial.stationKey)
  const [sort, setSort] = useState<'price' | 'distance'>('price')
  const [mobileView, setMobileView] = useState<'map' | 'list'>('map')
  const [infoOpen, setInfoOpen] = useState(false)
  const statusRef = useRef<StatusResponse | null>(null)
  const stationController = useRef<AbortController | null>(null)
  const searchController = useRef<AbortController | null>(null)
  const locationVersion = useRef(0)
  const latestStationRequest = useRef(0)
  const selectedRef = useRef<string | number | null>(initial.stationKey ?? initial.stationId)
  const forceRefresh = useRef(false)
  const detailStation = searchResult?.stations.find((station) => stationKey(station) === selectedKey)
  const detailId = detailStation?.id
  const detailKey = searchResult?.dataSource === 'live' && detailId !== undefined
    ? `${areaQuery(area)}:${searchResult.updatedAt}:${reload}:${detailId}` : null
  const currentDetail = detailState?.key === detailKey ? detailState : null
  const result = searchResult && currentDetail?.detail
    ? applyLiveDetail(searchResult, currentDetail.detail, area.fuel) : searchResult
  const detailPending = detailKey !== null && (!currentDetail || currentDetail.loading)

  const checkStatus = useCallback(async (signal?: AbortSignal) => {
    try {
      const next = await api<StatusResponse>('/api/status', { signal })
      if (signal?.aborted) return
      statusRef.current = next
      setStatus(next)
      setStatusError('')
    } catch (reason) {
      if (!signal?.aborted) setStatusError(`Stato della fonte non disponibile. ${errorMessage(reason)}`)
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    queueMicrotask(() => {
      if (!controller.signal.aborted) void checkStatus(controller.signal)
    })
    let ticks = 0
    const interval = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return
      ticks++
      if (!statusRef.current?.ready || ticks % 4 === 0) void checkStatus(controller.signal)
    }, 15000)
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        void checkStatus(controller.signal)
        if (Date.now() - latestStationRequest.current >= refreshIntervalMs) setReload((value) => value + 1)
      }
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      controller.abort()
      window.clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [checkStatus])

  useEffect(() => {
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') setReload((value) => value + 1)
    }, refreshIntervalMs)
    return () => window.clearInterval(interval)
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    stationController.current = controller
    queueMicrotask(() => {
      if (controller.signal.aborted) return
      if (!status?.ready) {
        setResult(null)
        setLoading(false)
        return
      }
      setLoading(true)
      setStationError('')
      setResult(null)
      latestStationRequest.current = Date.now()
      const refresh = forceRefresh.current
      forceRefresh.current = false
      void fetchStations(area, controller.signal, refresh)
        .then((data) => {
          if (controller.signal.aborted) return
          setResult(data)
          const next = data.stations.find((station) => typeof selectedRef.current === 'number'
            ? station.id === selectedRef.current : stationKey(station) === selectedRef.current) ?? data.stations[0]
          const nextKey = next ? stationKey(next) : null
          setSelectedKey(nextKey)
          selectedRef.current = nextKey
        })
        .catch((reason: unknown) => {
          if (!controller.signal.aborted) {
            setResult(null)
            setStationError(`Non riusciamo a caricare i distributori. ${errorMessage(reason)}`)
          }
        })
        .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    })
    return () => controller.abort()
  }, [area, status?.ready, reload])

  useEffect(() => {
    if (!detailKey || detailId === undefined) return
    const controller = new AbortController()
    queueMicrotask(() => {
      if (controller.signal.aborted) return
      setDetailState({ key: detailKey, loading: true })
      void api<LiveStationDetail>(`/api/stations/${detailId}?refresh=1`, {
        signal: controller.signal, cache: 'no-store',
      }).then((detail) => {
        if (detail.id !== detailId) throw new Error('Il Ministero ha restituito il dettaglio di un altro impianto.')
        if (!controller.signal.aborted) setDetailState({ key: detailKey, detail, loading: false })
      }).catch((reason: unknown) => {
        if (!controller.signal.aborted) setDetailState({
          key: detailKey, error: `Dettaglio MIMIT non disponibile. ${errorMessage(reason)}`, loading: false,
        })
      })
    })
    return () => controller.abort()
  }, [detailKey, detailId])

  useEffect(() => () => {
    searchController.current?.abort()
    locationVersion.current++
  }, [])

  function changeArea(next: SearchArea, nextLabel = label) {
    locationVersion.current++
    setLocating(false)
    stationController.current?.abort()
    setResult(null)
    setStationError('')
    setLoading(true)
    setSelectedKey(null)
    selectedRef.current = null
    setArea(next)
    setLabel(nextLabel)
    const url = new URL(window.location.href)
    url.search = areaQuery(next)
    window.history.replaceState(null, '', url)
  }

  async function searchAddress(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    searchController.current?.abort()
    locationVersion.current++
    setLocating(false)
    setPlaces(null)
    setSearchError('')
    const trimmed = query.trim()
    if (trimmed.length < 3) {
      setGeocoding(false)
      setSearchError('Scrivi almeno 3 caratteri per cercare un indirizzo o una città.')
      return
    }
    const controller = new AbortController()
    searchController.current = controller
    setGeocoding(true)
    try {
      const response = await api<{ results: Place[] }>(`/api/geocode?q=${encodeURIComponent(trimmed)}`, { signal: controller.signal })
      if (!controller.signal.aborted) setPlaces(response.results)
    } catch (reason) {
      if (!controller.signal.aborted) setSearchError(`Ricerca indirizzo non riuscita. ${errorMessage(reason)}`)
    } finally { if (!controller.signal.aborted) setGeocoding(false) }
  }

  function choosePlace(place: Place) {
    locationVersion.current++
    setLocating(false)
    changeArea({ ...area, lat: place.lat, lon: place.lon }, place.label)
    setQuery(place.label)
    setPlaces(null)
    setSearchError('')
  }

  function useCurrentLocation() {
    searchController.current?.abort()
    setGeocoding(false)
    setPlaces(null)
    setSearchError('')
    if (!navigator.geolocation) {
      setSearchError('La geolocalizzazione non è disponibile in questo browser. Cerca un indirizzo.')
      return
    }
    const version = ++locationVersion.current
    setLocating(true)
    navigator.geolocation.getCurrentPosition(
      (position) => {
        if (version !== locationVersion.current) return
        setLocating(false)
        changeArea({ ...area, lat: position.coords.latitude, lon: position.coords.longitude }, 'La tua posizione')
        setQuery('')
      },
      (reason) => {
        if (version !== locationVersion.current) return
        setLocating(false)
        const messages: Record<number, string> = {
          1: 'Accesso alla posizione negato. Puoi consentirlo nelle impostazioni del browser o cercare un indirizzo.',
          2: 'Posizione non disponibile. Controlla i servizi di localizzazione oppure cerca un indirizzo.',
          3: 'La localizzazione ha impiegato troppo tempo. Riprova oppure cerca un indirizzo.',
        }
        setSearchError(messages[reason.code] ?? 'Non è stato possibile leggere la posizione.')
      },
      { enableHighAccuracy: false, timeout: 15000, maximumAge: 60000 },
    )
  }

  function selectStation(key: string, fromMap = false) {
    const station = result?.stations.find((item) => stationKey(item) === key)
    if (!station) {
      console.warn('Il prezzo selezionato non e piu presente nei risultati correnti.')
      return
    }
    setSelectedKey(key)
    selectedRef.current = key
    const url = new URL(window.location.href)
    url.search = areaQuery(area)
    url.searchParams.set('station', String(station.id))
    url.searchParams.set('stationSelf', station.self ? '1' : '0')
    window.history.replaceState(null, '', url)
    if (fromMap) {
      setMobileView('list')
      window.requestAnimationFrame(() => document.getElementById(`station-${key}`)?.scrollIntoView({ block: 'nearest', behavior: 'instant' }))
    }
  }

  function retry() {
    forceRefresh.current = true
    stationController.current?.abort()
    setResult(null)
    setStationError('')
    setLoading(true)
    void checkStatus()
    setReload((value) => value + 1)
  }

  const stations = [...(result?.stations ?? [])].sort((a, b) =>
    sort === 'price' ? a.price - b.price || a.distanceKm - b.distanceKm : a.distanceKm - b.distanceKm || a.price - b.price)
  const selected = result?.stations.find((station) => stationKey(station) === selectedKey)
  const unit = unitFor(area.fuel)
  const dataWaiting = status !== null && !status.ready
  const initialLoading = status === null && !statusError
  const visibleError = stationError || (!status?.ready ? statusError : '')
  const live = result?.dataSource === 'live' || status?.dataSource === 'live'

  return (
    <>
      <a className="skip-link" href="#main">Vai al contenuto</a>
      <header className="site-header">
        <div className="header-inner">
          <a className="brand" href={appBase} aria-label="Pieno, pagina iniziale"><span className="brand-icon"><FuelIcon size={23} strokeWidth={2.1} /></span>Pieno<span className="brand-period">.</span></a>
          <nav aria-label="Navigazione principale">
            <a href="#esplora" className="nav-link active"><Compass size={16} />Esplora</a>
            <a href="#avvisi" className="nav-link"><Bell size={16} />I tuoi avvisi</a>
          </nav>
          <a href="#informazioni" className="header-source" onClick={() => setInfoOpen(true)}><span className="status-dot" />Dati ufficiali MIMIT<ArrowUpRight size={13} /></a>
        </div>
      </header>

      <main id="main" className="page-shell">
        <section className="intro" aria-labelledby="page-title">
          <div>
            <span className="intro-kicker"><span />MENO RICERCA. PIÙ STRADA.</span>
            <h1 id="page-title">Il pieno giusto,<br className="mobile-break" /> <span>vicino a te.</span></h1>
            <p>Confronta i prezzi dei distributori nella tua zona. E riparti più leggero.</p>
          </div>
          <div className="intro-note"><span className="intro-note-icon"><ShieldCheck size={23} strokeWidth={1.6} /></span><div>Prezzi trasparenti.<br /><strong>Scelte consapevoli.</strong></div></div>
        </section>

        <section className="search-panel" id="esplora" aria-label="Cerca e filtra distributori">
          <div className="search-top">
            <form className="address-form" onSubmit={(event) => void searchAddress(event)} role="search">
              <MapPin size={20} className="search-pin" />
              <label htmlFor="address" className="sr-only">Indirizzo o città</label>
              <input id="address" placeholder="Cerca un indirizzo o una città" value={query} autoComplete="off" maxLength={240}
                onChange={(event) => {
                  searchController.current?.abort()
                  setGeocoding(false)
                  setQuery(event.target.value)
                  setPlaces(null)
                  setSearchError('')
                }} />
              {query && <button type="button" className="clear-search" aria-label="Svuota indirizzo" onClick={() => { setQuery(''); setPlaces(null); searchController.current?.abort(); setGeocoding(false) }}><X size={16} /></button>}
              <button className="button button-primary search-submit" type="submit" disabled={geocoding} aria-label="Cerca">
                {geocoding ? <LoaderCircle className="spin" size={17} /> : <Search size={17} />}<span>Cerca</span>
              </button>
            </form>
            <span className="search-or">oppure</span>
            <button className="button location-button" onClick={useCurrentLocation} disabled={locating}>
              {locating ? <LoaderCircle className="spin" size={17} /> : <LocateFixed size={17} />}<span>{locating ? 'Localizzazione…' : 'Usa la mia posizione'}</span>
            </button>
          </div>
          {places !== null && (
            <div className="search-results" aria-label="Risultati ricerca indirizzo" aria-live="polite">
              <div className="search-results-heading"><span>{places.length ? 'Scegli il punto da cui partire' : 'Nessun indirizzo trovato. Prova con una città, una via o un CAP.'}</span><button className="icon-button" onClick={() => setPlaces(null)} aria-label="Chiudi risultati indirizzo"><X size={16} /></button></div>
              {places.map((place, index) => <button key={`${place.lat}-${place.lon}-${index}`} onClick={() => choosePlace(place)}><MapPin size={17} /><span>{place.label}</span><ArrowRight size={16} /></button>)}
            </div>
          )}
          {searchError && <p className="search-error" role="alert"><TriangleAlert size={16} />{searchError}</p>}
          <div className="filters-row">
            <fieldset className="fuel-filter">
              <legend>Carburante</legend>
              <div className="fuel-options">{FUELS.map((fuel) => (
                <button key={fuel.value} type="button" aria-pressed={area.fuel === fuel.value}
                  className={area.fuel === fuel.value ? 'fuel-chip chosen' : 'fuel-chip'}
                  onClick={() => changeArea({ ...area, fuel: fuel.value })}>
                  {area.fuel === fuel.value && <span className="fuel-choice-dot" />}{fuel.label}
                </button>
              ))}</div>
            </fieldset>
            <div className="filter-separator" />
            <fieldset className="service-filter">
              <legend>Modalità</legend>
              <div className="segmented-control">{(['self', 'servito', 'all'] as ServiceMode[]).map((service) => (
                <button key={service} aria-pressed={area.service === service} className={area.service === service ? 'chosen' : ''}
                  onClick={() => changeArea({ ...area, service })}>{service === 'self' ? 'Self' : service === 'all' ? 'Tutti' : 'Servito'}</button>
              ))}</div>
            </fieldset>
            <div className="radius-filter">
              <label htmlFor="radius">Raggio di ricerca</label>
              <div className="select-wrap"><SlidersHorizontal size={15} /><select id="radius" value={area.radius}
                onChange={(event) => changeArea({ ...area, radius: Number(event.target.value) })}>
                {RADII.map((radius) => <option key={radius} value={radius}>{radius} km</option>)}
              </select><ChevronDown size={14} /></div>
            </div>
          </div>
        </section>

        <div className="results-heading">
          <div className="area-heading"><MapPin size={16} /><h2 title={label}>{label}</h2><span className="area-radius">entro {area.radius} km</span></div>
          <div className="source-update"><span className={`status-dot${!status?.ready ? ' pending' : ''}`} />
            {live ? result?.updatedAt ? `Consultazione MIMIT: ${dateFormat(result.updatedAt, true)}` : 'Ricerca corrente MIMIT'
              : status?.ready ? snapshotLabel(result?.sourceDate ?? status.sourceDate) : dataWaiting ? 'Preparazione dati ufficiali' : 'Connessione alla fonte'}
            <button className="icon-button refresh-button" aria-label="Aggiorna prezzi" title="Aggiorna prezzi" onClick={retry} disabled={loading || initialLoading}><RefreshCw size={14} className={loading ? 'spin' : ''} /></button>
          </div>
          {live && <p className="list-footnote"><Info size={13} /><span>Prezzi dal portale corrente, non dai CSV del giorno precedente. Cache massima 2 minuti; “Aggiorna prezzi” richiede una nuova lettura al MIMIT.</span></p>}
        </div>
        {(status?.warning || result?.warning || (status?.ready && statusError)) && (
          <div className="data-warning" role="status"><Info size={17} /><span>{result?.warning || status?.warning || statusError}</span></div>
        )}

        <div className="stats-strip" aria-label="Riepilogo della ricerca">
          <div><span className="stat-icon"><FuelIcon size={18} /></span><p><strong>{result ? result.total : '—'}</strong><span>distributori trovati</span></p></div>
          <div><span className="stat-icon"><ArrowDownUp size={18} /></span><p><strong>{result?.cheapestPrice != null ? priceFormat(result.cheapestPrice) : '—'}<small> €/{unit}</small></strong><span>prezzo più basso comunicato</span></p></div>
          <div><span className="stat-icon"><Calculator size={18} /></span><p><strong>{result?.medianPrice != null ? priceFormat(result.medianPrice) : '—'}<small> €/{unit}</small></strong><span>mediana dei prezzi freschi</span></p></div>
          <div className="stats-caption"><Info size={15} /><span>{fuelLabel(area.fuel)} · {serviceLabel(area.service)}<br />Distanze in linea d’aria</span></div>
        </div>

        <div className="mobile-view-tabs" role="group" aria-label="Vista risultati">
          <button aria-pressed={mobileView === 'map'} className={mobileView === 'map' ? 'chosen' : ''} onClick={() => setMobileView('map')}><MapIcon size={17} />Mappa</button>
          <button aria-pressed={mobileView === 'list'} className={mobileView === 'list' ? 'chosen' : ''} onClick={() => setMobileView('list')}><List size={17} />Elenco{result ? ` (${result.total})` : ''}</button>
        </div>

        <section className={`explorer-grid mobile-${mobileView}`} aria-label="Distributori e mappa">
          <div className="map-column">
            <MapView area={area} stations={result?.stations ?? []} selectedKey={selectedKey}
              onSelect={(key) => selectStation(key, true)} label={label} visible={mobileView === 'map'} />
            {(visibleError || dataWaiting || loading || initialLoading || result?.total === 0) && (
              <div className="map-state-notice" role={visibleError ? 'alert' : 'status'}>
                {visibleError ? <TriangleAlert size={19} /> : dataWaiting ? <Database size={19} /> : loading || initialLoading ? <LoaderCircle size={19} className="spin" /> : <MapPin size={19} />}
                <div><strong>{visibleError ? 'Prezzi non disponibili' : dataWaiting ? 'Primo download MIMIT' : loading || initialLoading ? 'Cerchiamo i prezzi…' : 'Nessun prezzo per questi filtri'}</strong>
                  <p>{visibleError ? 'Non mostriamo risultati precedenti. Riprova o consulta la vista Elenco.' : dataWaiting ? 'Il server sta preparando i dati ufficiali. La pagina si aggiorna automaticamente.' : loading || initialLoading ? 'Stiamo consultando i dati della zona.' : 'Prova ad ampliare il raggio di ricerca.'}</p>
                  {visibleError && <button className="text-button" onClick={retry}>Riprova</button>}
                </div>
              </div>
            )}
            <div className="map-caption"><Compass size={13} /><span>Il punto verde è il centro della ricerca, non una posizione GPS in tempo reale.</span></div>
          </div>
          <div className="list-column">
            <div className="list-toolbar"><h3>Distributori <span>{result ? result.total : '—'}</span></h3><label className="sort-control"><ArrowDownUp size={13} /><span className="sr-only">Ordina distributori</span><select value={sort} onChange={(event) => setSort(event.target.value as 'price' | 'distance')}><option value="price">Prezzo più basso</option><option value="distance">Più vicini</option></select><ChevronDown size={13} /></label></div>
            <div className="station-list" aria-busy={loading || initialLoading} aria-label="Elenco distributori">
              {(loading || initialLoading) && !visibleError && !dataWaiting ? (
                <div className="loading-state" role="status"><LoaderCircle size={24} className="spin" /><strong>Un attimo, cerchiamo i prezzi.</strong><p>Stiamo consultando i dati ufficiali per questa zona.</p><div className="skeleton-card" /><div className="skeleton-card" /></div>
              ) : visibleError ? (
                <div className="empty-state error-state" role="alert"><span className="empty-icon"><TriangleAlert size={25} /></span><h3>Una sosta imprevista.</h3><p>{visibleError}</p><button className="button button-primary" onClick={retry}><RefreshCw size={15} />Riprova</button></div>
              ) : dataWaiting ? (
                <div className="empty-state" role="status"><span className="empty-icon"><Database size={26} /></span><h3>Prepariamo il primo viaggio.</h3><p>{status.refreshing ? 'Il server sta scaricando i dati ufficiali MIMIT. Il primo caricamento può richiedere qualche minuto.' : 'I dati ufficiali non sono ancora disponibili. Il server riproverà il download.'}</p><span className="waiting-caption"><LoaderCircle size={14} className="spin" />La pagina si aggiorna automaticamente</span><button className="text-button" onClick={retry}>Controlla adesso</button></div>
              ) : result && stations.length === 0 ? (
                <div className="empty-state"><span className="empty-icon"><MapPin size={27} /></span><h3>Qui non abbiamo trovato prezzi.</h3><p>Nessun distributore con un prezzo disponibile per questi filtri. Prova ad ampliare il raggio o cambiare modalità.</p>{area.radius < 30 && <button className="button button-primary" onClick={() => changeArea({ ...area, radius: RADII.find((radius) => radius > area.radius) ?? 30 })}>Amplia il raggio<ArrowRight size={15} /></button>}</div>
              ) : stations.map((station) => <StationCard key={stationKey(station)} station={station} selected={selectedKey === stationKey(station)} onSelect={() => selectStation(stationKey(station))} />)}
            </div>
            <div className="list-footnote"><Info size={13} /><span>I prezzi comunicati possono differire da quelli alla pompa.</span></div>
          </div>
        </section>

        {detailPending && <p className="data-warning" role="status"><LoaderCircle className="spin" size={16} />Controllo il prezzo selezionato nella scheda corrente MIMIT…</p>}
        {currentDetail?.error && <div className="data-warning" role="alert"><TriangleAlert size={16} /><span>{currentDetail.error} I prezzi nell’elenco sono quelli della ricerca precedente, il calcolo è sospeso.</span><button className="text-button" onClick={retry}>Riprova dettaglio</button></div>}
        {currentDetail?.detail && !selected && <p className="data-warning" role="status">Il prezzo selezionato non è più presente nella scheda MIMIT. Seleziona un altro distributore o aggiorna la ricerca.</p>}
        {currentDetail?.detail && selected && <p className="list-footnote">Scheda impianto consultata: {dateFormat(currentDetail.detail.updatedAt, true)}.</p>}
        <CalculatorPanel station={detailPending || currentDetail?.error ? undefined : selected} median={result?.medianPrice ?? null} fuel={area.fuel} />
        <MonitorPanel area={area} label={label} />

        <section className="info-section" id="informazioni">
          <button className="info-toggle" onClick={() => setInfoOpen(!infoOpen)} aria-expanded={infoOpen} aria-controls="info-content">
            <span><CircleHelp size={19} /><strong>Buono a sapersi</strong><span>Dati, anomalie e privacy</span></span><ChevronDown size={18} className={infoOpen ? 'rotate' : ''} />
          </button>
          {infoOpen && <div className="info-content" id="info-content">
            <div><Database size={20} /><h3>Prezzi correnti del portale MIMIT</h3><p>La ricerca consulta il servizio utilizzato dal portale Osservaprezzi, non i CSV che fotografano il giorno precedente. Una cache di massimo 2 minuti limita le richieste; il pulsante “Aggiorna prezzi” la salta. La pagina aggiorna la ricerca ogni minuto quando è visibile.</p><p>La data “Consultazione MIMIT” indica quando abbiamo letto il servizio. “Ultima comunicazione impianto” è la data complessiva restituita dalla ricerca: non certifica la data di ogni carburante. Selezionando un distributore consultiamo la sua scheda con l’indirizzo e la data specifica del prezzo e ricalcoliamo il pieno.</p><p>Se il servizio non risponde, mostriamo l’errore senza ripiegare sui prezzi giornalieri. Il servizio usato dal portale non ha un contratto pubblico di disponibilità per applicazioni esterne e può cambiare. Restano prezzi comunicati dagli esercenti, non rilevati alla pompa: verifica sempre carburante e modalità.</p>{!live && <p>{snapshotLabel(result?.sourceDate ?? status?.sourceDate ?? null)}: risposta giornaliera di una versione precedente del backend.</p>}<div className="source-links"><a href="https://carburanti.mise.gov.it/ospzSearch/" target="_blank" rel="noreferrer">Apri Osservaprezzi MIMIT<ExternalLink size={12} /><span className="sr-only"> (nuova scheda)</span></a><a href="https://www.mimit.gov.it/it/open-data/elenco-dataset/carburanti-prezzi-praticati-e-anagrafica-degli-impianti" target="_blank" rel="noreferrer">Informazioni sui CSV giornalieri<ExternalLink size={12} /><span className="sr-only"> (nuova scheda)</span></a></div></div>
            <div><TriangleAlert size={20} /><h3>Un’anomalia, non una promessa</h3><p>Segnaliamo un prezzo almeno il 25% sotto la mediana di almeno 5 <strong>altri</strong> distributori con lo stesso carburante e la stessa modalità (self o servito), nel raggio scelto. Gli indicatori sulla mappa sono preliminari e usano la data complessiva dell’impianto quando manca quella del singolo prezzo. Prima delle notifiche ricontrolliamo le schede e scartiamo i prezzi più vecchi di 7 giorni; se la verifica fallisce, l’avviso non parte.</p><p>Un prezzo insolito può essere un errore di comunicazione: non è un errore accertato né un risparmio garantito. La mediana di zona nel riepilogo è distinta da quella dei pari usata per l’anomalia.</p></div>
            <div><ShieldCheck size={20} /><h3>La tua zona, non i tuoi spostamenti</h3><p>La posizione viene richiesta solo quando premi il pulsante dedicato. Inviamo le coordinate della ricerca al server e al servizio MIMIT e, se attivi gli avvisi, conserviamo la zona monitorata e l’iscrizione push. Nessun tracciamento della posizione in background.</p><p>Le mappe contattano OpenStreetMap; gli indirizzi cercati vengono inoltrati a Photon. Questi servizi terzi ricevono i dati necessari al servizio. Le credenziali degli avvisi restano in questo browser. Disattivando gli avvisi elimini il monitoraggio dal server.</p></div>
          </div>}
        </section>
      </main>
      <footer className="site-footer">
        <a className="brand footer-brand" href={appBase}><FuelIcon size={20} />Pieno<span>.</span></a>
        <p>La strada è tua. La scelta, anche.</p>
        <div className="footer-attribution">
          <p>Fonte: <a href="https://carburanti.mise.gov.it/ospzSearch/" target="_blank" rel="noreferrer">Ministero delle Imprese e del Made in Italy — Osservaprezzi Carburanti</a>{' · '}Servizio non ufficiale</p>
          <p>Mappe © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a></p>
        </div>
      </footer>
    </>
  )
}

export default App
