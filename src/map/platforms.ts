// Which platform each departure on the board leaves from, so the map can mark the platforms in
// use with the same label as the board rows ("Zürich, Löwenplatz": A for one side of the street,
// B for the other).
//
// Transitous departures carry their platform position already. transport.opendata.ch has one
// point per stop only, so for Swiss stops the platform of each line and destination is looked up
// once in Transitous (which carries the same Swiss timetable) and cached. Requests are kept few on
// purpose: this is a nicety, and a rate-limited Transitous must not take the board down with it.
// Any failure pauses the lookups and the map falls back to one marker per stop.

import type { Location, StationboardEntry } from '../api'
import { getJson } from '../http'
import { TRANSITOUS_BASE, type TStopTime } from '../networks/transitous'
import type { MapPoint } from './board-map'

export interface Platform extends MapPoint {
  label: string
}

export interface PlatformInfo {
  /** Platforms the shown departures leave from, labelled. */
  markers: Platform[]
  /** Label per shown departure. */
  labelOf: Map<StationboardEntry, string>
}

/** Where a departure leaves from. */
export interface Position extends MapPoint {
  track?: string | null
}

/** Points closer than this (m) are one platform (the same platform from two feeds, …). The map
 *  pushes markers of close platforms apart, so both sides of a narrow street stay readable. */
const MERGE_M = 10
/** More platforms than this in use: a station; its platform numbers say more than markers. */
const MAX_PLATFORMS = 4
/** A Transitous stop further than this (m) from a Swiss stop of the same name is another stop. */
const SAME_STOP_M = 150
/** Lines and destinations per platform hardly change during a day. */
const TABLE_TTL_MS = 60 * 60_000
/** After a failed request (offline, rate limit) no lookups for this long. */
const PAUSE_MS = 10 * 60_000

const R = 6_371_000
function distM(a: MapPoint, b: MapPoint): number {
  const k = Math.cos((a.lat * Math.PI) / 180)
  return Math.hypot((((b.lng - a.lng) * Math.PI) / 180) * R * k, (((b.lat - a.lat) * Math.PI) / 180) * R)
}

/** "Zürich, Löwenplatz" and "Zürich,Löwenplatz" are the same name. */
const norm = (s: string) => s.toLowerCase().replace(/[\s,.]+/g, ' ').trim()

// ---------- Labels ----------

/**
 * Groups the departures by platform. Null when markers add nothing: all from one platform, or so
 * many platforms that it is a station.
 */
export function assignPlatforms(departures: StationboardEntry[], whereOf: (e: StationboardEntry) => Position | null): PlatformInfo | null {
  const groups: { at: Position; tracks: string[]; entries: StationboardEntry[] }[] = []
  for (const e of departures) {
    const at = whereOf(e)
    if (!at) continue
    let g = groups.find((x) => distM(x.at, at) < MERGE_M)
    if (!g) groups.push((g = { at, tracks: [], entries: [] }))
    g.entries.push(e)
    if (at.track) g.tracks.push(at.track)
  }
  if (groups.length < 2 || groups.length > MAX_PLATFORMS) return null
  // Platform names when every platform has its own short one ("17", "18"), else A, B, … west to east
  const track = (g: (typeof groups)[number]) => (g.tracks.length && g.tracks.every((t) => t === g.tracks[0]) ? g.tracks[0] : null)
  const tracks = groups.map(track)
  const named = tracks.every((t) => t && t.length <= 3) && new Set(tracks).size === tracks.length
  if (!named) groups.sort((a, b) => a.at.lng - b.at.lng || b.at.lat - a.at.lat)
  const labelOf = new Map<StationboardEntry, string>()
  const markers = groups.map((g, i) => {
    const label = named ? track(g)! : String.fromCharCode(65 + i)
    for (const e of g.entries) labelOf.set(e, label)
    return { lat: g.at.lat, lng: g.at.lng, label }
  })
  return { markers, labelOf }
}

/** Transitous departures: the stop of each departure is its platform. */
export function transitousPosition(e: StationboardEntry): Position | null {
  const c = e.stop.station.coordinate
  return c?.x != null && c.y != null ? { lat: c.x, lng: c.y, track: e.stop.platform } : null
}

