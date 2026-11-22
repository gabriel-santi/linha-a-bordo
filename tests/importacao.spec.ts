import { readFile, writeFile } from 'node:fs/promises'
import { chromium, expect, test, type Page, type TestInfo } from '@playwright/test'
import { readLibrary, type Layer, type Project } from './layer-data'
import {
  bitmap, channels, compose, encodePng, hex, opaque, palette, referenceCells, referenceFit,
  type Bitmap, type Cell, type Rgba,
} from './image-reference'
import { convertImage, fitImage } from '../src/image-import'

type Upload = { name: string, mimeType: string, buffer: Buffer }
type Point = [number, number]

const empty = '#fffcf6'
const cdPath = new URL('./fixtures/arte-cd.jpeg', import.meta.url)
const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true })
const dialog = (page: Page) => page.getByRole('dialog', { name: 'Importar imagem' })
const confirmButton = (page: Page) => button(page, 'Confirmar importação')
const field = (page: Page, axis: string) => page.getByLabel(axis + ' (pontos)')
const row = (page: Page, position: number) => button(page, 'Camada ' + position)
const grid = (page: Page) => page.locator('.grid-area canvas')
const previewCanvas = (page: Page) => dialog(page).locator('canvas')
const undo = (page: Page) => page.keyboard.press('Control+z')
const redo = (page: Page) => page.keyboard.press('Control+y')
const png = (name: string, image: Bitmap): Upload => ({ name, mimeType: 'image/png', buffer: encodePng(image) })

async function read(page: Page, number = 1): Promise<Project> {
  return (await readLibrary(page)).projects.find(project => project.number === number)!
}

// Wait for the IndexedDB write that follows an edit.
async function readWhen(page: Page, ready: (project: Project) => boolean, number = 1) {
  await expect.poll(async () => ready(await read(page, number)), { timeout: 15000 }).toBe(true)
  return read(page, number)
}

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
  await expect(grid(page)).toHaveAccessibleName('Grade de bordado de ' + width + ' por ' + height + ' pontos')
}

async function paint(page: Page, color: string, ...points: Point[]) {
  await button(page, color).click()
  for (const [col, row] of points) {
    const box = (await grid(page).boundingBox())!
    const [width, height] = await grid(page).evaluate((canvas: HTMLCanvasElement) => [canvas.width, canvas.height])
    await page.mouse.move(box.x + (col * 16 + 8) * box.width / width, box.y + (row * 16 + 8) * box.height / height)
    await page.mouse.down()
    await page.mouse.up()
  }
}

async function choose(page: Page, file: Upload, trigger = 'Importar imagem') {
  const chooser = page.waitForEvent('filechooser')
  await button(page, trigger).click()
  await (await chooser).setFiles(file)
}

async function preview(page: Page, file: Upload, trigger?: string) {
  await choose(page, file, trigger)
  await expect(dialog(page)).toBeVisible()
  await expect(confirmButton(page)).toBeEnabled({ timeout: 20000 })
}

async function importImage(page: Page, file: Upload) {
  const before = (await read(page)).layers.length
  await preview(page, file)
  await confirmButton(page).click()
  await expect(dialog(page)).toHaveCount(0)
  return readWhen(page, project => project.layers.length === before + 1)
}

function expectImported(before: Project, after: Project, cells: Cell[]) {
  expect([after.width, after.height]).toEqual([before.width, before.height])
  expect(after.layers.slice(0, -1)).toEqual(before.layers)
  const top = after.layers.at(-1)!
  expect(before.layers.map(layer => layer.id)).not.toContain(top.id)
  expect(top).toEqual({ id: top.id, visible: true, opacity: 100, cells })
  expect(after.activeLayerId).toBe(top.id)
}

// Decode in the page with the same options the import uses, so lossy fixtures have known pixels.
async function decode(page: Page, file: Upload): Promise<Bitmap> {
  const result = await page.evaluate(async ({ base64, type }) => {
    const bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0))
    const image = await createImageBitmap(new Blob([bytes], { type }), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' })
    const canvas = new OffscreenCanvas(image.width, image.height)
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(image, 0, 0)
    const { data } = ctx.getImageData(0, 0, image.width, image.height)
    image.close()
    let binary = ''
    for (let i = 0; i < data.length; i += 0x8000) binary += String.fromCharCode(...data.subarray(i, i + 0x8000))
    return { width: canvas.width, height: canvas.height, data: btoa(binary) }
  }, { base64: file.buffer.toString('base64'), type: file.mimeType })
  return { width: result.width, height: result.height, data: new Uint8Array(Buffer.from(result.data, 'base64')) }
}

async function encode(page: Page, image: Bitmap, type: 'image/jpeg' | 'image/webp', name: string, quality = 1): Promise<Upload> {
  const base64 = await page.evaluate(async ({ width, height, data, type, quality }) => {
    const canvas = new OffscreenCanvas(width, height)
    canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(data), width, height), 0, 0)
    const bytes = new Uint8Array(await (await canvas.convertToBlob({ type, quality })).arrayBuffer())
    let binary = ''
    for (const byte of bytes) binary += String.fromCharCode(byte)
    return btoa(binary)
  }, { width: image.width, height: image.height, data: Array.from(image.data), type, quality })
  return { name, mimeType: type, buffer: Buffer.from(base64, 'base64') }
}

async function save(info: TestInfo, file: Upload) {
  await writeFile(info.outputPath(file.name), file.buffer)
}

async function centers(canvas: ReturnType<typeof grid>, width: number, height: number) {
  return canvas.evaluate((element: HTMLCanvasElement, { width, height }) => {
    const { data } = element.getContext('2d')!.getImageData(0, 0, element.width, element.height)
    return Array.from({ length: width * height }, (_, i) => {
      const offset = 4 * ((Math.floor(i / width) * 16 + 8) * element.width + i % width * 16 + 8)
      return [data[offset], data[offset + 1], data[offset + 2]]
    })
  }, { width, height })
}

