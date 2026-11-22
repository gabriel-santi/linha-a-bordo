import type { Dimensions } from './geometry'

export type Layer<Ink> = {
  id: string
  visible: boolean
  opacity: number
  cells: Ink[]
}

// Layers are stored from bottom to top.
export type Drawing<Ink> = Dimensions & { layers: Layer<Ink>[], activeLayerId: string }

export function newLayer<Ink>(dimensions: Dimensions, empty: Ink): Layer<Ink> {
  return {
    id: crypto.randomUUID(),
    visible: true,
    opacity: 100,
    cells: Array<Ink>(dimensions.width * dimensions.height).fill(empty),
  }
}

export function newDrawing<Ink>(dimensions: Dimensions, empty: Ink): Drawing<Ink> {
  const layer = newLayer(dimensions, empty)
  return { ...dimensions, layers: [layer], activeLayerId: layer.id }
}

export function resizeDrawing<Ink>(drawing: Drawing<Ink>, dimensions: Dimensions, empty: Ink): Drawing<Ink> {
  const width = Math.min(drawing.width, dimensions.width)
  const height = Math.min(drawing.height, dimensions.height)
  const layers = drawing.layers.map(layer => {
    const cells = Array<Ink>(dimensions.width * dimensions.height).fill(empty)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        cells[y * dimensions.width + x] = layer.cells[y * drawing.width + x]
      }
    }
    return { ...layer, cells }
  })
  return { ...dimensions, layers, activeLayerId: drawing.activeLayerId }
}
