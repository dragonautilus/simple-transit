// Small street map for the departure board: your position, the selected stop and the other nearby
// stops on top of OpenStreetMap streets. Streets come from the Transitous vector tiles (MOTIS);
// when they can't be loaded the map still shows the stops and you, just without streets.

import { TRANSITOUS_BASE } from '../networks/transitous'
import { canvasToPng } from '../canvas'
import { httpGet } from '../http'
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
  /** Platforms of the selected stop that the shown departures leave from, labelled like the
   *  board rows; only when they are in different places (both sides of a street). */
  platforms?: (MapPoint & { label: string })[]
  /** e.g. "2/6": which stop of the board the map shows, same as in the board header. */
  label?: string
  /** Direction you face (° clockwise from north): the map is turned so it points up. */
  heading?: number | null
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
  /** Map rotation (radians): the heading that points up, 0 = north up. */
  rot: number
}

const MARGIN = 20
const MIN_SPAN_M = 260
const MAX_SPAN_M = 3000

/** View that keeps you and the selected stop in frame, centred between both. Turned maps are
 *  framed by distance from the centre, so turning around doesn't change the zoom. */
export function computeView(input: MapInput): View | null {
  const station = input.stations[input.selected]
  const focus = [input.me, ...(input.platforms?.length ? input.platforms : [station])].filter((p): p is MapPoint => !!p)
  if (focus.length === 0) return null
  const pts = focus.map(project)
  const xs = pts.map((p) => p[0])
  const ys = pts.map((p) => p[1])
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2
  const m16 = metresPerPx(focus[0].lat)
  const turned = input.heading != null
  const spanPx = turned
    ? 2 * Math.max(...pts.map(([x, y]) => Math.hypot(x - cx, y - cy)))
    : Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys))
  const spanM = Math.min(MAX_SPAN_M, Math.max(MIN_SPAN_M, (spanPx * m16 * MAP_W) / (MAP_W - 2 * MARGIN)))
  const k = (MAP_W * m16) / spanM
  // A turned map shows the corners of a larger square, up to its diagonal
  const cover = turned ? MAP_W * Math.SQRT2 : MAP_W
  // Coarser tiles when zoomed out, so at most 2×2 tiles cover the map
  const z = TILE * k >= cover ? 16 : TILE * 2 * k >= cover ? 15 : 14
  const scale = 2 ** (16 - z)
  const half = cover / 2 / k
  const tx0 = Math.floor((cx - half) / scale / TILE)
  const tx1 = Math.floor((cx + half) / scale / TILE)
  const ty0 = Math.floor((cy - half) / scale / TILE)
  const ty1 = Math.floor((cy + half) / scale / TILE)
  const tiles: [number, number][] = []
  for (let x = tx0; x <= tx1; x++) for (let y = ty0; y <= ty1; y++) tiles.push([x, y])
  return { cx, cy, k, mpp: m16 / k, z, tiles, rot: turned ? ((input.heading! % 360) * Math.PI) / 180 : 0 }
}

/** Zoom-16 world pixel → canvas pixel, turned so the heading points up. */
export function screenOf(view: View): (wx: number, wy: number) => [number, number] {
  const cos = Math.cos(-view.rot)
  const sin = Math.sin(-view.rot)
  return (wx, wy) => {
    const dx = (wx - view.cx) * view.k
    const dy = (wy - view.cy) * view.k
    return [dx * cos - dy * sin + MAP_W / 2, dx * sin + dy * cos + MAP_H / 2]
  }
}

// ---------- Tiles ----------

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

/** Minor ways first, so main roads end up on top. */
const DRAW_ORDER = Object.keys(STREET_STYLE).reverse()

interface Tile {
  extent: number
  /** Point lists per street kind; kinds the map doesn't draw (footways…) are dropped. */
  byKind: Map<string, number[][]>
}

function toTile(decoded: DecodedTile): Tile {
  const byKind = new Map<string, number[][]>()
  for (const line of decoded.lines) {
    if (!STREET_STYLE[line.kind]) continue
    let list = byKind.get(line.kind)
    if (!list) byKind.set(line.kind, (list = []))
    list.push(line.points)
  }
  return { extent: decoded.extent, byKind }
}

const cache = new Map<string, Promise<Tile | null>>()
const CACHE_MAX = 24

function loadTile(z: number, x: number, y: number): Promise<Tile | null> {
  const key = `${z}/${x}/${y}`
  let p = cache.get(key)
  if (!p) {
    p = httpGet(`${TRANSITOUS_BASE}/tiles/${key}.mvt`, 8000)
      .then(async (res) => toTile(decodeTile(new Uint8Array(await res.arrayBuffer()), ['streets'])))
      .catch(() => null)
    void p.then((t) => t || cache.delete(key)) // failed tiles are retried on the next render
    cache.set(key, p)
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!)
  }
  return p
}

// ---------- Drawing ----------

type Ctx = CanvasRenderingContext2D
type ToCanvas = (p: MapPoint) => [number, number]
const WHITE = '#ffffff'
const LABEL = '#c0c0c0'

