/// <reference types="vite/client" />
import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode, type Ref } from 'react'
import { createRoot } from 'react-dom/client'
import { createProject, loadLibrary, openProjects, renameProject, saveProject, selectProject, type Project } from './projects'
import { defaultDimension, isDimension, maxDimension, type Dimensions } from './geometry'
import { newDrawing, newLayer, resizeDrawing, type Drawing, type Layer } from './layers'
import { palette, type Color } from './palette'
import { fitImage } from './image-import'
import type { ImportRequest, ImportResponse } from './import-worker'
import logo from './assets/logo.png'
import './style.css'

const pitch = 16
const empty = '#fffcf6'
const majorLine = '#535e4d'
const fineLine = '#b5b8ab'

const eraserSizes = [1, 3, 5, 9] as const
const hexColor = /^#[0-9a-f]{6}$/i

type Ink = Color | null
type Point = { x: number, y: number }
type Stroke = { layerId: string, ink: Ink, before: Map<number, Ink> }
type Gesture = Stroke & { id: number, point: Point, radius: number, drawing: Drawing<Ink> }
type DrawingChange = { before: Drawing<Ink>, after: Drawing<Ink> }
type DrawingAction = Stroke | DrawingChange

function lineWidth(index: number) {
  return index % 10 === 0 ? 2 : 1
}

function drawGridLines(ctx: CanvasRenderingContext2D, { width, height }: Dimensions, step: number) {
  const { width: pixelsWide, height: pixelsHigh } = ctx.canvas
  // Draw strong lines last so they stay continuous across intersections.
  for (const thickness of [1, 2]) {
    ctx.fillStyle = thickness === 2 ? majorLine : fineLine
    for (let column = 0; column <= width; column++) {
      if ((column === width ? 2 : lineWidth(column)) !== thickness) continue
      ctx.fillRect(Math.min(column * step, pixelsWide - thickness), 0, thickness, pixelsHigh)
    }
    for (let row = 0; row <= height; row++) {
      if ((row === height ? 2 : lineWidth(row)) !== thickness) continue
      ctx.fillRect(0, Math.min(row * step, pixelsHigh - thickness), pixelsWide, thickness)
    }
  }
}

function downloadPng(project: Project<Ink>) {
  const exportPitch = 20
  const canvas = document.createElement('canvas')
  canvas.width = project.width * exportPitch
  canvas.height = project.height * exportPitch
  const ctx = canvas.getContext('2d', { alpha: false })!
  drawLayers(ctx, project, exportPitch, false)
  drawGridLines(ctx, project, exportPitch)

  const link = document.createElement('a')
  const name = Array.from(project.name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')).slice(0, 54).join('').trim()
  link.download = name + '.png'
  link.href = canvas.toDataURL('image/png')
  link.click()
}

function drawInk(ctx: CanvasRenderingContext2D, ink: Color, x: number, y: number, width: number, height: number, outlineWhite: boolean) {
  ctx.fillStyle = ink
  ctx.fillRect(x, y, width, height)
  if (outlineWhite && ink === '#ffffff') {
    ctx.fillStyle = '#8e8a80'
    ctx.fillRect(x, y, width, 2)
    ctx.fillRect(x, y + height - 2, width, 2)
    ctx.fillRect(x, y + 2, 2, height - 4)
    ctx.fillRect(x + width - 2, y + 2, 2, height - 4)
  }
}

function drawLayers(ctx: CanvasRenderingContext2D, drawing: Drawing<Ink>, step: number, editor: boolean) {
  ctx.fillStyle = editor ? empty : '#ffffff'
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height)
  for (const { cells, visible, opacity } of drawing.layers) {
    if (!visible || opacity === 0) continue

    ctx.globalAlpha = opacity / 100
    cells.forEach((ink, index) => {
      if (ink === null) return
      const col = index % drawing.width
      const row = Math.floor(index / drawing.width)
      const left = editor ? lineWidth(col) : 0
      const top = editor ? lineWidth(row) : 0
      drawInk(ctx, ink, col * step + left, row * step + top, step - left, step - top, editor && opacity === 100)
    })
  }
  ctx.globalAlpha = 1
}

function repaintCell(ctx: CanvasRenderingContext2D, drawing: Drawing<Ink>, col: number, row: number) {
  const left = lineWidth(col)
  const top = lineWidth(row)
  const x = col * pitch + left
  const y = row * pitch + top
  const width = pitch - left
  const height = pitch - top
  const index = row * drawing.width + col
  ctx.fillStyle = empty
  ctx.fillRect(x, y, width, height)
  for (const { cells, visible, opacity } of drawing.layers) {
    const ink = cells[index]
    if (ink === null || !visible || opacity === 0) continue
    ctx.globalAlpha = opacity / 100
    drawInk(ctx, ink, x, y, width, height, opacity === 100)
  }
  ctx.globalAlpha = 1
}