function expectPixels(actual: number[][], expected: number[][]) {
  expect(actual).toHaveLength(expected.length)
  const wrong = actual.findIndex((pixel, i) => pixel.some((value, c) => Math.abs(value - expected[i][c]) > 1))
  expect(wrong, 'primeira célula divergente').toBe(-1)
}

function composition(layers: Pick<Layer, 'cells' | 'visible' | 'opacity'>[], base: string) {
  return layers[0].cells.map((_, i) => compose(layers, base, i))
}

// A deterministic, colorful pattern that crosses several palette regions.
function pattern(width: number, height: number) {
  return bitmap(width, height, (x, y) => [(x * 37 + y * 91) % 256, (x * 13 + 60) % 256, (y * 29 + x * 7) % 256, 255])
}

function holdWorkers() {
  const held: (() => void)[] = []
  const state = { hold: true, created: 0, terminated: 0, held: 0 }
  const target = window as unknown as Record<string, unknown>
  target.__imports = state
  target.__releaseImports = () => {
    state.hold = false
    held.splice(0).forEach(deliver => deliver())
  }
  const Native = window.Worker
  window.Worker = class extends Native {
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options)
      state.created++
    }
    terminate() {
      state.terminated++
      super.terminate()
    }
    // Hold results so the test decides when a conversion finishes.
    set onmessage(handler: ((event: MessageEvent) => void) | null) {
      super.onmessage = handler && (event => {
        if (!state.hold) return handler.call(this, event)
        held.push(() => handler.call(this, event))
        state.held = held.length
      })
    }
    get onmessage() {
      return super.onmessage
    }
  }
}

const imports = (page: Page) => page.evaluate(() => (window as unknown as { __imports: Record<string, number> }).__imports)
const release = (page: Page) => page.evaluate(() => (window as unknown as { __releaseImports: () => void }).__releaseImports())

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
      window.addEventListener('release-import', () => tx.abort(), { once: true })
      tx.onabort = () => db.close()
      store.get(1).onsuccess = () => { hold(); resolve() }
    }
  }))
}

const unlock = (page: Page) => page.evaluate(() => window.dispatchEvent(new Event('release-import')))

function journals(page: Page) {
  return page.evaluate(() => Object.fromEntries(Object.entries(localStorage)
    .filter(([key]) => key.startsWith('linha-a-bordo:pending'))
    .map(([key, value]) => [key.slice('linha-a-bordo:'.length), JSON.parse(value)])))
}

test('I2 I3 regra de encaixe e conversão coincidem com a referência independente', () => {
  const sizes = [1, 2, 3, 4, 5, 7, 13, 59, 60, 61, 64, 99, 100, 101, 199, 200, 201, 1228, 1281, 4000]
  const grids = [1, 2, 3, 5, 7, 59, 60, 61, 199, 200]
  // Plain checks in the loop: one expect per case would make this test slow.
  const failures: string[] = []
  let cases = 0
  for (const sw of sizes) for (const sh of sizes) for (const gw of grids) for (const gh of grids) {
    const fit = fitImage({ width: sw, height: sh }, { width: gw, height: gh })
    const reference = referenceFit(sw, sh, gw, gh)
    const spareX = gw - fit.width - 2 * fit.left
    const spareY = gh - fit.height - 2 * fit.top
    const ok = JSON.stringify(fit) === JSON.stringify(reference) &&
      fit.width >= 1 && fit.width <= gw && fit.height >= 1 && fit.height <= gh &&
      (fit.width === gw || fit.height === gh) && spareX >= 0 && spareX <= 1 && spareY >= 0 && spareY <= 1
    if (!ok) failures.push(`${sw}×${sh} em ${gw}×${gh}: ${JSON.stringify(fit)} ≠ ${JSON.stringify(reference)}`)
    cases++
  }
  expect(cases).toBe(40000)
  expect(failures).toEqual([])

  let seed = 7
  const random = (limit: number) => (seed = (seed * 1103515245 + 12345) % 2147483648) % limit
  for (let sample = 0; sample < 300; sample++) {
    const alphas = [0, 255, 255, random(256)]
    const image = bitmap(1 + random(37), 1 + random(37), () => [random(256), random(256), random(256), alphas[random(4)]])
    const gw = 1 + random(29)
    const gh = 1 + random(29)
    const cells = Array.from(convertImage(image.data, image, { width: gw, height: gh }), index => index < 0 ? null : palette[index][1])
    if (JSON.stringify(cells) !== JSON.stringify(referenceCells(image, gw, gh))) failures.push(`amostra ${sample}`)
  }
  expect(failures).toEqual([])
})

test('I1 importa PNG, JPEG e WebP pela interação real e abre a prévia antes de inserir', async ({ page }, info) => {
  await create(page, 'Formatos', 12, 8)
  await paint(page, 'Vermelho', [0, 0], [11, 7])
  const source = pattern(30, 16)
  const files = [
    png('padrao.png', source),
    await encode(page, source, 'image/jpeg', 'padrao.jpg', 0.92),
    await encode(page, source, 'image/webp', 'padrao.webp', 1),
  ]
  for (const file of files) {
    await save(info, file)
    const before = await read(page)
    await preview(page, file)
    await expect(dialog(page).getByRole('status')).toContainText(file.name + ': 30 × 16 pixels em 12 × 6 pontos.')
    await expect(previewCanvas(page)).toBeVisible()
    // Nothing is inserted while the preview is open.
    expect(await read(page)).toEqual(before)
    await confirmButton(page).click()
    const after = await readWhen(page, project => project.layers.length === before.layers.length + 1)
    expectImported(before, after, referenceCells(await decode(page, file), 12, 8))
    await expect(row(page, after.layers.length)).toHaveAttribute('aria-pressed', 'true')
  }
})

