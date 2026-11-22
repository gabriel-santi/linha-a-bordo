import type { Dimensions } from './geometry'
import { convertImage, sniffFormat, type ImportedCells } from './image-import'

export type ImportRequest = { file: Blob, grid: Dimensions }
export type ImportResponse = { cells: ImportedCells, source: Dimensions } | { error: 'format' | 'decode' }

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<ImportRequest>) => void) | null
  postMessage: (message: ImportResponse, transfer?: Transferable[]) => void
}

async function convert({ file, grid }: ImportRequest): Promise<ImportResponse> {
  const header = new Uint8Array(await file.slice(0, 12).arrayBuffer())
  if (!sniffFormat(header)) return { error: 'format' }

  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' })
  } catch {
    return { error: 'decode' }
  }
  try {
    const source = { width: bitmap.width, height: bitmap.height }
    // Read the decoded pixels at their own size, so the browser never resamples them.
    const canvas = new OffscreenCanvas(source.width, source.height)
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!
    ctx.drawImage(bitmap, 0, 0)
    const { data } = ctx.getImageData(0, 0, source.width, source.height)
    return { cells: convertImage(data, source, grid), source }
  } catch {
    return { error: 'decode' }
  } finally {
    bitmap.close()
  }
}

scope.onmessage = event => {
  void convert(event.data).then(response => {
    scope.postMessage(response, 'cells' in response ? [response.cells.buffer] : [])
  }, () => scope.postMessage({ error: 'decode' }))
}
