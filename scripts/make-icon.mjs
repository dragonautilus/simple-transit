// Generates icon.png for Even Hub: 24x24, opaque #F4F4F4 on transparent, lit pixels in 2x2
// blocks. Drawn on a 12x12 grid and scaled 2x so the block rule always holds.
// Motif: the in-transit journey line - travelled part solid, position dot, rest dashed, stops.
import { writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'

const GRID = [
  '............',
  '............',
  '............',
  '.....##.....',
  '#...####...#',
  '##########.#',
  '##########.#',
  '#...####...#',
  '.....##.....',
  '............',
  '............',
  '............',
]

const SIZE = 24
const LIT = [0xf4, 0xf4, 0xf4, 0xff]

function crc32(buf) {
  let c, crc = 0xffffffff
  for (const b of buf) {
    c = (crc ^ b) & 0xff
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crc = (crc >>> 8) ^ c
  }
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

const raw = Buffer.alloc(SIZE * (1 + SIZE * 4))
for (let y = 0; y < SIZE; y++) {
  const row = y * (1 + SIZE * 4)
  raw[row] = 0 // filter: none
  for (let x = 0; x < SIZE; x++) {
    const lit = GRID[y >> 1][x >> 1] === '#'
    if (lit) raw.set(LIT, row + 1 + x * 4)
  }
}

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(SIZE, 0)
ihdr.writeUInt32BE(SIZE, 4)
ihdr[8] = 8 // bit depth
ihdr[9] = 6 // RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw)),
  chunk('IEND', Buffer.alloc(0)),
])
writeFileSync(process.argv[2] ?? 'icon.png', png)
console.log(GRID.join('\n').replaceAll('.', '  ').replaceAll('#', '██'))
