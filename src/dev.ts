// Test overrides via URL for the dev server and simulator, e.g. ?lat=47.3911&lng=8.4889&now=2026-11-04T08:10
// Production builds ignore the URL entirely (import.meta.env.DEV is false there).
//
//   lat, lng   replace the phone GPS (the simulator has none)
//   now        sets the app clock
//   ff         jumps the clock n minutes ahead once navigation starts
//   targets    Thun|8507100;Office|47.37,8.54;Südkreuz|de-VBB_de:11000:900058101|eu
//              seeds preset targets when none are stored (third part: network id)
//   jitter     makes the mock position wander by up to n m every 2 s (GPS after a cold start)
//   slowimg    delays every map image transfer by n ms (the simulator is faster than Bluetooth)
//   perf       logs timings and bridge traffic to the console
//   fail       requests to these hosts fail, e.g. fail=api.transitous.org (network failover)
//   heading    fixed direction you face (°), turns the map like the compass would
//   imu        logs the raw IMU reports of the glasses to the console

import type { Target } from './bridge'
import type { Fix } from './journey'

// No location in unit tests (Node)
const params = new URLSearchParams(import.meta.env.DEV && typeof location !== 'undefined' ? location.search : '')
const num = (k: string) => (params.has(k) ? Number(params.get(k)) : NaN)

const lat = num('lat')
const lng = num('lng')
export const mockFix = Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng, accuracy: 10 } : null

const fixedNow = params.has('now') ? Date.parse(params.get('now')!) : NaN
let offset = Number.isNaN(fixedNow) ? 0 : fixedNow - Date.now()

export const now = (): number => Date.now() + offset

let forwarded = false
export function fastForward(): void {
  if (forwarded) return
  forwarded = true
  offset += (num('ff') || 0) * 60_000
}

const heading = num('heading')
export const mockHeading = Number.isFinite(heading) ? heading : null

export const logImu = params.has('imu')

export const slowImageMs = num('slowimg') || 0

/** Hosts whose requests fail, to try the network failover. */
export const failHosts = new Set((params.get('fail') ?? '').split(',').filter(Boolean))

const perf = params.has('perf')
export function mark(label: string): void {
  if (perf) console.log(`[perf] ${Math.round(performance.now())} ms since page load  ${label}`)
}

export const mockTargets: Target[] = (params.get('targets') ?? '')
  .split(';')
  .filter((s) => s.includes('|'))
  .map((s, i) => {
    const [label, query, network] = s.split('|').map((p) => {
      try {
        return decodeURIComponent(p)
      } catch {
        return p
      }
    })
    return { id: `dev${i}`, label, query, place: label, network: network || undefined }
  })

export function startDevHooks(onFix: (fix: Fix) => void, stats: () => string): void {
  const jitter = num('jitter') || 0
  if (mockFix && jitter) {
    const r = () => ((Math.random() * 2 - 1) * jitter) / 111_000
    setInterval(() => onFix({ lat: mockFix.lat + r(), lng: mockFix.lng + r(), accuracy: jitter, timestamp: now() }), 2000)
  }
  if (perf) setInterval(() => mark(stats()), 10_000)
}