// Visit cells in the order the segment crosses their vertical and horizontal boundaries.
function visitSegment(from: Point, to: Point, visit: (col: number, row: number) => void) {
  let col = Math.floor(from.x)
  let row = Math.floor(from.y)
  const endCol = Math.floor(to.x)
  const endRow = Math.floor(to.y)
  const dx = to.x - from.x
  const dy = to.y - from.y
  const stepX = Math.sign(dx)
  const stepY = Math.sign(dy)

  visit(col, row)
  while (col !== endCol || row !== endRow) {
    const nextX = col === endCol ? Infinity : (col + (stepX > 0 ? 1 : 0) - from.x) / dx
    const nextY = row === endRow ? Infinity : (row + (stepY > 0 ? 1 : 0) - from.y) / dy
    if (nextX <= nextY) col += stepX
    if (nextY <= nextX) row += stepY
    visit(col, row)
  }
}

function pointerPoint(event: PointerEvent<HTMLCanvasElement>) {
  const canvas = event.currentTarget
  const { left, top, width, height } = canvas.getBoundingClientRect()
  return {
    x: (event.clientX - left) * canvas.width / (width * pitch),
    y: (event.clientY - top) * canvas.height / (height * pitch),
  }
}

type EditorHandle = { finishEdits: () => void, visibleDrawing: () => Drawing<Ink> }