test('I1 arquivo inválido, corrompido ou seletor cancelado preservam bordado e histórico', async ({ page }, info) => {
  await create(page, 'Inválidos', 6, 4)
  await paint(page, 'Azul', [0, 0])
  await button(page, 'Nova camada').click()
  await paint(page, 'Verde', [1, 1])
  const before = await readWhen(page, project => project.layers[1].cells[7] === hex.Verde)
  const valid = encodePng(pattern(4, 4))
  const corrupt = Buffer.concat([valid.subarray(0, 40), Buffer.alloc(60, 7)])
  const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')
  const cases: [Upload, string][] = [
    [{ name: 'corrompido.png', mimeType: 'image/png', buffer: corrupt }, 'Não foi possível ler esta imagem. O bordado não foi alterado.'],
    [{ name: 'vazio.webp', mimeType: 'image/webp', buffer: Buffer.alloc(0) }, 'Escolha uma imagem PNG, JPEG ou WebP. O bordado não foi alterado.'],
    [{ name: 'texto.png', mimeType: 'image/png', buffer: Buffer.from('não é imagem') }, 'Escolha uma imagem PNG, JPEG ou WebP. O bordado não foi alterado.'],
    [{ name: 'animacao.png', mimeType: 'image/png', buffer: gif }, 'Escolha uma imagem PNG, JPEG ou WebP. O bordado não foi alterado.'],
    [{ name: 'truncado.jpg', mimeType: 'image/jpeg', buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70]) }, 'Não foi possível ler esta imagem. O bordado não foi alterado.'],
  ]
  for (const [file, message] of cases) {
    await save(info, file)
    await choose(page, file)
    await expect(dialog(page).getByRole('alert')).toHaveText(message)
    await expect(confirmButton(page)).toBeDisabled()
    await expect(previewCanvas(page)).toHaveCount(0)
    await button(page, 'Cancelar').click()
    await expect(dialog(page)).toHaveCount(0)
    expect(await read(page)).toEqual(before)
  }

  // Esc on the error dialog also closes it without changes.
  await choose(page, cases[0][0])
  await expect(dialog(page).getByRole('alert')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog(page)).toHaveCount(0)

  // Closing the native chooser without a file: Playwright intercepts it and no file is set.
  const chooser = page.waitForEvent('filechooser')
  await button(page, 'Importar imagem').click()
  await (await chooser).element().dispatchEvent('cancel')
  await expect(dialog(page)).toHaveCount(0)
  expect(await read(page)).toEqual(before)

  // The history is the same: one undo removes the green stroke, the next removes the layer.
  await undo(page)
  let project = await readWhen(page, item => item.layers[1].cells[7] === null)
  expect(project.layers).toHaveLength(2)
  await undo(page)
  project = await readWhen(page, item => item.layers.length === 1)
  await redo(page)
  await redo(page)
  expect(await readWhen(page, item => item.layers.length === 2 && item.layers[1].cells[7] === hex.Verde)).toEqual(before)
})

test('I2 média por área em fundo uniforme, traços finos, limites fracionários e mão calculada', async ({ page }, info) => {
  await create(page, 'Média', 40, 30)
  const uniform = bitmap(37, 23, () => [140, 100, 60, 255])
  // One-pixel strokes cross the cells at fractional positions (121 → 40 and 97 → 30 do not divide).
  const strokes = bitmap(121, 97, (x, y) => x % 7 === 3 || y % 11 === 5 ? opaque(hex.Preto) : opaque(hex.Branco))
  const fractional = bitmap(53, 41, (x, y) => (x + 2 * y) % 5 < 2 ? opaque(hex.Azul) : [250, 245, 200, 255])
  for (const [name, image] of [['uniforme.png', uniform], ['tracos.png', strokes], ['fracionario.png', fractional]] as const) {
    const file = png(name, image)
    await save(info, file)
    const before = await read(page)
    const after = await importImage(page, file)
    const expected = referenceCells(image, 40, 30)
    expectImported(before, after, expected)
    if (name === 'uniforme.png') expect(new Set(expected.filter(Boolean))).toEqual(new Set([hex.Marrom]))
    if (name === 'tracos.png') {
      // Area average mixes strokes and paper: neither all-black nor all-white, unlike one-pixel sampling.
      const colors = new Set(expected)
      expect(colors.size).toBeGreaterThan(2)
      expect(colors.has(hex.Cinza) || colors.has(hex.Bege)).toBe(true)
    }
    await undo(page)
    await readWhen(page, project => project.layers.length === before.layers.length)
  }

  // Hand calculation: 3 × 1 pixels into a 2 × 1 grid. Cell 1 covers 1/3 black and 2/3 white:
  // (34 + 2 · 255) / 3 = 181.33 per channel, nearest Bege; one-pixel sampling would give black or white.
  await resize(page, 2, 1)
  const hand = await importImage(page, png('mao.png', bitmap(3, 1, x => opaque(x === 2 ? hex.Branco : hex.Preto))))
  expect(hand.layers.at(-1)!.cells).toEqual([hex.Preto, hex.Bege])
})

for (const size of [60, 120, 200]) {
  test(`I2 I3 arte CD em ${size} × ${size} coincide com a referência célula a célula`, async ({ page }, info) => {
    test.setTimeout(120000)
    await create(page, 'Arte CD', size, size)
    const file = { name: 'arte-cd.jpeg', mimeType: 'image/jpeg', buffer: await readFile(cdPath) }
    const before = await read(page)
    await preview(page, file)
    const fit = referenceFit(1228, 1281, size, size)
    await expect(dialog(page).getByRole('status')).toContainText(`1228 × 1281 pixels em ${fit.width} × ${fit.height} pontos`)
    await confirmButton(page).click()
    const after = await readWhen(page, project => project.layers.length === 2)
    const decoded = await decode(page, file)
    expect([decoded.width, decoded.height]).toEqual([1228, 1281])
    const expected = referenceCells(decoded, size, size)
    expectImported(before, after, expected)
    expect(expected.filter(cell => cell === null)).toHaveLength(size * size - fit.width * fit.height)

    // Informative: agreement with the experimental comparison (GDI+ decoder) of R1.
    const experiment = await readFile(new URL(`../../import-comparison-r1/area-${size}.csv`, import.meta.url), 'utf8').catch(() => '')
    if (experiment) {
      const cells = experiment.trim().split(/\r?\n/).flatMap(line => line.split(',')).map(cell => cell === '.' ? null : cell)
      const differences = cells.filter((cell, i) => cell !== expected[i]).length
      await writeFile(info.outputPath('comparacao-experimento.json'), JSON.stringify({ size, differences, total: cells.length }))
      info.annotations.push({ type: 'experimento', description: `${differences} de ${cells.length} células diferem do CSV area-${size}` })
    }
  })
}

