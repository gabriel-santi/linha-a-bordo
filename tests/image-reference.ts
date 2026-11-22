import { crc32, deflateSync } from 'node:zlib'

// Independent references for the image import. They do not import from src/.
export const palette = [
  ['Preto', '#222222'], ['Cinza', '#777777'], ['Branco', '#ffffff'],
  ['Marrom', '#774631'], ['Bege', '#dcc29b'], ['Vermelho', '#c82e37'],
  ['Laranja', '#eb782b'], ['Amarelo', '#f3d344'], ['Verde', '#3b804a'],
  ['Azul', '#3066bd'], ['Roxo', '#773e9d'], ['Rosa', '#df72a3'],
  ['Verde-claro', '#90ce97'], ['Azul-claro', '#8dbbfa'],
] as const
export const hex = Object.fromEntries(palette) as Record<(typeof palette)[number][0], string>
export type Cell = string | null
export type Rgba = [number, number, number, number]
export type Bitmap = { width: number, height: number, data: Uint8Array }

export function channels(color: string): [number, number, number] {
  return [1, 3, 5].map(index => parseInt(color.slice(index, index + 2), 16)) as [number, number, number]
}

export function bitmap(width: number, height: number, pixel: (x: number, y: number) => Rgba): Bitmap {
  const data = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) data.set(pixel(x, y), 4 * (y * width + x))
  }
  return { width, height, data }
}

export const opaque = (color: string): Rgba => [...channels(color), 255]

// Minimal RGBA PNG encoder (color type 6, 8 bits, filter 0) with node:zlib only.
export function encodePng({ width, height, data }: Bitmap) {
  const chunk = (type: string, body: Buffer) => {
    const head = Buffer.alloc(8)
    head.writeUInt32BE(body.length, 0)
    head.write(type, 4, 'latin1')
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])) >>> 0, 0)
    return Buffer.concat([head, body, crc])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.set([8, 6, 0, 0, 0], 8)
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) raw.set(data.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1)
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ])
}

// Proportional fit: compare aspect ratios by cross-multiplication, round the free axis half up
// with integer division and keep it between 1 and the grid.
export function referenceFit(sw: number, sh: number, gw: number, gh: number) {
  const roundHalfUp = (numerator: number, denominator: number) => {
    const remainder = numerator % denominator
    return (numerator - remainder) / denominator + (2 * remainder >= denominator ? 1 : 0)
  }
  const wide = sw * gh >= sh * gw
  const width = Math.max(1, Math.min(gw, wide ? gw : roundHalfUp(sw * gh, sh)))
  const height = Math.max(1, Math.min(gh, wide ? roundHalfUp(sh * gw, sw) : gh))
  return { width, height, left: (gw - width - (gw - width) % 2) / 2, top: (gh - height - (gh - height) % 2) / 2 }
}

// Two-dimensional area average (not separable): every source pixel contributes the area of its
// overlap with the cell in coordinates scaled by the destination size. Colors are composed over
// white with (c * a + 255 * (255 - a)) / 255 before averaging. The nearest color uses BigInt
// squared distances on the exact sums; on ties the first palette color wins.
export function referenceCells({ width: sw, height: sh, data }: Bitmap, gw: number, gh: number): Cell[] {
  const fit = referenceFit(sw, sh, gw, gh)
  const out = Array<Cell>(gw * gh).fill(null)
  const inks = palette.map(([, color]) => channels(color).map(BigInt))
  for (let cy = 0; cy < fit.height; cy++) {
    const y0 = cy * sh, y1 = y0 + sh
    for (let cx = 0; cx < fit.width; cx++) {
      const x0 = cx * sw, x1 = x0 + sw
      const sum = [0, 0, 0]
      let alpha = 0
      let area = 0
      for (let py = Math.floor(y0 / fit.height); py * fit.height < y1; py++) {
        const oy = Math.min(y1, (py + 1) * fit.height) - Math.max(y0, py * fit.height)
        if (oy <= 0) continue
        for (let px = Math.floor(x0 / fit.width); px * fit.width < x1; px++) {
          const ox = Math.min(x1, (px + 1) * fit.width) - Math.max(x0, px * fit.width)
          if (ox <= 0) continue
          const i = 4 * (py * sw + px)
          const a = data[i + 3]
          for (let c = 0; c < 3; c++) sum[c] += ox * oy * (data[i + c] * a + 255 * (255 - a))
          alpha += ox * oy * a
          area += ox * oy
        }
      }
      if (area !== sw * sh) throw new Error('Pesos não somam a área da célula')
      if (alpha === 0) continue
      const scale = BigInt(255 * area)
      let best = -1
      let bestDistance = 0n
      inks.forEach((ink, index) => {
        let distance = 0n
        for (let c = 0; c < 3; c++) {
          const delta = BigInt(sum[c]) - ink[c] * scale
          distance += delta * delta
        }
        if (best < 0 || distance < bestDistance) {
          best = index
          bestDistance = distance
        }
      })
      out[(fit.top + cy) * gw + fit.left + cx] = palette[best][1]
    }
  }
  return out
}

// Composition over a base color with the source-over equation, for opaque destinations.
export function compose(layers: { cells: Cell[], visible: boolean, opacity: number }[], base: string, index: number) {
  let pixel: number[] = channels(base)
  for (const layer of layers) {
    const ink = layer.cells[index]
    if (!layer.visible || layer.opacity === 0 || ink === null) continue
    pixel = channels(ink).map((value, c) => Math.round(value * layer.opacity / 100 + pixel[c] * (1 - layer.opacity / 100)))
  }
  return pixel
}
