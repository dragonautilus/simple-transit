import { describe, expect, it } from 'vitest'
import type { Connection, StationboardEntry } from './api'
import { buildTrip } from './journey'
import { allocate, layoutLine } from './line-layout'
import { boardRows } from './format'
import connections from './__fixtures__/connections.json'
import board from './__fixtures__/stationboard.json'

const trip = buildTrip((connections as { connections: Connection[] }).connections[0])

describe('allocate', () => {
  it('is proportional when every part is above its minimum', () => {
    expect(allocate([1, 3], [10, 10], 400)).toEqual([100, 300])
  })

  it('pins small parts to their minimum and shares the rest', () => {
    const w = allocate([1, 99], [60, 60], 500)
    expect(w[0]).toBe(60)
    expect(w[0] + w[1]).toBeCloseTo(500)
  })
})

describe('layoutLine', () => {
  const layout = layoutLine(trip, 18, 558)
  const segs = layout.segments

  it('covers the whole width without gaps', () => {
    expect(segs[0].x0).toBe(18)
    expect(segs.at(-1)!.x1).toBeCloseTo(558)
    segs.slice(1).forEach((s, i) => expect(s.x0).toBeCloseTo(segs[i].x1))
  })

  it('gives transfer waits their own segment and short rides a readable width', () => {
    expect(segs.some((s) => s.kind === 'wait')).toBe(true)
    for (const s of segs) if (s.kind === 'ride') expect(s.x1 - s.x0).toBeGreaterThanOrEqual(59.9)
  })

  it('maps time monotonically onto x', () => {
    let last = -Infinity
    for (let t = trip.start - 60_000; t <= trip.end + 60_000; t += 30_000) {
      const x = layout.xAt(t)
      expect(x).toBeGreaterThanOrEqual(last)
      last = x
    }
    expect(layout.xAt(trip.start)).toBe(18)
    expect(layout.xAt(trip.end)).toBeCloseTo(558)
  })
})

describe('boardRows', () => {
  const entries = (board as { stationboard: StationboardEntry[] }).stationboard
  const first = Date.parse(entries[0].stop.departure!.replace(/([+-]\d\d)(\d\d)$/, '$1:$2'))

  it('splits each departure into time, line, destination and platform', () => {
    const rows = boardRows(entries, 'Zürich HB', first - 3 * 60_000, 7)
    expect(rows).toHaveLength(7)
    for (const r of rows) {
      expect(r.time).toMatch(/^\d\d:\d\d$/)
      expect(r.when).toMatch(/^(now|\d+'|\d+h)$/)
      expect(r.line.length).toBeGreaterThan(0)
      expect(r.dest).toMatch(/^→ \S/)
    }
    expect(rows[0].info).toContain(entries[0].stop.platform!)
    expect(rows[0].when).toBe("3'")
  })

  it('keeps "departs in" short for departures far ahead', () => {
    const at = (min: number) => boardRows(entries, 'Zürich HB', first - min * 60_000, 1)[0].when
    expect(at(99)).toBe("99'")
    expect(at(100)).toBe('2h')
    expect(at(200)).toBe('3h')
  })

  it('leaves out departures more than a day ahead', () => {
    expect(boardRows(entries, 'Zürich HB', first - 25 * 3_600_000, 7)).toHaveLength(0)
  })
})
