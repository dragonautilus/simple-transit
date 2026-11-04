// Thin client for https://transport.opendata.ch/docs.html (Swiss network).
// Timetable data: opentransportdata.swiss
// The types below are also the shared data model: other networks (see networks/) convert their
// responses into these shapes so the rest of the app stays network-agnostic.

const BASE = 'https://transport.opendata.ch/v1'

export interface Coordinate {
  type?: string
  x: number | null // latitude
  y: number | null // longitude
}

export interface Location {
  id: string | null
  name: string | null
  score?: number | null
  coordinate?: Coordinate | null
  distance?: number | null
  icon?: string | null
}

export interface Prognosis {
  platform: string | null
  arrival: string | null
  departure: string | null
}

export interface Stop {
  station: Location
  arrival: string | null
  arrivalTimestamp?: number | null
  departure: string | null
  departureTimestamp?: number | null
  delay?: number | null
  platform: string | null
  prognosis?: Prognosis | null
}

export interface Journey {
  name: string
  category: string
  number: string | null
  operator?: string | null
  to: string
  passList: Stop[]
}

export interface Section {
  journey: Journey | null
  walk: { duration: number | null } | null
  departure: Stop
  arrival: Stop
}

export interface Connection {
  from: Stop
  to: Stop
  duration: string
  transfers?: number
  products: string[]
  sections: Section[]
}

export interface StationboardEntry {
  stop: Stop
  name: string
  category: string
  number: string | null
  operator: string | null
  to: string
}

async function get<T>(path: string, params: Record<string, string | number | undefined>): Promise<T> {
  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') qs.append(k, String(v))
  }
  const res = await fetch(`${BASE}${path}?${qs}`)
  if (!res.ok) throw new Error(`transport API ${res.status}`)
  return res.json() as Promise<T>
}

/** Closest stations to a GPS position, nearest first. Addresses and POIs (no id) are dropped. */
export async function nearbyStations(lat: number, lng: number, max = 6): Promise<Location[]> {
  const data = await get<{ stations: Location[] }>('/locations', { x: lat, y: lng, type: 'station' })
  const seen = new Set<string>()
  return data.stations
    .filter((s) => s.id && s.name && !seen.has(s.id) && seen.add(s.id))
    .sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity))
    .slice(0, max)
}

/** Free-text search for stations, addresses and POIs (used by the companion app). */
export async function searchLocations(query: string): Promise<Location[]> {
  const data = await get<{ stations: Location[] }>('/locations', { query, type: 'all' })
  return data.stations.filter((s) => s.name)
}

export async function stationboard(id: string, limit = 10): Promise<StationboardEntry[]> {
  const data = await get<{ stationboard: StationboardEntry[] }>('/stationboard', { id, limit })
  return data.stationboard ?? []
}

export interface ConnectionQuery {
  from: string
  to: string
  date?: string // YYYY-MM-DD
  time?: string // hh:mm
  /** Display name of the destination, for networks that only echo coordinates back. */
  toName?: string
}

export async function connections(q: ConnectionQuery, limit = 4): Promise<Connection[]> {
  const { toName: _toName, ...params } = q
  const data = await get<{ connections: Connection[] }>('/connections', { ...params, limit })
  return data.connections ?? []
}
