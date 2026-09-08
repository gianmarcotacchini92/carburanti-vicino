import { useEffect, useMemo, useState } from 'react'
import { Circle, CircleMarker, MapContainer, Marker, TileLayer, Tooltip, ZoomControl, useMap, useMapEvents } from 'react-leaflet'
import { divIcon, latLng } from 'leaflet'
import { Maximize2 } from 'lucide-react'
import type { SearchArea, StationResult } from '../shared/types'
import { priceFormat, stationKey, unitFor } from './lib'
import 'leaflet/dist/leaflet.css'

interface Props {
  area: SearchArea
  stations: StationResult[]
  selectedKey: string | null
  onSelect: (key: string) => void
  label: string
  visible: boolean
}

function StationMarkers({ stations, selectedKey, onSelect }: Pick<Props, 'stations' | 'selectedKey' | 'onSelect'>) {
  const map = useMap()
  const [viewport, setViewport] = useState(() => ({ bounds: map.getBounds(), zoom: map.getZoom() }))
  const syncViewport = () => setViewport({ bounds: map.getBounds(), zoom: map.getZoom() })
  useMapEvents({
    zoomend: syncViewport,
    moveend: syncViewport,
    resize: syncViewport,
  })
  const priceLabels = useMemo(() => {
    // Keep all stations on the map, but avoid overlapping price labels in dense cities.
    const uniqueLocations = new Set(stations.map((station) => `${station.lat},${station.lon}`))
    if (stations.length <= 12 && uniqueLocations.size === stations.length) return new Set(stations.map(stationKey))
    const ordered = [...stations].sort((a, b) =>
      Number(stationKey(b) === selectedKey) - Number(stationKey(a) === selectedKey)
      || Number(b.isAnomaly) - Number(a.isAnomaly)
      || a.price - b.price)
    const occupied: { x: number; y: number }[] = []
    const labels = new Set<string>()
    for (const station of ordered) {
      if (!viewport.bounds.contains([station.lat, station.lon]) && stationKey(station) !== selectedKey) continue
      const point = map.project([station.lat, station.lon], viewport.zoom)
      if (!occupied.some((other) => Math.abs(other.x - point.x) < 87 && Math.abs(other.y - point.y) < 48)) {
        labels.add(stationKey(station))
        occupied.push(point)
      }
    }
    return labels
  }, [map, stations, selectedKey, viewport])

  return (
    <>
      {stations.filter((station) => Number.isFinite(station.price)).map((station) => priceLabels.has(stationKey(station)) ? (
        <Marker key={stationKey(station)} position={[station.lat, station.lon]}
          title={`${station.name}: ${priceFormat(station.price)} €/${station.unit}`}
          alt={`Seleziona ${station.name}`}
          zIndexOffset={stationKey(station) === selectedKey ? 1000 : station.isAnomaly ? 100 : 0}
          icon={divIcon({
            className: `price-marker${stationKey(station) === selectedKey ? ' is-selected' : ''}${station.isAnomaly ? ' is-anomaly' : ''}`,
            html: `<span>${priceFormat(station.price)}</span>`,
            iconSize: [67, 33], iconAnchor: [33, 39],
          })}
          eventHandlers={{ click: () => onSelect(stationKey(station)) }}>
          <Tooltip direction="top" offset={[0, -36]}>{station.name} · {station.self ? 'Self' : 'Servito'}</Tooltip>
        </Marker>
      ) : (
        <CircleMarker key={stationKey(station)} center={[station.lat, station.lon]} radius={4}
          pathOptions={{ color: '#fff', weight: 1.5, fillColor: station.isAnomaly ? '#b48d3f' : '#27896e', fillOpacity: 0.9 }}
          eventHandlers={{ click: () => onSelect(stationKey(station)) }}>
          <Tooltip>{station.name} · {priceFormat(station.price)} €/{station.unit} · {station.self ? 'Self' : 'Servito'}</Tooltip>
        </CircleMarker>
      ))}
      {stations.length > 12 && <div className="map-density-note">Ingrandisci per vedere altri prezzi</div>}
    </>
  )
}

function MapControl({ area, selected, visible }: {
  area: SearchArea; selected: StationResult | undefined; visible: boolean
}) {
  const map = useMap()
  const centerMap = () => {
    map.fitBounds(latLng(area.lat, area.lon).toBounds(area.radius * 2400), {
      padding: [22, 22], animate: false, maxZoom: 15,
    })
  }
  useEffect(() => {
    map.invalidateSize()
    map.fitBounds(latLng(area.lat, area.lon).toBounds(area.radius * 2400), {
      padding: [22, 22], animate: false, maxZoom: 15,
    })
  }, [map, area.lat, area.lon, area.radius, visible])
  useEffect(() => {
    if (selected && !map.getBounds().contains([selected.lat, selected.lon])) {
      map.panTo([selected.lat, selected.lon], { animate: false })
    }
  }, [map, selected])
  return (
    <div className="map-reset leaflet-top leaflet-right">
      <button className="icon-button" onClick={centerMap} aria-label="Inquadra tutta la zona di ricerca" title="Inquadra la zona">
        <Maximize2 size={18} />
      </button>
    </div>
  )
}

export default function MapView({ area, stations, selectedKey, onSelect, label, visible }: Props) {
  return (
    <div className="map-frame" role="region" aria-label="Mappa dei distributori">
      <MapContainer center={[area.lat, area.lon]} zoom={13} scrollWheelZoom={false} zoomControl={false} preferCanvas className="station-map">
        <ZoomControl position="topleft" zoomInTitle="Ingrandisci la mappa" zoomOutTitle="Riduci la mappa" />
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a>'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <Circle center={[area.lat, area.lon]} radius={area.radius * 1000}
          pathOptions={{ color: '#159c84', weight: 1.5, fillColor: '#22b494', fillOpacity: 0.045, dashArray: '5 7' }} />
        <CircleMarker center={[area.lat, area.lon]} radius={7}
          pathOptions={{ color: '#ffffff', fillColor: '#087f70', fillOpacity: 1, weight: 3 }}>
          <Tooltip>{label} · centro della ricerca</Tooltip>
        </CircleMarker>
        <StationMarkers stations={stations} selectedKey={selectedKey} onSelect={onSelect} />
        <MapControl area={area} selected={stations.find((station) => stationKey(station) === selectedKey)} visible={visible} />
      </MapContainer>
      <div className="map-key" aria-hidden="true">
        <span><i className="legend-dot" />Prezzi in €/{unitFor(area.fuel)}</span>
        <span><i className="legend-dot anomaly-dot" />Possibile anomalia</span>
      </div>
    </div>
  )
}
