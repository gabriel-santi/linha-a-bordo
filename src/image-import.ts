import type { Dimensions } from './geometry'
import { palette } from './palette'

export type Placement = Dimensions & { left: number, top: number }

// The cell index of each palette color, or -1 for an empty cell.
export type ImportedCells = Int8Array

export type ImportFormat = 'png' | 'jpeg' | 'webp'

export function sniffFormat(header: Uint8Array): ImportFormat | undefined {
  const starts = (bytes: number[], offset = 0) => bytes.every((byte, index) => header[offset + index] === byte)
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png'
  if (starts([0xff, 0xd8, 0xff])) return 'jpeg'
  if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return 'webp'
}

// Fit the whole image inside the grid, keeping its proportion. The limiting axis receives the full
// grid size; the other axis is rounded to the nearest integer (half up) and kept between 1 and the
// grid size. The leftover is split with the odd cell going to the right or bottom.
export function fitImage(source: Dimensions, grid: Dimensions): Placement {
  let width = grid.width
  let height = grid.height
  if (source.width * grid.height >= source.height * grid.width) {
    height = Math.floor((2 * source.height * grid.width + source.width) / (2 * source.width))
  } else {
    width = Math.floor((2 * source.width * grid.height + source.height) / (2 * source.height))
  }
  width = Math.min(grid.width, Math.max(1, width))
  height = Math.min(grid.height, Math.max(1, height))
  return { width, height, left: Math.floor((grid.width - width) / 2), top: Math.floor((grid.height - height) / 2) }
}

// Overlap between destination cell j, covering [j * source, (j + 1) * source), and source pixel i,
// covering [i * target, (i + 1) * target), in integer coordinates scaled by both lengths.
function axisWeights(source: number, target: number) {
  const starts = new Int32Array(target)
  const weights: Float64Array[] = []
  for (let j = 0; j < target; j++) {
    const from = j * source
    const to = from + source
    const first = Math.floor(from / target)
    const last = Math.ceil(to / target) - 1
    const row = new Float64Array(last - first + 1)
    for (let i = first; i <= last; i++) row[i - first] = Math.min(to, (i + 1) * target) - Math.max(from, i * target)
    starts[j] = first
    weights.push(row)
  }
  return { starts, weights }
}

// Area average weighted by the exact fractional coverage of each source pixel. Every pixel is first
// combined with white: c * a + 255 * (255 - a). The sums stay as exact integers over the common
// denominator 255 * width * height of the source; a cell is empty only if all of its pixels are
// fully transparent.
export function areaAverage(rgba: Uint8ClampedArray | Uint8Array, source: Dimensions, target: Dimensions) {
  const { width: sw, height: sh } = source
  const { width: tw, height: th } = target
  const horizontal = axisWeights(sw, tw)
  const vertical = axisWeights(sh, th)
  const rows = new Float64Array(sh * tw * 4)
  for (let y = 0; y < sh; y++) {
    for (let j = 0; j < tw; j++) {
      const first = horizontal.starts[j]
      const weights = horizontal.weights[j]
      let r = 0, g = 0, b = 0, alpha = 0
      for (let k = 0; k < weights.length; k++) {
        const p = 4 * (y * sw + first + k)
        const a = rgba[p + 3]
        const w = weights[k]
        const paper = 255 * (255 - a)
        r += w * (rgba[p] * a + paper)
        g += w * (rgba[p + 1] * a + paper)
        b += w * (rgba[p + 2] * a + paper)
        alpha += w * a
      }
      const o = 4 * (y * tw + j)
      rows[o] = r
      rows[o + 1] = g
      rows[o + 2] = b
      rows[o + 3] = alpha
    }
  }

  const sums = new Float64Array(tw * th * 4)
  for (let i = 0; i < th; i++) {
    const first = vertical.starts[i]
    const weights = vertical.weights[i]
    for (let k = 0; k < weights.length; k++) {
      const w = weights[k]
      const from = 4 * (first + k) * tw
      const to = 4 * i * tw
      for (let c = 0; c < 4 * tw; c++) sums[to + c] += w * rows[from + c]
    }
  }
  return { sums, denominator: 255 * sw * sh }
}

const inks = palette.map(([, hex]) => [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16)))

// Nearest palette color by squared Euclidean distance in the encoded RGB channels; on a tie the
// earlier palette color wins. Comparing d(c) < d(best) through
// sum (best - c) * (2N - (c + best) * D) < 0 keeps the comparison exact on the integer sums N / D.
export function nearestInk(sums: Float64Array, offset: number, denominator: number) {
  const safe = 3 * 255 * 510 * denominator <= Number.MAX_SAFE_INTEGER
  let best = 0
  for (let candidate = 1; candidate < inks.length; candidate++) {
    const p = inks[best]
    const q = inks[candidate]
    let closer: boolean
    if (safe) {
      let s = 0
      for (let c = 0; c < 3; c++) s += (p[c] - q[c]) * (2 * sums[offset + c] - (p[c] + q[c]) * denominator)
      closer = s < 0
    } else {
      let s = 0n
      const d = BigInt(denominator)
      for (let c = 0; c < 3; c++) s += BigInt(p[c] - q[c]) * (2n * BigInt(sums[offset + c]) - BigInt(p[c] + q[c]) * d)
      closer = s < 0n
    }
    if (closer) best = candidate
  }
  return best
}

export function convertImage(rgba: Uint8ClampedArray | Uint8Array, source: Dimensions, grid: Dimensions): ImportedCells {
  const placement = fitImage(source, grid)
  const { sums, denominator } = areaAverage(rgba, source, placement)
  const cells = new Int8Array(grid.width * grid.height).fill(-1)
  for (let y = 0; y < placement.height; y++) {
    for (let x = 0; x < placement.width; x++) {
      const offset = 4 * (y * placement.width + x)
      if (sums[offset + 3] === 0) continue
      cells[(placement.top + y) * grid.width + placement.left + x] = nearestInk(sums, offset, denominator)
    }
  }
  return cells
}