test('I2 encaixe em grades quadradas, retangulares e extremas sem alterar o bordado', async ({ page }) => {
  test.setTimeout(240000)
  await create(page, 'Encaixe', 60, 60)
  const images = [
    pattern(3, 1), pattern(1, 3), pattern(2, 2), pattern(1, 1),
    pattern(250, 90), pattern(70, 230), pattern(210, 210),
  ]
  for (const [gw, gh] of [[1, 1], [1, 200], [200, 1], [7, 5], [5, 9], [60, 60], [200, 200]]) {
    await resize(page, gw, gh)
    await paint(page, 'Rosa', [0, 0])
    const before = await readWhen(page, project => project.width === gw && project.height === gh && project.layers[0].cells[0] === hex.Rosa)
    for (const image of images) {
      const after = await importImage(page, png(`encaixe-${image.width}x${image.height}.png`, image))
      const fit = referenceFit(image.width, image.height, gw, gh)
      expect(fit.width * fit.height).toBeGreaterThan(0)
      const cells = after.layers.at(-1)!.cells
      expect(cells.filter(cell => cell !== null), `${image.width}×${image.height} em ${gw}×${gh}`).toHaveLength(fit.width * fit.height)
      expectImported(before, after, referenceCells(image, gw, gh))
      await undo(page)
      await readWhen(page, project => project.layers.length === 1)
    }
  }
})

test('I3 cores exatas, intermediárias e desempate pela ordem da paleta preservam seletor e pintura', async ({ page }) => {
  await create(page, 'Cores', 14, 1)
  const exact = await importImage(page, png('paleta.png', bitmap(14, 1, x => opaque(palette[x][1]))))
  expect(exact.layers.at(-1)!.cells).toEqual(palette.map(([, color]) => color))
  await undo(page)
  await readWhen(page, project => project.layers.length === 1)

  // Each pair averages to a color at the same distance from both inks; the earlier ink wins.
  const ties: [string, string, string][] = [
    [hex.Marrom, hex.Preto, hex.Preto], [hex['Azul-claro'], hex['Verde-claro'], hex['Verde-claro']],
    [hex.Bege, hex.Branco, hex.Branco], [hex.Azul, hex.Verde, hex.Verde], [hex['Azul-claro'], hex.Rosa, hex.Rosa],
    [hex.Roxo, hex.Vermelho, hex.Vermelho], [hex.Amarelo, hex.Laranja, hex.Laranja],
  ]
  await resize(page, 7, 1)
  const tie = await importImage(page, png('empates.png', bitmap(14, 1, x => opaque(ties[x >> 1][x & 1]))))
  expect(tie.layers.at(-1)!.cells).toEqual(ties.map(([, , winner]) => winner))
  // The tie really is exact: both inks, and only them, are at the minimum doubled distance.
  for (const [a, b, winner] of ties) {
    const distances = palette.map(([, color]) => channels(color).reduce((sum, value, c) =>
      sum + (channels(a)[c] + channels(b)[c] - 2 * value) ** 2, 0))
    const minimum = Math.min(...distances)
    expect(palette.filter((_, i) => distances[i] === minimum).map(([, color]) => color)).toEqual([winner, winner === a ? b : a])
  }
  await undo(page)
  await readWhen(page, project => project.layers.length === 1)

  const intermediates: Rgba[] = [[10, 10, 10, 255], [128, 128, 128, 255], [200, 60, 40, 255], [240, 200, 90, 255],
    [60, 140, 220, 255], [170, 110, 190, 255], [250, 250, 245, 255]]
  const middle = bitmap(7, 1, x => intermediates[x])
  const mixed = await importImage(page, png('intermediarias.png', middle))
  expect(mixed.layers.at(-1)!.cells).toEqual(referenceCells(middle, 7, 1))
  expect(mixed.layers.at(-1)!.cells).toEqual([hex.Preto, hex.Cinza, hex.Vermelho, hex.Amarelo, hex.Azul, hex.Rosa, hex.Branco])

  // The fixed swatches and the custom color stay as before, and the imported layer is paintable.
  const tools = page.getByRole('group', { name: 'Paleta de cores e borracha' })
  await expect(tools.getByRole('button')).toHaveCount(15)
  for (const [name, color] of palette) {
    expect(await tools.getByRole('button', { name, exact: true }).evaluate((element: HTMLElement) => element.style.getPropertyValue('--swatch'))).toBe(color)
  }
  await page.getByLabel('Hexadecimal').fill('#123456')
  await grid(page).click({ position: { x: 4, y: 4 } })
  const painted = await readWhen(page, project => project.layers.at(-1)!.cells[0] === '#123456')
  expect(painted.layers.at(-1)!.cells.slice(1)).toEqual(mixed.layers.at(-1)!.cells.slice(1))
})

