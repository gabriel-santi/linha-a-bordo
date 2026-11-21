import { chromium, expect, test, type Page, type TestInfo } from '@playwright/test'
import { readLibrary, singleLayer } from './layer-data'

type Dimensions = readonly [width: number, height: number]
type Point = readonly [x: number, y: number]
type Painted = readonly [x: number, y: number, ink: string]
type Stored = { width: number, height: number, cells: (string | null)[] }
const empty = '#fffcf6'
const white = '#ffffff'
const black = '#222222'
const red = '#c82e37'
const blue = '#3066bd'
const major = '#535e4d'
const fine = '#b5b8ab'
const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true })
const canvas = (page: Page) => page.locator('canvas')
const widthField = (page: Page) => page.getByLabel('Largura (pontos)')
const heightField = (page: Page) => page.getByLabel('Altura (pontos)')
const dialog = (page: Page) => page.getByRole('dialog')
const undo = (page: Page) => page.keyboard.press('Control+z')
const redo = (page: Page) => page.keyboard.press('Control+y')

async function expectGrid(page: Page, [width, height]: Dimensions) {
  await expect(page.getByRole('img', { name: 'Grade de bordado de ' + width + ' por ' + height + ' pontos' })).toBeVisible()
  await expect(canvas(page)).toHaveAttribute('width', String(width * 16 + 2))
  await expect(canvas(page)).toHaveAttribute('height', String(height * 16 + 2))
}

async function expectProject(page: Page, number: number, name: string, size: Dimensions) {
  await expect(page.getByRole('banner').getByRole('heading')).toHaveText(name)
  await expect(button(page, 'Bordado ' + number + ': ' + name)).toHaveAttribute('aria-current', 'true')
  await expectGrid(page, size)
}

async function setDimensions(page: Page, [width, height]: Dimensions) {
  await widthField(page).fill(String(width))
  await heightField(page).fill(String(height))
}

async function create(page: Page, number: number, name: string, size?: Dimensions) {
  if (number > 1) await button(page, 'Novo bordado').click()
  await page.getByLabel('Nome do bordado').fill(name)
  await expect(widthField(page)).toHaveValue('60')
  await expect(heightField(page)).toHaveValue('60')
  if (size) await setDimensions(page, size)
  await button(page, 'Criar bordado').click()
  await expectProject(page, number, name, size ?? [60, 60])
}

async function requestResize(page: Page, size: Dimensions) {
  await button(page, 'Redimensionar').click()
  await setDimensions(page, size)
  await button(page, 'Aplicar dimensões').click()
}

async function resize(page: Page, size: Dimensions, crop = false) {
  await requestResize(page, size)
  if (crop) {
    await expect(dialog(page)).toHaveAccessibleName('Confirmar corte')
    await button(page, 'Confirmar corte').click()
  }
  await expect(dialog(page)).toHaveCount(0)
  await expectGrid(page, size)
}

async function draw(page: Page, from: Point, to = from) {
  const grid = canvas(page)
  const box = (await grid.boundingBox())!
  const [width, height] = await grid.evaluate((element: HTMLCanvasElement) => [element.width, element.height])
  const move = ([x, y]: Point) => page.mouse.move(box.x + (x * 16 + 8) * box.width / width, box.y + (y * 16 + 8) * box.height / height)
  await move(from)
  await page.mouse.down()
  if (to !== from) await move(to)
  await page.mouse.up()
}

function pixels(page: Page, points: Point[], centers = true) {
  return canvas(page).evaluate((grid: HTMLCanvasElement, { points, centers }) => {
    const ctx = grid.getContext('2d')!
    return points.map(([x, y]) => {
      const { data } = ctx.getImageData(centers ? x * 16 + 8 : x, centers ? y * 16 + 8 : y, 1, 1)
      return '#' + [...data.slice(0, 3)].map(value => value.toString(16).padStart(2, '0')).join('')
    })
  }, { points, centers })
}

