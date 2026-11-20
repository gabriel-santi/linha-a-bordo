import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react'
import { createRoot } from 'react-dom/client'
import { latestProject, openProjects, saveProject, type Project } from './projects'
import './style.css'

const cells = 60
const pitch = 16
const size = cells * pitch + 2
const empty = '#fffcf6'
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
] as const

type Ink = typeof palette[number][1] | null
type Point = { x: number, y: number }
type Stroke = { ink: Ink, before: Map<number, Ink> }
type Gesture = Stroke & { id: number, point: Point }

function lineWidth(index: number) {
  return index % 10 === 0 ? 2 : 1
}

function paintCell(ctx: CanvasRenderingContext2D, col: number, row: number, ink: Ink) {
  if (col < 0 || col >= cells || row < 0 || row >= cells) return

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
  const { left, top, width, height } = event.currentTarget.getBoundingClientRect()
  return {
    x: (event.clientX - left) * size / (width * pitch),
    y: (event.clientY - top) * size / (height * pitch),
  }
}

function Grid({ ink, zoom, project, onSave }: {
  ink: Ink
  zoom: number
  project: Project<Ink>
  onSave: (cells: Ink[]) => void
}) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const drawing = useRef<Ink[]>([])
  const gesture = useRef<Gesture | null>(null)
  const undo = useRef<Stroke[]>([])
  const redo = useRef<Stroke[]>([])

  useLayoutEffect(() => {
    const ctx = canvas.current!.getContext('2d')!
    ctx.fillStyle = empty
    ctx.fillRect(0, 0, size, size)
    for (let line = 0; line <= cells; line++) {
      const width = lineWidth(line)
      const offset = line * pitch
      ctx.fillStyle = width === 2 ? '#535e4d' : '#b5b8ab'
      ctx.fillRect(offset, 0, width, size)
      ctx.fillRect(0, offset, size, width)
    }
    drawing.current = project.cells.slice()
    drawing.current.forEach((ink, index) => {
      if (ink !== null) paintCell(ctx, index % cells, Math.floor(index / cells), ink)
    })
  }, [project])

  useEffect(() => {
    function handleHistory(event: KeyboardEvent) {
      if (!event.ctrlKey || event.shiftKey || event.altKey || event.metaKey) return

      const key = event.key.toLowerCase()
      if (key !== 'z' && key !== 'y') return

      event.preventDefault()
      if (gesture.current) return

      const undoing = key === 'z'
      const source = undoing ? undo.current : redo.current
      const destination = undoing ? redo.current : undo.current
      const stroke = source.pop()
      if (!stroke) return

      const ctx = canvas.current!.getContext('2d')!
      for (const [index, before] of stroke.before) {
        const color = undoing ? before : stroke.ink
        drawing.current[index] = color
        paintCell(ctx, index % cells, Math.floor(index / cells), color)
      }
      destination.push(stroke)
      onSave(drawing.current)
    }

    window.addEventListener('keydown', handleHistory)
    return () => window.removeEventListener('keydown', handleHistory)
  }, [onSave])

  function trace(ctx: CanvasRenderingContext2D, active: Gesture, point: Point) {
    visitSegment(active.point, point, (col, row) => {
      if (col < 0 || col >= cells || row < 0 || row >= cells) return

      const index = row * cells + col
      const before = drawing.current[index]
      if (before === active.ink) return

      // The first visit records the original color even if the pointer returns.
      active.before.set(index, before)
      drawing.current[index] = active.ink
      paintCell(ctx, col, row, active.ink)
    })
    active.point = point
  }

  function start(event: PointerEvent<HTMLCanvasElement>) {
    if (event.button !== 0 || gesture.current) return

    const point = pointerPoint(event)
    event.currentTarget.setPointerCapture(event.pointerId)
    const active = { id: event.pointerId, point, ink, before: new Map<number, Ink>() }
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
    onSave(drawing.current)
  }

  return <canvas ref={canvas} width={size} height={size} role="img"
    aria-label="Grade de bordado de 60 por 60 pontos"
    style={{ '--zoom': zoom } as CSSProperties}
    onPointerDown={start} onPointerMove={move}
    onPointerUp={event => { move(event); end(event) }}
    onPointerCancel={end} onLostPointerCapture={end} />
}

function Editor({ project, onSave }: { project: Project<Ink>, onSave: (cells: Ink[]) => void }) {
  const [ink, setInk] = useState<Ink>(palette[0][1])
  const [zoom, setZoom] = useState(1)
  const viewport = useRef<HTMLDivElement>(null)
  const zoomCenter = useRef<Point | null>(null)

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
              onClick={() => setInk(color)} />
          ))}
          <button type="button" aria-pressed={ink === null} onClick={() => setInk(null)}>
            Borracha
          </button>
        </div>
        <div className="zoom" role="group" aria-label="Zoom da grade">
          <button type="button" aria-label="Diminuir zoom" disabled={zoom === 1}
            onClick={() => changeZoom(zoom - 1)}>−</button>
          <output aria-label="Zoom atual">{zoom * 100}%</output>
          <button type="button" aria-label="Aumentar zoom" disabled={zoom === 4}
            onClick={() => changeZoom(zoom + 1)}>+</button>
          <button type="button" disabled={zoom === 1} onClick={() => changeZoom(1)}>Ajustar à tela</button>
        </div>
      </div>
      <div className="grid-area" ref={viewport} role="region" tabIndex={0} aria-label="Área da grade">
        <div className="grid-content"><Grid ink={ink} zoom={zoom} project={project} onSave={onSave} /></div>
      </div>
    </main>
  )
}

function App() {
  const [db, setDb] = useState<IDBDatabase>()
  const [project, setProject] = useState<Project<Ink> | null>(null)
  const [draft, setDraft] = useState('')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    void openProjects().then(async database => {
      setProject(await latestProject<Ink>(database))
      setDb(database)
    }).catch(() => setError('Não foi possível abrir os bordados salvos neste navegador.'))
  }, [])

  async function create() {
    const name = draft.trim()
    if (!db || !name || creating) return

    setCreating(true)
    setError('')
    try {
      setProject(await latestProject<Ink>(db, { name, cells: Array(cells * cells).fill(null) }))
    } catch {
      setError('Não foi possível criar o bordado.')
    } finally {
      setCreating(false)
    }
  }

  const save = useCallback((cells: Ink[]) => {
    if (!db || !project) return

    void saveProject(db, { ...project, cells }).then(
      () => setError(''),
      () => setError('Não foi possível salvar a última edição.'),
    )
  }, [db, project])

  return (
    <div className="app">
      <header><span className="brand">Linha a Bordo</span>
        {project && <><h1 title={project.name}>{project.name}</h1>
          <span>Bordado nº {project.number}</span></>}
        {error && <span role="alert">{error}</span>}
      </header>
      {project ? (
        <Editor key={project.number} project={project} onSave={save} />
      ) : db ? (
        <main className="start">
          <form onSubmit={event => { event.preventDefault(); void create() }}>
            <h1>Novo bordado</h1>
            <label htmlFor="name">Nome do bordado</label>
            <input id="name" value={draft} onChange={event => setDraft(event.target.value)} required />
            <button disabled={creating || !draft.trim()}>Criar bordado</button>
          </form>
        </main>
      ) : !error && <main className="start" role="status">Abrindo bordado…</main>}
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
