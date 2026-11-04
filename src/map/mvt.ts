// Minimal Mapbox Vector Tile decoder: reads line geometries (and their "kind") from selected
// layers. Spec: https://github.com/mapbox/vector-tile-spec/tree/master/2.1

export interface TileLine {
  layer: string
  kind: string
  /** Flat [x0, y0, x1, y1, …] in tile units (0…extent). */
  points: number[]
}

export interface DecodedTile {
  extent: number
  lines: TileLine[]
}

class Pbf {
  pos: number
  constructor(
    private buf: Uint8Array,
    start = 0,
    readonly end = buf.length,
  ) {
    this.pos = start
  }

  eof() {
    return this.pos >= this.end
  }

  varint(): number {
    let result = 0
    let shift = 0
    let b: number
    do {
      b = this.buf[this.pos++]
      result += (b & 0x7f) * 2 ** shift
      shift += 7
    } while (b & 0x80 && shift < 64)
    return result
  }

  /** [start, end) of a length-delimited field. */
  slice(): [number, number] {
    const len = this.varint()
    const start = this.pos
    this.pos += len
    return [start, this.pos]
  }

  skip(wire: number) {
    if (wire === 0) this.varint()
    else if (wire === 1) this.pos += 8
    else if (wire === 2) this.slice()
    else if (wire === 5) this.pos += 4
    else throw new Error(`unsupported wire type ${wire}`)
  }

  sub([start, end]: [number, number]) {
    return new Pbf(this.buf, start, end)
  }

  text([start, end]: [number, number]) {
    return new TextDecoder().decode(this.buf.subarray(start, end))
  }
}

const zigzag = (n: number) => (n % 2 === 1 ? -(n + 1) / 2 : n / 2)

const GEOM_LINESTRING = 2
const GEOM_POLYGON = 3

function decodeGeometry(cmds: number[], out: (points: number[]) => void) {
  let x = 0
  let y = 0
  let current: number[] = []
  for (let i = 0; i < cmds.length; ) {
    const cmd = cmds[i] & 0x7
    const count = cmds[i] >> 3
    i++
    if (cmd === 7) {
      // ClosePath: back to the ring's first point
      if (current.length >= 2) current.push(current[0], current[1])
      continue
    }
    for (let c = 0; c < count && i + 1 < cmds.length; c++) {
      x += zigzag(cmds[i++])
      y += zigzag(cmds[i++])
      if (cmd === 1) {
        if (current.length >= 4) out(current)
        current = [x, y]
      } else {
        current.push(x, y)
      }
    }
  }
  if (current.length >= 4) out(current)
}

/** Decode lines (linestrings and polygon outlines) from the given layers. */
export function decodeTile(buf: Uint8Array, layers: string[]): DecodedTile {
  const tile = new Pbf(buf)
  const wanted = new Set(layers)
  const lines: TileLine[] = []
  let extent = 4096
  while (!tile.eof()) {
    const tag = tile.varint()
    if (tag >> 3 !== 3 || (tag & 7) !== 2) {
      tile.skip(tag & 7)
      continue
    }
    const layer = tile.sub(tile.slice())
    let name = ''
    const keys: string[] = []
    const values: string[] = []
    const features: [number, number][] = []
    while (!layer.eof()) {
      const t = layer.varint()
      const field = t >> 3
      if (field === 1) name = layer.text(layer.slice())
      else if (field === 2) features.push(layer.slice())
      else if (field === 3) keys.push(layer.text(layer.slice()))
      else if (field === 4) {
        const v = layer.sub(layer.slice())
        let value = ''
        while (!v.eof()) {
          const vt = v.varint()
          if (vt >> 3 === 1) value = v.text(v.slice())
          else v.skip(vt & 7)
        }
        values.push(value)
      } else if (field === 5) extent = layer.varint()
      else layer.skip(t & 7)
    }
    if (!wanted.has(name)) continue
    const kindKey = keys.indexOf('kind')
    for (const range of features) {
      const f = layer.sub(range)
      let type = 0
      let kind = ''
      let geometry: number[] = []
      while (!f.eof()) {
        const t = f.varint()
        const field = t >> 3
        if (field === 2) {
          const tags = f.sub(f.slice())
          while (!tags.eof()) {
            const k = tags.varint()
            const v = tags.varint()
            if (k === kindKey) kind = values[v] ?? ''
          }
        } else if (field === 3) type = f.varint()
        else if (field === 4) {
          const g = f.sub(f.slice())
          geometry = []
          while (!g.eof()) geometry.push(g.varint())
        } else f.skip(t & 7)
      }
      if (type !== GEOM_LINESTRING && type !== GEOM_POLYGON) continue
      decodeGeometry(geometry, (points) => lines.push({ layer: name, kind, points }))
    }
  }
  return { extent, lines }
}
