// Testing overrides via URL, e.g. index.html?lat=47.3911&lng=8.4889&now=2026-11-04T08:10
// lat/lng replace the phone GPS (the simulator has none), now shifts the app clock, ff see below.

const params = new URLSearchParams(location.search)
const num = (k: string) => (params.has(k) ? Number(params.get(k)) : NaN)

const lat = num('lat')
const lng = num('lng')
export const mockFix = Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng, accuracy: 10 } : null

const fixedNow = params.has('now') ? Date.parse(params.get('now')!) : NaN
let offset = Number.isNaN(fixedNow) ? 0 : fixedNow - Date.now()

export const now = (): number => Date.now() + offset

/** perf=1 logs timings and bridge traffic to the console. */
export const perf = params.has('perf')
/** Milliseconds since the page started loading. */
export function mark(label: string): void {
  if (perf) console.log(`[perf] ${Math.round(performance.now())} ms  ${label}`)
}

/** jitter=20 makes the mock position wander by up to 20 m every 2 s (like GPS after a cold start). */
export const jitterM = num('jitter') || 0

/** slowimg=3000 delays every image transfer by 3 s (the simulator is much faster than Bluetooth). */
export const slowImageMs = num('slowimg') || 0

/** ff=40 jumps the clock 40 minutes ahead once navigation starts. */
let forwarded = false
export function fastForward(): void {
  if (forwarded) return
  forwarded = true
  offset += (num('ff') || 0) * 60_000
}

/** targets=Thun|8507100;Office|47.37,8.54;Südkreuz|de-VBB_de:11000:900058101|eu seeds preset
 *  targets when none are stored (third part: network id, default Swiss). */
export const mockTargets = (params.get('targets') ?? '')
  .split(';')
  .filter((s) => s.includes('|'))
  .map((s, i) => {
    const [label, query, network] = s.split('|').map(decodeURIComponent)
    return { id: `dev${i}`, label, query, place: label, network: network || undefined }
  })
