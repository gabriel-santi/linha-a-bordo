import { chromium, expect, test, type Page, type TestInfo } from '@playwright/test'
import { readLibrary, type Cell, type Drawing, type Layer } from './layer-data'

type Point = [number, number]
type Mark = [number, number, string]
const black = '#222222'
const blue = '#3066bd'
const red = '#c82e37'
const white = '#ffffff'
const empty = '#fffcf6'
const major = '#535e4d'
const fine = '#b5b8ab'
const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true })
const row = (page: Page, position: number) => button(page, 'Camada ' + position)
const select = (page: Page, position: number) => row(page, position).click()
const add = (page: Page) => button(page, 'Nova camada').click()
const range = (page: Page) => page.getByRole('slider', { name: 'Opacidade' })
const visibility = (page: Page) => page.getByRole('checkbox', { name: 'Visível' })
const undo = (page: Page) => page.keyboard.press('Control+z')
const redo = (page: Page) => page.keyboard.press('Control+y')
const grid = (page: Page) => page.locator('canvas')
const field = (page: Page, axis: string) => page.getByLabel(axis + ' (pontos)')
const read = async (page: Page, number = 1) => (await readLibrary(page)).projects.find(project => project.number === number)!

async function create(page: Page, name: string, width: number, height: number, number = 1) {
  if (number > 1) await button(page, 'Novo bordado').click()
  else await page.goto('/')
  await page.getByLabel('Nome do bordado').fill(name)
  await field(page, 'Largura').fill(String(width))
  await field(page, 'Altura').fill(String(height))
  await button(page, 'Criar bordado').click()
  await expectOpen(page, name, width, height, number)
}

async function expectOpen(page: Page, name: string, width: number, height: number, number = 1) {
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible()
  await expect(button(page, 'Bordado ' + number + ': ' + name)).toHaveAttribute('aria-current', 'true')
  await expect(grid(page)).toHaveAccessibleName('Grade de bordado de ' + width + ' por ' + height + ' pontos')
}

async function resize(page: Page, width: number, height: number) {
  await button(page, 'Redimensionar').click()
  await field(page, 'Largura').fill(String(width))
  await field(page, 'Altura').fill(String(height))
  await button(page, 'Aplicar dimensões').click()
}

async function point(page: Page, [col, row]: Point) {
  const box = (await grid(page).boundingBox())!
  const [width, height] = await grid(page).evaluate((canvas: HTMLCanvasElement) => [canvas.width, canvas.height])
  return [box.x + (col * 16 + 8) * box.width / width, box.y + (row * 16 + 8) * box.height / height] as const
}

async function draw(page: Page, from: Point, to?: Point) {
  await page.mouse.move(...await point(page, from))
  await page.mouse.down()
  if (to) await page.mouse.move(...await point(page, to))
  await page.mouse.up()
}

async function paint(page: Page, color: string, ...points: Point[]) {
  await button(page, color).click()
  for (const cell of points) await draw(page, cell)
}

async function opacity(page: Page, value: number) {
  await range(page).fill(String(value))
  await expect(range(page)).toHaveValue(String(value))
}

async function removePainted(page: Page) {
  await button(page, 'Excluir camada').click()
  await expect(page.getByRole('dialog')).toHaveAccessibleName('Excluir camada?')
  await button(page, 'Confirmar exclusão').click()
}

function cells(width: number, height: number, ...marks: Mark[]) {
  const all = Array<Cell>(width * height).fill(null)
  for (const [x, y, color] of marks) all[y * width + x] = color
  return all
}

function layer(id: string, cells: Cell[], opacity = 100, visible = true): Layer {
  return { id, cells, opacity, visible }
}

function expectDrawing(actual: Drawing, width: number, height: number, activeLayerId: string, ...layers: Layer[]) {
  expect(actual).toMatchObject({ width, height, activeLayerId, layers })
  expect(new Set(actual.layers.map(layer => layer.id)).size).toBe(layers.length)
}

