import { describe, expect, it } from 'vitest'
// @ts-expect-error Node types are not installed; vitest runs this file in Node
import { readFileSync } from 'node:fs'
import { MAP_W, compass, computeView, metresPerPx, project, scaleBar, screenOf, spreadApart } from './board-map'
import { decodeTile } from './mvt'

describe('vector tile decoder', () => {
  it('reads street lines with their kind', () => {
    const buf = new Uint8Array(readFileSync(new URL('../__fixtures__/tile-16-34319-22950.mvt', import.meta.url)))
    const tile = decodeTile(buf, ['streets'])
    expect(tile.extent).toBe(4096)
    expect(tile.lines.length).toBeGreaterThan(300)
    const kinds = new Set(tile.lines.map((l) => l.kind))
    expect(kinds.has('residential')).toBe(true)
    expect(kinds.has('tram')).toBe(true)
    for (const l of tile.lines) expect(l.points.length % 2).toBe(0)
  })
})

describe('map view', () => {
  const me = { lat: 47.3782, lng: 8.5402 }
  const near = { lat: 47.3785, lng: 8.5406 }
  const far = { lat: 47.3862, lng: 8.5402 }

  it('turns the map so the direction you face points up', () => {
    const east = { lat: 47.3782, lng: 8.55 }
    const v = computeView({ me, stations: [east], selected: 0, heading: 90 })!
    const [x, y] = screenOf(v)(...project(east))
    const [mx, my] = screenOf(v)(...project(me))
    expect(Math.abs(x - mx)).toBeLessThan(1)
    expect(y).toBeLessThan(my)
  })

  it('keeps the zoom and both points in frame while you turn', () => {
    const views = [0, 45, 90, 135].map((heading) => computeView({ me, stations: [far], selected: 0, heading })!)
    for (const v of views) {
      expect(v.k).toBeCloseTo(views[0].k)
      for (const p of [me, far]) {
        const [x, y] = screenOf(v)(...project(p))
        expect(x).toBeGreaterThanOrEqual(0)
        expect(x).toBeLessThanOrEqual(MAP_W)
        expect(y).toBeGreaterThanOrEqual(0)
        expect(y).toBeLessThanOrEqual(MAP_W)
      }
    }
  })

  it('keeps a minimum span when the stop is right next to you', () => {
    const v = computeView({ me, stations: [near], selected: 0 })!
    expect(v.mpp * 144).toBeGreaterThan(250)
    expect(v.z).toBe(16)
    expect(v.tiles.length).toBeLessThanOrEqual(4)
  })

  it('fits you and a distant stop into the frame', () => {
    const v = computeView({ me, stations: [far], selected: 0 })!
    for (const p of [me, far]) {
      const [x, y] = project(p)
      const cx = (x - v.cx) * v.k + 72
      const cy = (y - v.cy) * v.k + 72
      expect(cx).toBeGreaterThanOrEqual(0)
      expect(cy).toBeGreaterThanOrEqual(0)
      expect(cx).toBeLessThanOrEqual(144)
      expect(cy).toBeLessThanOrEqual(144)
    }
    expect(v.tiles.length).toBeLessThanOrEqual(4)
  })

  it('computes direction and scale', () => {
    expect(compass(me, far)).toBe('N')
    expect(compass(far, me)).toBe('S')
    expect(compass(me, { lat: 47.3782, lng: 8.55 })).toBe('E')
    expect(scaleBar(2)).toBe(100)
    expect(metresPerPx(0)).toBeCloseTo(2.39, 1)
  })
})

describe('platform boxes', () => {
  it('pushes overlapping boxes apart and leaves separate ones alone', () => {
    const boxes = [
      { x: 50, y: 50, w: 15 },
      { x: 54, y: 46, w: 15 },
      { x: 120, y: 120, w: 15 },
    ]
    spreadApart(boxes)
    const [a, b, c] = boxes
    expect(Math.abs(b.x - a.x) >= 18 || Math.abs(b.y - a.y) >= 18).toBe(true)
    expect(b.x).toBeGreaterThan(a.x) // order kept: B stays east of A
    expect(c).toEqual({ x: 120, y: 120, w: 15 })
  })
})
