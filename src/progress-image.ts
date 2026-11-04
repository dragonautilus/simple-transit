// Renders the journey line (legs, changes, current-position dot) into a 576 px wide greyscale
// bitmap, split into two image containers because one image container is at most 288 px wide.

import type { Progress, Trip } from './journey'
import { layoutLine, type LineLayout } from './line-layout'
import { hhmm, shortStop, truncate } from './format'

export const LINE_W = 576
export const LINE_H = 70
export const HALF_W = LINE_W / 2

const PAD = 18
const Y = 34
const BRIGHT = '#ffffff'
const DIM = '#6a6a6a'
const FONT = 'bold 15px sans-serif'

interface Node {
  x: number
  name: string
  time: string
  align: CanvasTextAlign
}

function nodes(trip: Trip, layout: LineLayout): Node[] {
  const segs = layout.segments
  if (segs.length === 0) return []
  // A trip starting with a walk is labelled with the first boarding stop, which matters more than
  // the street address you start from (and would sit too close to it for two labels).
  const firstRide = trip.legs[0].kind === 'walk' && trip.legs[1]?.kind === 'ride' ? 1 : 0
  const start = trip.legs[firstRide]
  const out: Node[] = [{ x: segs[0].x0, name: start.from.name, time: hhmm(start.from.time), align: 'left' }]
  trip.legs.forEach((leg, i) => {
    if (i <= firstRide || leg.kind !== 'ride') return
    // Boarding point of a later ride: centre of the transfer wait if there is one
    const wait = segs.find((s) => s.kind === 'wait' && s.legIndex === i)
    const ride = segs.find((s) => s.kind === 'ride' && s.legIndex === i)!
    const x = wait ? (wait.x0 + wait.x1) / 2 : ride.x0
    out.push({ x, name: leg.from.name, time: hhmm(leg.from.time), align: 'center' })
  })
  const last = trip.legs[trip.legs.length - 1]
  out.push({ x: segs[segs.length - 1].x1, name: last.to.name, time: hhmm(last.to.time), align: 'right' })
  return out
}

/** Horizontal space a label at this node may use without reaching its neighbours' labels. */
function roomFor(n: Node, list: Node[]): number {
  const i = list.indexOf(n)
  const prev = list[i - 1]?.x ?? -Infinity
  const next = list[i + 1]?.x ?? Infinity
  // Neighbouring labels share the gap between their nodes
  if (n.align === 'left') return Math.min(LINE_W, (next - n.x) / 2 - 4)
  if (n.align === 'right') return Math.min(LINE_W, (n.x - prev) / 2 - 4)
  return Math.min(n.x - prev, next - n.x) - 8
}

/** Truncate text with an ellipsis until it fits maxWidth; null if not even 3 chars fit. */
function fitText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string | null {
  if (ctx.measureText(text).width <= maxWidth) return text
  for (let n = text.length - 1; n >= 3; n--) {
    const t = truncate(text, n)
    if (ctx.measureText(t).width <= maxWidth) return t
  }
  return null
}

function drawLabels(ctx: CanvasRenderingContext2D, list: Node[]) {
  ctx.font = FONT
  ctx.fillStyle = BRIGHT
  ctx.textAlign = 'left'
  const context = list[0]?.name
  // Ends first so they always get a label, then change points where they fit
  const ordered = [list[0], list[list.length - 1], ...list.slice(1, -1)].filter(Boolean)
  const taken: Record<'top' | 'bottom', [number, number][]> = { top: [], bottom: [] }
  for (const n of ordered) {
    const full = n === list[0] ? n.name : shortStop(n.name, context)
    for (const [label, y, row] of [
      [n.time, Y - 16, 'top'],
      [full, Y + 28, 'bottom'],
    ] as const) {
      const text = fitText(ctx, label, roomFor(n, list))
      if (!text) continue
      const w = ctx.measureText(text).width
      let left = n.align === 'left' ? n.x - 6 : n.align === 'right' ? n.x + 6 - w : n.x - w / 2
      left = Math.min(Math.max(0, left), LINE_W - w)
      const right = left + w
      if (taken[row].some(([a, b]) => left < b + 8 && right > a - 8)) continue
      taken[row].push([left, right])
      ctx.fillText(text, left, y)
    }
  }
}

const layoutFor = (trip: Trip) => layoutLine(trip, PAD, LINE_W - PAD)