test('I4 transparência total vira vazio, branco é tinta e alfa intermediário combina com branco', async ({ page }, info) => {
  await create(page, 'Transparência', 8, 4)
  await paint(page, 'Vermelho', [0, 0], [1, 0], [2, 0], [3, 0], [4, 0], [5, 0], [6, 0], [7, 0], [0, 3], [7, 3])
  const alphas = [0, 255, 128, 64, 200, 1, 255, 0]
  const source = bitmap(8, 4, (x, y) => {
    if (y === 0) return x === 1 || x === 6 ? opaque(hex.Branco) : [34, 34, 34, alphas[x]]
    if (y === 1) return [48, 102, 189, alphas[x]]
    if (y === 2) return [255, 255, 255, alphas[x]]
    return [0, 0, 0, 0]
  })
  const files = [png('alfa.png', source), await encode(page, source, 'image/webp', 'alfa.webp', 1)]
  let first = true
  for (const file of files) {
    await save(info, file)
    const decoded = await decode(page, file)
    // The fixtures keep the alpha values exactly after decoding.
    expect(Array.from(decoded.data.filter((_, i) => i % 4 === 3))).toEqual(Array.from(source.data.filter((_, i) => i % 4 === 3)))
    const before = await read(page)
    const after = await importImage(page, file)
    const expected = referenceCells(decoded, 8, 4)
    expectImported(before, after, expected)
    const top = after.layers.at(-1)!.cells
    expect([0, 7, 8, 15, 16, 23, 24, 31].map(i => top[i])).toEqual(Array(8).fill(null))
    expect(top.slice(25, 31)).toEqual(Array(6).fill(null))
    expect([top[1], top[6]]).toEqual([hex.Branco, hex.Branco])
    if (first) {
      // Explicit composition with white: black at alpha 128 → (34·128 + 255·127)/255 = 144.1 → Cinza.
      // 64 → 199.5 (Bege), 200 → 81.7 (Marrom), 1 → 254.1 (Branco).
      expect([top[2], top[3], top[4], top[5]]).toEqual([hex.Cinza, hex.Bege, hex.Marrom, hex.Branco])
      expect(top.slice(17, 23)).toEqual(Array(6).fill(hex.Branco))
      first = false
    }
    // Empty cells show the red lower layer; white covers it.
    expectPixels(await centers(grid(page), 8, 4), composition(after.layers, empty))
    expect((await centers(grid(page), 8, 4))[0]).toEqual(channels(hex.Vermelho))
    expect((await centers(grid(page), 8, 4))[1]).toEqual(channels(hex.Branco))
    await undo(page)
    await readWhen(page, project => project.layers.length === 1)
  }
})

test('I5 prévia mostra composição e somente a nova camada, descarta conversões e equivale ao confirmado', async ({ page }, info) => {
  await page.addInitScript(holdWorkers)
  await create(page, 'Prévia', 10, 6)
  await paint(page, 'Azul', [0, 0], [1, 0], [2, 0], [0, 1])
  await button(page, 'Nova camada').click()
  await paint(page, 'Amarelo', [3, 0], [4, 0], [0, 2])
  await page.getByRole('slider', { name: 'Opacidade' }).fill('50')
  await button(page, 'Nova camada').click()
  await paint(page, 'Verde', [5, 0], [0, 3])
  await page.getByRole('checkbox', { name: 'Visível' }).uncheck()
  await button(page, 'Camada 1').click()
  const before = await readWhen(page, project => !project.layers[2].visible && project.activeLayerId === project.layers[0].id)

  const transparent = bitmap(5, 3, (x, y) => x === 0 ? [0, 0, 0, 0] : y === 0 ? opaque(hex.Branco) : y === 1 ? opaque(hex.Rosa) : [0, 0, 0, 128])
  const other = pattern(10, 6)
  const fileA = png('previa-a.png', transparent)
  const fileB = png('previa-b.png', other)
  await save(info, fileA)
  await save(info, fileB)
  await choose(page, fileA)
  await expect(dialog(page).getByRole('status')).toHaveText('Convertendo previa-a.png…')
  await expect(confirmButton(page)).toBeDisabled()
  await expect.poll(async () => (await imports(page)).held).toBe(1)
  await release(page)
  await expect(confirmButton(page)).toBeEnabled()
  await expect(page.getByRole('button', { name: /bicúbico|método|algoritmo/i })).toHaveCount(0)
  await expect(dialog(page).getByRole('combobox')).toHaveCount(0)

  const composite = page.getByRole('radio', { name: 'Composição completa' })
  const only = page.getByRole('radio', { name: 'Somente a nova camada' })
  await expect(composite).toBeChecked()
  await expect(previewCanvas(page)).toHaveAccessibleName('Prévia da composição com a camada importada no topo')
  const cellsA = referenceCells(transparent, 10, 6)
  const imported = { visible: true, opacity: 100, cells: cellsA }
  expectPixels(await centers(previewCanvas(page), 10, 6), composition([...before.layers, imported], empty))
  await only.check()
  await expect(previewCanvas(page)).toHaveAccessibleName('Prévia da camada importada')
  expectPixels(await centers(previewCanvas(page), 10, 6), composition([imported], empty))
  expect(await read(page)).toEqual(before)

  // Choosing another file discards the old conversion and shows the new one.
  await choose(page, fileB, 'Escolher outro arquivo')
  await expect(confirmButton(page)).toBeEnabled()
  const cellsB = referenceCells(other, 10, 6)
  await expect(previewCanvas(page)).toHaveAccessibleName('Prévia da camada importada')
  expectPixels(await centers(previewCanvas(page), 10, 6), composition([{ ...imported, cells: cellsB }], empty))
  await button(page, 'Cancelar').click()
  await expect(dialog(page)).toHaveCount(0)
  expect(await read(page)).toEqual(before)
  expect(await journals(page)).toEqual({})

  await preview(page, fileA)
  await expect(composite).toBeChecked()
  const shown = await centers(previewCanvas(page), 10, 6)
  await confirmButton(page).click()
  const after = await readWhen(page, project => project.layers.length === 4)
  expectImported(before, after, cellsA)
  expect(await centers(grid(page), 10, 6)).toEqual(shown)
  const workers = await imports(page)
  expect(workers.terminated).toBeGreaterThanOrEqual(workers.created)
})