async function expectPixels(page: Page, cells: Painted[]) {
  await expect.poll(() => pixels(page, cells.map(([x, y]) => [x, y]))).toEqual(cells.map(([, , ink]) => ink))
}

function gridData([width, height]: Dimensions, painted: Painted[] = []): Stored {
  const cells = Array<string | null>(width * height).fill(null)
  for (const [x, y, ink] of painted) cells[y * width + x] = ink
  return { width, height, cells }
}

function saved(number: number, name: string, size: Dimensions, painted: Painted[] = []) {
  return { number, name, ...layeredGrid(size, painted) }
}

function layeredGrid(size: Dimensions, painted: Painted[]) {
  const { width, height, cells } = gridData(size, painted)
  return { width, height, ...singleLayer(cells) }
}

function errorsOn(page: Page) {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
  return errors
}

async function png(page: Page, info: TestInfo, label: string, filename: string, [columns, rows]: Dimensions, painted: Painted[] = []) {
  const [download] = await Promise.all([page.waitForEvent('download'), button(page, 'Baixar PNG').click()])
  expect(download.suggestedFilename()).toBe(filename)
  expect(await download.failure()).toBeNull()
  expect(download.url()).toMatch(/^data:image\/png;base64,/)
  await download.saveAs(info.outputPath(label + '.png'))
  const image = await page.evaluate(async (url) => {
    const image = await createImageBitmap(await (await fetch(url)).blob())
    const grid = document.createElement('canvas')
    const { width, height } = image
    grid.width = width
    grid.height = height
    const ctx = grid.getContext('2d')!
    ctx.drawImage(image, 0, 0)
    image.close()
    const { data } = ctx.getImageData(0, 0, width, height)
    const rgb = (x: number, y: number) => {
      const index = 4 * (y * width + x)
      return '#' + Array.from(data.subarray(index, index + 3), value => value.toString(16).padStart(2, '0')).join('')
    }
    const centers = []
    for (let y = 10; y < height; y += 20) {
      for (let x = 10; x < width; x += 20) centers.push(rgb(x, y))
    }
    return { width, height, centers,
      horizontal: Array.from({ length: width }, (_, x) => rgb(x, 10)),
      vertical: Array.from({ length: height }, (_, y) => rgb(10, y)),
      opaque: data.every((value, index) => index % 4 !== 3 || value === 255),
      hash: Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data))),
    }
  }, download.url())
  expect([image.width, image.height]).toEqual([columns * 20, rows * 20])
  expect(image.opaque).toBe(true)
  expect(image.centers).toEqual(gridData([columns, rows], painted).cells.map(ink => ink ?? white))
  const checkLines = (scan: string[]) => {
    for (let offset = 0; offset < scan.length; offset += 20) {
      expect(scan[offset]).toBe(offset % 200 === 0 ? major : fine)
    }
    expect(scan.slice(-2)).toEqual([major, major])
  }
  checkLines(image.horizontal)
  checkLines(image.vertical)
  return image.hash
}

test('D1 valida os eixos separadamente e cria seis combinações sem perder seleção ou numeração', async ({ page }) => {
  await page.goto('/')
  await expect(widthField(page)).toHaveValue('60')
  await expect(heightField(page)).toHaveValue('60')
  await page.getByLabel('Nome do bordado').fill('Inválido')
  for (const field of [widthField(page), heightField(page)]) {
    for (const invalid of ['', '0', '-1', '1.5', '201', 'abc']) {
      await field.fill(invalid)
      await field.press('Enter')
      await expect(field).toHaveAttribute('aria-invalid', 'true')
      await expect(field).toHaveAccessibleDescription('Use um inteiro de 1 a 200.')
      await expect(page.getByRole('img')).toHaveCount(0)
    }
    await field.fill('60')
  }
  expect(await readLibrary(page)).toEqual({ projects: [], selected: undefined })
  const sizes = [[60, 60], [80, 70], [1, 1], [1, 200], [200, 1], [200, 200]] as const
  for (const [i, size] of sizes.entries()) await create(page, i + 1, 'Bordado ' + (i + 1), i === 0 ? undefined : size)
  await expect(page.getByRole('navigation').getByRole('button')).toHaveText(['1', '2', '3', '4', '5', '6'])
  expect(await readLibrary(page)).toEqual({
    projects: sizes.map((size, i) => saved(i + 1, 'Bordado ' + (i + 1), size)), selected: 6,
  })
})

