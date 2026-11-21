import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react'
import { createRoot } from 'react-dom/client'
import { createProject, loadLibrary, openProjects, renameProject, saveProject, selectProject, type Project } from './projects'
import './style.css'

const cells = 60
const pitch = 16
const size = cells * pitch + 2
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
] as const

type Ink = typeof palette[number][1] | null
type Point = { x: number, y: number }
type Stroke = { ink: Ink, before: Map<number, Ink> }
type Gesture = Stroke & { id: number, point: Point }

function lineWidth(index: number) {
  return index % 10 === 0 ? 2 : 1
}

function downloadPng(project: Project<Ink>) {
  const exportPitch = 20
  const exportSize = cells * exportPitch
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = exportSize
  const ctx = canvas.getContext('2d', { alpha: false })!
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, exportSize, exportSize)
  project.cells.forEach((ink, index) => {
    if (ink === null || ink === '#ffffff') return
    ctx.fillStyle = ink
    ctx.fillRect(index % cells * exportPitch, Math.floor(index / cells) * exportPitch, exportPitch, exportPitch)
  })

  // Draw the stronger lines over the thin ones, keeping the outer edges inside the image.
  for (const width of [1, 2]) {
    ctx.fillStyle = width === 2 ? majorLine : fineLine
    for (let line = 0; line <= cells; line++) {
      if (lineWidth(line) !== width) continue
      const offset = Math.min(line * exportPitch, exportSize - width)
      ctx.fillRect(offset, 0, width, exportSize)
      ctx.fillRect(0, offset, exportSize, width)
    }
  }

  const link = document.createElement('a')
  const name = Array.from(project.name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')).slice(0, 54).join('').trim()
  link.download = 'Bordado ' + project.number + ' - ' + name + '.png'
  link.href = canvas.toDataURL('image/png')
  link.click()
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
  const initialCells = useRef(project.cells)
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
      ctx.fillStyle = width === 2 ? majorLine : fineLine
      ctx.fillRect(offset, 0, width, size)
      ctx.fillRect(0, offset, size, width)
    }
    drawing.current = initialCells.current.slice()
    drawing.current.forEach((ink, index) => {
      if (ink !== null) paintCell(ctx, index % cells, Math.floor(index / cells), ink)
    })
  }, [])

  useEffect(() => {
    function handleHistory(event: KeyboardEvent) {
      if (event.target instanceof Element && event.target.closest('dialog')) return
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

function Editor({ project, onSave }: {
  project: Project<Ink>
  onSave: (cells: Ink[]) => void
}) {
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

function ProjectForm({ mode, initialName = '', busy, onSubmit, onCancel }: {
  mode: 'create' | 'rename'
  initialName?: string
  busy: boolean
  onSubmit: (name: string) => void
  onCancel?: () => void
}) {
  const [draft, setDraft] = useState(initialName)
  const renaming = mode === 'rename'

  return (
    <form onSubmit={event => {
      event.preventDefault()
      const name = draft.trim()
      if (name && !busy) onSubmit(name)
    }}>
      <h1 id="project-form-title">{renaming ? 'Renomear bordado' : 'Novo bordado'}</h1>
      <label htmlFor="name">Nome do bordado</label>
      <input id="name" value={draft} onChange={event => setDraft(event.target.value)}
        required disabled={busy} autoFocus={!!onCancel} />
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
  onSubmit: (name: string) => void
  onCancel: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)

  useLayoutEffect(() => {
    const element = dialog.current!
    element.showModal()
    return () => element.close()
  }, [])

  return (
    <dialog ref={dialog} aria-labelledby="project-form-title" onCancel={event => {
      event.preventDefault()
      if (!busy) onCancel()
    }}>
      <ProjectForm mode={mode} initialName={mode === 'rename' ? name : ''}
        busy={busy} onSubmit={onSubmit} onCancel={onCancel} />
      {error && <p role="alert">{error}</p>}
    </dialog>
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

  async function create(name: string) {
    if (!db) return

    setBusy(true)
    setError('')
    const draft = { name, cells: Array<Ink>(cells * cells).fill(null) }
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

  const save = useCallback((cells: Ink[]) => {
    if (!db || selected === undefined) return

    const copy = cells.slice()
    setProjects(items => items.map(item => item.number === selected ? { ...item, cells: copy } : item))
    setError('')
    void saveProject(db, selected, copy).catch(() => setError('Não foi possível salvar a última edição.'))
  }, [db, selected])

  return (
    <div className="app">
      <header>
        <span className="brand">Linha a Bordo</span>
        {project && <>
          <h1 title={project.name}>{project.name}</h1>
          <span className="project-number">Bordado nº {project.number}</span>
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