test('I6 confirmação dupla, Esc, cancelamento durante processamento e isolamento entre bordados', async ({ page }) => {
  await page.addInitScript(holdWorkers)
  await create(page, 'Norte', 6, 4)
  await paint(page, 'Azul', [0, 0])
  await button(page, 'Nova camada').click()
  await button(page, 'Camada 1').click()
  const north = await readWhen(page, project => project.layers.length === 2 && project.activeLayerId === project.layers[0].id)
  const file = png('dupla.png', pattern(6, 4))
  await choose(page, file)
  await expect.poll(async () => (await imports(page)).held).toBe(1)
  await release(page)
  await expect(confirmButton(page)).toBeEnabled()
  // Two activations before React renders again.
  await confirmButton(page).evaluate((element: HTMLButtonElement) => { element.click(); element.click() })
  const once = await readWhen(page, project => project.layers.length === 3)
  await page.waitForTimeout(300)
  expect(await read(page)).toEqual(once)
  expectImported(north, once, referenceCells(pattern(6, 4), 6, 4))
  await undo(page)
  expect(await readWhen(page, project => project.layers.length === 2)).toEqual(north)
  await expect(row(page, 1)).toHaveAttribute('aria-pressed', 'true')

  // Esc on the ready preview keeps the redo stack: Ctrl+Y restores the same import.
  await preview(page, file)
  await page.keyboard.press('Escape')
  await expect(dialog(page)).toHaveCount(0)
  expect(await read(page)).toEqual(north)
  await redo(page)
  expect(await readWhen(page, project => project.layers.length === 3)).toEqual(once)
  await undo(page)
  expect(await readWhen(page, project => project.layers.length === 2)).toEqual(north)

  await page.reload()
  await expectOpen(page, 'Norte', 6, 4)
  // Cancel during processing: the result arrives later and is ignored.
  await choose(page, file)
  await expect(dialog(page).getByRole('status')).toHaveText('Convertendo dupla.png…')
  await expect.poll(async () => (await imports(page)).held).toBe(1)
  await button(page, 'Cancelar').click()
  await expect(dialog(page)).toHaveCount(0)
  await release(page)
  await page.waitForTimeout(300)
  await expect(dialog(page)).toHaveCount(0)
  expect(await read(page)).toEqual(north)


  await create(page, 'Sul', 3, 5, 2)
  const south = await read(page, 2)
  await page.reload()
  await expectOpen(page, 'Sul', 3, 5, 2)
  await choose(page, file)
  await expect.poll(async () => (await imports(page)).held).toBe(1)
  // The library cannot be switched under the modal preview.
  await button(page, 'Bordado 1: Norte').click({ force: true, timeout: 2000 }).catch(() => {})
  await expect(button(page, 'Bordado 2: Sul')).toHaveAttribute('aria-current', 'true')
  await page.keyboard.press('Escape')
  await button(page, 'Bordado 1: Norte').click()
  await expectOpen(page, 'Norte', 6, 4)
  await release(page)
  await page.waitForTimeout(300)
  await expect(dialog(page)).toHaveCount(0)
  const library = await readLibrary(page)
  expect(library.projects.find(project => project.number === 2)).toEqual(south)
  expect(library.projects.find(project => project.number === 1)!.layers).toEqual(north.layers)
})

test('I7 um undo remove a importação inteira e edições seguem no histórico existente', async ({ page }) => {
  await create(page, 'Histórico', 8, 6)
  await paint(page, 'Azul', [0, 0])
  await button(page, 'Nova camada').click()
  await button(page, 'Camada 1').click()
  const before = await readWhen(page, project => project.layers.length === 2 && project.activeLayerId === project.layers[0].id)
  const image = pattern(8, 6)
  const imported = await importImage(page, png('historico.png', image))
  const cells = referenceCells(image, 8, 6)
  expectImported(before, imported, cells)
  await expect(row(page, 3)).toHaveAttribute('aria-pressed', 'true')

  // History shortcuts stay blocked inside the preview dialog.
  await preview(page, png('historico.png', image))
  await undo(page)
  await expect(dialog(page)).toBeVisible()
  await button(page, 'Cancelar').click()
  expect(await read(page)).toEqual(imported)

  await undo(page)
  expect(await readWhen(page, project => project.layers.length === 2)).toEqual(before)
  await expect(row(page, 1)).toHaveAttribute('aria-pressed', 'true')
  await redo(page)
  expect(await readWhen(page, project => project.layers.length === 3)).toEqual(imported)
  await expect(row(page, 3)).toHaveAttribute('aria-pressed', 'true')

  const id = imported.activeLayerId
  await paint(page, 'Preto', [7, 5])
  await button(page, 'Borracha').click()
  await grid(page).click({ position: { x: 4, y: 4 } })
  await page.getByRole('slider', { name: 'Opacidade' }).fill('40')
  await page.getByRole('checkbox', { name: 'Visível' }).uncheck()
  await page.getByRole('checkbox', { name: 'Visível' }).check()
  await button(page, 'Descer camada').click()
  await resize(page, 9, 6)
  const edited = await readWhen(page, project => project.width === 9)
  const layer = edited.layers[1]
  expect(layer.id).toBe(id)
  expect(layer.opacity).toBe(40)
  const expected = cells.flatMap((cell, i) => {
    const value = i === 0 ? null : i === 47 ? hex.Preto : cell
    return i % 8 === 7 ? [value, null] : [value]
  })
  expect(layer.cells).toEqual(expected)
  expect(edited.layers.map(item => item.id)).toEqual([before.layers[0].id, id, before.layers[1].id])

  for (let step = 0; step < 7; step++) await undo(page)
  expect(await readWhen(page, project => project.width === 8 && project.layers[2].opacity === 100 &&
    project.layers[2].cells[0] === cells[0] && project.layers[2].cells[47] === cells[47])).toEqual(imported)
  await undo(page)
  expect(await readWhen(page, project => project.layers.length === 2)).toEqual(before)
  for (let step = 0; step < 8; step++) await redo(page)
  expect(await readWhen(page, project => project.width === 9)).toEqual(edited)
  for (let step = 0; step < 8; step++) await undo(page)
  await readWhen(page, project => project.layers.length === 2)
  await redo(page)
  await readWhen(page, project => project.layers.length === 3)
  // A new edit after undo discards redo.
  await paint(page, 'Rosa', [3, 3])
  const fresh = await readWhen(page, project => project.layers[2].cells[27] === hex.Rosa)
  await redo(page)
  await page.waitForTimeout(200)
  expect(await read(page)).toEqual(fresh)
  expect(fresh.layers[2].cells).toEqual(cells.map((cell, i) => i === 27 ? hex.Rosa : cell))
})

