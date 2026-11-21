import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { createProject, loadLibrary, openProjects, renameProject, saveProject, selectProject, type Project } from './projects'
import { defaultDimension, isDimension, maxDimension, type Dimensions, type GridData } from './geometry'
import './style.css'

const pitch = 16
const empty = '#fffcf6'
const majorLine = '#535e4d'
const fineLine = '#b5b8ab'
const palette = [
  ['Preto', '#222222'],
  ['Cinza', '#777777'],
  ['Branco', '#ffffff'],
  ['Marrom', '#774631'],
  ['Bege', '#dcc29b'],
  ['Vermelho', '#c82e37'],
  ['Laranja', '#eb782b'],
  ['Amarelo', '#f3d344'],
  ['Verde', '#3b804a'],
  ['Azul', '#3066bd'],
  ['Roxo', '#773e9d'],
  ['Rosa', '#df72a3'],
  ['Verde-claro', '#90ce97'],
  ['Azul-claro', '#8dbbfa'],
] as const

const eraserSizes = [1, 3, 5, 9] as const
const hexColor = /^#[0-9a-f]{6}$/i

type Color = `#${string}`
type Ink = Color | null
type Point = { x: number, y: number }
type Stroke = { ink: Ink, before: Map<number, Ink> }
type Gesture = Stroke & { id: number, point: Point, radius: number }
type Resize = { before: GridData<Ink>, after: GridData<Ink> }
type GridAction = Stroke | Resize

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
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  project.cells.forEach((ink, index) => {
    if (ink === null || ink === '#ffffff') return
    ctx.fillStyle = ink
    ctx.fillRect(index % project.width * exportPitch, Math.floor(index / project.width) * exportPitch, exportPitch, exportPitch)
  })
  drawGridLines(ctx, project, exportPitch)

  const link = document.createElement('a')
  const name = Array.from(project.name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')).slice(0, 54).join('').trim()
  link.download = name + '.png'
  link.href = canvas.toDataURL('image/png')
  link.click()
}