function rgba(color: string) {
  return [1, 3, 5].map(index => parseInt(color.slice(index, index + 2), 16)).concat(255)
}

// Opaque destination. Compare against the source-over equation independently of Canvas.
function over(below: number[], ink: string, opacity: number) {
  return rgba(ink).map((source, index) => Math.round(source * opacity / 100 + below[index] * (1 - opacity / 100)))
}

function comparePixels(actual: number[][], expected: number[][]) {
  expect(actual).toHaveLength(expected.length)
  actual.forEach((pixel, i) => {
    for (let channel = 0; channel < 3; channel++) expect(Math.abs(pixel[channel] - expected[i][channel])).toBeLessThanOrEqual(1)
    expect(pixel[3]).toBe(255)
  })
}

async function editorPixels(page: Page, points: Point[], raw = false) {
  return grid(page).evaluate((element: HTMLCanvasElement, { points, raw }) => {
    const ctx = element.getContext('2d')!
    return points.map(([x, y]) => Array.from(ctx.getImageData(raw ? x : x * 16 + 8, raw ? y : y * 16 + 8, 1, 1).data))
  }, { points, raw })
}

async function expectPixels(page: Page, ...marks: Mark[]) {
  expect(await editorPixels(page, marks.map(([x, y]) => [x, y]))).toEqual(marks.map(([, , color]) => rgba(color)))
}

async function png(page: Page, info: TestInfo, filename: string, width: number, height: number, expected: number[][], artifact?: string) {
  const [file] = await Promise.all([page.waitForEvent('download'), button(page, 'Baixar PNG').click()])
  expect(file.suggestedFilename()).toBe(filename)
  expect(await file.failure()).toBeNull()
  if (artifact) await file.saveAs(info.outputPath(artifact + '.png'))
  const decoded = await page.evaluate(async ({ url, cells }) => {
    const bitmap = await createImageBitmap(await (await fetch(url)).blob())
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(bitmap, 0, 0)
    bitmap.close()
    const { width, height } = canvas
    const pixel = (x: number, y: number) => Array.from(ctx.getImageData(x, y, 1, 1).data)
    return {
      width, height,
      centers: Array.from({ length: cells }, (_, i) => pixel(i * 20 + 10, 10)),
      lines: [pixel(0, 10), pixel(0, 0), pixel(10, height - 1), pixel(width - 1, 10), pixel(10, 20)],
    }
  }, { url: file.url(), cells: expected.length })
  expect([decoded.width, decoded.height]).toEqual([width * 20, height * 20])
  comparePixels(decoded.centers, expected)
  expect(decoded.lines).toEqual([major, major, major, major, fine].map(rgba))
}