for (const viewport of [{ width: 1280, height: 720 }, { width: 1920, height: 1080 }]) {
  test('D2 D3 D9 redimensiona por teclado e protege histórico em ' + viewport.width, async ({ page }, info) => {
    const errors = errorsOn(page)
    await page.setViewportSize(viewport)
    await page.goto('/')
    await create(page, 1, 'Teclado', [80, 70])
    await button(page, 'Branco').click()
    await draw(page, [79, 3])
    await expectPixels(page, [[79, 3, white]])
    const original = { projects: [saved(1, 'Teclado', [80, 70], [[79, 3, white]])], selected: 1 }
    const control = button(page, 'Redimensionar')
    for (const label of ['Redimensionar', 'Novo bordado', 'Renomear', 'Baixar PNG', 'Borracha', 'Aumentar zoom']) {
      await expect(button(page, label)).toBeInViewport({ ratio: 1 })
    }
    await expect(canvas(page)).toBeInViewport({ ratio: 1 })
    await control.focus()
    await page.keyboard.press('Enter')
    await expect(dialog(page)).toHaveAccessibleName('Redimensionar bordado')
    await expect(widthField(page)).toBeFocused()
    await expect(widthField(page)).toHaveValue('80')
    await expect(heightField(page)).toHaveValue('70')
    await widthField(page).fill('201')
    await page.keyboard.press('Enter')
    await expect(widthField(page)).toHaveAccessibleDescription('Use um inteiro de 1 a 200.')
    await page.screenshot({ path: info.outputPath('dimensao-invalida.png') })
    await undo(page)
    await redo(page)
    await expect(canvas(page)).toHaveAttribute('width', String(80 * 16 + 2))
    await expectPixels(page, [[79, 3, white]])
    await widthField(page).fill('79')
    await page.keyboard.press('Tab')
    await expect(heightField(page)).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(dialog(page)).toHaveAccessibleName('Confirmar corte')
    await expect(button(page, 'Cancelar')).toBeFocused()
    await page.screenshot({ path: info.outputPath('confirmar-corte.png') })
    await undo(page)
    await redo(page)
    await page.keyboard.press('Escape')
    await expect(control).toBeFocused()
    await expectGrid(page, [80, 70])
    await requestResize(page, [79, 70])
    await button(page, 'Cancelar').press('Space')
    await expect(dialog(page)).toHaveCount(0)
    expect(await readLibrary(page)).toEqual(original)
    await requestResize(page, [79, 70])
    await page.keyboard.press('Tab')
    await expect(button(page, 'Confirmar corte')).toBeFocused()
    await page.keyboard.press('Enter')
    await expectGrid(page, [79, 70])
    await page.getByLabel('Hexadecimal').focus()
    await undo(page)
    await expectGrid(page, [79, 70])
    await page.getByLabel('Cor', { exact: true }).focus()
    await undo(page)
    await expectGrid(page, [79, 70])
    await page.getByLabel('Tamanho da borracha').focus()
    await undo(page)
    await expectGrid(page, [80, 70])
    await expectPixels(page, [[79, 3, white]])
    await redo(page)
    await expectGrid(page, [79, 70])
    expect(errors).toEqual([])
  })
}