function paintCell(ctx: CanvasRenderingContext2D, col: number, row: number, ink: Ink) {
  const left = lineWidth(col)
  const top = lineWidth(row)
  const x = col * pitch + left
  const y = row * pitch + top
  const width = pitch - left
  const height = pitch - top
  ctx.fillStyle = ink === '#ffffff' ? '#8e8a80' : ink ?? empty
  ctx.fillRect(x, y, width, height)
  if (ink === '#ffffff') {
    ctx.fillStyle = ink
    ctx.fillRect(x + 2, y + 2, width - 4, height - 4)
  }
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

function newGrid({ width, height }: Dimensions): GridData<Ink> {
  return { width, height, cells: Array<Ink>(width * height).fill(null) }
}

function copyGrid({ width, height, cells }: GridData<Ink>): GridData<Ink> {
  return { width, height, cells: cells.slice() }
}

function resizeGrid(current: GridData<Ink>, dimensions: Dimensions) {
  const next = newGrid(dimensions)
  const width = Math.min(current.width, next.width)
  const height = Math.min(current.height, next.height)
  for (let row = 0; row < height; row++) {
    const start = row * current.width
    for (let column = 0; column < width; column++) {
      next.cells[row * next.width + column] = current.cells[start + column]
    }
  }
  return next
}

function Editor({ project, onSave }: {
  project: Project<Ink>
  onSave: (grid: GridData<Ink>) => void
}) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const drawing = useRef<GridData<Ink> | null>(null)
  drawing.current ??= copyGrid(project)
  const redraw = useRef(true)
  const gesture = useRef<Gesture | null>(null)
  const undo = useRef<GridAction[]>([])
  const redo = useRef<GridAction[]>([])
  const [resizing, setResizing] = useState(false)

  useLayoutEffect(() => {
    if (!redraw.current) return
    redraw.current = false
    const grid = drawing.current!
    const ctx = canvas.current!.getContext('2d')!
    ctx.fillStyle = empty
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height)
    drawGridLines(ctx, grid, pitch)
    grid.cells.forEach((ink, index) => {
      if (ink !== null) paintCell(ctx, index % grid.width, Math.floor(index / grid.width), ink)
    })
  })

  const applyGrid = useCallback((grid: GridData<Ink>) => {
    drawing.current = copyGrid(grid)
    redraw.current = true
    onSave(grid)
  }, [onSave])

  useEffect(() => {
    function handleHistory(event: KeyboardEvent) {
      if (resizing || (event.target instanceof Element &&
        event.target.closest('dialog, input, textarea, [contenteditable]'))) return
      if (!event.ctrlKey || event.shiftKey || event.altKey || event.metaKey) return

      const key = event.key.toLowerCase()
      if (key !== 'z' && key !== 'y') return

      event.preventDefault()
      if (gesture.current) return

      const undoing = key === 'z'
      const source = undoing ? undo.current : redo.current
      const destination = undoing ? redo.current : undo.current
      const action = source.pop()
      if (!action) return

      destination.push(action)
      if ('after' in action) {
        applyGrid(undoing ? action.before : action.after)
        return
      }

      const grid = drawing.current!
      const ctx = canvas.current!.getContext('2d')!
      for (const [index, before] of action.before) {
        const color = undoing ? before : action.ink
        grid.cells[index] = color
        if (!redraw.current) paintCell(ctx, index % grid.width, Math.floor(index / grid.width), color)
      }
      onSave(copyGrid(grid))
    }

    window.addEventListener('keydown', handleHistory)
    return () => window.removeEventListener('keydown', handleHistory)
  }, [applyGrid, onSave, resizing])

  function resize(dimensions: Dimensions) {
    setResizing(false)
    const grid = drawing.current!
    if (grid.width === dimensions.width && grid.height === dimensions.height) return

    const after = resizeGrid(grid, dimensions)
    undo.current.push({ before: copyGrid(grid), after })
    redo.current.length = 0
    applyGrid(after)
  }

  function trace(ctx: CanvasRenderingContext2D, active: Gesture, point: Point) {
    const { width, height, cells } = drawing.current!
    visitSegment(active.point, point, (col, row) => {
      if (col < 0 || col >= width || row < 0 || row >= height) return

      const { radius, ink } = active
      for (let y = Math.max(0, row - radius); y <= Math.min(height - 1, row + radius); y++) {
        for (let x = Math.max(0, col - radius); x <= Math.min(width - 1, col + radius); x++) {
          const index = y * width + x
          const before = cells[index]
          if (before === ink) continue

          // Later visits find the gesture's ink and preserve the original color.
          active.before.set(index, before)
          cells[index] = ink
          paintCell(ctx, x, y, ink)
        }
      }
    })
    active.point = point
  }

  function start(event: PointerEvent<HTMLCanvasElement>) {
    if (event.button !== 0 || gesture.current) return

    const point = pointerPoint(event)
    event.currentTarget.setPointerCapture(event.pointerId)
    const radius = ink === null ? (eraserSize - 1) / 2 : 0
    const active = { id: event.pointerId, point, ink, radius, before: new Map<number, Ink>() }
    gesture.current = active
    trace(event.currentTarget.getContext('2d')!, active, point)
  }

  function move(event: PointerEvent<HTMLCanvasElement>) {
    const active = gesture.current
    if (!active || active.id !== event.pointerId) return

    trace(event.currentTarget.getContext('2d')!, active, pointerPoint(event))
  }

  function end(event: PointerEvent<HTMLCanvasElement>) {
    const active = gesture.current
    if (!active || active.id !== event.pointerId) return

    gesture.current = null
    if (active.before.size === 0) return

    undo.current.push({ ink: active.ink, before: active.before })
    redo.current.length = 0
    onSave(copyGrid(drawing.current!))
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
          {palette.map(([name, color]) => (
            <button key={color} type="button" className="swatch"
              aria-label={name} aria-pressed={ink === color} title={name}
              style={{ '--swatch': color } as CSSProperties}
              onClick={() => chooseColor(color)} />
          ))}
          <button type="button" aria-pressed={erasing} onClick={() => setErasing(true)}>
            Borracha
          </button>
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
        <label className="eraser-size">
          <span>Tamanho da borracha</span>
          <select id="eraser-size" value={eraserSize} onChange={event => setEraserSize(Number(event.target.value))}>
            {eraserSizes.map(size => <option key={size} value={size}>{size}×{size}</option>)}
          </select>
        </label>
        <div className="zoom" role="group" aria-label="Zoom da grade">
          <button type="button" aria-label="Diminuir zoom" disabled={zoom === 1}
            onClick={() => changeZoom(zoom - 0.5)}>−</button>
          <output aria-label="Zoom atual">{zoom * 100}%</output>
          <button type="button" aria-label="Aumentar zoom" disabled={zoom === 4}
            onClick={() => changeZoom(zoom + 0.5)}>+</button>
          <button type="button" disabled={zoom === 1} onClick={() => changeZoom(1)}>Ajustar à tela</button>
        </div>
        <button type="button" className="secondary resize-control"
          onClick={() => { if (!gesture.current) setResizing(true) }}>Redimensionar</button>
      </div>
      <div className="grid-area" ref={viewport} role="region" tabIndex={0} aria-label="Área da grade">
        <div className="grid-content">
          <canvas ref={canvas} width={canvasWidth} height={canvasHeight} role="img"
            aria-label={`Grade de bordado de ${project.width} por ${project.height} pontos`}
            style={{ '--zoom': zoom, '--canvas-width': canvasWidth + 'px',
              '--canvas-ratio': canvasWidth / canvasHeight } as CSSProperties}
            onPointerDown={start} onPointerMove={move}
            onPointerUp={event => { move(event); end(event) }}
            onPointerCancel={end} onLostPointerCapture={end} />
        </div>
      </div>
      {resizing && <ResizeDialog grid={drawing.current} onSubmit={resize} onCancel={() => setResizing(false)} />}
    </main>
  )
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