async function exportPng(page: Page, info: TestInfo, label: string) {
  const [download] = await Promise.all([page.waitForEvent('download'), button(page, 'Baixar PNG').click()])
  const path = info.outputPath(label + '.png')
  await download.saveAs(path)
  return page.evaluate(async encoded => {
    const bytes = Uint8Array.from(atob(encoded), char => char.charCodeAt(0))
    const image = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
    const canvas = new OffscreenCanvas(image.width, image.height)
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(image, 0, 0)
    image.close()
    const { width, height } = canvas
    const { data } = ctx.getImageData(0, 0, width, height)
    const pixel = (x: number, y: number) => Array.from(data.subarray(4 * (y * width + x), 4 * (y * width + x) + 4))
    const columns = width / 20
    return {
      width, height,
      centers: Array.from({ length: columns * height / 20 }, (_, i) => pixel(i % columns * 20 + 10, Math.floor(i / columns) * 20 + 10)),
      lines: [pixel(0, 10), pixel(10, 0), pixel(width - 1, 10), pixel(10, height - 1), pixel(20, 10)],
    }
  }, (await readFile(path)).toString('base64'))
}

test('I8 salva, reabre e exporta PNG 200 × 200 da composição importada', async ({ page }, info) => {
  test.setTimeout(180000)
  await create(page, 'Grande', 200, 200)
  await paint(page, 'Vermelho', [0, 0], [199, 199], [100, 0])
  const image = bitmap(300, 120, (x, y) => x < 30 ? [0, 0, 0, 0] : opaque(palette[(x * 3 + y) % 14][1]))
  const before = await readWhen(page, project => project.layers[0].cells[0] === hex.Vermelho && project.layers[0].cells[39999] === hex.Vermelho)
  const imported = await importImage(page, png('grande.png', image))
  expectImported(before, imported, referenceCells(image, 200, 200))
  await page.reload()
  await expectOpen(page, 'Grande', 200, 200)
  await expect(row(page, 2)).toHaveAttribute('aria-pressed', 'true')
  expect(await read(page)).toEqual(imported)

  await create(page, 'Pequeno', 4, 3, 2)
  const small = await importImage2(page, 2, png('pequeno.png', pattern(4, 3)))
  await button(page, 'Bordado 1: Grande').click()
  await expectOpen(page, 'Grande', 200, 200)
  await button(page, 'Camada 1').click()
  await button(page, 'Aumentar zoom').click()
  await page.getByRole('region', { name: 'Área da grade' }).evaluate(area => { area.scrollLeft = 500; area.scrollTop = 700 })
  const exported = await exportPng(page, info, 'grande-200')
  expect([exported.width, exported.height]).toEqual([4000, 4000])
  const major = channels('#535e4d')
  expect(exported.lines.map(pixel => pixel.slice(0, 3))).toEqual([major, major, major, major, channels('#b5b8ab')])
  expect(exported.centers.every(pixel => pixel[3] === 255)).toBe(true)
  expectPixels(exported.centers.map(pixel => pixel.slice(0, 3)), composition(imported.layers, hex.Branco))
  expect(exported.centers[0].slice(0, 3)).toEqual(channels(hex.Vermelho))

  await button(page, 'Bordado 2: Pequeno').click()
  await expectOpen(page, 'Pequeno', 4, 3, 2)
  expect(await read(page, 2)).toEqual(small)
  const second = await exportPng(page, info, 'pequeno')
  expect([second.width, second.height]).toEqual([80, 60])
  expectPixels(second.centers.map(pixel => pixel.slice(0, 3)), composition(small.layers, hex.Branco))
  // Only the selection chosen before the export changed in the first project.
  expect(await read(page, 1)).toEqual({ ...imported, activeLayerId: imported.layers[0].id })
})

async function importImage2(page: Page, number: number, file: Upload) {
  const before = await read(page, number)
  await preview(page, file)
  await confirmButton(page).click()
  const after = await readWhen(page, project => project.layers.length === before.layers.length + 1, number)
  expectImported(before, after, referenceCells(await decode(page, file), before.width, before.height))
  return after
}

test('I8 fecha e reabre o navegador e nunca salva uma prévia cancelada', async ({ baseURL }, info) => {
  const launch = () => chromium.launchPersistentContext(info.outputPath('perfil'), { baseURL })
  let browser = await launch()
  try {
    let page = browser.pages()[0]
    await create(page, 'Reabrir', 5, 5)
    const file = png('reabrir.png', pattern(9, 5))
    const imported = await importImage(page, file)
    await preview(page, png('cancelada.png', pattern(5, 9)))
    await button(page, 'Cancelar').click()
    await browser.close()

    browser = await launch()
    page = browser.pages()[0]
    await page.goto('/')
    await expectOpen(page, 'Reabrir', 5, 5)
    await expect(row(page, 2)).toHaveAttribute('aria-pressed', 'true')
    expect(await read(page)).toEqual(imported)
    expect(imported.layers.at(-1)!.cells).toEqual(referenceCells(pattern(9, 5), 5, 5))
    expect(await journals(page)).toEqual({})
  } finally {
    await browser.close()
  }
})

