import { useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react'
import { createRoot } from 'react-dom/client'
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
function paintSegment(ctx: CanvasRenderingContext2D, from: Point, to: Point, ink: Ink) {
  let col = Math.floor(from.x)
  let row = Math.floor(from.y)
  const endCol = Math.floor(to.x)
  const endRow = Math.floor(to.y)
  const dx = to.x - from.x
  const dy = to.y - from.y
  const stepX = Math.sign(dx)
  const stepY = Math.sign(dy)

  paintCell(ctx, col, row, ink)
  while (col !== endCol || row !== endRow) {
    const nextX = col === endCol ? Infinity : (col + (stepX > 0 ? 1 : 0) - from.x) / dx
    const nextY = row === endRow ? Infinity : (row + (stepY > 0 ? 1 : 0) - from.y) / dy
    if (nextX <= nextY) col += stepX
    if (nextY <= nextX) row += stepY
    paintCell(ctx, col, row, ink)
  }
}

function pointerPoint(event: PointerEvent<HTMLCanvasElement>) {
  const { left, top, width, height } = event.currentTarget.getBoundingClientRect()
  return {
    x: (event.clientX - left) * size / (width * pitch),
    y: (event.clientY - top) * size / (height * pitch),
  }
}

function Grid({ ink }: { ink: Ink }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const gesture = useRef<{ id: number, point: Point, ink: Ink } | null>(null)

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
  }, [])

  function start(event: PointerEvent<HTMLCanvasElement>) {
    if (event.button !== 0 || gesture.current) return

    const point = pointerPoint(event)
    event.currentTarget.setPointerCapture(event.pointerId)
    gesture.current = { id: event.pointerId, point, ink }
    paintSegment(event.currentTarget.getContext('2d')!, point, point, ink)
  }

  function move(event: PointerEvent<HTMLCanvasElement>) {
    const active = gesture.current
    if (!active || active.id !== event.pointerId) return

    const point = pointerPoint(event)
    paintSegment(event.currentTarget.getContext('2d')!, active.point, point, active.ink)
    active.point = point
  }

  function end(event: PointerEvent<HTMLCanvasElement>) {
    if (gesture.current?.id === event.pointerId) gesture.current = null
  }

  return <canvas ref={canvas} width={size} height={size} role="img"
    aria-label="Grade de bordado de 60 por 60 pontos"
    onPointerDown={start} onPointerMove={move}
    onPointerUp={event => { move(event); end(event) }}
    onPointerCancel={end} onLostPointerCapture={end} />
}

function Editor() {
  const [ink, setInk] = useState<Ink>(palette[0][1])

  return (
    <main className="editor">
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
      <div className="grid-area"><Grid ink={ink} /></div>
    </main>
  )
}


function App() {
  const [draft, setDraft] = useState('')
  const [name, setName] = useState('')
  return (
    <div className="app">
      <header><span className="brand">Linha a Bordo</span>
        {name && <h1 title={name}>{name}</h1>}
      </header>
      {name ? (
        <Editor />
      ) : (
        <main className="start">
          <form onSubmit={event => {
            event.preventDefault()
            if (draft.trim()) setName(draft.trim())
          }}>
            <h1>Novo bordado</h1>
            <label htmlFor="name">Nome do bordado</label>
            <input id="name" value={draft} onChange={event => setDraft(event.target.value)} required />
            <button disabled={!draft.trim()}>Criar bordado</button>
          </form>
        </main>
      )}
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