for (const viewport of [{ width: 1280, height: 720 }, { width: 1920, height: 1080 }]) {
  test('L1 L4 L9 opera as camadas por teclado em ' + viewport.width, async ({ page }, info) => {
    await page.setViewportSize(viewport)
    await create(page, 'Amostra', 60, 60)
    const panel = page.getByRole('region', { name: 'Camadas' })
    const initial = await read(page)
    expectDrawing(initial, 60, 60, initial.activeLayerId, layer(initial.activeLayerId, cells(60, 60)))
    await expect(button(page, 'Excluir camada')).toBeDisabled()
    await expect(button(page, 'Subir camada')).toBeDisabled()
    await expect(button(page, 'Descer camada')).toBeDisabled()
    await expect(panel.getByRole('textbox')).toHaveCount(0)
    await expect(panel.getByRole('button', { name: /renomear/i })).toHaveCount(0)

    await button(page, 'Redimensionar').focus()
    await page.keyboard.press('Tab')
    await expect(page.getByRole('region', { name: 'Área da grade' })).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(button(page, 'Nova camada')).toBeFocused()
    await page.keyboard.press('Enter')
    await page.keyboard.press('Space')
    await expect(row(page, 3)).toHaveAttribute('aria-pressed', 'true')
    await expect(panel.getByRole('listitem')).toHaveCount(3)

    await page.keyboard.press('Tab')
    await expect(row(page, 3)).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(row(page, 2)).toBeFocused()
    await page.keyboard.press('Enter')
    const identities = (await read(page)).layers.map(layer => layer.id)
    expect(new Set(identities).size).toBe(3)
    expect((await read(page)).activeLayerId).toBe(identities[1])
    await button(page, 'Subir camada').focus()
    await page.keyboard.press('Enter')
    await expect(row(page, 3)).toHaveAttribute('aria-pressed', 'true')
    await expect(button(page, 'Subir camada')).toBeDisabled()
    expect((await read(page)).layers.map(layer => layer.id)).toEqual([identities[0], identities[2], identities[1]])
    await button(page, 'Descer camada').focus()
    await undo(page)
    expect((await read(page)).layers.map(layer => layer.id)).toEqual(identities)
    await redo(page)
    await expect(row(page, 3)).toHaveAttribute('aria-pressed', 'true')

    await range(page).focus()
    await page.keyboard.press('Home')
    await expect(range(page)).toHaveValue('0')
    await undo(page)
    await expect(range(page)).toBeFocused()
    await expect(range(page)).toHaveValue('100')
    await redo(page)
    await expect(range(page)).toHaveValue('0')
    await visibility(page).focus()
    await page.keyboard.press('Space')
    await expect(page.getByRole('status').filter({ hasText: 'Mostre a camada para editar.' })).toBeVisible()
    await undo(page)
    await expect(visibility(page)).toBeChecked()
    await redo(page)
    await expect(visibility(page)).not.toBeChecked()
    await expect(panel).toBeInViewport({ ratio: 1 })
    await expect(button(page, 'Excluir camada')).toBeInViewport({ ratio: 1 })
    await range(page).focus()
    await expect(range(page)).toHaveCSS('outline-style', 'solid')
    await page.screenshot({ path: info.outputPath('painel.png') })

    const priorDelete = await read(page)
    await button(page, 'Excluir camada').click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(panel.getByRole('listitem')).toHaveCount(2)
    await undo(page)
    expect(await read(page)).toEqual(priorDelete)
    await select(page, 1)
    await page.reload()
    await expect(row(page, 1)).toHaveAttribute('aria-pressed', 'true')
    await expect(button(page, 'Descer camada')).toBeDisabled()
    expect((await read(page)).activeLayerId).toBe(identities[0])
  })
}