function drawStreets(ctx: Ctx, view: View, tiles: (Tile | null)[]) {
  const scale = 2 ** (16 - view.z)
  const screen = screenOf(view)
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  for (const kind of DRAW_ORDER) {
    const [width, colour, dash] = STREET_STYLE[kind]
    ctx.strokeStyle = colour
    ctx.lineWidth = width
    ctx.setLineDash(dash ?? [])
    ctx.beginPath()
    tiles.forEach((tile, i) => {
      if (!tile) return
      const [tx, ty] = view.tiles[i]
      const f = (TILE * scale) / tile.extent
      const ox = tx * TILE * scale
      const oy = ty * TILE * scale
      for (const points of tile.byKind.get(kind) ?? []) {
        for (let j = 0; j < points.length; j += 2) {
          const [px, py] = screen(ox + points[j] * f, oy + points[j + 1] * f)
          if (j === 0) ctx.moveTo(px, py)
          else ctx.lineTo(px, py)
        }
      }
    })
    ctx.stroke()
  }
  ctx.setLineDash([])
}

function drawOtherStops(ctx: Ctx, input: MapInput, at: ToCanvas) {
  input.stations.forEach((s, i) => {
    if (i === input.selected) return
    const [x, y] = at(s)
    ctx.beginPath()
    ctx.arc(x, y, 4, 0, Math.PI * 2)
    ctx.fillStyle = '#000'
    ctx.fill()
    ctx.lineWidth = 2
    ctx.strokeStyle = '#a0a0a0'
    ctx.stroke()
  })
}

function drawWayToStop(ctx: Ctx, me: MapPoint, stop: MapPoint, at: ToCanvas) {
  const [ax, ay] = at(me)
  const [bx, by] = at(stop)
  ctx.setLineDash([2, 3])
  ctx.lineWidth = 1.5
  ctx.strokeStyle = WHITE
  ctx.beginPath()
  ctx.moveTo(ax, ay)
  ctx.lineTo(bx, by)
  ctx.stroke()
  ctx.setLineDash([])
}

/** Hollow, so your dot stays visible inside it when you stand at the stop. */
function drawSelectedStop(ctx: Ctx, stop: MapPoint, at: ToCanvas) {
  const [x, y] = at(stop)
  ctx.fillStyle = '#000'
  ctx.fillRect(x - 11, y - 11, 22, 22)
  ctx.lineWidth = 3
  ctx.strokeStyle = WHITE
  ctx.strokeRect(x - 8.5, y - 8.5, 17, 17)
}

const BOX_H = 15
const BOX_GAP = 3

/** Moves overlapping boxes apart along the line between them, so every label stays readable
 *  (a few pixels off is fine; the platforms of a narrow street are only metres apart). */
export function spreadApart(boxes: { x: number; y: number; w: number }[]): void {
  for (let round = 0; round < 20; round++) {
    let moved = false
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]
        const b = boxes[j]
        const overlapX = (a.w + b.w) / 2 + BOX_GAP - Math.abs(b.x - a.x)
        const overlapY = BOX_H + BOX_GAP - Math.abs(b.y - a.y)
        if (overlapX <= 0 || overlapY <= 0) continue
        // Separate along the axis that needs less movement; same spot: side by side
        const alongX = overlapX <= overlapY
        const sign = alongX ? Math.sign(b.x - a.x) || 1 : Math.sign(b.y - a.y) || 1
        const d = ((alongX ? overlapX : overlapY) / 2) * sign
        if (alongX) {
          a.x -= d
          b.x += d
        } else {
          a.y -= d
          b.y += d
        }
        moved = true
      }
    }
    if (!moved) return
  }
}

/** One labelled box per platform, with the label the board rows show for its departures. */
function drawPlatforms(ctx: Ctx, platforms: NonNullable<MapInput['platforms']>, at: ToCanvas) {
  ctx.font = 'bold 11px sans-serif'
  const boxes = platforms.map((p) => {
    const [x, y] = at(p)
    const w = Math.max(15, ctx.measureText(p.label).width + 6)
    return { x, y, w, label: p.label }
  })
  spreadApart(boxes)
  // All backings first, so boxes that overlap keep their outlines
  ctx.fillStyle = '#000'
  for (const b of boxes) ctx.fillRect(b.x - b.w / 2 - 1.5, b.y - BOX_H / 2 - 1.5, b.w + 3, BOX_H + 3)
  ctx.lineWidth = 2
  ctx.strokeStyle = WHITE
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  for (const b of boxes) {
    ctx.strokeRect(b.x - b.w / 2, b.y - BOX_H / 2, b.w, BOX_H)
    ctx.fillStyle = WHITE
    ctx.fillText(b.label, b.x, b.y + 0.5)
  }
  ctx.textBaseline = 'alphabetic'
}

/** The platform you reach first, for the walking line. */
function nearest(me: MapPoint, points: MapPoint[]): MapPoint {
  const d = (p: MapPoint) => (p.lat - me.lat) ** 2 + ((p.lng - me.lng) * Math.cos((me.lat * Math.PI) / 180)) ** 2
  return points.reduce((a, b) => (d(b) < d(a) ? b : a))
}

