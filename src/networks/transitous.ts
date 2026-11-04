// Germany (and most of Europe) via Transitous, a community-run MOTIS instance:
// https://transitous.org/api/  Data sources: https://transitous.org/sources/
// Responses are converted into the transport.opendata.ch shapes from api.ts.
//
// Usage policy (summary): non-commercial, open-source clients only, light use; clients identify
// themselves (User-Agent or, in a browser, the Referer) and link https://transitous.org/sources/.

import type { Connection, ConnectionQuery, Location, Section, StationboardEntry, Stop } from '../api'
import type { Network } from './types'

export const TRANSITOUS_BASE = 'https://api.transitous.org'

// ---------- Response types (only the fields we use) ----------

export interface TPlace {
  name: string
  stopId?: string
  parentId?: string
  lat: number
  lon: number
  arrival?: string
  departure?: string
  scheduledArrival?: string
  scheduledDeparture?: string
  track?: string
  scheduledTrack?: string
  cancelled?: boolean
}

export interface TStopTime {
  place: TPlace
  mode: string
  realTime: boolean
  headsign?: string
  tripTo?: TPlace
  agencyName?: string
  routeShortName?: string
  displayName?: string
  cancelled?: boolean
  tripCancelled?: boolean
}

export interface TLeg {
  mode: string
  duration: number
  startTime: string
  endTime: string
  scheduledStartTime: string
  scheduledEndTime: string
  realTime: boolean
  from: TPlace
  to: TPlace
  headsign?: string
  tripTo?: TPlace
  agencyName?: string
  routeShortName?: string
  displayName?: string
  tripShortName?: string
  intermediateStops?: TPlace[]
}

export interface TItinerary {
  duration: number
  startTime: string
  endTime: string
  transfers: number
  legs: TLeg[]
}

export interface TMapStop {
  name: string
  stopId: string
  lat: number
  lon: number
  importance?: number
}

export interface TMatch {
  type: 'STOP' | 'ADDRESS' | 'PLACE'
  name: string
  id: string
  lat: number
  lon: number
  houseNumber?: string
  street?: string
  areas?: { name: string; default?: boolean }[]
}

// ---------- Conversion ----------

const WALK_MODES = new Set(['WALK', 'BIKE', 'CAR', 'RENTAL', 'CAR_PARKING', 'FLEX', 'ODM'])

/** "1 (U5)" → "1", "Pos. 13" → "13". Keeps platform cells short on the glasses. */
export function cleanTrack(t: string | undefined | null): string | null {
  if (!t) return null
  const s = t.replace(/\s*\(.*\)\s*$/, '').replace(/^(Pos\.|Gleis|Steig|Bstg\.?)\s*/i, '').trim()
  return s || null
}

/** Category/number pair that lineName() in journey.ts turns into "Bus 100", "Tram M10", "U5", "ICE". */
export function lineParts(mode: string, displayName?: string, routeShortName?: string): { category: string; number: string | null } {
  const label = (displayName || routeShortName || '').trim()
  const prefixed = (cat: string, word: RegExp) => {
    const n = label.replace(word, '').trim()
    return { category: cat, number: n || null }
  }
  switch (mode) {
    case 'BUS':
    case 'COACH':
      return prefixed('B', /^bus\s*/i)
    case 'TRAM':
      return prefixed('T', /^(tram|str)\s*/i)
    case 'FERRY':
      return prefixed('BAT', /^(ferry|fähre|f)\s+/i)
    case 'FUNICULAR':
      return { category: 'FUN', number: null }
    case 'AERIAL_LIFT':
    case 'CABLE_CAR':
      return { category: 'PB', number: null }
    default:
      return { category: label || mode.charAt(0) + mode.slice(1).toLowerCase(), number: null }
  }
}

const loc = (p: TPlace, name = p.name): Location => ({
  id: p.stopId ?? null,
  name,
  coordinate: { x: p.lat, y: p.lon },
})

function toStop(p: TPlace, name: string, fallback?: { dep?: [string, string]; arr?: [string, string] }): Stop {
  const sDep = p.scheduledDeparture ?? fallback?.dep?.[0] ?? null
  const sArr = p.scheduledArrival ?? fallback?.arr?.[0] ?? null
  const dep = p.departure ?? fallback?.dep?.[1] ?? null
  const arr = p.arrival ?? fallback?.arr?.[1] ?? null
  const platform = cleanTrack(p.scheduledTrack ?? p.track)
  const actual = cleanTrack(p.track)
  return {
    station: loc(p, name),
    departure: sDep,
    arrival: sArr,
    platform,
    delay: null,
    prognosis: { departure: dep, arrival: arr, platform: actual && actual !== platform ? actual : null },
  }
}

export function stationboardFromStopTimes(data: { stopTimes: TStopTime[] }): StationboardEntry[] {
  return (data.stopTimes ?? [])
    .filter((s) => s.place?.scheduledDeparture && !s.cancelled && !s.tripCancelled)
    .map((s) => {
      const { category, number } = lineParts(s.mode, s.displayName, s.routeShortName)
      return {
        stop: toStop(s.place, s.place.name),
        name: s.displayName ?? s.routeShortName ?? s.mode,
        category,
        number,
        operator: s.agencyName ?? null,
        to: s.headsign || s.tripTo?.name || '?',
      }
    })
}

/** Names MOTIS uses for the free coordinates of a query. */
const placeName = (p: TPlace, start: string, end: string) => (p.name === 'START' ? start : p.name === 'END' ? end : p.name)