test('L1 L2 L3 L4 L8 compõe e edita três camadas, preservando pixels e histórico', async ({ page }, info) => {
  await create(page, 'Cor / trama', 5, 4)
  await paint(page, 'Azul', [0, 0], [1, 0], [2, 0])
  await add(page)
  await paint(page, 'Vermelho', [0, 0], [1, 0])
  await opacity(page, 50)
  await add(page)
  await paint(page, 'Branco', [0, 0], [2, 0], [4, 3])
  await expectPixels(page, [0, 0, white], [2, 0, white], [3, 0, empty])
  comparePixels(await editorPixels(page, [[1, 0]]), [over(rgba(blue), red, 50)])
  expect(await editorPixels(page, [[16, 8], [0, 8], [81, 8]], true)).toEqual([fine, major, major].map(rgba))

  await opacity(page, 50)
  const blended = over(over(rgba(blue), red, 50), white, 50)
  comparePixels(await editorPixels(page, [[0, 0], [2, 0]]), [blended, over(rgba(blue), white, 50)])
  await png(page, info, 'Cor _ trama.png', 5, 4, [blended, over(rgba(blue), red, 50), over(rgba(blue), white, 50), rgba(white)], 'composto')
  const box = (await range(page).boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.95, box.y + box.height / 2, { steps: 6 })
  await page.mouse.move(box.x + 1, box.y + box.height / 2, { steps: 12 })
  await page.mouse.up()
  await expect(range(page)).toHaveValue('0')
  await expect(range(page)).toBeFocused()
  await undo(page)
  await expect(range(page)).toHaveValue('50')
  await redo(page)
  await expect(range(page)).toHaveValue('0')
  await png(page, info, 'Cor _ trama.png', 5, 4, [over(rgba(blue), red, 50), over(rgba(blue), red, 50), rgba(blue)])

  await opacity(page, 100)
  await button(page, 'Descer camada').click()
  comparePixels(await editorPixels(page, [[0, 0], [1, 0], [2, 0]]), [over(rgba(white), red, 50), over(rgba(blue), red, 50), rgba(white)])
  await visibility(page).uncheck()
  const hidden = await read(page)
  await paint(page, 'Preto', [3, 0])
  expect(await read(page)).toEqual(hidden)
  await visibility(page).check()
  await button(page, 'Borracha').click()
  await draw(page, [0, 0])
  comparePixels(await editorPixels(page, [[0, 0]]), [over(rgba(blue), red, 50)])
  await png(page, info, 'Cor _ trama.png', 5, 4, [over(rgba(blue), red, 50), over(rgba(blue), red, 50), rgba(white)])
  await page.getByLabel('Tamanho da borracha').focus()
  await undo(page)
  await png(page, info, 'Cor _ trama.png', 5, 4, [over(rgba(white), red, 50), over(rgba(blue), red, 50), rgba(white)])
  await redo(page)
  const erased = await read(page)
  expect(erased.layers[0].cells).toEqual(cells(5, 4, [0, 0, blue], [1, 0, blue], [2, 0, blue]))
  expect(erased.layers[1].cells).toEqual(cells(5, 4, [2, 0, white], [4, 3, white]))
  expect(erased.layers[2].cells).toEqual(cells(5, 4, [0, 0, red], [1, 0, red]))

  await opacity(page, 0)
  await visibility(page).uncheck()
  const before = await read(page)
  await button(page, 'Excluir camada').click()
  await expect(page.getByRole('dialog')).toHaveAccessibleName('Excluir camada?')
  await undo(page)
  await page.keyboard.press('Escape')
  expect(await read(page)).toEqual(before)
  await removePainted(page)
  await expect(row(page, 2)).toHaveAttribute('aria-pressed', 'true')
  await undo(page)
  expect(await read(page)).toEqual(before)
  await redo(page)

  await button(page, 'Renomear').click()
  await page.getByLabel('Nome do bordado').fill('Outra trama')
  await button(page, 'Salvar nome').click()
  await expectOpen(page, 'Outra trama', 5, 4)
  await undo(page)
  expect(await read(page)).toEqual({ ...before, name: 'Outra trama' })
  await visibility(page).check()
  const edited = await read(page)
  await redo(page)
  expect(await read(page)).toEqual(edited)
})

test('L3 finaliza o traço quando a camada muda durante a captura', async ({ page }) => {
  await create(page, 'Traço', 8, 5)
  await paint(page, 'Azul', [0, 0])
  await add(page)
  await button(page, 'Vermelho').click()
  for (let i = 0; i < 6; i++) await button(page, 'Aumentar zoom').click()
  await expect(page.getByLabel('Zoom atual')).toHaveText('400%')
  await page.getByRole('region', { name: 'Área da grade' }).evaluate(area => { area.scrollTo(0, 0) })

  await page.mouse.move(...await point(page, [0, 0]))
  await page.mouse.down()
  await page.mouse.move(...await point(page, [1, 0]))
  await row(page, 1).focus()
  await page.keyboard.press('Enter')
  await page.mouse.move(...await point(page, [1, 1]))
  await page.mouse.up()
  await expectPixels(page, [0, 0, red], [1, 0, red], [1, 1, empty])
  const current = await read(page)
  expect(current.layers[0].cells).toEqual(cells(8, 5, [0, 0, blue]))
  expect(current.layers[1].cells).toEqual(cells(8, 5, [0, 0, red], [1, 0, red]))
  await undo(page)
  await expectPixels(page, [0, 0, blue], [1, 0, empty])
  await redo(page)
  await expectPixels(page, [0, 0, red], [1, 0, red])
  await select(page, 1)
  await button(page, 'Preto').click()
  await draw(page, [1, 0])
  await expectPixels(page, [1, 0, red])
  await button(page, 'Subir camada').click()
  await expectPixels(page, [0, 0, blue], [1, 0, black])
})

