// Small street map for the departure board: your position, the selected stop and the other nearby
// stops on top of OpenStreetMap streets. Streets come from the Transitous vector tiles (MOTIS);
// when they can't be loaded the map still shows the stops and you, just without streets.

import { TRANSITOUS_BASE } from '../networks/transitous'
import { decodeTile, type DecodedTile } from './mvt'

export const MAP_W = 144
export const MAP_H = 144

export interface MapPoint {
  lat: number
  lng: number
}

export interface MapInput {
  me: (MapPoint & { accuracy?: number }) | null
  stations: MapPoint[]
  selected: number
  /** e.g. "2/6": which stop of the board the map shows, same as in the board header. */
  label?: string
}

// ---------- Web Mercator ----------

const TILE = 256

/** World pixel coordinates at zoom 16. */
export function project(p: MapPoint): [number, number] {
  const size = TILE * 2 ** 16
  const sin = Math.sin((p.lat * Math.PI) / 180)
  const x = ((p.lng + 180) / 360) * size
  const y = (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * size
  return [x, y]
}

/** Metres per zoom-16 world pixel at a latitude. */
export const metresPerPx = (lat: number) => (156_543.034 * Math.cos((lat * Math.PI) / 180)) / 2 ** 16

export interface View {
  /** Zoom-16 world pixel at the canvas centre. */
  cx: number
  cy: number
  /** Canvas pixels per zoom-16 world pixel. */
  k: number
  /** Metres per canvas pixel. */
  mpp: number
  /** Tile zoom to load and the tiles covering the view. */
  z: number
  tiles: [number, number][]
}

const MARGIN = 20
const MIN_SPAN_M = 260
const MAX_SPAN_M = 3000

/** View that keeps you and the selected stop in frame, centred between both. */
export function computeView(input: MapInput): View | null {
  const station = input.stations[input.selected]
  const focus = [input.me, station].filter((p): p is MapPoint => !!p)
  if (focus.length === 0) return null
  const pts = focus.map(project)
  const xs = pts.map((p) => p[0])
  const ys = pts.map((p) => p[1])
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2
  const m16 = metresPerPx(focus[0].lat)
  const spanPx = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys))
  const spanM = Math.min(MAX_SPAN_M, Math.max(MIN_SPAN_M, (spanPx * m16 * MAP_W) / (MAP_W - 2 * MARGIN)))
  const k = (MAP_W * m16) / spanM
  // Coarser tiles when zoomed out, so at most 2×2 tiles cover the map
  const z = TILE * k >= MAP_W ? 16 : TILE * 2 * k >= MAP_W ? 15 : 14
  const scale = 2 ** (16 - z)
  const half = MAP_W / 2 / k
  const tx0 = Math.floor((cx - half) / scale / TILE)
  const tx1 = Math.floor((cx + half) / scale / TILE)
  const ty0 = Math.floor((cy - half) / scale / TILE)
  const ty1 = Math.floor((cy + half) / scale / TILE)
  const tiles: [number, number][] = []
  for (let x = tx0; x <= tx1; x++) for (let y = ty0; y <= ty1; y++) tiles.push([x, y])
  return { cx, cy, k, mpp: m16 / k, z, tiles }
}

// ---------- Tiles ----------

const cache = new Map<string, Promise<DecodedTile | null>>()
const CACHE_MAX = 24

function loadTile(z: number, x: number, y: number): Promise<DecodedTile | null> {
  const key = `${z}/${x}/${y}`
  let p = cache.get(key)
  if (!p) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 8000)
    p = fetch(`${TRANSITOUS_BASE}/tiles/${key}.mvt`, { signal: ctrl.signal })
      .then(async (res) => (res.ok ? decodeTile(new Uint8Array(await res.arrayBuffer()), ['streets']) : null))
      .catch(() => null)
      .finally(() => clearTimeout(timer))
    // Failed tiles are retried on the next render
    p.then((t) => t || cache.delete(key))
    cache.set(key, p)
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!)
  }
  return p
}