test('D2 D3 D5 remapeia duas geometrias e passa por pintura, corte, desfazer e refazer', async ({ page }, info) => {
  await page.goto('/')
  await create(page, 1, 'Grade / cores', [80, 70])
  const colors = [[3, 2, red], [79, 2, blue], [2, 69, white], [79, 69, black]] as const
  for (const [i, label] of ['Vermelho', 'Azul', 'Branco', 'Preto'].entries()) {
    await button(page, label).click()
    await draw(page, [colors[i][0], colors[i][1]])
  }
  const full = await png(page, info, 'antes', 'Grade _ cores.png', [80, 70], [...colors])
  await resize(page, [82, 71])
  await expectPixels(page, [...colors, [80, 2, empty], [2, 70, empty], [81, 70, empty]])
  await resize(page, [80, 71])
  await resize(page, [80, 70])
  await expectPixels(page, [...colors])
  await resize(page, [79, 69], true)
  const clipped = await png(page, info, 'recorte', 'Grade _ cores.png', [79, 69], [colors[0]])
  await button(page, 'Azul').click()
  await draw(page, [78, 68])
  await undo(page)
  await expectPixels(page, [colors[0], [78, 68, empty]])
  await undo(page)
  expect(await png(page, info, 'recorte-desfeito', 'Grade _ cores.png', [80, 70], [...colors])).toEqual(full)
  await resize(page, [80, 70])
  await redo(page)
  expect(await png(page, info, 'recorte-refeito', 'Grade _ cores.png', [79, 69], [colors[0]])).toEqual(clipped)
  await redo(page)
  await expectPixels(page, [[78, 68, blue], colors[0]])
  for (let i = 0; i < 6; i++) await undo(page)
  await expectGrid(page, [80, 70])
  await expectPixels(page, [colors[0], colors[1], colors[2], [79, 69, empty]])
  await draw(page, [77, 68])
  await redo(page)
  await expectGrid(page, [80, 70])
  await expectPixels(page, [[77, 68, blue], [79, 69, empty]])
  await create(page, 2, 'Segundo', [1, 1])
  await undo(page)
  await png(page, info, 'segundo', 'Segundo.png', [1, 1])
  await button(page, 'Bordado 1: Grade / cores').click()
  await undo(page)
  await expectPixels(page, [[77, 68, blue], [79, 69, empty]])
})