test('L5 remapeia três camadas e confirma corte de branco oculto a 0%', async ({ page }, info) => {
  await create(page, 'Pilha grande', 80, 70)
  await paint(page, 'Azul', [0, 0], [1, 0])
  await add(page)
  await paint(page, 'Vermelho', [0, 0])
  await opacity(page, 50)
  await add(page)
  await paint(page, 'Branco', [0, 0], [2, 2])
  await opacity(page, 50)
  await resize(page, 200, 200)
  await expectOpen(page, 'Pilha grande', 200, 200)
  const before = await read(page)
  const [a, b, c] = before.layers.map(layer => layer.id)
  expectDrawing(before, 200, 200, c,
    layer(a, cells(200, 200, [0, 0, blue], [1, 0, blue])),
    layer(b, cells(200, 200, [0, 0, red]), 50),
    layer(c, cells(200, 200, [0, 0, white], [2, 2, white]), 50))

  await opacity(page, 0)
  await visibility(page).uncheck()
  const beforeCrop = await read(page)
  await resize(page, 200, 200)
  expect(await read(page)).toEqual(beforeCrop)
  await resize(page, 200, 1)
  await expect(page.getByRole('dialog')).toHaveAccessibleName('Confirmar corte')
  await page.keyboard.press('Escape')
  expect(await read(page)).toEqual(beforeCrop)
  await resize(page, 200, 1)
  await button(page, 'Confirmar corte').click()
  await expectOpen(page, 'Pilha grande', 200, 1)
  expectDrawing(await read(page), 200, 1, c, layer(a, cells(200, 1, [0, 0, blue], [1, 0, blue])),
    layer(b, cells(200, 1, [0, 0, red]), 50), layer(c, cells(200, 1, [0, 0, white]), 0, false))
  await undo(page)
  expect(await read(page)).toEqual(beforeCrop)
  await redo(page)
  await resize(page, 1, 200)
  await button(page, 'Confirmar corte').click()
  await expectOpen(page, 'Pilha grande', 1, 200)
  expectDrawing(await read(page), 1, 200, c, layer(a, cells(1, 200, [0, 0, blue])),
    layer(b, cells(1, 200, [0, 0, red]), 50), layer(c, cells(1, 200, [0, 0, white]), 0, false))
  await png(page, info, 'Pilha grande.png', 1, 200, [over(rgba(blue), red, 50)])
  await undo(page)
  await undo(page)
  expect(await read(page)).toEqual(beforeCrop)
})

test('L8 exporta três camadas a 4000 × 4000, preservando pilhas de dois bordados', async ({ page }, info) => {
  await create(page, 'Pilha grande', 200, 200)
  await paint(page, 'Azul', [0, 0], [1, 0])
  await add(page)
  await paint(page, 'Vermelho', [0, 0])
  await opacity(page, 50)
  await add(page)
  await paint(page, 'Branco', [0, 0], [2, 2])
  await opacity(page, 50)
  await select(page, 1)
  await button(page, 'Aumentar zoom').click()
  const snapshot = await read(page)
  await png(page, info, 'Pilha grande.png', 200, 200, [over(over(rgba(blue), red, 50), white, 50), rgba(blue)], '4000')
  expect(await read(page)).toEqual(snapshot)
  await select(page, 3)
  await opacity(page, 0)
  await visibility(page).uncheck()
  const hidden = await read(page)

  await create(page, 'Outro', 3, 4, 2)
  await paint(page, 'Preto', [0, 0])
  await add(page)
  await paint(page, 'Branco', [0, 0])
  await png(page, info, 'Outro.png', 3, 4, [rgba(white), rgba(white)])
  await button(page, 'Bordado 1: Pilha grande').click()
  await png(page, info, 'Pilha grande.png', 200, 200, [over(rgba(blue), red, 50), rgba(blue)])
  expect(await read(page)).toEqual(hidden)
})

