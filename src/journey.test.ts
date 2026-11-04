import { describe, expect, it } from 'vitest'
import type { Connection } from './api'
import { buildTrip, estimateProgress, lineName } from './journey'
import { connectionItem, nextAction, tripSteps } from './format'
import fixture from './__fixtures__/connections.json'

const conn = (fixture as { connections: Connection[] }).connections[0]
const trip = buildTrip(conn)
const rides = trip.legs.filter((l) => l.kind === 'ride')

describe('buildTrip', () => {
  it('keeps every ride with times, platforms and stops', () => {
    expect(rides.length).toBe(3)
    for (const leg of rides) {
      expect(leg.to.time).toBeGreaterThan(leg.from.time)
      expect(leg.stops.length).toBeGreaterThanOrEqual(2)
    }
    expect(trip.end).toBeGreaterThan(trip.start)
    expect(rides[1].from.name).toBe('Zürich HB')
    expect(rides[1].from.platform).toBe('32')
  })

  it('hides long train numbers in line names', () => {
    expect(lineName('ICE', '000271')).toBe('ICE')
    expect(lineName('IC', '1')).toBe('IC 1')
    expect(lineName('T', '4')).toBe('Tram 4')
    expect(lineName('B', '46')).toBe('Bus 46')
    expect(lineName('EC', '000193')).toBe('EC')
  })
})

describe('estimateProgress (time)', () => {
  it('is 0 before departure and waiting for the first leg', () => {
    const p = estimateProgress(trip, trip.start - 10 * 60_000)
    expect(p.fraction).toBe(0)
    expect(p.legIndex).toBe(0)
    expect(p.arrived).toBe(false)
  })

  it('tracks the current leg mid-journey', () => {
    const leg = rides[1]
    const p = estimateProgress(trip, (leg.from.time + leg.to.time) / 2)
    expect(trip.legs[p.legIndex]).toBe(leg)
    expect(p.waiting).toBe(false)
    expect(p.fraction).toBeGreaterThan(0)
    expect(p.fraction).toBeLessThan(1)
  })

  it('reports waiting during a change', () => {
    const t = rides[1].from.time - 30_000
    if (t <= rides[0].to.time) return // no gap in this fixture
    const p = estimateProgress(trip, t)
    expect(p.waiting).toBe(true)
    expect(trip.legs[p.legIndex]).toBe(rides[1])
  })

  it('is arrived after the end', () => {
    const p = estimateProgress(trip, trip.end + 5 * 60_000)
    expect(p.fraction).toBe(1)
    expect(p.arrived).toBe(true)
  })
})

describe('estimateProgress (GPS)', () => {
  it('uses GPS when the fix is on the route, e.g. train still standing at a stop', () => {
    const leg = rides.find((l) => l.stops.length > 2)!
    const stop = leg.stops[1]
    const fix = { ...stop.coord!, accuracy: 20, timestamp: 0 }
    // Clock says we're 5 minutes past that stop; GPS says we're still there
    const now = stop.time + 5 * 60_000
    const p = estimateProgress(trip, now, { ...fix, timestamp: now })
    expect(p.source).toBe('gps')
    expect(Math.abs(p.time - stop.time)).toBeLessThan(60_000)
  })

  it('ignores GPS far away from the route', () => {
    const now = (rides[1].from.time + rides[1].to.time) / 2
    const p = estimateProgress(trip, now, { lat: 46.0, lng: 6.0, accuracy: 10, timestamp: now })
    expect(p.source).toBe('time')
  })
})

describe('format', () => {
  it('lists every change with arrival and departure platform', () => {
    const p = estimateProgress(trip, trip.start)
    const { lines } = tripSteps(trip, p)
    const text = lines.join('\n')
    expect(text).toContain('Change at Zürich HB')
    expect(text).toContain('Change at Bern')
    expect(text).toMatch(/arr \d\d:\d\d.* Pl \S+ → dep \d\d:\d\d.* Pl 32/)
    expect(lines.at(-1)).toContain('Thun')
  })

  it('builds a short connection label', () => {
    const s = connectionItem(trip)
    expect(s).toMatch(/^\d\d:\d\d.*→\d\d:\d\d .* ↔2 /)
    expect(s.length).toBeLessThanOrEqual(60)
  })

  it('tells the user what to do next', () => {
    const before = estimateProgress(trip, trip.start - 60_000)
    expect(nextAction(trip, before, trip.start - 60_000)).toMatch(/^Board S 5/)
    const mid = (rides[0].from.time + rides[0].to.time) / 2
    expect(nextAction(trip, estimateProgress(trip, mid), mid)).toMatch(/^Exit at Zürich HB .* then IC 1 Pl 32/)
  })
})
