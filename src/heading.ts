// Which way you face, for the map that turns with you. The SDK gives apps no compass of the
// glasses (their IMU reports raw x/y/z only), so this uses the phone:
//
// - phone in your hand: the direction its top (held flat) or its back (held upright) points;
// - phone in a pocket: while you walk, the GPS course tells which axis of the phone points the
//   way you go. That axis then follows your body when you stop and turn around (the idea of
//   "body tracking" in github.com/r-tkbyc/even-simple-compass, calibrated automatically here);
// - no compass at all (blocked, or the WebView gets no sensor events): the GPS course itself.
//
// Orientation math follows the W3C DeviceOrientation spec: alpha (z), beta (x), gamma (y),
// device frame x right, y towards the top, z out of the screen; earth frame x east, y north, z up.

import { mockHeading } from './dev'
import type { Fix } from './journey'

export interface Heading {
  /** Degrees clockwise from north. */
  deg: number
  source: 'compass' | 'body' | 'gps'
}

type Vec = [number, number, number]
/** Rows of the device → earth rotation. */
export type Matrix = [Vec, Vec, Vec]

/** Compass readings older than this no longer count (phone locked, WebView paused). */
const COMPASS_STALE_MS = 3000
/** Low-pass factor per compass event (events arrive up to 60 times a second). */
const SMOOTH = 0.15
/** Slower than this (m/s) the GPS course is noise. */
const MIN_SPEED = 1
const GPS_STALE_MS = 20_000
/** A pocket calibration is trusted this long after you last walked. */
const BODY_MAX_AGE_MS = 15 * 60_000
/** A new course this far off the learnt axis: the phone moved in the pocket, start over. */
const BODY_RESET_DEG = 60
const BODY_BLEND = 0.3
/** Screen within this angle of horizontal: the phone is held in your hand. */
const FLAT_DEG = 45
/** Without a fresh reading the last direction is kept this long, so the map doesn't flip to
 *  north-up whenever you stop at a crossing. */
const HOLD_MS = 60_000
/** Listeners hear about compass changes at most this often. */
const NOTIFY_MS = 500

const RAD = Math.PI / 180
const norm360 = (d: number) => ((d % 360) + 360) % 360

/** Smallest angle between two directions, 0..180. */
export function angleDiff(a: number, b: number): number {
  const d = norm360(a - b)
  return d > 180 ? 360 - d : d
}

/** Averages directions as unit vectors, so 350° and 10° give 0°, not 180°. */
export function smoothVector(prev: { x: number; y: number } | null, deg: number, k: number): { x: number; y: number } {
  const x = Math.sin(deg * RAD)
  const y = Math.cos(deg * RAD)
  return prev ? { x: prev.x + (x - prev.x) * k, y: prev.y + (y - prev.y) * k } : { x, y }
}

const vectorDeg = (v: { x: number; y: number }) => norm360(Math.atan2(v.x, v.y) / RAD)

export function rotationMatrix(alpha: number, beta: number, gamma: number): Matrix {
  const [cA, sA] = [Math.cos(alpha * RAD), Math.sin(alpha * RAD)]
  const [cB, sB] = [Math.cos(beta * RAD), Math.sin(beta * RAD)]
  const [cG, sG] = [Math.cos(gamma * RAD), Math.sin(gamma * RAD)]
  return [
    [cA * cG - sA * sB * sG, -cB * sA, cG * sA * sB + cA * sG],
    [cG * sA + cA * sB * sG, cA * cB, sA * sG - cA * cG * sB],
    [-cB * sG, sB, cB * cG],
  ]
}

const toEarth = (m: Matrix, v: Vec): Vec => [0, 1, 2].map((i) => m[i][0] * v[0] + m[i][1] * v[1] + m[i][2] * v[2]) as Vec
const toDevice = (m: Matrix, v: Vec): Vec => [0, 1, 2].map((i) => m[0][i] * v[0] + m[1][i] * v[1] + m[2][i] * v[2]) as Vec
const unit = (v: Vec): Vec => {
  const n = Math.hypot(...v) || 1
  return [v[0] / n, v[1] / n, v[2] / n]
}

/** Compass direction of a device axis; null when it points (almost) straight up or down. */
export function axisHeading(m: Matrix, axis: Vec): number | null {
  const [x, y] = toEarth(m, axis)
  return Math.hypot(x, y) < 0.2 ? null : norm360(Math.atan2(x, y) / RAD)
}

/** Screen roughly horizontal (face up or down): the phone is in your hand, not in a pocket. */
export const isFlat = (m: Matrix) => Math.abs(m[2][2]) > Math.cos(FLAT_DEG * RAD)

/** Where the phone points: its top when held flat, else its back (as when you look at it upright). */
export function phoneHeading(m: Matrix): number | null {
  return isFlat(m) ? axisHeading(m, [0, 1, 0]) : axisHeading(m, [0, 0, -1])
}

/** The device axis that points horizontally in the direction `deg`. */
export function bodyAxis(m: Matrix, deg: number): Vec {
  return unit(toDevice(m, [Math.sin(deg * RAD), Math.cos(deg * RAD), 0]))
}