test('L7 recupera um journal legado retangular e preserva pilha diante de journal antigo', async ({ page }, info) => {
  await page.goto('/')
  await expect(page.getByLabel('Nome do bordado')).toBeVisible()
  const existing = [
    layer('base', cells(4, 3, [0, 0, red])),
    layer('topo', cells(4, 3, [1, 0, white]), 65, false),
  ]
  const legacy = cells(5, 3, [0, 0, white], [4, 2, blue])
  await page.evaluate(({ existing, legacy, old }) => new Promise<void>((resolve, reject) => {
    const request = indexedDB.open('linha-a-bordo', 2)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const db = request.result
      const tx = db.transaction(['projects', 'settings'], 'readwrite')
      const store = tx.objectStore('projects')
      store.add({ number: 4, name: 'Legado', width: 3, height: 4, cells: old })
      store.add({ number: 5, name: 'Existente', width: 4, height: 3, layers: existing, activeLayerId: 'base' })
      tx.objectStore('settings').put(4, 'selected')
      localStorage.setItem('linha-a-bordo:pending:4', JSON.stringify({ width: 5, height: 3, cells: legacy, revision: [1, 3] }))
      localStorage.setItem('linha-a-bordo:pending:5', JSON.stringify({ width: 3, height: 4, cells: old, revision: [1, 4] }))
      tx.oncomplete = () => { db.close(); resolve() }
      tx.onabort = () => { db.close(); reject(tx.error) }
    }
  }), { existing, legacy, old: cells(3, 4, [2, 3, black]) })
  await page.reload()
  await expectOpen(page, 'Legado', 5, 3, 4)
  await expectPixels(page, [0, 0, white], [4, 2, blue], [2, 1, empty])
  const migrated = await read(page, 4)
  expectDrawing(migrated, 5, 3, migrated.activeLayerId, layer(migrated.activeLayerId, legacy))
  expectDrawing(await read(page, 5), 4, 3, 'base', ...existing)
  expect(await journals(page)).toEqual({})
  await add(page)
  await paint(page, 'Preto', [1, 0])
  await resize(page, 6, 4)
  await button(page, 'Renomear').click()
  await page.getByLabel('Nome do bordado').fill('Acervo revisto')
  await button(page, 'Salvar nome').click()
  await expectOpen(page, 'Acervo revisto', 6, 4, 4)
  await png(page, info, 'Acervo revisto.png', 6, 4, [rgba(white), rgba(black)])
  const snapshot = await readLibrary(page)
  await page.reload()
  await expectOpen(page, 'Acervo revisto', 6, 4, 4)
  await expectPixels(page, [0, 0, white], [1, 0, black], [4, 2, blue])
  expect(await readLibrary(page)).toEqual(snapshot)
  await button(page, 'Bordado 5: Existente').click()
  await expectOpen(page, 'Existente', 4, 3, 5)
  await expectPixels(page, [0, 0, red], [1, 0, empty])
})

function journals(page: Page) {
  return page.evaluate(() => Object.fromEntries(Object.entries(localStorage)
    .filter(([key]) => key.startsWith('linha-a-bordo:pending'))
    .map(([key, value]) => [key.slice('linha-a-bordo:'.length), JSON.parse(value)])))
}

async function lock(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    const open = indexedDB.open('linha-a-bordo')
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const db = open.result
      const tx = db.transaction(['projects', 'settings'], 'readwrite')
      const store = tx.objectStore('projects')
      function hold() {
        store.get(1).onsuccess = hold
      }
      window.addEventListener('release-layers', () => tx.abort(), { once: true })
      tx.onabort = () => db.close()
      store.get(1).onsuccess = () => { hold(); resolve() }
    }
  }))
}

const unlock = (page: Page) => page.evaluate(() => window.dispatchEvent(new Event('release-layers')))

