export type Fuel = 'benzina' | 'gasolio' | 'gpl' | 'metano'
export type ServiceMode = 'self' | 'servito' | 'all'

export interface SearchArea {
  lat: number
  lon: number
  radius: number
  fuel: Fuel
  service: ServiceMode
}

export interface Monitor extends SearchArea {
  label: string
}

export interface Place {
  lat: number
  lon: number
  label: string
}

export interface StationResult {
  id: number
  name: string
  brand: string
  address: string
  town: string
  province: string
  lat: number
  lon: number
  distanceKm: number
  price: number
  self: boolean
  unit: 'L' | 'kg'
  reportedAt: string
  isStale: boolean
  isAnomaly: boolean
  discountPercent: number
  peerMedian: number | null
}

export interface StationsResponse {
  stations: StationResult[]
  total: number
  medianPrice: number | null
  cheapestPrice: number | null
  updatedAt: string | null
  sourceDate: string | null
  warning: string | null
  analysis: {
    minimumPeers: number
    thresholdPercent: number
    freshnessDays: number
  }
}

export interface StatusResponse {
  ready: boolean
  refreshing: boolean
  lastRefreshAt: string | null
  sourceDate: string | null
  stationCount: number
  priceCount: number
  warning: string | null
  catalogVersion?: string
}

export interface PushCredentials {
  id: string
  token: string
}

export interface CatalogStation {
  id: number
  name: string
  brand: string
  address: string
  town: string
  province: string
  lat: number
  lon: number
  prices: {
    fuel: Fuel
    self: boolean
    price: number
    reportedAt: string
  }[]
}

export interface CatalogSnapshot extends StatusResponse {
  catalogVersion: string
  cells: string[]
}

export interface CloudMonitor {
  id: string
  subscription: string
  monitor: string
  sent: string
}
