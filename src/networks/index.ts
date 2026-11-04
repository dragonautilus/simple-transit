// Registry of public transport networks.
//
// Adding a network: write an adapter that implements `Network` (see types.ts and transitous.ts
// for an example that converts a foreign API into the api.ts shapes), add it to NETWORKS below
// and add its API origin to "permissions" → "network" → "whitelist" in app.json.

import * as swissApi from '../api'
import { transitous } from './transitous'
import type { Network } from './types'

export type { Network } from './types'

export const swiss: Network = {
  id: 'ch',
  name: 'Switzerland',
  source: 'transport.opendata.ch',
  attribution: 'opentransportdata.swiss via transport.opendata.ch',
  // Switzerland + Liechtenstein bounding box (also catches some border towns, which the Swiss
  // timetable mostly covers too)
  covers: (lat, lng) => lat >= 45.81 && lat <= 47.81 && lng >= 5.95 && lng <= 10.5,
  nearbyStations: swissApi.nearbyStations,
  searchLocations: swissApi.searchLocations,
  stationboard: swissApi.stationboard,
  connections: swissApi.connections,
}

/** Order matters for automatic selection: the first network that covers a position wins. */
export const NETWORKS: Network[] = [swiss, transitous]

export const DEFAULT_NETWORK = swiss.id

export function getNetwork(id: string | undefined | null): Network {
  return NETWORKS.find((n) => n.id === id) ?? swiss
}

/** 'auto' picks by position; any other value forces that network. */
export function networkFor(setting: string, lat: number, lng: number): Network {
  if (setting !== 'auto') return getNetwork(setting)
  return NETWORKS.find((n) => n.covers(lat, lng)) ?? NETWORKS[NETWORKS.length - 1]
}

/** Next network to try when the selected one finds no stop nearby (auto mode only). */
export function fallbackNetwork(current: Network, lat: number, lng: number): Network | null {
  return NETWORKS.find((n) => n !== current && n.covers(lat, lng)) ?? null
}