function Modal({ title, children, onCancel, description }: {
  title: string
  children: ReactNode
  onCancel: () => void
  description?: string
}) {
  const dialog = useRef<HTMLDialogElement>(null)

  useLayoutEffect(() => {
    const element = dialog.current!
    element.showModal()
    return () => element.close()
  }, [])

  return <dialog ref={dialog} aria-labelledby={title} aria-describedby={description} onCancel={event => {
    event.preventDefault()
    onCancel()
  }}>{children}</dialog>
}

function ResizeDialog({ grid, onSubmit, onCancel }: {
  grid: GridData<Ink>
  onSubmit: (dimensions: Dimensions) => void
  onCancel: () => void
}) {
  const [draft, setDraft] = useState(() => dimensionDraft(grid))
  const [confirmation, setConfirmation] = useState<Dimensions>()

  function requestResize() {
    const next = parseDimensions(draft)
    if (!next) return

    const cutsPaint = (next.width < grid.width || next.height < grid.height) && grid.cells.some((ink, index) =>
      ink !== null && (index % grid.width >= next.width || Math.floor(index / grid.width) >= next.height),
    )
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
    const draft = { name, ...newGrid(dimensions) }
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

    setError('')
    setSelected(number)
    void selectProject(db, number).catch(() => setError('Não foi possível salvar o bordado selecionado.'))
  }

  const save = useCallback((grid: GridData<Ink>) => {
    if (!db || selected === undefined) return

    setProjects(items => items.map(item => item.number === selected ? { ...item, ...grid } : item))
    setError('')
    void saveProject(db, selected, grid).catch(() => setError('Não foi possível salvar a última edição.'))
  }, [db, selected])

  return (
    <div className="app">
      <header>
        <span className="brand">Linha a bordo</span>
        {project && <>
          <h1 title={project.name}>{project.name}</h1>
          <div className="project-actions">
            <button className="secondary" type="button" onClick={() => downloadPng(project)}>Baixar PNG</button>
            <button className="secondary" type="button" onClick={() => openDialog('rename')}>Renomear</button>
            <button type="button" onClick={() => openDialog('create')}>Novo bordado</button>
          </div>
        </>}
        {error && !dialog && <span role="alert">{error}</span>}
      </header>
      {project ? (
        <div className="workspace">
          <Editor key={project.number} project={project} onSave={save} />
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