// ---------- Swiss stops via Transitous ----------

/** Platform per line + destination, from a sample of Transitous departures at the stop. */
export type PlatformTable = Map<string, Position>

const lineKey = (number: string | null | undefined, dest: string) => `${norm(number ?? '')}|${norm(dest)}`

export function platformTable(stopTimes: TStopTime[]): PlatformTable {
  const table: PlatformTable = new Map()
  for (const s of stopTimes) {
    const dest = s.headsign || s.tripTo?.name
    if (!dest || !s.place) continue
    const key = lineKey(s.routeShortName ?? s.displayName, dest)
    if (!table.has(key)) table.set(key, { lat: s.place.lat, lng: s.place.lon, track: s.place.track ?? null })
  }
  return table
}

export function swissPosition(table: PlatformTable, e: StationboardEntry): Position | null {
  return table.get(lineKey(e.number, e.to)) ?? null
}

interface MapStop {
  name: string
  stopId: string
  lat: number
  lon: number
}

/** Transitous stop id for each Swiss stop, matched by name and position. */
export function matchStops(stations: Location[], stops: MapStop[]): Map<string, string | null> {
  const ids = new Map<string, string | null>()
  for (const s of stations) {
    const c = s.coordinate
    if (!s.id) continue
    const here = c?.x != null && c.y != null ? { lat: c.x, lng: c.y } : null
    const name = norm(s.name ?? '')
    const m = here && stops.find((t) => norm(t.name) === name && distM(here, { lat: t.lat, lng: t.lon }) <= SAME_STOP_M)
    ids.set(s.id, m ? m.stopId : null)
  }
  return ids
}

let pausedUntil = 0
const transitousIds = new Map<string, string | null>()
const tables = new Map<string, { at: number; table: PlatformTable }>()
const pending = new Map<string, Promise<PlatformTable | null>>()

/** Cached table for a stop, without any request. */
export function cachedTable(stationId: string, now: number): PlatformTable | null {
  const t = tables.get(stationId)
  return t && now - t.at < TABLE_TTL_MS ? t.table : null
}

/**
 * Table for a Swiss stop: at most one request for the ids of all nearby stops, and one per stop
 * and hour. Null when Transitous doesn't know the stop or can't be reached.
 */
export function loadSwissTable(station: Location, nearby: Location[], now: number): Promise<PlatformTable | null> {
  const id = station.id
  if (!id) return Promise.resolve(null)
  const cached = cachedTable(id, now)
  if (cached) return Promise.resolve(cached)
  if (now < pausedUntil) return Promise.resolve(null)
  let p = pending.get(id)
  if (!p) {
    p = (async () => {
      try {
        if (!transitousIds.has(id)) await resolveIds(nearby.some((s) => s.id === id) ? nearby : [station])
        const tid = transitousIds.get(id)
        if (!tid) return null
        const data = await getJson<{ stopTimes: TStopTime[] }>(TRANSITOUS_BASE, '/api/v6/stoptimes', { stopId: tid, n: 24 })
        const table = platformTable(data.stopTimes ?? [])
        tables.set(id, { at: now, table })
        return table
      } catch {
        pausedUntil = now + PAUSE_MS
        return null
      } finally {
        pending.delete(id)
      }
    })()
    pending.set(id, p)
  }
  return p
}

async function resolveIds(stations: Location[]) {
  const pts = stations.map((s) => s.coordinate).filter((c) => c?.x != null && c.y != null) as { x: number; y: number }[]
  if (pts.length === 0) return
  const pad = 0.0015 // ~150 m
  const lats = pts.map((p) => p.x)
  const lngs = pts.map((p) => p.y)
  const padLng = pad / Math.cos((lats[0] * Math.PI) / 180)
  const stops = await getJson<MapStop[]>(TRANSITOUS_BASE, '/api/v6/map/stops', {
    min: `${Math.min(...lats) - pad},${Math.min(...lngs) - padLng}`,
    max: `${Math.max(...lats) + pad},${Math.max(...lngs) + padLng}`,
    grouped: true,
  })
  for (const [k, v] of matchStops(stations, stops)) transitousIds.set(k, v)
}
