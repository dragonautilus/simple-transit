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

export function serial<T>(fn: () => Promise<T>, timeoutMs = 6000): Promise<T> {
  const run = queue.then(() =>
    Promise.race([
      fn(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('bridge call timed out')), timeoutMs)),
    ]),
  )
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

async function read(key: string): Promise<unknown> {
  const bridge = await getBridge()
  let raw: string | null = null
  try {
    raw = bridge ? await serial(() => bridge.getLocalStorage(key)) : localStorage.getItem(key)
  } catch {
    raw = null
  }
  try {
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

async function write(key: string, value: unknown): Promise<void> {
  const raw = JSON.stringify(value)
  const bridge = await getBridge()
  if (bridge) await serial(() => bridge.setLocalStorage(key, raw))
  else localStorage.setItem(key, raw)
}

export async function loadTargets(): Promise<Target[]> {
  const parsed = await read(KEY)
  return Array.isArray(parsed) ? parsed : []
}

export const saveTargets = (targets: Target[]): Promise<void> => write(KEY, targets)

export async function loadSettings(): Promise<Settings> {
  const parsed = await read(SETTINGS_KEY)
  return { ...DEFAULT_SETTINGS, ...(parsed && typeof parsed === 'object' ? parsed : {}) }
}

export const saveSettings = (settings: Settings): Promise<void> => write(SETTINGS_KEY, settings)