interface OrientationEventLike {
  webkitCompassHeading?: number
  alpha: number | null
  beta: number | null
  gamma: number | null
  absolute: boolean
  type: string
}

/** Orientation from one event, or null when it isn't relative to north. */
export function orientationOf(e: OrientationEventLike): Matrix | null {
  if (e.beta == null || e.gamma == null) return null
  // iOS: alpha starts wherever the phone pointed; the compass heading anchors it to north
  if (typeof e.webkitCompassHeading === 'number' && e.webkitCompassHeading >= 0) {
    return rotationMatrix(360 - e.webkitCompassHeading, e.beta, e.gamma)
  }
  if (e.alpha != null && (e.absolute || e.type === 'deviceorientationabsolute')) return rotationMatrix(e.alpha, e.beta, e.gamma)
  return null
}

let orientation: Matrix | null = null
let orientationAt = 0
let smoothed: { x: number; y: number } | null = null
let smoothedSource: Heading['source'] = 'compass'
let body: Vec | null = null
let bodyAt = 0
let last: (Heading & { at: number }) | null = null
let notifiedAt = 0
let listener: (() => void) | null = null

function headingFrom(m: Matrix, now: number): { deg: number; source: Heading['source'] } | null {
  if (!isFlat(m) && body && now - bodyAt <= BODY_MAX_AGE_MS) {
    const deg = axisHeading(m, body)
    if (deg != null) return { deg, source: 'body' }
  }
  const deg = phoneHeading(m)
  return deg == null ? null : { deg, source: 'compass' }
}

function onOrientation(e: DeviceOrientationEvent) {
  const m = orientationOf(e as unknown as OrientationEventLike)
  if (!m) return
  const now = Date.now()
  const h = headingFrom(m, now)
  const fresh = now - orientationAt <= COMPASS_STALE_MS
  orientation = m
  orientationAt = now
  if (!h) return
  // Switching between hand and pocket jumps: start the average over
  smoothed = smoothVector(fresh && h.source === smoothedSource ? smoothed : null, h.deg, SMOOTH)
  smoothedSource = h.source
  if (listener && now - notifiedAt >= NOTIFY_MS) {
    notifiedAt = now
    listener()
  }
}

/** Learns the pocket axis from the GPS course while you walk with the phone put away. */
export function learnFromFix(fix: Fix, now: number): void {
  const wall = Date.now()
  if (!orientation || wall - orientationAt > COMPASS_STALE_MS || isFlat(orientation)) return
  if (fix.heading == null || fix.heading < 0 || (fix.speed ?? 0) < MIN_SPEED || now - (fix.timestamp ?? 0) > 5000) return
  const axis = bodyAxis(orientation, fix.heading)
  const off = body ? (Math.acos(Math.max(-1, Math.min(1, axis[0] * body[0] + axis[1] * body[1] + axis[2] * body[2]))) / RAD) : 180
  body = off > BODY_RESET_DEG ? axis : unit([0, 1, 2].map((i) => body![i] + (axis[i] - body![i]) * BODY_BLEND) as Vec)
  bodyAt = wall
}

const eventName = () => ('ondeviceorientationabsolute' in window ? 'deviceorientationabsolute' : 'deviceorientation')

/** Starts listening to the phone compass; onChange is called (throttled) while it turns. */
export function startCompass(onChange: () => void): () => void {
  if (typeof window === 'undefined' || !('DeviceOrientationEvent' in window)) return () => {}
  listener = onChange
  const name = eventName()
  window.addEventListener(name, onOrientation as EventListener)
  return () => {
    window.removeEventListener(name, onOrientation as EventListener)
    listener = null
  }
}

type PermissionApi = { requestPermission?: () => Promise<'granted' | 'denied'> }

/** iOS asks before a page may read the compass, and only from a tap on the phone page. */
export function compassNeedsPermission(): boolean {
  return typeof window !== 'undefined' && typeof (window.DeviceOrientationEvent as PermissionApi | undefined)?.requestPermission === 'function'
}

export async function requestCompassPermission(): Promise<boolean> {
  const api = window.DeviceOrientationEvent as PermissionApi | undefined
  if (typeof api?.requestPermission !== 'function') return true
  try {
    return (await api.requestPermission()) === 'granted'
  } catch {
    return false
  }
}

/** The direction you face right now, or null (the map is then drawn north-up). */
export function currentHeading(fix: Fix | null, now: number): Heading | null {
  if (mockHeading != null) return { deg: mockHeading, source: 'compass' }
  const wall = Date.now()
  let fresh: Heading | null = null
  if (smoothed && wall - orientationAt <= COMPASS_STALE_MS) fresh = { deg: vectorDeg(smoothed), source: smoothedSource }
  else if (fix && fix.heading != null && fix.heading >= 0 && (fix.speed ?? 0) >= MIN_SPEED && now - (fix.timestamp ?? 0) <= GPS_STALE_MS) {
    fresh = { deg: fix.heading, source: 'gps' }
  }
  if (fresh) {
    last = { ...fresh, at: wall }
    return fresh
  }
  return last && wall - last.at <= HOLD_MS ? { deg: last.deg, source: last.source } : null
}
