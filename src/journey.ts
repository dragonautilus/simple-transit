// Journey model built from a transport API connection, plus progress estimation
// (by timetable incl. delays, refined by GPS when the fix is close to the route).

import type { Connection, Section, Stop } from './api'

export interface LatLng {
  lat: number
  lng: number
}

export interface Point {
  name: string
  coord: LatLng | null
  /** Effective time (prognosis or scheduled + delay), epoch ms. */
  time: number
  /** Scheduled time, epoch ms. */
  scheduled: number
  delayMin: number
  platform: string | null
  platformChanged: boolean
}

export interface Leg {
  kind: 'ride' | 'walk'
  from: Point
  to: Point
  /** e.g. "IC 1", "T 4" (rides only) */
  line: string
  direction: string
  /** All stops of a ride including both ends, used for GPS projection. */
  stops: Point[]
}

export interface Trip {
  /** Stable id of the chosen connection, used to find it again after a refresh. */
  signature: string
  legs: Leg[]
  start: number
  end: number
}

const parseTime = (iso: string | null | undefined): number | null => {
  if (!iso) return null
  // API format: 2026-11-03T13:32:00+0100 (offset without colon)
  const t = Date.parse(iso.replace(/([+-]\d\d)(\d\d)$/, '$1:$2'))
  return Number.isNaN(t) ? null : t
}

function toPoint(stop: Stop, which: 'arrival' | 'departure', fallback?: number): Point {
  const scheduledRaw = parseTime(stop[which])
  const scheduled = scheduledRaw ?? fallback ?? 0
  const delayMin = stop.delay ?? 0
  const prog = parseTime(stop.prognosis?.[which])
  const time = prog ?? (scheduledRaw !== null ? scheduled + delayMin * 60_000 : scheduled)
  const progPlatform = stop.prognosis?.platform ?? null
  const c = stop.station?.coordinate
  return {
    name: stop.station?.name ?? '?',
    coord: c && c.x != null && c.y != null ? { lat: c.x, lng: c.y } : null,
    time,
    scheduled,
    delayMin: Math.max(0, Math.round((time - scheduled) / 60_000)),
    platform: progPlatform ?? stop.platform ?? null,
    platformChanged: !!progPlatform && !!stop.platform && progPlatform !== stop.platform,
  }
}

const CATEGORY_NAMES: Record<string, string> = {
  T: 'Tram',
  NFT: 'Tram',
  TRAM: 'Tram',
  B: 'Bus',
  NFB: 'Bus',
  BUS: 'Bus',
  BAT: 'Boat',
  BAV: 'Boat',
  FUN: 'Funi',
  PB: 'Cable',
}

export function lineName(category: string, number: string | null): string {
  const cat = CATEGORY_NAMES[category.toUpperCase()] ?? category
  const n = (number ?? '').trim()
  // Long-distance trains report the train number (e.g. "EC" + "000193"); hide those
  if (!n || n.length > 4 || n.startsWith('0')) return cat
  return `${cat} ${n}`
}

function sectionToLeg(s: Section, prevEnd: number | null): Leg {
  if (s.journey) {
    const from = toPoint(s.departure, 'departure')
    const to = toPoint(s.arrival, 'arrival')
    const stops = s.journey.passList.map((p, i, all) =>
      toPoint(p, i === all.length - 1 ? 'arrival' : p.departure ? 'departure' : 'arrival'),
    )
    return {
      kind: 'ride',
      from,
      to,
      line: lineName(s.journey.category, s.journey.number),
      direction: s.journey.to,
      stops: stops.length >= 2 ? stops : [from, to],
    }
  }
  const walkMs = (s.walk?.duration ?? 0) * 1000
  const from = toPoint(s.departure, 'departure', prevEnd ?? undefined)
  const to = toPoint(s.arrival, 'arrival', from.time + walkMs)
  if (to.time < from.time + walkMs) to.time = from.time + walkMs
  return { kind: 'walk', from, to, line: 'Walk', direction: to.name, stops: [from, to] }
}

export function connectionSignature(c: Connection): string {
  return c.sections
    .filter((s) => s.journey)
    .map((s) => `${s.journey!.category}${s.journey!.number}@${s.departure.departure}`)
    .join('|')
}

export function buildTrip(c: Connection): Trip {
  const legs: Leg[] = []
  let prevEnd: number | null = null
  for (const s of c.sections) {
    const leg = sectionToLeg(s, prevEnd)
    // Skip zero-length walks the API sometimes emits between platforms
    if (leg.kind === 'walk' && leg.to.time - leg.from.time <= 0 && leg.from.name === leg.to.name) continue
    legs.push(leg)
    prevEnd = leg.to.time
  }
  return {
    signature: connectionSignature(c),
    legs,
    start: legs[0]?.from.time ?? 0,
    end: legs[legs.length - 1]?.to.time ?? 0,
  }
}

// ---------- Geometry ----------

const R = 6_371_000

/** Equirectangular projection around a reference latitude; good enough at city/route scale. */
function toXY(p: LatLng, refLat: number): [number, number] {
  const k = Math.cos((refLat * Math.PI) / 180)
  return [((p.lng * Math.PI) / 180) * R * k, ((p.lat * Math.PI) / 180) * R]
}