function Editor({ project, onSave, ref }: {
  project: Project<Ink>
  onSave: (drawing: Drawing<Ink>) => void
  ref: Ref<EditorHandle>
}) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const { width, height, layers, activeLayerId } = project
  const drawing = useRef<Drawing<Ink>>({ width, height, layers, activeLayerId })
  const gesture = useRef<Gesture | null>(null)
  const undo = useRef<DrawingAction[]>([])
  const redo = useRef<DrawingAction[]>([])
  const [resizing, setResizing] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [importing, setImporting] = useState<{ file: File, base: Drawing<Ink> } | null>(null)
  const opacityDrag = useRef<{ pointerId: number, value: number } | null>(null)
  const [previewOpacity, setPreviewOpacity] = useState<number>()
  const layerIndex = layers.findIndex(layer => layer.id === activeLayerId)
  const activeLayer = layers[layerIndex]

  function withLayer(current: Drawing<Ink>, layer: Layer<Ink>): Drawing<Ink> {
    return { ...current, layers: current.layers.map(item => item.id === layer.id ? layer : item) }
  }

  const apply = useCallback((next: Drawing<Ink>) => {
    drawing.current = next
    onSave(next)
  }, [onSave])

  const commit = useCallback((after: Drawing<Ink>) => {
    undo.current.push({ before: drawing.current, after })
    redo.current.length = 0
    apply(after)
  }, [apply])

  function visibleDrawing() {
    const current = gesture.current?.drawing ?? drawing.current
    if (previewOpacity === undefined) return current

    const layer = current.layers.find(item => item.id === current.activeLayerId)!
    return withLayer(current, { ...layer, opacity: previewOpacity })
  }

  useLayoutEffect(() => {
    const shown = visibleDrawing()
    const ctx = canvas.current!.getContext('2d')!
    drawLayers(ctx, shown, pitch, true)
    drawGridLines(ctx, shown, pitch)
  }, [width, height, layers, previewOpacity])

  const changeOpacity = useCallback((value: number) => {
    const current = drawing.current
    const layer = current.layers.find(item => item.id === current.activeLayerId)!
    if (value !== layer.opacity) commit(withLayer(current, { ...layer, opacity: value }))
  }, [commit])

  const finishOpacity = useCallback((cancel = false) => {
    const drag = opacityDrag.current
    if (!drag) return

    opacityDrag.current = null
    setPreviewOpacity(undefined)
    if (!cancel) changeOpacity(drag.value)
  }, [changeOpacity])

  useEffect(() => {
    function finishPointer(event: globalThis.PointerEvent) {
      if (event.pointerId === opacityDrag.current?.pointerId) finishOpacity(event.type === 'pointercancel')
    }
    window.addEventListener('pointerup', finishPointer)
    window.addEventListener('pointercancel', finishPointer)
    return () => {
      window.removeEventListener('pointerup', finishPointer)
      window.removeEventListener('pointercancel', finishPointer)
    }
  }, [finishOpacity])

  const finishStroke = useCallback(() => {
    const active = gesture.current
    if (!active) return

    gesture.current = null
    if (canvas.current?.hasPointerCapture(active.id)) canvas.current.releasePointerCapture(active.id)
    if (active.before.size === 0) return

    undo.current.push({ layerId: active.layerId, ink: active.ink, before: active.before })
    redo.current.length = 0
    apply(active.drawing)
  }, [apply])

  function finishEdits() {
    finishStroke()
    finishOpacity()
  }

  useImperativeHandle(ref, () => ({ finishEdits, visibleDrawing }))

  useEffect(() => {
    function handleHistory(event: KeyboardEvent) {
      if (resizing || deleting || importing || (event.target instanceof HTMLElement && (
        event.target.isContentEditable || event.target.closest('dialog, textarea') ||
        (event.target instanceof HTMLInputElement && !['range', 'checkbox', 'radio'].includes(event.target.type))
      ))) return
      if (!event.ctrlKey || event.shiftKey || event.altKey || event.metaKey) return

      const key = event.key.toLowerCase()
      if (key !== 'z' && key !== 'y') return

      event.preventDefault()
      if (gesture.current) return
      finishOpacity()

      const undoing = key === 'z'
      const source = undoing ? undo.current : redo.current
      const destination = undoing ? redo.current : undo.current
      const action = source.pop()
      if (!action) return

      destination.push(action)
      if ('after' in action) {
        apply(undoing ? action.before : action.after)
        return
      }

      const current = drawing.current
      const layer = current.layers.find(item => item.id === action.layerId)!
      const cells = layer.cells.slice()
      for (const [index, before] of action.before) cells[index] = undoing ? before : action.ink
      apply(withLayer({ ...current, activeLayerId: layer.id }, { ...layer, cells }))
    }

    window.addEventListener('keydown', handleHistory)
    return () => window.removeEventListener('keydown', handleHistory)
  }, [apply, deleting, finishOpacity, importing, resizing])

  function resize(dimensions: Dimensions) {
    setResizing(false)
    const current = drawing.current
    if (current.width === dimensions.width && current.height === dimensions.height) return

    commit(resizeDrawing(current, dimensions, null))
  }

  function selectLayer(id: string) {
    finishEdits()
    const current = drawing.current
    if (id !== current.activeLayerId) apply({ ...current, activeLayerId: id })
  }

  function addLayer() {
    finishEdits()
    const current = drawing.current
    const layer = newLayer<Ink>(current, null)
    commit({ ...current, layers: [...current.layers, layer], activeLayerId: layer.id })
  }

  function moveLayer(direction: number) {
    finishEdits()
    const current = drawing.current
    const next = current.layers.slice()
    const target = layerIndex + direction
    if (target < 0 || target >= next.length) return

    const layer = next[layerIndex]
    next[layerIndex] = next[target]
    next[target] = layer
    commit({ ...current, layers: next })
  }

  function toggleVisibility() {
    finishEdits()
    const current = drawing.current
    const layer = current.layers[layerIndex]
    commit(withLayer(current, { ...layer, visible: !layer.visible }))
  }

  function deleteLayer() {
    setDeleting(false)
    const current = drawing.current
    if (current.layers.length < 2) return

    const next = current.layers.filter(layer => layer.id !== current.activeLayerId)
    commit({ ...current, layers: next, activeLayerId: next[Math.min(layerIndex, next.length - 1)].id })
  }

  function requestDelete() {
    finishEdits()
    const current = drawing.current
    if (current.layers.length < 2) return
    if (current.layers[layerIndex].cells.some(ink => ink !== null)) setDeleting(true)
    else deleteLayer()
  }

  function chooseImage(file: File) {
    finishEdits()
    setImporting({ file, base: drawing.current })
  }

  function confirmImport(base: Drawing<Ink>, cells: Ink[]) {
    setImporting(null)
    const current = drawing.current
    // The conversion belongs to the grid it was made for.
    if (current !== base || cells.length !== current.width * current.height) return

    const layer = { ...newLayer<Ink>(current, null), cells }
    commit({ ...current, layers: [...current.layers, layer], activeLayerId: layer.id })
  }

  function trace(ctx: CanvasRenderingContext2D, active: Gesture, point: Point) {
    const { width, height, layers } = active.drawing
    const cells = layers.find(layer => layer.id === active.layerId)!.cells
    visitSegment(active.point, point, (col, row) => {
      if (col < 0 || col >= width || row < 0 || row >= height) return

      const { radius, ink } = active
      for (let y = Math.max(0, row - radius); y <= Math.min(height - 1, row + radius); y++) {
        for (let x = Math.max(0, col - radius); x <= Math.min(width - 1, col + radius); x++) {
          const index = y * width + x
          const before = cells[index]
          if (before === ink) continue

          active.before.set(index, before)
          cells[index] = ink
          repaintCell(ctx, active.drawing, x, y)
        }
      }
    })
    active.point = point
  }

  function start(event: PointerEvent<HTMLCanvasElement>) {
    if (event.button !== 0 || gesture.current || !activeLayer.visible) return
    finishOpacity()

    const current = drawing.current
    const layer = current.layers[layerIndex]
    const point = pointerPoint(event)
    const radius = ink === null ? (eraserSize - 1) / 2 : 0
    const active = {
      id: event.pointerId, layerId: layer.id, point, ink, radius, before: new Map<number, Ink>(),
      drawing: withLayer(current, { ...layer, cells: layer.cells.slice() }),
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    gesture.current = active
    trace(event.currentTarget.getContext('2d')!, active, point)
  }

  function move(event: PointerEvent<HTMLCanvasElement>) {
    const active = gesture.current
    if (!active || active.id !== event.pointerId) return
    trace(event.currentTarget.getContext('2d')!, active, pointerPoint(event))
  }

  function end(event: PointerEvent<HTMLCanvasElement>) {
    if (gesture.current?.id === event.pointerId) finishStroke()
  }

  const [color, setColor] = useState<Color>(palette[0][1])
  const [hex, setHex] = useState<string>(palette[0][1])
  const [erasing, setErasing] = useState(false)
  const [eraserSize, setEraserSize] = useState<number>(1)
  const [zoom, setZoom] = useState(1)
  const viewport = useRef<HTMLDivElement>(null)
  const zoomCenter = useRef<Point | null>(null)
  const ink = erasing ? null : color
  const invalidHex = !hexColor.test(hex)
  const canvasWidth = project.width * pitch + 2
  const canvasHeight = project.height * pitch + 2

  function chooseColor(next: Color) {
    setColor(next)
    setHex(next)
    setErasing(false)
  }

  function editHex(value: string) {
    setHex(value)
    if (!hexColor.test(value)) return

    setColor(value.toLowerCase() as Color)
    setErasing(false)
  }

  function changeZoom(next: number) {
    const area = viewport.current!
    const canvas = area.querySelector('canvas')!
    const view = area.getBoundingClientRect()
    const grid = canvas.getBoundingClientRect()
    zoomCenter.current = {
      x: (view.left + area.clientWidth / 2 - grid.left) / grid.width,
      y: (view.top + area.clientHeight / 2 - grid.top) / grid.height,
    }
    setZoom(next)
  }

  useLayoutEffect(() => {
    const center = zoomCenter.current
    if (!center) return

    const area = viewport.current!
    const grid = area.querySelector('canvas')!.getBoundingClientRect()
    const view = area.getBoundingClientRect()
    area.scrollLeft += grid.left + center.x * grid.width - (view.left + area.clientWidth / 2)
    area.scrollTop += grid.top + center.y * grid.height - (view.top + area.clientHeight / 2)
    zoomCenter.current = null
  }, [zoom])

  return (
    <main className="editor">
      <div className="editor-tools">
        <div className="palette" role="group" aria-label="Paleta de cores e borracha">
          <div className="swatches">
            {palette.map(([name, color]) => (
              <button key={color} type="button" className="swatch"
                aria-label={name} aria-pressed={ink === color} title={name}
                style={{ '--swatch': color } as CSSProperties}
                onClick={() => chooseColor(color)} />
            ))}
          </div>
          <div className="color-tools" role="group" aria-label="Cor personalizada">
            <label className="color-picker">
              <span>Cor</span>
              <input type="color" value={color} onChange={event => chooseColor(event.target.value as Color)} />
            </label>
            <label className="hex-color">
              <span>Hexadecimal</span>
              <input id="hex-color" value={hex} spellCheck={false} autoComplete="off"
                aria-invalid={invalidHex} aria-describedby={invalidHex ? 'hex-error' : undefined}
                onChange={event => editHex(event.target.value)}
                onBlur={() => { if (!invalidHex) setHex(color) }} />
            </label>
            {invalidHex && <span id="hex-error" role="status">Use o formato #RRGGBB.</span>}
          </div>
          <div className="eraser-tools">
            <button type="button" className="secondary eraser" aria-pressed={erasing} onClick={() => setErasing(true)}>
              Borracha
            </button>
            <label className="eraser-size">
              <span>Tamanho da borracha</span>
              <select id="eraser-size" value={eraserSize} onChange={event => setEraserSize(Number(event.target.value))}>
                {eraserSizes.map(size => <option key={size} value={size}>{size}×{size}</option>)}
              </select>
            </label>
          </div>
        </div>
        <div className="zoom" role="group" aria-label="Zoom da grade">
          <button type="button" className="secondary" aria-label="Diminuir zoom" disabled={zoom === 1}
            onClick={() => changeZoom(zoom - 0.5)}>−</button>
          <output aria-label="Zoom atual">{zoom * 100}%</output>
          <button type="button" className="secondary" aria-label="Aumentar zoom" disabled={zoom === 4}
            onClick={() => changeZoom(zoom + 0.5)}>+</button>
          <button type="button" className="secondary" disabled={zoom === 1} onClick={() => changeZoom(1)}>Ajustar à tela</button>
        </div>
        <div className="grid-tools">
          <button type="button" className="secondary resize-control"
            onClick={() => { finishEdits(); setResizing(true) }}>Redimensionar</button>
        </div>
      </div>
      <div className="editor-workarea">
        <div className="grid-area" ref={viewport} role="region" tabIndex={0} aria-label="Área da grade">
          <div className="grid-content">
            <canvas data-hidden-layer={!activeLayer.visible || undefined} ref={canvas} width={canvasWidth} height={canvasHeight} role="img"
              aria-label={`Grade de bordado de ${project.width} por ${project.height} pontos`}
              style={{ '--zoom': zoom, '--canvas-width': canvasWidth + 'px',
                '--canvas-ratio': canvasWidth / canvasHeight } as CSSProperties}
              onPointerDown={start} onPointerMove={move}
              onPointerUp={event => { move(event); end(event) }}
              onPointerCancel={end} onLostPointerCapture={end} />
          </div>
        </div>
        <section className="layer-panel" aria-labelledby="layers-title">
          <div className="layer-header">
            <h2 id="layers-title">Camadas</h2>
            <button type="button" className="secondary" onClick={addLayer}>Nova camada</button>
          </div>
          <ol className="layer-list" reversed aria-label="Ordem das camadas, do topo à base">
            {layers.map((layer, index) => ({ layer, index })).reverse().map(({ layer, index }) => (
              <li key={layer.id}>
                <button type="button" className="secondary" aria-pressed={layer.id === activeLayerId}
                  onClick={() => selectLayer(layer.id)}>
                  Camada {index + 1}
                  <span aria-hidden="true">{layer.visible ? layer.opacity + '%' : 'Oculta'}</span>
                </button>
              </li>
            ))}
          </ol>
          <div className="layer-controls" role="group" aria-label="Controles da camada ativa">
            <label className="layer-visible">
              <input type="checkbox" checked={activeLayer.visible} onChange={toggleVisibility} />
              Visível
            </label>
            <div className="layer-opacity">
              <label htmlFor="layer-opacity">Opacidade</label>
              <output aria-hidden="true">{previewOpacity ?? activeLayer.opacity}%</output>
              <input id="layer-opacity" type="range" min="0" max="100" value={previewOpacity ?? activeLayer.opacity}
                onPointerDown={event => {
                  if (event.button !== 0 || opacityDrag.current) return
                  finishStroke()
                  opacityDrag.current = { pointerId: event.pointerId, value: activeLayer.opacity }
                }}
                onChange={event => {
                  const value = Number(event.target.value)
                  if (opacityDrag.current) {
                    opacityDrag.current.value = value
                    setPreviewOpacity(value)
                  } else {
                    finishStroke()
                    changeOpacity(value)
                  }
                }}
                onBlur={() => finishOpacity()} />
            </div>
            <div className="layer-actions">
              <button type="button" className="secondary" aria-label="Subir camada"
                disabled={layerIndex === layers.length - 1} onClick={() => moveLayer(1)}>Subir</button>
              <button type="button" className="secondary" aria-label="Descer camada"
                disabled={layerIndex === 0} onClick={() => moveLayer(-1)}>Descer</button>
              <button type="button" className="secondary" aria-label="Excluir camada"
                disabled={layers.length === 1} onClick={requestDelete}>Excluir</button>
            </div>
          </div>
          <ImageButton className="secondary import-control" onBeforeOpen={finishEdits} onChoose={chooseImage}>Importar imagem</ImageButton>
          {!activeLayer.visible && <p className="layer-hint" role="status">Mostre a camada para editar.</p>}
        </section>
      </div>
      {importing && <ImportDialog file={importing.file} base={importing.base}
        onChoose={chooseImage} onConfirm={cells => confirmImport(importing.base, cells)} onCancel={() => setImporting(null)} />}
      {resizing && <ResizeDialog grid={drawing.current} onSubmit={resize} onCancel={() => setResizing(false)} />}
      {deleting && <Modal title="delete-layer-title" description="delete-layer-description" onCancel={() => setDeleting(false)}>
        <form onSubmit={event => { event.preventDefault(); deleteLayer() }}>
          <h1 id="delete-layer-title">Excluir camada?</h1>
          <p id="delete-layer-description">A camada {layerIndex + 1} contém pontos pintados.</p>
          <div className="form-actions">
            <button type="button" className="secondary" autoFocus onClick={() => setDeleting(false)}>Cancelar</button>
            <button>Confirmar exclusão</button>
          </div>
        </form>
      </Modal>}
    </main>
  )
}

function ImageButton({ className, children, onBeforeOpen, onChoose }: {
  className?: string
  children: ReactNode
  onBeforeOpen?: () => void
  onChoose: (file: File) => void
}) {
  const input = useRef<HTMLInputElement>(null)
  return <>
    <button type="button" className={className} onClick={() => { onBeforeOpen?.(); input.current!.click() }}>{children}</button>
    <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" hidden tabIndex={-1} aria-hidden="true"
      onChange={event => {
        const file = event.target.files?.[0]
        event.target.value = ''
        if (file) onChoose(file)
      }} />
  </>
}

type Conversion =
  | { status: 'converting' }
  | { status: 'ready', file: File, cells: Ink[], source: Dimensions }
  | { status: 'error', file: File, message: string }

const importErrors = {
  format: 'Escolha uma imagem PNG, JPEG ou WebP. O bordado não foi alterado.',
  decode: 'Não foi possível ler esta imagem. O bordado não foi alterado.',
}

function ImportDialog({ file, base, onChoose, onConfirm, onCancel }: {
  file: File
  base: Drawing<Ink>
  onChoose: (file: File) => void
  onConfirm: (cells: Ink[]) => void
  onCancel: () => void
}) {
  const [conversion, setConversion] = useState<Conversion>({ status: 'converting' })
  const [onlyNew, setOnlyNew] = useState(false)
  const preview = useRef<HTMLCanvasElement>(null)
  const confirmed = useRef(false)
  const cancel = useRef<HTMLButtonElement>(null)
  // A result only counts for the file it was made from, even before the next effect runs.
  const current = conversion.status !== 'converting' && conversion.file === file ? conversion : undefined
  const ready = current?.status === 'ready' ? current : undefined

  useEffect(() => {
    setConversion({ status: 'converting' })
    const worker = new Worker(new URL('./import-worker.ts', import.meta.url), { type: 'module' })
    let pending = true
    const finish = (response: ImportResponse) => {
      if (!pending) return
      pending = false
      worker.terminate()
      if ('error' in response) setConversion({ status: 'error', file, message: importErrors[response.error] })
      else if (response.cells.length !== base.width * base.height) setConversion({ status: 'error', file, message: importErrors.decode })
      else setConversion({ status: 'ready', file, source: response.source,
        cells: Array.from(response.cells, index => index < 0 ? null : palette[index][1]) })
    }
    worker.onmessage = (event: MessageEvent<ImportResponse>) => finish(event.data)
    worker.onerror = () => finish({ error: 'decode' })
    worker.postMessage({ file, grid: { width: base.width, height: base.height } } satisfies ImportRequest)
    return () => {
      // Discard a conversion that is replaced, canceled or belongs to a closed editor.
      pending = false
      worker.onmessage = null
      worker.onerror = null
      worker.terminate()
    }
  }, [file, base])

  // The Modal opens in its own layout effect, which runs before this one.
  useLayoutEffect(() => cancel.current!.focus(), [])

  useLayoutEffect(() => {
    if (!ready || !preview.current) return
    const layer = { id: 'preview', visible: true, opacity: 100, cells: ready.cells }
    const shown = { ...base, layers: onlyNew ? [layer] : [...base.layers, layer] }
    const ctx = preview.current.getContext('2d')!
    drawLayers(ctx, shown, pitch, true)
    drawGridLines(ctx, shown, pitch)
  }, [base, onlyNew, ready])

  const placement = ready && fitImage(ready.source, base)
  const position = base.layers.length + 1

  return <Modal title="import-title" description="import-description" className="import-dialog" onCancel={onCancel}>
    <form onSubmit={event => {
      event.preventDefault()
      if (!ready || confirmed.current) return
      confirmed.current = true
      onConfirm(ready.cells)
    }}>
      <h1 id="import-title">Importar imagem</h1>
      {current?.status === 'error'
        ? <p id="import-description" role="alert">{current.message}</p>
        : <p id="import-description" role="status">{placement
          ? `${file.name}: ${ready.source.width} × ${ready.source.height} pixels em ${placement.width} × ${placement.height} pontos. ` +
            `A imagem entra como camada ${position}, no topo, visível e com opacidade de 100%.`
          : `Convertendo ${file.name}…`}</p>}
      <fieldset className="preview-mode" disabled={!ready}>
        <legend>Mostrar na prévia</legend>
        <label><input type="radio" name="preview-mode" checked={!onlyNew} onChange={() => setOnlyNew(false)} />Composição completa</label>
        <label><input type="radio" name="preview-mode" checked={onlyNew} onChange={() => setOnlyNew(true)} />Somente a nova camada</label>
      </fieldset>
      <div className="import-preview">
        {ready && <canvas ref={preview} width={base.width * pitch + 2} height={base.height * pitch + 2} role="img"
          aria-label={onlyNew ? 'Prévia da camada importada' : 'Prévia da composição com a camada importada no topo'} />}
      </div>
      <div className="form-actions">
        <button disabled={!ready}>Confirmar importação</button>
        <ImageButton className="secondary" onChoose={onChoose}>Escolher outro arquivo</ImageButton>
        <button ref={cancel} type="button" className="secondary" onClick={onCancel}>Cancelar</button>
      </div>
    </form>
  </Modal>
}

type DimensionDraft = Record<keyof Dimensions, string>

function dimensionDraft({ width, height }: Dimensions = { width: defaultDimension, height: defaultDimension }): DimensionDraft {
  return { width: String(width), height: String(height) }
}

function parseDimension(value: string) {
  const number = Number(value)
  return /^\d+$/.test(value) && isDimension(number) ? number : undefined
}

function parseDimensions(draft: DimensionDraft): Dimensions | undefined {
  const width = parseDimension(draft.width)
  const height = parseDimension(draft.height)
  if (width !== undefined && height !== undefined) return { width, height }
}

function DimensionFields({ draft, onChange, disabled }: {
  draft: DimensionDraft
  onChange: (draft: DimensionDraft) => void
  disabled?: boolean
}) {
  return <div className="dimension-fields">
    {(['width', 'height'] as const).map(axis => {
      const id = 'dimension-' + axis
      const invalid = parseDimension(draft[axis]) === undefined
      return <div key={axis}>
        <label htmlFor={id}>{axis === 'width' ? 'Largura' : 'Altura'} (pontos)</label>
        <input id={id} type="text" inputMode="numeric" value={draft[axis]} disabled={disabled}
          aria-invalid={invalid} aria-describedby={invalid ? id + '-error' : undefined}
          onChange={event => onChange({ ...draft, [axis]: event.target.value })} />
        {invalid && <span className="dimension-error" id={id + '-error'} role="status">
          Use um inteiro de 1 a {maxDimension}.
        </span>}
      </div>
    })}
  </div>
}

function Modal({ title, children, onCancel, description, className }: {
  title: string
  children: ReactNode
  onCancel: () => void
  description?: string
  className?: string
}) {
  const dialog = useRef<HTMLDialogElement>(null)

  useLayoutEffect(() => {
    const element = dialog.current!
    element.showModal()
    return () => element.close()
  }, [])

  return <dialog ref={dialog} className={className} aria-labelledby={title} aria-describedby={description} onCancel={event => {
    event.preventDefault()
    onCancel()
  }}>{children}</dialog>
}

function ResizeDialog({ grid, onSubmit, onCancel }: {
  grid: Drawing<Ink>
  onSubmit: (dimensions: Dimensions) => void
  onCancel: () => void
}) {
  const [draft, setDraft] = useState(() => dimensionDraft(grid))
  const [confirmation, setConfirmation] = useState<Dimensions>()

  function requestResize() {
    const next = parseDimensions(draft)
    if (!next) return

    const cutsPaint = (next.width < grid.width || next.height < grid.height) && grid.layers.some(layer => layer.cells.some((ink, index) =>
      ink !== null && (index % grid.width >= next.width || Math.floor(index / grid.width) >= next.height),
    ))
    if (cutsPaint) setConfirmation(next)
    else onSubmit(next)
  }

  return <Modal title="resize-title" onCancel={onCancel} description={confirmation ? 'crop-description' : undefined}>
    {confirmation ? (
      <form key="confirm" onSubmit={event => { event.preventDefault(); onSubmit(confirmation) }}>
        <h1 id="resize-title">Confirmar corte</h1>
        <p id="crop-description">O tamanho de {confirmation.width} por {confirmation.height} pontos corta pontos pintados do bordado.</p>
        <div className="form-actions">
          <button className="secondary" type="button" autoFocus onClick={onCancel}>Cancelar</button>
          <button>Confirmar corte</button>
        </div>
      </form>
    ) : (
      <form key="dimensions" onSubmit={event => { event.preventDefault(); requestResize() }}>
        <h1 id="resize-title">Redimensionar bordado</h1>
        <DimensionFields draft={draft} onChange={setDraft} />
        <div className="form-actions">
          <button>Aplicar dimensões</button>
          <button className="secondary" type="button" onClick={onCancel}>Cancelar</button>
        </div>
      </form>
    )}
  </Modal>
}

function ProjectForm({ mode, initialName = '', busy, onSubmit, onCancel }: {
  mode: 'create' | 'rename'
  initialName?: string
  busy: boolean
  onSubmit: (name: string, dimensions: Dimensions) => void
  onCancel?: () => void
}) {
  const [draft, setDraft] = useState(initialName)
  const [dimensions, setDimensions] = useState(() => dimensionDraft())
  const renaming = mode === 'rename'

  return (
    <form onSubmit={event => {
      event.preventDefault()
      const name = draft.trim()
      const parsed = parseDimensions(dimensions)
      if (name && !busy && parsed) onSubmit(name, parsed)
    }}>
      <h1 id="project-form-title">{renaming ? 'Renomear bordado' : 'Novo bordado'}</h1>
      <label htmlFor="name">Nome do bordado</label>
      <input id="name" value={draft} onChange={event => setDraft(event.target.value)}
        required disabled={busy} autoFocus={!!onCancel} />
      {!renaming && <DimensionFields draft={dimensions} onChange={setDimensions} disabled={busy} />}
      <div className="form-actions">
        <button disabled={busy || !draft.trim()}>{renaming ? 'Salvar nome' : 'Criar bordado'}</button>
        {onCancel && <button className="secondary" type="button" disabled={busy} onClick={onCancel}>Cancelar</button>}
      </div>
    </form>
  )
}

function ProjectDialog({ mode, name, busy, error, onSubmit, onCancel }: {
  mode: 'create' | 'rename'
  name: string
  busy: boolean
  error: string
  onSubmit: (name: string, dimensions: Dimensions) => void
  onCancel: () => void
}) {
  return (
    <Modal title="project-form-title" onCancel={() => { if (!busy) onCancel() }}>
      <ProjectForm mode={mode} initialName={mode === 'rename' ? name : ''}
        busy={busy} onSubmit={onSubmit} onCancel={onCancel} />
      {error && <p role="alert">{error}</p>}
    </Modal>
  )
}

function App() {
  const [db, setDb] = useState<IDBDatabase>()
  const [projects, setProjects] = useState<Project<Ink>[]>([])
  const [selected, setSelected] = useState<number>()
  const [dialog, setDialog] = useState<'create' | 'rename' | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [drawingSaves, setDrawingSaves] = useState(new Map<number, { committed: Promise<void>, message: string }>())

  const editor = useRef<EditorHandle>(null)
  const project = projects.find(item => item.number === selected)

  useEffect(() => {
    void openProjects().then(async database => {
      const library = await loadLibrary<Ink>(database)
      setProjects(library.projects)
      setSelected(library.selected)
      setDb(database)
    }).catch(() => setError('Não foi possível abrir os bordados salvos neste navegador.'))
  }, [])

  function openDialog(mode: 'create' | 'rename') {
    editor.current?.finishEdits()
    setError('')
    setDialog(mode)
  }

  function closeDialog() {
    setError('')
    setDialog(null)
  }

  async function create(name: string, dimensions: Dimensions) {
    if (!db) return

    setBusy(true)
    setError('')
    const draft = { name, ...newDrawing<Ink>(dimensions, null) }
    try {
      if (project) {
        const created = await createProject(db, draft)
        setProjects(items => [...items, created])
        setSelected(created.number)
      } else {
        const library = await loadLibrary(db, draft)
        setProjects(library.projects)
        setSelected(library.selected)
      }
      closeDialog()
    } catch {
      setError('Não foi possível criar o bordado.')
    } finally {
      setBusy(false)
    }
  }

  async function rename(name: string) {
    if (!db || selected === undefined) return

    setBusy(true)
    setError('')
    try {
      await renameProject(db, selected, name)
      setProjects(items => items.map(item => item.number === selected ? { ...item, name } : item))
      closeDialog()
    } catch {
      setError('Não foi possível renomear o bordado.')
    } finally {
      setBusy(false)
    }
  }

  function select(number: number) {
    if (!db || number === selected) return
    editor.current?.finishEdits()

    setError('')
    setSelected(number)
    void selectProject(db, number).catch(() => setError('Não foi possível salvar o bordado selecionado.'))
  }

  const save = useCallback((grid: Drawing<Ink>) => {
    if (!db || selected === undefined) return

    setProjects(items => items.map(item => item.number === selected ? { ...item, ...grid } : item))
    setError('')
    const { journaled, committed } = saveProject(db, selected, grid)
    setDrawingSaves(current => new Map(current).set(selected, {
      committed,
      message: journaled ? '' : 'A última edição ainda não foi salva. Se fechar a página agora, a alteração pode ser perdida.',
    }))

    const finish = (message: string) => {
      setDrawingSaves(current => {
        // Only the latest edit to this project can change its alert.
        if (current.get(selected)?.committed !== committed) return current
        const next = new Map(current)
        if (message) next.set(selected, { committed, message })
        else next.delete(selected)
        return next
      })
    }
    void committed.then(
      () => finish(''),
      () => finish('Não foi possível salvar a última edição.'),
    )
  }, [db, selected])

  return (
    <div className="app">
      <header>
        <img className="brand" src={logo} alt="Linha a bordo" width={549} height={106} />
        {project && <h1 title={project.name}>{project.name}</h1>}
        <div className="header-end">
          {project && <div className="project-actions">
            <button className="secondary" type="button" onClick={() => downloadPng({ ...project, ...editor.current?.visibleDrawing() })}>Baixar PNG</button>
            <button className="secondary" type="button" onClick={() => openDialog('rename')}>Renomear</button>
            <button type="button" onClick={() => openDialog('create')}>Novo bordado</button>
          </div>}
          {error && !dialog && <span role="alert">{error}</span>}
          {[...drawingSaves].map(([number, { message }]) => message && <span key={number} role="alert">
            {number !== selected && ('Bordado ' + number + ': ')}{message}
          </span>)}
        </div>
      </header>
      {project ? (
        <div className="workspace">
          <Editor ref={editor} key={project.number} project={project} onSave={save} />
          <nav className="project-bar" aria-label="Bordados locais">
            {projects.map(item => (
              <button key={item.number} type="button"
                aria-label={`Bordado ${item.number}: ${item.name}`}
                aria-current={item.number === selected ? 'true' : undefined}
                onClick={() => select(item.number)}>{item.number}</button>
            ))}
          </nav>
        </div>
      ) : db ? (
        <main className="start"><ProjectForm mode="create" busy={busy} onSubmit={create} /></main>
      ) : !error && <main className="start" role="status">Abrindo bordado…</main>}
      {dialog && project && <ProjectDialog mode={dialog} name={project.name} busy={busy}
        error={error} onSubmit={dialog === 'rename' ? rename : create} onCancel={closeDialog} />}
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