/** Pixel x of the position dot; used to skip image updates while the dot hasn't moved. */
export function dotX(trip: Trip, p: Progress): number {
  return layoutFor(trip).xAt(p.time)
}

function strokeLine(ctx: CanvasRenderingContext2D, a: number, b: number, width: number, dash: number[], colour: string) {
  if (b <= a) return
  ctx.strokeStyle = colour
  ctx.lineWidth = width
  ctx.lineCap = 'butt'
  ctx.setLineDash(dash)
  ctx.beginPath()
  ctx.moveTo(a, Y)
  ctx.lineTo(b, Y)
  ctx.stroke()
  ctx.setLineDash([])
}

/** Station marker: a ring, stretched into a capsule when it spans a transfer wait. */
function station(ctx: CanvasRenderingContext2D, x0: number, x1: number, colour: string) {
  const r = 8
  ctx.beginPath()
  ctx.arc(x0, Y, r, Math.PI / 2, (Math.PI * 3) / 2)
  ctx.lineTo(x1, Y - r)
  ctx.arc(x1, Y, r, -Math.PI / 2, Math.PI / 2)
  ctx.closePath()
  ctx.fillStyle = '#000'
  ctx.fill()
  ctx.lineWidth = 3
  ctx.strokeStyle = colour
  ctx.stroke()
}

export function drawProgress(canvas: HTMLCanvasElement, trip: Trip, p: Progress): void {
  canvas.width = LINE_W
  canvas.height = LINE_H
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, LINE_W, LINE_H)
  const layout = layoutFor(trip)
  const segs = layout.segments
  const dot = layout.xAt(p.time)
  const shade = (x: number) => (x <= dot ? BRIGHT : DIM)

  // Track: rides solid, walks dashed; travelled part bright, the rest dim
  for (const s of segs) {
    if (s.kind === 'wait') continue
    const [width, dash] = s.kind === 'ride' ? [6, []] : [3, [4, 4]]
    strokeLine(ctx, s.x0, Math.min(s.x1, dot), width, dash, BRIGHT)
    strokeLine(ctx, Math.max(s.x0, dot), s.x1, width, dash, DIM)
    if (s.kind === 'ride') {
      for (const stop of trip.legs[s.legIndex].stops.slice(1, -1)) {
        const x = layout.xAt(stop.time)
        ctx.fillStyle = shade(x)
        ctx.fillRect(x - 1, Y - 8, 2, 16)
      }
    }
  }

  // Stations: capsules over transfer waits, rings at all other ride/trip ends
  segs.forEach((s, i) => {
    const prev = segs[i - 1]
    const next = segs[i + 1]
    if (s.kind === 'wait') return station(ctx, s.x0, s.x1, shade(s.x0))
    if ((s.kind === 'ride' || !prev) && prev?.kind !== 'wait') station(ctx, s.x0, s.x0, shade(s.x0))
    if ((s.kind === 'ride' || !next) && next?.kind !== 'wait') station(ctx, s.x1, s.x1, shade(s.x1))
  })

  // Current position
  ctx.beginPath()
  ctx.arc(dot, Y, 13, 0, Math.PI * 2)
  ctx.fillStyle = '#000'
  ctx.fill()
  ctx.beginPath()
  ctx.arc(dot, Y, 10, 0, Math.PI * 2)
  ctx.fillStyle = BRIGHT
  ctx.fill()
  if (p.source === 'gps') {
    ctx.beginPath()
    ctx.arc(dot, Y, 15, 0, Math.PI * 2)
    ctx.lineWidth = 1.5
    ctx.strokeStyle = BRIGHT
    ctx.stroke()
  }

  drawLabels(ctx, nodes(trip, layout))
}

async function sliceToPng(src: HTMLCanvasElement, x: number): Promise<number[]> {
  const part = document.createElement('canvas')
  part.width = HALF_W
  part.height = LINE_H
  part.getContext('2d')!.drawImage(src, x, 0, HALF_W, LINE_H, 0, 0, HALF_W, LINE_H)
  const blob = await new Promise<Blob>((resolve, reject) =>
    part.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png'),
  )
  return Array.from(new Uint8Array(await blob.arrayBuffer()))
}

/** PNG bytes for the left and right image container. */
export async function renderProgressPngs(trip: Trip, p: Progress): Promise<[number[], number[]]> {
  const canvas = document.createElement('canvas')
  drawProgress(canvas, trip, p)
  return [await sliceToPng(canvas, 0), await sliceToPng(canvas, HALF_W)]
}