// ---------- Drawing ----------

const STREET_STYLE: Record<string, [width: number, colour: string, dash?: number[]]> = {
  motorway: [3, '#8c8c8c'],
  trunk: [3, '#8c8c8c'],
  primary: [3, '#8c8c8c'],
  secondary: [3, '#7a7a7a'],
  tertiary: [2, '#606060'],
  residential: [2, '#505050'],
  unclassified: [2, '#505050'],
  living_street: [2, '#505050'],
  pedestrian: [2, '#505050'],
  service: [1, '#3a3a3a'],
  rail: [1, '#505050', [3, 3]],
  tram: [1, '#404040', [2, 3]],
}

/** Draw order: thin and minor ways first so main roads stay on top. */
const ORDER = Object.keys(STREET_STYLE).reverse()

export async function drawMap(canvas: HTMLCanvasElement, input: MapInput): Promise<void> {
  canvas.width = MAP_W
  canvas.height = MAP_H
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, MAP_W, MAP_H)
  const view = computeView(input)
  if (!view) return
  const toCanvas = ([x, y]: [number, number]): [number, number] => [
    (x - view.cx) * view.k + MAP_W / 2,
    (y - view.cy) * view.k + MAP_H / 2,
  ]

  // Streets
  const tiles = await Promise.all(view.tiles.map(([x, y]) => loadTile(view.z, x, y)))
  const scale = 2 ** (16 - view.z)
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  for (const kind of ORDER) {
    const [width, colour, dash] = STREET_STYLE[kind]
    ctx.strokeStyle = colour
    ctx.lineWidth = width
    ctx.setLineDash(dash ?? [])
    ctx.beginPath()
    tiles.forEach((tile, i) => {
      if (!tile) return
      const [tx, ty] = view.tiles[i]
      const f = (TILE * scale) / tile.extent
      for (const line of tile.lines) {
        if (line.kind !== kind) continue
        for (let j = 0; j < line.points.length; j += 2) {
          const [px, py] = toCanvas([tx * TILE * scale + line.points[j] * f, ty * TILE * scale + line.points[j + 1] * f])
          if (j === 0) ctx.moveTo(px, py)
          else ctx.lineTo(px, py)
        }
      }
    })
    ctx.stroke()
  }
  ctx.setLineDash([])

  // Other nearby stops: small rings
  input.stations.forEach((s, i) => {
    if (i === input.selected) return
    const [x, y] = toCanvas(project(s))
    ctx.beginPath()
    ctx.arc(x, y, 4, 0, Math.PI * 2)
    ctx.fillStyle = '#000'
    ctx.fill()
    ctx.lineWidth = 2
    ctx.strokeStyle = '#a0a0a0'
    ctx.stroke()
  })

  // Selected stop: bright square (like a stop sign), you: bright dot with a ring
  const station = input.stations[input.selected]
  const me = input.me
  if (station && me) {
    const [ax, ay] = toCanvas(project(me))
    const [bx, by] = toCanvas(project(station))
    ctx.setLineDash([2, 3])
    ctx.lineWidth = 1.5
    ctx.strokeStyle = '#ffffff'
    ctx.beginPath()
    ctx.moveTo(ax, ay)
    ctx.lineTo(bx, by)
    ctx.stroke()
    ctx.setLineDash([])
  }
  if (station) {
    // Hollow square, so your dot stays visible inside it when you stand at the stop
    const [x, y] = toCanvas(project(station))
    ctx.fillStyle = '#000'
    ctx.fillRect(x - 11, y - 11, 22, 22)
    ctx.lineWidth = 3
    ctx.strokeStyle = '#ffffff'
    ctx.strokeRect(x - 8.5, y - 8.5, 17, 17)
  }
  if (me) {
    const [x, y] = toCanvas(project(me))
    const acc = (me.accuracy ?? 0) / view.mpp
    if (acc > 9) {
      ctx.beginPath()
      ctx.arc(x, y, Math.min(acc, MAP_W), 0, Math.PI * 2)
      ctx.lineWidth = 1
      ctx.strokeStyle = '#6a6a6a'
      ctx.stroke()
    }
    ctx.beginPath()
    ctx.arc(x, y, 6.5, 0, Math.PI * 2)
    ctx.fillStyle = '#000'
    ctx.fill()
    ctx.beginPath()
    ctx.arc(x, y, 4.5, 0, Math.PI * 2)
    ctx.fillStyle = '#ffffff'
    ctx.fill()
  }

  // North marker and scale bar
  ctx.font = 'bold 11px sans-serif'
  ctx.fillStyle = '#c0c0c0'
  ctx.textAlign = 'right'
  ctx.textAlign = 'left'
  ctx.fillText('N↑', 4, 12)
  const bar = scaleBar(view.mpp)
  const len = bar / view.mpp
  ctx.fillStyle = '#000'
  ctx.fillRect(2, MAP_H - 16, len + 8, 14)
  ctx.strokeStyle = '#c0c0c0'
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(5, MAP_H - 9)
  ctx.lineTo(5, MAP_H - 5)
  ctx.lineTo(5 + len, MAP_H - 5)
  ctx.lineTo(5 + len, MAP_H - 9)
  ctx.stroke()
  ctx.textAlign = 'left'
  ctx.fillStyle = '#c0c0c0'
  ctx.fillText(bar >= 1000 ? `${bar / 1000} km` : `${bar} m`, 9 + len, MAP_H - 4)

  // OpenStreetMap attribution at the map, as the ODbL / OSM guidelines ask
  ctx.font = 'bold 9px sans-serif'
  ctx.textAlign = 'right'
  const osm = '© OSM'
  const w = ctx.measureText(osm).width
  ctx.fillStyle = '#000'
  ctx.fillRect(MAP_W - w - 6, 2, w + 4, 11)
  ctx.fillStyle = '#9a9a9a'
  ctx.fillText(osm, MAP_W - 4, 11)
  ctx.font = 'bold 11px sans-serif'

  // Stop number, bottom right, so map and header can be matched at a glance
  if (input.label) {
    ctx.font = 'bold 12px sans-serif'
    const lw = ctx.measureText(input.label).width
    ctx.fillStyle = '#000'
    ctx.fillRect(MAP_W - lw - 8, MAP_H - 17, lw + 6, 15)
    ctx.fillStyle = '#ffffff'
    ctx.textAlign = 'right'
    ctx.fillText(input.label, MAP_W - 4, MAP_H - 5)
  }

  // Frame
  ctx.strokeStyle = '#4a4a4a'
  ctx.lineWidth = 1
  ctx.strokeRect(0.5, 0.5, MAP_W - 1, MAP_H - 1)
}

/** Round scale bar length (m) that is about a third of the map wide. */
export function scaleBar(mpp: number): number {
  const target = (MAP_W / 3) * mpp
  return [20, 50, 100, 200, 250, 500, 1000, 2000].reduce((best, v) => (Math.abs(v - target) < Math.abs(best - target) ? v : best))
}

// ---------- Text helpers ----------

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']

/** "NE": direction from a to b. */
export function compass(a: MapPoint, b: MapPoint): string {
  const [ax, ay] = project(a)
  const [bx, by] = project(b)
  const deg = (Math.atan2(bx - ax, ay - by) * 180) / Math.PI
  return COMPASS[Math.round(((deg + 360) % 360) / 45) % 8]
}

export async function renderMapPng(input: MapInput): Promise<number[]> {
  const canvas = document.createElement('canvas')
  await drawMap(canvas, input)
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png'),
  )
  return Array.from(new Uint8Array(await blob.arrayBuffer()))
}