export function connectionsFromPlan(data: { itineraries: TItinerary[] }, toName = 'Destination', fromName = 'Start'): Connection[] {
  return (data.itineraries ?? []).map((it) => {
    const sections: Section[] = it.legs.map((leg) => {
      const name = (p: TPlace) => placeName(p, fromName, toName)
      const times = { dep: [leg.scheduledStartTime, leg.startTime] as [string, string], arr: [leg.scheduledEndTime, leg.endTime] as [string, string] }
      const departure = toStop(leg.from, name(leg.from), { dep: times.dep })
      const arrival = toStop(leg.to, name(leg.to), { arr: times.arr })
      if (WALK_MODES.has(leg.mode)) {
        return { journey: null, walk: { duration: leg.duration }, departure, arrival }
      }
      const { category, number } = lineParts(leg.mode, leg.displayName, leg.routeShortName)
      const passList = [departure, ...(leg.intermediateStops ?? []).map((p) => toStop(p, p.name)), arrival]
      return {
        journey: {
          name: leg.displayName ?? leg.routeShortName ?? leg.mode,
          category,
          // Train number makes the refresh signature unique; lineName() hides it (> 4 chars or absent)
          number: number ?? (leg.tripShortName ? `0${leg.tripShortName}` : null),
          operator: leg.agencyName ?? null,
          to: leg.headsign || leg.tripTo?.name || name(leg.to),
          passList,
        },
        walk: null,
        departure,
        arrival,
      }
    })
    return {
      from: sections[0]?.departure,
      to: sections[sections.length - 1]?.arrival,
      duration: String(it.duration),
      transfers: it.transfers,
      products: sections.filter((s) => s.journey).map((s) => s.journey!.name),
      sections,
    }
  })
}

const R = 6_371_000
const dist = (aLat: number, aLng: number, bLat: number, bLng: number) => {
  const k = Math.cos((aLat * Math.PI) / 180)
  const dx = ((bLng - aLng) * Math.PI) / 180 * R * k
  const dy = ((bLat - aLat) * Math.PI) / 180 * R
  return Math.hypot(dx, dy)
}

export function nearbyFromMapStops(stops: TMapStop[], lat: number, lng: number, max: number): Location[] {
  const byName = new Map<string, Location>()
  for (const s of stops) {
    const l: Location = { id: s.stopId, name: s.name, coordinate: { x: s.lat, y: s.lon }, distance: dist(lat, lng, s.lat, s.lon) }
    const prev = byName.get(s.name)
    // Both sides of a street often come as separate stops with the same name: keep the closest
    if (!prev || (l.distance ?? 0) < (prev.distance ?? 0)) byName.set(s.name, l)
  }
  return [...byName.values()].sort((a, b) => (a.distance ?? 0) - (b.distance ?? 0)).slice(0, max)
}

export function locationsFromGeocode(matches: TMatch[]): Location[] {
  return matches.map((m) => {
    const town = m.areas?.find((a) => a.default)?.name
    const base = m.type === 'ADDRESS' && m.street ? `${m.street}${m.houseNumber ? ` ${m.houseNumber}` : ''}` : m.name
    const name = town && !base.includes(town) ? `${base}, ${town}` : base
    return {
      id: m.type === 'STOP' ? m.id : null,
      name,
      coordinate: { x: m.lat, y: m.lon },
      icon: m.type === 'PLACE' ? 'poi' : m.type === 'ADDRESS' ? 'address' : 'train',
    }
  })
}

// ---------- HTTP ----------

async function get<T>(path: string, params: Record<string, string | number | boolean | undefined>): Promise<T> {
  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') qs.append(k, String(v))
  const res = await fetch(`${TRANSITOUS_BASE}${path}?${qs}`)
  if (!res.ok) throw new Error(`Transitous ${res.status}`)
  return res.json() as Promise<T>
}

/** Local "YYYY-MM-DD" + "hh:mm" → ISO instant. */
function isoTime(q: ConnectionQuery): string | undefined {
  if (!q.date || !q.time) return undefined
  const t = new Date(`${q.date}T${q.time}:00`)
  return Number.isNaN(t.getTime()) ? undefined : t.toISOString()
}

export const transitous: Network = {
  id: 'eu',
  name: 'Germany & Europe',
  source: 'Transitous',
  attribution: 'Transitous (transitous.org/sources), © OpenStreetMap contributors',
  // Everything outside Switzerland; used as the fallback network
  covers: () => true,

  async nearbyStations(lat, lng, max = 6) {
    for (const r of [0.006, 0.02]) {
      const dLng = r / Math.cos((lat * Math.PI) / 180)
      const stops = await get<TMapStop[]>('/api/v6/map/stops', {
        min: `${lat - r},${lng - dLng}`,
        max: `${lat + r},${lng + dLng}`,
        grouped: true,
      })
      const found = nearbyFromMapStops(stops, lat, lng, max)
      if (found.length >= 2 || r === 0.02) return found
    }
    return []
  },

  async searchLocations(query) {
    return locationsFromGeocode(await get<TMatch[]>('/api/v1/geocode', { text: query }))
  },

  async stationboard(id, limit = 10) {
    return stationboardFromStopTimes(await get<{ stopTimes: TStopTime[] }>('/api/v6/stoptimes', { stopId: id, n: limit }))
  },

  async connections(q, limit = 4) {
    const data = await get<{ itineraries: TItinerary[] }>('/api/v6/plan', {
      fromPlace: q.from,
      toPlace: q.to,
      time: isoTime(q),
      numItineraries: limit,
      detailedTransfers: false,
    })
    return connectionsFromPlan(data, q.toName)
  },
}
