// Schematic layout of a trip on a horizontal line. Pure time scaling squashes short legs into a
// few pixels and leaves holes during transfer waits, so every part gets a minimum width and the
// waits are laid out as segments of their own (drawn as the station).

import type { Trip } from './journey'

export type SegmentKind = 'ride' | 'walk' | 'wait'

export interface Segment {
  kind: SegmentKind
  /** Index of the leg (ride/walk) or of the leg after the wait. */
  legIndex: number
  t0: number
  t1: number
  x0: number
  x1: number
}

const MIN_WIDTH: Record<SegmentKind, number> = { ride: 60, walk: 26, wait: 16 }

export interface LineLayout {
  segments: Segment[]
  /** x for a point in time; piecewise linear inside each segment. */
  xAt(t: number): number
}

export function layoutLine(trip: Trip, left: number, right: number): LineLayout {
  const parts: Omit<Segment, 'x0' | 'x1'>[] = []
  trip.legs.forEach((leg, i) => {
    const prev = trip.legs[i - 1]
    if (prev && leg.from.time > prev.to.time) {
      parts.push({ kind: 'wait', legIndex: i, t0: prev.to.time, t1: leg.from.time })
    }
    parts.push({ kind: leg.kind, legIndex: i, t0: leg.from.time, t1: Math.max(leg.from.time, leg.to.time) })
  })

  const widths = allocate(
    parts.map((p) => p.t1 - p.t0),
    parts.map((p) => MIN_WIDTH[p.kind]),
    right - left,
  )
  let x = left
  const segments: Segment[] = parts.map((p, i) => {
    const s = { ...p, x0: x, x1: x + widths[i] }
    x = s.x1
    return s
  })

  const xAt = (t: number): number => {
    if (segments.length === 0) return left
    if (t <= segments[0].t0) return segments[0].x0
    for (const s of segments) {
      if (t <= s.t1) return s.t1 === s.t0 ? s.x1 : s.x0 + ((t - s.t0) / (s.t1 - s.t0)) * (s.x1 - s.x0)
    }
    return segments[segments.length - 1].x1
  }
  return { segments, xAt }
}

/**
 * Split `total` px proportionally to `weights`, but never below `mins`. Segments that would fall
 * below their minimum are pinned to it and the rest is shared by the others.
 */
export function allocate(weights: number[], mins: number[], total: number): number[] {
  const n = weights.length
  if (n === 0) return []
  const minSum = mins.reduce((a, b) => a + b, 0)
  // Not enough room even for the minimums: scale those down
  if (minSum >= total) return mins.map((m) => (m / minSum) * total)

  const pinned = new Array<boolean>(n).fill(false)
  for (;;) {
    const free = total - mins.reduce((a, m, i) => a + (pinned[i] ? m : 0), 0)
    const freeWeight = weights.reduce((a, w, i) => a + (pinned[i] ? 0 : Math.max(w, 0)), 0)
    const widths = weights.map((w, i) =>
      pinned[i] ? mins[i] : freeWeight > 0 ? (Math.max(w, 0) / freeWeight) * free : free / pinned.filter((p) => !p).length,
    )
    const under = widths.findIndex((w, i) => !pinned[i] && w < mins[i])
    if (under < 0) return widths
    // Pin the segment that's furthest below its minimum, then redistribute
    let worst = under
    widths.forEach((w, i) => {
      if (!pinned[i] && mins[i] - w > mins[worst] - widths[worst]) worst = i
    })
    pinned[worst] = true
  }
}