export function distanceM(a: LatLng, b: LatLng): number {
  const [ax, ay] = toXY(a, a.lat)
  const [bx, by] = toXY(b, a.lat)
  return Math.hypot(ax - bx, ay - by)
}

interface Projection {
  distance: number
  time: number
}

/** Project a position onto the stop polyline of a leg and interpolate the time at that spot. */
function projectOnLeg(leg: Leg, pos: LatLng): Projection | null {
  const pts = leg.stops.filter((s) => s.coord)
  if (pts.length < 2) return null
  const [px, py] = toXY(pos, pos.lat)
  let best: Projection | null = null
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]
    const b = pts[i + 1]
    const [ax, ay] = toXY(a.coord!, pos.lat)
    const [bx, by] = toXY(b.coord!, pos.lat)
    const dx = bx - ax
    const dy = by - ay
    const len2 = dx * dx + dy * dy
    const u = len2 === 0 ? 0 : Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / len2))
    const d = Math.hypot(px - (ax + u * dx), py - (ay + u * dy))
    const time = a.time + u * (b.time - a.time)
    if (!best || d < best.distance) best = { distance: d, time }
  }
  return best
}

export interface Fix extends LatLng {
  accuracy?: number
  timestamp?: number
}

export interface Progress {
  /** Estimated "journey clock" time, epoch ms. */
  time: number
  /** 0..1 along the whole trip, by effective time. */
  fraction: number
  /** Index of the leg the traveller is in (or waiting for). */
  legIndex: number
  /** True while waiting between legs (e.g. on the platform at a change). */
  waiting: boolean
  source: 'gps' | 'time'
  arrived: boolean
}

/** Max distance from the route (plus fix accuracy) for GPS to override the timetable. */
const GPS_ROUTE_TOLERANCE_M = 250
const GPS_MAX_AGE_MS = 120_000
/** GPS may move the dot at most this far from the timetable estimate. Prevents snapping onto
 *  the wrong part of a route that passes the same place twice. */
const GPS_MAX_SHIFT_MS = 30 * 60_000
/** GPS differences smaller than this keep the timetable position. */
const GPS_MIN_SHIFT_MS = 90_000
/** Fixes less accurate than this (m) are ignored. */
const GPS_MAX_ACCURACY_M = 150

export function estimateProgress(trip: Trip, now: number, fix?: Fix | null): Progress {
  let time = now
  let source: Progress['source'] = 'time'

  // Time first; GPS only corrects it, and only with a fresh, reasonably accurate fix
  const fresh = fix && (fix.timestamp === undefined || now - fix.timestamp < GPS_MAX_AGE_MS)
  const accurate = fix && (fix.accuracy ?? 0) <= GPS_MAX_ACCURACY_M
  if (fix && fresh && accurate && now >= trip.start - 5 * 60_000) {
    const tolerance = GPS_ROUTE_TOLERANCE_M + Math.min(fix.accuracy ?? 0, 500)
    let best: Projection | null = null
    for (const leg of trip.legs) {
      const p = projectOnLeg(leg, fix)
      if (!p || p.distance > tolerance || Math.abs(p.time - now) > GPS_MAX_SHIFT_MS) continue
      if (!best || Math.abs(p.time - now) < Math.abs(best.time - now)) best = p
    }
    if (best) {
      // Small differences are GPS noise or stop-to-stop interpolation, not a real delay: keep the
      // steady clock. GPS only moves the dot when it clearly disagrees (train late or early).
      if (Math.abs(best.time - now) >= GPS_MIN_SHIFT_MS) time = best.time
      source = 'gps'
    }
    // Standing at a change point: both adjacent legs project onto the same spot, so the clock
    // is the better estimate of where in the transfer gap we are.
    for (let i = 0; i < trip.legs.length - 1; i++) {
      const arrive = trip.legs[i].to
      const depart = trip.legs[i + 1].from
      const at = arrive.coord ?? depart.coord
      if (at && now >= arrive.time && now <= depart.time && distanceM(fix, at) <= tolerance) {
        time = now
        source = 'gps'
      }
    }
  }

  const raw = time
  time = Math.min(Math.max(time, trip.start), trip.end)
  const span = Math.max(1, trip.end - trip.start)
  const fraction = (time - trip.start) / span

  let legIndex = trip.legs.length - 1
  let waiting = false
  for (let i = 0; i < trip.legs.length; i++) {
    const leg = trip.legs[i]
    if (raw < leg.from.time) {
      legIndex = i
      waiting = true
      break
    }
    if (raw <= leg.to.time) {
      legIndex = i
      break
    }
  }

  const nearDest =
    source === 'gps' && fix && trip.legs.length > 0 && trip.legs[trip.legs.length - 1].to.coord
      ? distanceM(fix, trip.legs[trip.legs.length - 1].to.coord!) < 80
      : false
  const arrived = now > trip.end + 60_000 || nearDest

  return { time, fraction, legIndex, waiting, source, arrived }
}

/** Fraction (0..1) of a point in time along the trip. */
export function fractionAt(trip: Trip, t: number): number {
  return Math.min(1, Math.max(0, (t - trip.start) / Math.max(1, trip.end - trip.start)))
}
