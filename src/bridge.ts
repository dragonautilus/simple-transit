// Access to the Even App bridge and the app's persistent storage. All bridge calls share one
// Bluetooth link, so they run one at a time, each with a timeout (a flaky hop can hang for ~30 s).

import { waitForEvenAppBridge, type EvenAppBridge } from '@evenrealities/even_hub_sdk'

let bridgePromise: Promise<EvenAppBridge | null> | null = null

/** Resolves to null when the page runs in a plain browser (no Even App host). */
export function getBridge(timeoutMs = 4000): Promise<EvenAppBridge | null> {
  bridgePromise ??= Promise.race([
    waitForEvenAppBridge(),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
  ])
  return bridgePromise
}

export const bridgeStats = { calls: 0, busyMs: 0 }

interface Job {
  run: () => Promise<void>
}
// Images are slow to transfer, so they only go when nothing else waits: text and taps never
// queue behind them.
const lanes: { high: Job[]; low: Job[] } = { high: [], low: [] }
let running = false

function pump() {
  if (running) return
  const job = lanes.high.shift() ?? lanes.low.shift()
  if (!job) return
  running = true
  void job.run().finally(() => {
    running = false
    pump()
  })
}

export function serial<T>(fn: () => Promise<T>, timeoutMs = 6000, priority: 'high' | 'low' = 'high'): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    lanes[priority].push({
      run: async () => {
        const start = performance.now()
        bridgeStats.calls++
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          resolve(
            await Promise.race([
              fn(),
              new Promise<never>((_, rej) => {
                timer = setTimeout(() => rej(new Error('bridge call timed out')), timeoutMs)
              }),
            ]),
          )
        } catch (err) {
          reject(err)
        } finally {
          clearTimeout(timer)
          bridgeStats.busyMs += performance.now() - start
        }
      },
    })
    pump()
  })
}

// ---------- Persistent settings ----------

export interface Target {
  id: string
  label: string
  /** Value passed as `to` to /connections: station id, or "lat,lng" for addresses/POIs. */
  query: string
  /** Full name of the location as returned by the API. */
  place: string
  /** Network the query belongs to (see networks/). Targets saved before 0.2 are Swiss. */
  network?: string
}

export interface Settings {
  /** 'auto' (by position) or a network id. */
  network: string
  /** Small street map next to the departure board. */
  map: boolean
  /** The map turns so that the direction you face is up (else north is up). */
  rotate: boolean
}

export const DEFAULT_SETTINGS: Settings = { network: 'auto', map: true, rotate: true }

const KEY = 'sst.targets'
const SETTINGS_KEY = 'sst.settings'

// The Even app storage is the source of truth (survives WebView resets); every value is mirrored
// into WebView localStorage so startup can use it synchronously, without a round trip to the app.

const parse = (raw: string | null | undefined): unknown => {
  try {
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

/** Last known value from the WebView mirror, synchronous (may be missing or slightly stale). */
export function readCached(key: string): unknown {
  try {
    return parse(localStorage.getItem(key))
  } catch {
    return null
  }
}

function mirror(key: string, raw: string | null) {
  try {
    if (raw) localStorage.setItem(key, raw)
    else localStorage.removeItem(key)
  } catch {
    // mirror is only an optimisation
  }
}

/** One round trip per key, shared by the phone page and the glasses side. */
const reads = new Map<string, Promise<unknown>>()

export function read(key: string): Promise<unknown> {
  let p = reads.get(key)
  if (!p) {
    p = (async () => {
      const bridge = await getBridge()
      if (!bridge) return readCached(key)
      const raw = await serial(() => bridge.getLocalStorage(key)).catch(() => null)
      // Empty in the app (e.g. first start after an update): keep what the mirror has
      if (!raw) return readCached(key)
      mirror(key, raw)
      return parse(raw)
    })()
    reads.set(key, p)
  }
  return p
}

export async function write(key: string, value: unknown): Promise<void> {
  const raw = value == null ? '' : JSON.stringify(value)
  mirror(key, raw || null)
  reads.set(key, Promise.resolve(value ?? null))
  const bridge = await getBridge()
  if (bridge) await serial(() => bridge.setLocalStorage(key, raw))
}

const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0

function isTarget(t: unknown): t is Target {
  const x = t as Target
  return !!x && str(x.id) && str(x.label) && str(x.query) && str(x.place) && (x.network === undefined || str(x.network))
}

export async function loadTargets(): Promise<Target[]> {
  const parsed = await read(KEY)
  return Array.isArray(parsed) ? parsed.filter(isTarget) : []
}

export const saveTargets = (targets: Target[]): Promise<void> => write(KEY, targets)

function toSettings(parsed: unknown): Settings {
  const p = (parsed ?? {}) as Partial<Settings>
  return {
    network: str(p.network) ? p.network : DEFAULT_SETTINGS.network,
    map: typeof p.map === 'boolean' ? p.map : DEFAULT_SETTINGS.map,
    rotate: typeof p.rotate === 'boolean' ? p.rotate : DEFAULT_SETTINGS.rotate,
  }
}

export async function loadSettings(): Promise<Settings> {
  return toSettings(await read(SETTINGS_KEY))
}

/** From the WebView mirror, for the very first frame. */
export const cachedSettings = (): Settings => toSettings(readCached(SETTINGS_KEY))

export const saveSettings = (settings: Settings): Promise<void> => write(SETTINGS_KEY, settings)
