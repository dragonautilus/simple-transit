import { describe, expect, it } from 'vitest'
// @ts-expect-error Node types are not installed; vitest runs this file in Node
import { readFileSync } from 'node:fs'
import { compass, computeView, metresPerPx, project, scaleBar } from './board-map'
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