for (const [width, height] of [[80, 70], [1, 200], [200, 1], [200, 200]] as const) {
  test('D4 D5 ajusta, percorre e exporta ' + width + ' × ' + height, async ({ page }, info) => {
    const errors = errorsOn(page)
    const size = [width, height] as const
    await page.setViewportSize({ width: 1280, height: 720 })
    await page.goto('/')
    await create(page, 1, 'Grade', size)
    const area = page.getByRole('region', { name: 'Área da grade' })
    const geometry = () => canvas(page).evaluate((element: HTMLCanvasElement) => {
      const { width, height } = element.getBoundingClientRect()
      return { width, height, aspect: element.width / element.height }
    })
    await expect(canvas(page)).toBeInViewport({ ratio: 1 })
    const fit = await geometry()
    expect(fit.width / fit.height).toBeCloseTo(fit.aspect, width > height * 10 ? 0 : 2)
    const to: Point = [width === 1 ? 0 : 12, height === 1 ? 0 : 12]
    await draw(page, [0, 0], to)
    const path: Painted[] = Array.from({ length: 13 }, (_, i) => [width === 1 ? 0 : i, height === 1 ? 0 : i, black])
    const edge: Painted = [width - 1, height - 1, blue]
    await button(page, 'Azul').click()
    const border: Painted[] = Array.from({ length: 6 }, (_, i) => [edge[0] - (width > 1 ? i : 0), edge[1] - (width === 1 ? i : 0), blue])
    await draw(page, [edge[0], edge[1]], [border[5][0], border[5][1]])
    await expectPixels(page, [...path, ...border])
    const { projects } = await readLibrary(page)
    const painted: Painted[] = []
    projects[0].layers[0].cells.forEach((ink, i) => {
      if (ink === null) return
      const x = i % width
      const y = Math.floor(i / width)
      if (ink === black) {
        expect(x).toBeLessThanOrEqual(to[0])
        expect(y).toBeLessThanOrEqual(to[1])
        if (width > 1 && height > 1) expect(Math.abs(x - y)).toBeLessThanOrEqual(1)
      } else expect(border).toContainEqual([x, y, ink])
      painted.push([x, y, ink])
    })
    const expected = await png(page, info, 'ajustado', 'Grade.png', size, painted)
    for (let i = 0; i < 6; i++) {
      await button(page, 'Aumentar zoom').click()
      await expect(page.getByLabel('Zoom atual')).toHaveText((150 + i * 50) + '%')
    }
    await area.evaluate(element => element.scrollTo(element.scrollWidth, element.scrollHeight))
    const scroll = await area.evaluate(element => [element.scrollLeft, element.scrollTop])
    if (width > 1) expect(scroll[0]).toBeGreaterThan(0)
    if (height > 1) expect(scroll[1]).toBeGreaterThan(0)
    const enlarged = await geometry()
    expect(enlarged.width / fit.width).toBeCloseTo(4, 1)
    expect(enlarged.height / fit.height).toBeCloseTo(4, 1)
    expect(await png(page, info, 'zoom-400', 'Grade.png', size, painted)).toEqual(expected)
    expect(await area.evaluate(element => [element.scrollLeft, element.scrollTop])).toEqual(scroll)
    await button(page, 'Borracha').click()
    for (const size of ['1', '3', '5', '9']) {
      const radius = (Number(size) - 1) / 2
      await page.getByLabel('Tamanho da borracha').selectOption(size)
      await draw(page, [edge[0], edge[1]])
      await expectPixels(page, [path[0], ...border.map(([x, y, ink], i): Painted => [x, y, i <= radius ? empty : ink])])
      const boundary: Point[] = [[width * 16, height * 16], [0, 0]]
      if (width > 10) boundary.push([160, 8])
      if (height > 10) boundary.push([8, 160])
      expect(await pixels(page, boundary, false)).toEqual(boundary.map(() => major))
      expect(await pixels(page, [width > 1 ? [16, 8] : [8, 16]], false)).toEqual([fine])
      await undo(page)
      await expectPixels(page, border)
    }
    await button(page, 'Ajustar à tela').click()
    await expect(canvas(page)).toBeInViewport({ ratio: 1 })
    expect(errors).toEqual([])
  })
}
test('D6 abre acervo v2 com journal antigo, redimensiona, edita, renomeia e reabre', async ({ page }, info) => {
  await page.route('**/__v2', route => route.fulfill({ contentType: 'text/plain', body: 'Banco v2' }))
  await page.goto('/__v2')
  await page.evaluate(({ stored, journal }) => new Promise<void>((resolve, reject) => {
    const open = indexedDB.open('linha-a-bordo', 2)
    open.onerror = () => reject(open.error)
    open.onupgradeneeded = () => {
      const db = open.result
      const projects = db.createObjectStore('projects', { keyPath: 'number', autoIncrement: true })
      projects.add({ number: 3, name: 'Outro acervo', cells: stored })
      projects.add({ number: 7, name: 'Acervo', cells: stored })
      db.createObjectStore('settings').put(7, 'selected')
    }
    open.onsuccess = () => {
      open.result.close()
      localStorage.setItem('linha-a-bordo:pending:7', JSON.stringify({ revision: [8, 7], cells: journal }))
      resolve()
    }
  }), { stored: gridData([60, 60], [[2, 1, black]]).cells, journal: gridData([60, 60], [[2, 1, white], [2, 2, blue]]).cells })
  await page.goto('/')
  await expectProject(page, 7, 'Acervo', [60, 60])
  await expectPixels(page, [[2, 1, white], [2, 2, blue], [3, 2, empty]])
  await resize(page, [5, 3])
  await button(page, 'Vermelho').click()
  await draw(page, [4, 2])
  await button(page, 'Renomear').click()
  await page.getByLabel('Nome do bordado').fill('Acervo revisto')
  await button(page, 'Salvar nome').click()
  await expectProject(page, 7, 'Acervo revisto', [5, 3])
  const painted = [[2, 1, white], [2, 2, blue], [4, 2, red]] as const
  await page.reload()
  await expectProject(page, 7, 'Acervo revisto', [5, 3])
  await expectPixels(page, [...painted, [3, 2, empty]])
  await png(page, info, 'acervo', 'Acervo revisto.png', [5, 3], [...painted])
  const library = await readLibrary(page)
  expect(library.selected).toBe(7)
  expect(library.projects[0]).toEqual({ number: 3, name: 'Outro acervo', cells: gridData([60, 60], [[2, 1, black]]).cells })
  expect(library.projects[1]).toEqual(saved(7, 'Acervo revisto', [5, 3], [...painted]))
  await create(page, 8, 'Novo', [1, 200])
  await page.reload()
  await expectProject(page, 8, 'Novo', [1, 200])
  await button(page, 'Bordado 3: Outro acervo').click()
  await expectProject(page, 3, 'Outro acervo', [60, 60])
  await expectPixels(page, [[2, 1, black], [2, 2, empty]])
})