for (const run of ['a', 'b', 'c']) {
  test(`@I9R ${run} confirma com gravação pendente e recarga imediata`, async ({ page, context }) => {
    await create(page, 'Pendente', 6, 5)
    await paint(page, 'Azul', [0, 0], [5, 4])
    const before = await readWhen(page, project => project.layers[0].cells[29] === hex.Azul)
    const image = bitmap(12, 5, (x, y) => x < 3 ? [0, 0, 0, 0] : opaque(palette[(x + y) % 14][1]))
    const cells = referenceCells(image, 6, 5)
    const blocker = await context.newPage()
    await blocker.goto('/')
    await expectOpen(blocker, 'Pendente', 6, 5)
    await lock(blocker)
    try {
      await preview(page, png('pendente.png', image))
      await page.evaluate(() => document.querySelector('dialog form')!.addEventListener('submit', () => setTimeout(() => location.reload()), { once: true }))
      const reload = page.waitForEvent('load')
      await confirmButton(page).click()
      await reload
      const journal = (await journals(blocker))['pending:1']
      expect(journal.layers.slice(0, -1)).toEqual(before.layers)
      expect(journal.layers.at(-1)).toEqual({ id: journal.activeLayerId, visible: true, opacity: 100, cells })
    } finally {
      await unlock(blocker)
    }
    await expectOpen(page, 'Pendente', 6, 5)
    await expect(row(page, 2)).toHaveAttribute('aria-pressed', 'true')
    const after = await read(page)
    expectImported(before, after, cells)
    expect(await journals(page)).toEqual({})
    expectPixels(await centers(grid(page), 6, 5), composition(after.layers, empty))
  })

  test(`@I9R ${run} cancela a conversão em andamento sem alterar dados nem seleção`, async ({ page }) => {
    await page.addInitScript(holdWorkers)
    await create(page, 'Cancelar', 5, 4)
    await paint(page, 'Verde', [1, 1])
    await button(page, 'Nova camada').click()
    await button(page, 'Camada 1').click()
    const before = await readWhen(page, project => project.layers.length === 2 && project.activeLayerId === project.layers[0].id)
    await choose(page, png('lenta.png', pattern(40, 30)))
    await expect.poll(async () => (await imports(page)).held).toBe(1)
    await page.keyboard.press('Escape')
    await expect(dialog(page)).toHaveCount(0)
    await release(page)
    await page.waitForTimeout(300)
    expect(await read(page)).toEqual(before)
    await expect(row(page, 1)).toHaveAttribute('aria-pressed', 'true')
    expect(await journals(page)).toEqual({})
    const state = await imports(page)
    expect(state.terminated).toBeGreaterThanOrEqual(state.created)
    await page.reload()
    await expectOpen(page, 'Cancelar', 5, 4)
    expect(await read(page)).toEqual(before)
    await expect(row(page, 1)).toHaveAttribute('aria-pressed', 'true')
  })

  test(`@I9R ${run} isola a importação entre dois bordados`, async ({ page }) => {
    await page.addInitScript(holdWorkers)
    await create(page, 'Leste', 4, 4)
    await paint(page, 'Rosa', [0, 0])
    const east = await readWhen(page, project => project.layers[0].cells[0] === hex.Rosa)
    await create(page, 'Oeste', 7, 3, 2)
    await paint(page, 'Roxo', [6, 2])
    const west = await readWhen(page, project => project.layers[0].cells[20] === hex.Roxo, 2)
    const image = pattern(8, 8)

    // A conversion started for Oeste and left pending is never applied to Leste.
    await choose(page, png('oeste.png', image))
    await expect.poll(async () => (await imports(page)).held).toBe(1)
    await button(page, 'Cancelar').click()
    await button(page, 'Bordado 1: Leste').click()
    await expectOpen(page, 'Leste', 4, 4)
    await release(page)
    await page.waitForTimeout(300)
    await expect(dialog(page)).toHaveCount(0)
    expect(await read(page, 1)).toEqual(east)
    expect(await read(page, 2)).toEqual(west)

    const imported = await importImage(page, png('leste.png', image))
    expectImported(east, imported, referenceCells(image, 4, 4))
    await button(page, 'Bordado 2: Oeste').click()
    await expectOpen(page, 'Oeste', 7, 3, 2)
    await undo(page)
    await page.waitForTimeout(200)
    expect(await read(page, 2)).toEqual(west)
    expect(await read(page, 1)).toEqual(imported)
    await page.reload()
    await expectOpen(page, 'Oeste', 7, 3, 2)
    expect((await readLibrary(page)).selected).toBe(2)
    await button(page, 'Bordado 1: Leste').click()
    await expect(row(page, 2)).toHaveAttribute('aria-pressed', 'true')
    expect(await read(page, 1)).toEqual(imported)
  })
}

for (const viewport of [{ width: 1280, height: 720 }, { width: 1920, height: 1080 }]) {
  test('I9 importa pelo teclado com controles rotulados em ' + viewport.width, async ({ page }, info) => {
    await page.setViewportSize(viewport)
    await create(page, 'Teclado', 60, 60)
    await paint(page, 'Azul', [0, 0])
    const before = await readWhen(page, project => project.layers[0].cells[0] === hex.Azul)
    const trigger = button(page, 'Importar imagem')
    await expect(trigger).toBeInViewport({ ratio: 1 })
    // Listen first: Playwright enables chooser interception asynchronously.
    const chooser = page.waitForEvent('filechooser')
    // Subir, Descer and Excluir are disabled with a single layer.
    await page.getByRole('slider', { name: 'Opacidade' }).focus()
    await page.keyboard.press('Tab')
    await expect(trigger).toBeFocused()
    await page.keyboard.press('Enter')
    const image = pattern(90, 60)
    await (await chooser).setFiles(png('teclado.png', image))
    await expect(confirmButton(page)).toBeEnabled()
    await expect(button(page, 'Cancelar')).toBeFocused()
    for (const control of [confirmButton(page), button(page, 'Escolher outro arquivo'), button(page, 'Cancelar'),
      page.getByRole('radio', { name: 'Composição completa' }), page.getByRole('radio', { name: 'Somente a nova camada' }), previewCanvas(page)]) {
      await expect(control).toBeInViewport({ ratio: 1 })
    }
    const box = (await previewCanvas(page).boundingBox())!
    expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(150)
    await page.keyboard.press('Shift+Tab')
    await expect(button(page, 'Escolher outro arquivo')).toBeFocused()
    await page.keyboard.press('Shift+Tab')
    await expect(confirmButton(page)).toBeFocused()
    await page.keyboard.press('Shift+Tab')
    await expect(page.getByRole('radio', { name: 'Composição completa' })).toBeFocused()
    await page.keyboard.press('ArrowRight')
    await expect(page.getByRole('radio', { name: 'Somente a nova camada' })).toBeChecked()
    await page.screenshot({ path: info.outputPath('previa-' + viewport.width + '.png') })
    await page.keyboard.press('Tab')
    await expect(confirmButton(page)).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(dialog(page)).toHaveCount(0)
    const after = await readWhen(page, project => project.layers.length === 2)
    expectImported(before, after, referenceCells(image, 60, 60))
    await expect(row(page, 2)).toHaveAttribute('aria-pressed', 'true')
    await page.screenshot({ path: info.outputPath('importada-' + viewport.width + '.png') })
  })
}