test('@L9P a recupera pintura, seleção, ordem e opacidade após recarga imediata', async ({ page, context }) => {
  await create(page, 'Primeiro', 6, 4)
  await paint(page, 'Azul', [0, 0])
  await add(page)
  await paint(page, 'Vermelho', [0, 0])
  await add(page)
  const [a, b, c] = (await read(page)).layers.map(layer => layer.id)
  const blocker = await context.newPage()
  await blocker.goto('/')
  await expectOpen(blocker, 'Primeiro', 6, 4)
  const expected = [
    layer(a, cells(6, 4, [0, 0, blue])),
    layer(c, cells(6, 4, [0, 0, white], [1, 0, white]), 50),
    layer(b, cells(6, 4, [0, 0, red]), 50),
  ]
  await lock(blocker)
  try {
    await opacity(page, 50)
    await button(page, 'Descer camada').click()
    await select(page, 3)
    await opacity(page, 50)
    await select(page, 2)
    await button(page, 'Branco').click()
    await draw(page, [0, 0])
    await page.evaluate(() => window.addEventListener('pointerup', () => location.reload(), { once: true }))
    const reload = page.waitForEvent('load')
    await draw(page, [1, 0])
    await reload
    expectDrawing((await journals(blocker))['pending:1'], 6, 4, c, ...expected)
  } finally {
    await unlock(blocker)
  }

  await expectOpen(page, 'Primeiro', 6, 4)
  await expect(row(page, 2)).toHaveAttribute('aria-pressed', 'true')
  await expect(range(page)).toHaveValue('50')
  comparePixels(await editorPixels(page, [[0, 0], [1, 0], [2, 0]]),
    [over(over(rgba(blue), white, 50), red, 50), over(rgba(empty), white, 50), rgba(empty)])
  expectDrawing(await read(page), 6, 4, c, ...expected)
  expect(await journals(page)).toEqual({})
})

test('@L9P b fecha e reabre após exclusão, undo e redo com camada oculta', async ({ baseURL }, info) => {
  const launch = () => chromium.launchPersistentContext(info.outputPath('p'), { baseURL })
  let browser = await launch()
  try {
    let page = browser.pages()[0]
    await create(page, 'Fechar', 6, 4)
    await paint(page, 'Azul', [0, 0])
    await add(page)
    await paint(page, 'Branco', [0, 0], [1, 0])
    await opacity(page, 0)
    await visibility(page).uncheck()
    const before = await read(page)
    const [a, b] = before.layers.map(layer => layer.id)
    expectDrawing(before, 6, 4, b, layer(a, cells(6, 4, [0, 0, blue])), layer(b, cells(6, 4, [0, 0, white], [1, 0, white]), 0, false))
    await removePainted(page)
    await undo(page)
    await browser.close()

    browser = await launch()
    page = browser.pages()[0]
    await page.goto('/')
    await expectOpen(page, 'Fechar', 6, 4)
    await expect(row(page, 2)).toHaveAttribute('aria-pressed', 'true')
    await expect(visibility(page)).not.toBeChecked()
    await expect(range(page)).toHaveValue('0')
    await expectPixels(page, [0, 0, blue], [1, 0, empty])
    expect(await read(page)).toEqual(before)
    await removePainted(page)
    await undo(page)
    await redo(page)
    await browser.close()

    browser = await launch()
    page = browser.pages()[0]
    await page.goto('/')
    await expectOpen(page, 'Fechar', 6, 4)
    await expect(row(page, 1)).toHaveAttribute('aria-pressed', 'true')
    await expect(button(page, 'Excluir camada')).toBeDisabled()
    await expectPixels(page, [0, 0, blue], [1, 0, empty])
    expect(await read(page)).toEqual({ ...before, activeLayerId: a, layers: [before.layers[0]] })
    expect(await journals(page)).toEqual({})
  } finally {
    await browser.close()
  }
})

