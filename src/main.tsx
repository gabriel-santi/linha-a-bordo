import { useLayoutEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './style.css'

const cells = 60
const pitch = 16
const size = cells * pitch + 2

function Grid() {
  const canvas = useRef<HTMLCanvasElement>(null)

  useLayoutEffect(() => {
    const ctx = canvas.current!.getContext('2d')!
    ctx.fillStyle = '#fffcf6'
    ctx.fillRect(0, 0, size, size)
    for (let line = 0; line <= cells; line++) {
      const major = line % 10 === 0
      const width = major ? 2 : 1
      const offset = line * pitch
      ctx.fillStyle = major ? '#535e4d' : '#b5b8ab'
      ctx.fillRect(offset, 0, width, size)
      ctx.fillRect(0, offset, size, width)
    }
  }, [])

  return <canvas ref={canvas} width={size} height={size} role="img"
    aria-label="Grade de bordado de 60 por 60 pontos" />
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
        <main className="editor"><Grid /></main>
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