async function blockLibrary(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    const open = indexedDB.open('linha-a-bordo')
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const db = open.result
      const tx = db.transaction(['projects', 'settings'], 'readwrite')
      const store = tx.objectStore('projects')
      let released = false
      window.addEventListener('release-dimensions', () => { released = true }, { once: true })
      tx.oncomplete = () => db.close()
      tx.onabort = () => { db.close(); reject(tx.error) }
      function hold() {
        if (!released) store.get(1).onsuccess = hold
      }
      store.get(1).onsuccess = () => { hold(); resolve() }
    }
  }))
}

const releaseLibrary = (page: Page) => page.evaluate(() => window.dispatchEvent(new Event('release-dimensions')))

function pendingLibrary(page: Page) {
  return page.evaluate(() => Object.fromEntries(Object.entries(localStorage)
    .filter(([key]) => key.startsWith('linha-a-bordo:pending'))
    .map(([key, value]) => [key.slice('linha-a-bordo:'.length), JSON.parse(value)])))
}

test('D7 @D8 (a) altera apenas a largura, pinta e recarrega no fim do gesto com gravação bloqueada', async ({ page, context }) => {
  const errors = errorsOn(page)
  await page.goto('/')
  await create(page, 1, 'Largura', [5, 4])
  await button(page, 'Branco').click()
  await draw(page, [4, 2])
  const blocker = await context.newPage()
  await blocker.goto('/')
  await expectProject(blocker, 1, 'Largura', [5, 4])
  await blockLibrary(blocker)
  try {
    await resize(page, [8, 4])
    await button(page, 'Azul').click()
    await page.evaluate(() => window.addEventListener('pointerup', () => location.reload(), { once: true }))
    const reloaded = page.waitForEvent('load')
    await draw(page, [7, 2])
    await reloaded
    expect((await pendingLibrary(blocker))['pending:1']).toMatchObject(layeredGrid([8, 4], [[4, 2, white], [7, 2, blue]]))
  } finally {
    await releaseLibrary(blocker)
  }
  await expectProject(page, 1, 'Largura', [8, 4])
  await expectPixels(page, [[4, 2, white], [7, 2, blue], [1, 2, empty], [7, 1, empty]])
  expect(await readLibrary(page)).toEqual({ projects: [saved(1, 'Largura', [8, 4], [[4, 2, white], [7, 2, blue]])], selected: 1 })
  expect(await pendingLibrary(page)).toEqual({})
  expect(errors).toEqual([])
})