test('@L9P c alterna projetos com pilhas e geometrias distintas enquanto gravação aguarda', async ({ page, context }) => {
  await create(page, 'Norte', 6, 4)
  await paint(page, 'Azul', [0, 0])
  await add(page)
  const [a, b] = (await read(page)).layers.map(layer => layer.id)
  await create(page, 'Sul', 3, 8, 2)
  await add(page)
  await paint(page, 'Branco', [0, 0], [2, 7])
  await add(page)
  const [c, d, e] = (await read(page, 2)).layers.map(layer => layer.id)
  expect(new Set([a, b, c, d, e]).size).toBe(5)
  const south = [
    layer(c, cells(5, 9)),
    layer(e, cells(5, 9, [0, 0, red], [4, 8, red]), 50),
    layer(d, cells(5, 9, [0, 0, white], [2, 7, white])),
  ]
  const north = [layer(a, cells(8, 5, [0, 0, blue])), layer(b, cells(8, 5, [7, 4, black]), 0)]
  const blocker = await context.newPage()
  await blocker.goto('/')
  await expectOpen(blocker, 'Sul', 3, 8, 2)
  await lock(blocker)
  try {
    await resize(page, 5, 9)
    await paint(page, 'Vermelho', [0, 0], [4, 8])
    await opacity(page, 50)
    await button(page, 'Descer camada').click()
    await button(page, 'Bordado 1: Norte').click()
    await resize(page, 8, 5)
    await draw(page, [7, 4])
    await opacity(page, 0)
    await undo(page)
    await redo(page)
    await button(page, 'Bordado 2: Sul').click()
    await undo(page)
    await expectOpen(page, 'Sul', 5, 9, 2)
    await expect(row(page, 2)).toHaveAttribute('aria-pressed', 'true')
    await expectPixels(page, [0, 0, white], [2, 7, white])
    await button(page, 'Bordado 1: Norte').click()
    const pending = await journals(blocker)
    expectDrawing(pending['pending:1'], 8, 5, b, ...north)
    expectDrawing(pending['pending:2'], 5, 9, e, ...south)
    expect(pending['pending-selection'].number).toBe(1)
    await page.reload()
  } finally {
    await unlock(blocker)
  }

  await expectOpen(page, 'Norte', 8, 5)
  await expectPixels(page, [0, 0, blue], [7, 4, empty])
  const library = await readLibrary(page)
  expect(library.selected).toBe(1)
  expect(library.projects.map(({ number, name }) => [number, name])).toEqual([[1, 'Norte'], [2, 'Sul']])
  expectDrawing(library.projects[0], 8, 5, b, ...north)
  expectDrawing(library.projects[1], 5, 9, e, ...south)
  expect(await journals(page)).toEqual({})
  await button(page, 'Bordado 2: Sul').click()
  await expectOpen(page, 'Sul', 5, 9, 2)
  await expectPixels(page, [0, 0, white], [2, 7, white])
  comparePixels(await editorPixels(page, [[4, 8]]), [over(rgba(empty), red, 50)])
})

test('L6 sinaliza falha de gravação e mantém o último estado persistido', async ({ page }) => {
  await create(page, 'Gravação', 5, 4)
  await paint(page, 'Azul', [0, 0])
  await add(page)
  const stored = await read(page)
  await page.evaluate(() => {
    const transaction = IDBDatabase.prototype.transaction
    IDBDatabase.prototype.transaction = function (...args) {
      const tx = transaction.apply(this, args)
      if (args[0] === 'projects' && args[1] === 'readwrite') tx.abort()
      return tx
    }
    Storage.prototype.setItem = function () { throw new DOMException('Sem espaço', 'QuotaExceededError') }
  })
  await paint(page, 'Vermelho', [0, 0])
  await expect(page.getByRole('alert')).toHaveText('Não foi possível salvar a última edição.')
  await expectPixels(page, [0, 0, red])
  expect(await read(page)).toEqual(stored)
  await page.reload()
  await expectOpen(page, 'Gravação', 5, 4)
  await expectPixels(page, [0, 0, blue])
  expect(await read(page)).toEqual(stored)
})
