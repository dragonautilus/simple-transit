import type { Connection, ConnectionQuery, Location, StationboardEntry } from '../api'

/**
 * A public transport data source. Every network returns the shared shapes from api.ts, so the
 * glasses and companion UI never need to know which one they talk to.
 */
export interface Network {
  /** Stable id, stored with targets and settings. */
  id: string
  /** Shown in the phone app, e.g. "Switzerland". */
  name: string
  /** Data provider, e.g. "transport.opendata.ch". */
  source: string
  /** Rough coverage check used by automatic network selection. */
  covers(lat: number, lng: number): boolean
  /** Closest stops (with id), nearest first, `distance` in metres. */
  nearbyStations(lat: number, lng: number, max?: number): Promise<Location[]>
  /** Stops, addresses and places for the companion search. Stops have an id, others coordinates. */
  searchLocations(query: string): Promise<Location[]>
  stationboard(id: string, limit?: number): Promise<StationboardEntry[]>
  /** `from`/`to` are a stop id from this network or "lat,lng". */
  connections(q: ConnectionQuery, limit?: number): Promise<Connection[]>
}