test('D7 @D8 (b) fecha e relança o navegador após desfazer e após refazer o recorte', async ({ baseURL }, info) => {
  const launch = () => chromium.launchPersistentContext(info.outputPath('p'), { baseURL })
  let browser = await launch()
  const before = [[1, 0, black], [4, 1, white], [4, 3, blue]] as const
  const after = [before[0]]
  try {
    let page = browser.pages()[0]
    const errors = errorsOn(page)
    await page.goto('/')
    await create(page, 1, 'Recorte', [5, 4])
    for (const [i, color] of ['Preto', 'Branco', 'Azul'].entries()) {
      await button(page, color).click()
      await draw(page, [before[i][0], before[i][1]])
    }
    await resize(page, [3, 2], true)
    await undo(page)
    await browser.close()
    expect(errors).toEqual([])

    browser = await launch()
    page = browser.pages()[0]
    const reopenedErrors = errorsOn(page)
    await page.goto('/')
    await expectProject(page, 1, 'Recorte', [5, 4])
    await expectPixels(page, [...before, [3, 3, empty]])
    expect(await readLibrary(page)).toEqual({ projects: [saved(1, 'Recorte', [5, 4], [...before])], selected: 1 })
    await resize(page, [3, 2], true)
    await undo(page)
    await redo(page)
    await browser.close()
    expect(reopenedErrors).toEqual([])

    browser = await launch()
    page = browser.pages()[0]
    const finalErrors = errorsOn(page)
    await page.goto('/')
    await expectProject(page, 1, 'Recorte', [3, 2])
    await expectPixels(page, [before[0], [2, 1, empty]])
    expect(await readLibrary(page)).toEqual({ projects: [saved(1, 'Recorte', [3, 2], after)], selected: 1 })
    expect(await pendingLibrary(page)).toEqual({})
    expect(finalErrors).toEqual([])
  } finally {
    await browser.close()
  }
})

test('D7 @D8 (c) recupera mudanças rápidas, geometrias de mesma área, pintura e seleção sob transação pendente', async ({ page, context }) => {
  const errors = errorsOn(page)
  await page.goto('/')
  await create(page, 1, 'Primeiro', [6, 4])
  await draw(page, [2, 2])
  await create(page, 2, 'Segundo', [3, 8])
  const blocker = await context.newPage()
  await blocker.goto('/')
  await expectProject(blocker, 2, 'Segundo', [3, 8])
  await blockLibrary(blocker)
  const first = [[2, 2, black], [7, 4, red]] as const
  const second = [[2, 7, white], [4, 9, blue]] as const
  try {
    await button(page, 'Branco').click()
    await draw(page, [2, 7])
    await resize(page, [5, 10])
    await resize(page, [4, 9])
    await undo(page)
    await redo(page)
    await undo(page)
    await button(page, 'Azul').click()
    await draw(page, [4, 9])
    await button(page, 'Bordado 1: Primeiro').click()
    await resize(page, [4, 6])
    await expectPixels(page, [[2, 2, black], [2, 3, empty]])
    await resize(page, [9, 6])
    await resize(page, [8, 5])
    await button(page, 'Vermelho').click()
    await draw(page, [7, 4])
    await button(page, 'Bordado 2: Segundo').click()
    await undo(page)
    await expectProject(page, 2, 'Segundo', [5, 10])
    await expectPixels(page, [...second])
    await button(page, 'Bordado 1: Primeiro').click()
    const journal = await pendingLibrary(blocker)
    expect(journal['pending:1']).toMatchObject(layeredGrid([8, 5], [...first]))
    expect(journal['pending:2']).toMatchObject(layeredGrid([5, 10], [...second]))
    expect(journal['pending-selection']).toMatchObject({ number: 1 })
    await page.reload()
  } finally {
    await releaseLibrary(blocker)
  }
  await expectProject(page, 1, 'Primeiro', [8, 5])
  await expectPixels(page, [...first, [7, 3, empty]])
  expect(await readLibrary(page)).toEqual({
    projects: [saved(1, 'Primeiro', [8, 5], [...first]), saved(2, 'Segundo', [5, 10], [...second])], selected: 1,
  })
  expect(await pendingLibrary(page)).toEqual({})
  await button(page, 'Bordado 2: Segundo').click()
  await page.reload()
  await expectProject(page, 2, 'Segundo', [5, 10])
  await expectPixels(page, [...second, [4, 7, empty]])
  expect(errors).toEqual([])
})