/** You: a dot, or on a turned map an arrow pointing up, the way you face. */
function drawMe(ctx: Ctx, me: NonNullable<MapInput['me']>, view: View, at: ToCanvas, facing: boolean) {
  const [x, y] = at(me)
  const accuracyPx = (me.accuracy ?? 0) / view.mpp
  if (accuracyPx > 9) {
    ctx.beginPath()
    ctx.arc(x, y, Math.min(accuracyPx, MAP_W), 0, Math.PI * 2)
    ctx.lineWidth = 1
    ctx.strokeStyle = '#6a6a6a'
    ctx.stroke()
  }
  if (facing) {
    ctx.beginPath()
    ctx.moveTo(x, y - 8)
    ctx.lineTo(x + 6, y + 6)
    ctx.lineTo(x, y + 3)
    ctx.lineTo(x - 6, y + 6)
    ctx.closePath()
    ctx.lineJoin = 'round'
    ctx.lineWidth = 4
    ctx.strokeStyle = '#000'
    ctx.stroke()
    ctx.fillStyle = WHITE
    ctx.fill()
    return
  }
  for (const [r, colour] of [[6.5, '#000'], [4.5, WHITE]] as const) {
    ctx.beginPath()
    ctx.arc(x, y, r, 0, Math.PI * 2)
    ctx.fillStyle = colour
    ctx.fill()
  }
}

/** Compass needle in the top left corner: the white half points north. */
function drawNorth(ctx: Ctx, rot: number) {
  const cx = 12
  const cy = 12
  // North (0, -1) turned like the map
  const nx = Math.sin(-rot)
  const ny = -Math.cos(-rot)
  ctx.beginPath()
  ctx.arc(cx, cy, 10, 0, Math.PI * 2)
  ctx.fillStyle = '#000'
  ctx.fill()
  ctx.lineWidth = 1
  ctx.strokeStyle = '#6a6a6a'
  ctx.stroke()
  for (const [dir, colour] of [[1, WHITE], [-1, '#6a6a6a']] as const) {
    ctx.beginPath()
    ctx.moveTo(cx + nx * 8 * dir, cy + ny * 8 * dir)
    ctx.lineTo(cx - ny * 3, cy + nx * 3)
    ctx.lineTo(cx + ny * 3, cy - nx * 3)
    ctx.closePath()
    ctx.fillStyle = colour
    ctx.fill()
  }
}

/** Text on a black backing, so it stays readable over streets. */
function label(ctx: Ctx, text: string, x: number, y: number, align: CanvasTextAlign, font: string, colour: string) {
  ctx.font = font
  ctx.textAlign = align
  const w = ctx.measureText(text).width
  const left = align === 'right' ? x - w : x
  ctx.fillStyle = '#000'
  ctx.fillRect(left - 2, y - 10, w + 4, 13)
  ctx.fillStyle = colour
  ctx.fillText(text, x, y)
}

function drawScaleBar(ctx: Ctx, view: View) {
  const metres = scaleBar(view.mpp)
  const len = metres / view.mpp
  ctx.fillStyle = '#000'
  ctx.fillRect(2, MAP_H - 16, len + 8, 14)
  ctx.strokeStyle = LABEL
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(5, MAP_H - 9)
  ctx.lineTo(5, MAP_H - 5)
  ctx.lineTo(5 + len, MAP_H - 5)
  ctx.lineTo(5 + len, MAP_H - 9)
  ctx.stroke()
  label(ctx, metres >= 1000 ? `${metres / 1000} km` : `${metres} m`, 9 + len, MAP_H - 4, 'left', 'bold 11px sans-serif', LABEL)
}

export async function drawMap(canvas: HTMLCanvasElement, input: MapInput): Promise<void> {
  canvas.width = MAP_W
  canvas.height = MAP_H
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, MAP_W, MAP_H)
  const view = computeView(input)
  if (!view) return
  const screen = screenOf(view)
  const at: ToCanvas = (p) => screen(...project(p))

  drawStreets(ctx, view, await Promise.all(view.tiles.map(([x, y]) => loadTile(view.z, x, y))))
  drawOtherStops(ctx, input, at)
  const stop = input.stations[input.selected]
  const platforms = stop && input.platforms?.length ? input.platforms : null
  if (stop && input.me) drawWayToStop(ctx, input.me, platforms ? nearest(input.me, platforms) : stop, at)
  if (platforms) drawPlatforms(ctx, platforms, at)
  else if (stop) drawSelectedStop(ctx, stop, at)
  const turned = input.heading != null
  if (input.me) drawMe(ctx, input.me, view, at, turned)

  if (turned) drawNorth(ctx, view.rot)
  else label(ctx, 'N↑', 4, 12, 'left', 'bold 11px sans-serif', LABEL)
  // Required OpenStreetMap attribution at the map itself
  label(ctx, '© OSM', MAP_W - 4, 11, 'right', 'bold 9px sans-serif', '#9a9a9a')
  drawScaleBar(ctx, view)
  if (input.label) label(ctx, input.label, MAP_W - 4, MAP_H - 5, 'right', 'bold 12px sans-serif', WHITE)

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
  return canvasToPng(canvas)
}
