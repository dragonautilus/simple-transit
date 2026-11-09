// Registry of public transport networks.
//
// Adding a network: write an adapter that implements `Network` (transitous.ts is an example that
// converts a foreign API into the api.ts shapes), add it to NETWORKS below, add its API origin to
// the network whitelist in app.json and its data sources and licences to credits.ts.

import * as opendataApi from '../api'
import { transitous } from './transitous'
import type { Network } from './types'

export type { Network } from './types'

/**
 * Swiss timetable incl. trains across the border (Milano, Paris, München, …), but no local transport
 * abroad. The id stays 'ch': settings and saved targets store it.
 */
export const opendata: Network = {
  id: 'ch',
  name: 'Switzerland & cross-border',
  source: 'transport.opendata.ch',
  // Switzerland + Liechtenstein bounding box (also catches some border towns, which the Swiss
  // timetable mostly covers too). Transitous is preferred everywhere; this network takes over in
  // Switzerland when Transitous fails or finds no stop close by.
  covers: (lat, lng) => lat >= 45.81 && lat <= 47.81 && lng >= 5.95 && lng <= 10.5,
  nearbyStations: opendataApi.nearbyStations,
  searchLocations: opendataApi.searchLocations,
  stationboard: opendataApi.stationboard,
  connections: opendataApi.connections,
}

/** Order matters for automatic selection: the first network that covers a position wins.
 *  Transitous (worldwide) is preferred; the others are fallbacks where they cover the position. */
export const NETWORKS: Network[] = [transitous, opendata]

export const DEFAULT_NETWORK = transitous.id

export function getNetwork(id: string | undefined | null): Network {
  return NETWORKS.find((n) => n.id === id) ?? transitous
}

/** 'auto' picks by position; any other value forces that network. */
export function networkFor(setting: string, lat: number, lng: number): Network {
  if (setting !== 'auto') return getNetwork(setting)
  return NETWORKS.find((n) => n.covers(lat, lng)) ?? NETWORKS[NETWORKS.length - 1]
}

// ---------- Failover ----------
//
// A network whose request failed (down, rate-limited, …) is avoided for a while and the other
// networks covering the position take over; after the pause it is tried first again.

/** How long a failed network is avoided. */
export const DOWN_MS = 5 * 60_000

const downUntil = new Map<string, number>()

export function markDown(network: Network, now: number): void {
  downUntil.set(network.id, now + DOWN_MS)
}

export function isDown(network: Network, now: number): boolean {
  return (downUntil.get(network.id) ?? 0) > now
}

/** For tests. */
export function resetHealth(): void {
  downUntil.clear()
}

/**
 * Networks to ask for a position, best first: the chosen one (by setting or position), then the
 * others covering the position. Networks that failed recently go last, still tried when all fail.
 */
export function candidates(setting: string, lat: number, lng: number, now: number): Network[] {
  const chosen = networkFor(setting, lat, lng)
  const all = [chosen, ...NETWORKS.filter((n) => n !== chosen && n.covers(lat, lng))]
  return [...all.filter((n) => !isDown(n, now)), ...all.filter((n) => isDown(n, now))]
}
