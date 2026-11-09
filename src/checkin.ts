// Check-in: the journey you are on, kept in the Even app's storage so the app can be closed
// during a long ride and opens straight into the journey again. Checked out automatically
// once the journey is over.

import type { ConnectionQuery } from './api'
import { read, readCached, write, type Target } from './bridge'
import { distanceM, type Fix, type Trip } from './journey'

export interface CheckIn {
  target: Target
  query: ConnectionQuery
  /** Network the query (stop ids) belongs to; another than the target's when that had failed.
   *  Missing in check-ins from before 0.5.1: the target's network. */
  network?: string
  trip: Trip
  checkedInAt: number
  /** When the timetable (incl. delays) was last refreshed. */
  fetchedAt: number
}

const KEY = 'sst.checkin'
/** Pre-0.3 resume data (WebView storage only). */
const LEGACY_KEY = 'sst.activeTrip'

/** Checked out this long after arrival when the arrival is confirmed (GPS or fresh timetable). */
export const ARRIVED_GRACE_MS = 10 * 60_000
/** Checked out this long after the last known arrival in any case (covers unseen delays). */
export const MAX_OVERRUN_MS = 60 * 60_000
/** "At the destination" radius for the GPS check. */
const AT_DESTINATION_M = 1000

/** Whether the journey is over and the check-in can be dropped. */
export function checkInExpired(c: CheckIn, now: number, fix: Fix | null): boolean {
  const end = c.trip.end
  if (now > end + MAX_OVERRUN_MS) return true
  if (now <= end + ARRIVED_GRACE_MS) return false
  const dest = c.trip.legs[c.trip.legs.length - 1]?.to.coord
  const atDestination = !!fix && !!dest && distanceM(fix, dest) <= AT_DESTINATION_M
  // Timetable fetched around/after the arrival: the end time includes the latest delays
  const confirmed = c.fetchedAt >= end - 5 * 60_000
  return atDestination || confirmed
}

function valid(c: unknown): c is CheckIn {
  const x = c as CheckIn | null
  return !!x?.trip?.legs?.length && !!x.target && !!x.query
}

function normalise(found: unknown): CheckIn | null {
  if (!valid(found)) return null
  // Legacy entries have neither timestamp
  return { ...found, checkedInAt: found.checkedInAt ?? found.fetchedAt ?? 0, fetchedAt: found.fetchedAt ?? 0 }
}

/** From the WebView mirror, synchronous: decides the very first frame on the glasses. */
export function cachedCheckIn(): CheckIn | null {
  return normalise(readCached(KEY)) ?? normalise(readCached(LEGACY_KEY))
}

/** From the Even app storage (survives app restarts and WebView resets). */
export async function loadCheckIn(): Promise<CheckIn | null> {
  return normalise(await read(KEY)) ?? cachedCheckIn()
}

export async function saveCheckIn(c: CheckIn | null): Promise<void> {
  try {
    localStorage.removeItem(LEGACY_KEY)
  } catch {
    // ignore
  }
  await write(KEY, c).catch(() => undefined)
}
