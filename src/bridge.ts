// Access to the Even App bridge. All bridge calls share one BLE link, so they are serialised and
// each one gets a timeout (a flaky hop can otherwise hang for ~30 s).

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

let queue: Promise<unknown> = Promise.resolve()

/** Bridge traffic counters (logged with ?perf=1). */
export const bridgeStats = { calls: 0, busyMs: 0 }

export function serial<T>(fn: () => Promise<T>, timeoutMs = 6000): Promise<T> {
  const run = queue.then(() => {
    const start = performance.now()
    bridgeStats.calls++
    return Promise.race([
      fn(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('bridge call timed out')), timeoutMs)),
    ]).finally(() => (bridgeStats.busyMs += performance.now() - start))
  })
  queue = run.catch(() => undefined)
  return run
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
}

export const DEFAULT_SETTINGS: Settings = { network: 'auto', map: true }

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

export async function loadTargets(): Promise<Target[]> {
  const parsed = await read(KEY)
  return Array.isArray(parsed) ? parsed : []
}

export const saveTargets = (targets: Target[]): Promise<void> => write(KEY, targets)

const toSettings = (parsed: unknown): Settings => ({ ...DEFAULT_SETTINGS, ...(parsed && typeof parsed === 'object' ? parsed : {}) })

export async function loadSettings(): Promise<Settings> {
  return toSettings(await read(SETTINGS_KEY))
}

/** Settings from the WebView mirror, for the very first frame. */
export const cachedSettings = (): Settings => toSettings(readCached(SETTINGS_KEY))

export const saveSettings = (settings: Settings): Promise<void> => write(SETTINGS_KEY, settings)
