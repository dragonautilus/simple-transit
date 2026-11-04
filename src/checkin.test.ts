import { describe, expect, it } from 'vitest'
import type { Connection } from './api'
import { ARRIVED_GRACE_MS, MAX_OVERRUN_MS, checkInExpired, type CheckIn } from './checkin'
import { buildTrip } from './journey'
import fixture from './__fixtures__/connections.json'

const trip = buildTrip((fixture as { connections: Connection[] }).connections[0])
const dest = trip.legs[trip.legs.length - 1].to.coord!
const make = (fetchedAt: number): CheckIn => ({
  target: { id: 't', label: 'Thun', query: '8507100', place: 'Thun' },
  query: { from: '47.39,8.49', to: '8507100' },
  trip,
  checkedInAt: trip.start - 60_000,
  fetchedAt,
})
const at = (lat: number, lng: number) => ({ lat, lng, accuracy: 10, timestamp: 0 })

describe('check-in expiry', () => {
  const early = make(trip.start)
  it('stays checked in during the journey and shortly after arrival', () => {
    expect(checkInExpired(early, trip.start + 60_000, null)).toBe(false)
    expect(checkInExpired(early, trip.end + ARRIVED_GRACE_MS - 1, at(dest.lat, dest.lng))).toBe(false)
  })
  it('checks out after arrival when GPS is at the destination', () => {
    expect(checkInExpired(early, trip.end + ARRIVED_GRACE_MS + 1, at(dest.lat, dest.lng))).toBe(true)
  })
  it('waits for possible delays when GPS is elsewhere and the timetable is old', () => {
    expect(checkInExpired(early, trip.end + ARRIVED_GRACE_MS + 1, at(47.37, 8.54))).toBe(false)
    expect(checkInExpired(early, trip.end + ARRIVED_GRACE_MS + 1, null)).toBe(false)
  })
  it('checks out when a fresh timetable confirms the arrival', () => {
    expect(checkInExpired(make(trip.end), trip.end + ARRIVED_GRACE_MS + 1, null)).toBe(true)
  })
  it('always checks out an hour after the last known arrival', () => {
    expect(checkInExpired(early, trip.end + MAX_OVERRUN_MS + 1, at(47.37, 8.54))).toBe(true)
  })
})
