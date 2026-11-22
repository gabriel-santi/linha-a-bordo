import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'

const empty = '#fffcf6'
const black = '#222222'
const green = '#90ce97'
const blue = '#8dbbfa'
const custom = '#7b2a04'
type Cell = [col: number, row: number]

const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true })
const hex = (page: Page) => page.getByLabel('Hexadecimal')
const picker = (page: Page) => page.getByLabel('Cor', { exact: true })
const size = (page: Page) => page.getByLabel('Tamanho da borracha')
const grid = (page: Page) => page.locator('canvas')
const area = (page: Page) => page.getByRole('region', { name: 'Área da grade' })

async function create(page: Page, name = 'Jardim', next = false) {
  if (next) await button(page, 'Novo bordado').click()
  else await page.goto('/')
  await page.getByLabel('Nome do bordado').fill(name)
  await button(page, 'Criar bordado').click()
  await expect(page.getByRole('banner').getByRole('heading')).toHaveText(name)
}

async function position(page: Page, [col, row]: Cell) {
  const box = (await grid(page).boundingBox())!
  return [box.x + (col * 16 + 8) * box.width / 962, box.y + (row * 16 + 8) * box.height / 962] as const
}

async function draw(page: Page, ...points: Cell[]) {
  await page.mouse.move(...await position(page, points[0]))
  await page.mouse.down()
  for (const point of points.slice(1)) await page.mouse.move(...await position(page, point))
  await page.mouse.up()
}

function pixels(page: Page, points: Cell[], centers = true) {
  return grid(page).evaluate((canvas: HTMLCanvasElement, { points, centers }) => {
    const ctx = canvas.getContext('2d')!
    return points.map(([x, y]) => {
      const { data } = ctx.getImageData(centers ? x * 16 + 8 : x, centers ? y * 16 + 8 : y, 1, 1)
      return '#' + [...data.slice(0, 3)].map(byte => byte.toString(16).padStart(2, '0')).join('')
    })
  }, { points, centers })
}

function block(left: number, top: number, width: number, height = width): Cell[] {
  return Array.from({ length: width * height }, (_, i) => [left + i % width, top + Math.floor(i / width)])
}

async function zoom(page: Page) {
  await button(page, 'Aumentar zoom').click()
  await expect(page.getByLabel('Zoom atual')).toHaveText('150%')
  for (let step = 0; step < 5; step++) await button(page, 'Aumentar zoom').click()
  await expect(page.getByLabel('Zoom atual')).toHaveText('400%')
}

for (const viewport of [{ width: 1280, height: 720 }, { width: 1920, height: 1080 }]) {
  test('C2/C7 edita a cor e opera os controles por teclado em ' + viewport.width, async ({ page }, info) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
    await page.setViewportSize(viewport)
    await create(page)
    const eraser = button(page, 'Borracha')
    await expect(page.locator('html')).toHaveCSS('color-scheme', 'dark')
    await expect(grid(page)).toBeInViewport({ ratio: 1 })
    await expect(size(page)).toHaveValue('1')
    for (const control of [picker(page), hex(page), size(page)]) {
      await expect(control).toBeInViewport({ ratio: 1 })
    }

    await draw(page, [2, 2])
    await eraser.focus()
    await page.keyboard.press('Space')
    await expect(eraser).toHaveAttribute('aria-pressed', 'true')
    // The eraser size sits next to the eraser, before the custom color.
    await page.keyboard.press('Tab')
    await expect(size(page)).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(picker(page)).toBeFocused()
    await expect(picker(page)).toHaveCSS('outline-style', 'solid')
    // Set the native input through the browser's input event, without depending on the OS dialog.
    await picker(page).fill('#1324f0')
    await expect(hex(page)).toHaveValue('#1324f0')
    await expect(eraser).toHaveAttribute('aria-pressed', 'false')
    await draw(page, [8, 3])
    expect(await pixels(page, [[8, 3]])).toEqual(['#1324f0'])
    await picker(page).focus()
    await page.keyboard.press('Tab')
    await expect(hex(page)).toBeFocused()
    await page.keyboard.press('Control+a')
    await page.keyboard.type('#7B2A04')
    await expect(picker(page)).toHaveValue(custom)
    await page.keyboard.press('Control+z')
    await page.keyboard.press('Control+y')
    expect(await pixels(page, [[2, 2], [3, 2]])).toEqual([black, empty])
    await hex(page).fill('#7B2A04')
    await page.keyboard.press('Shift+Tab')
    await expect(picker(page)).toBeFocused()
    await page.keyboard.press('Shift+Tab')
    await expect(size(page)).toBeFocused()
    await expect(hex(page)).toHaveValue(custom)
    await page.keyboard.press('ArrowDown')
    await expect(size(page)).toHaveValue('3')
    await expect(size(page)).toHaveCSS('outline-style', 'solid')
    await page.screenshot({ path: info.outputPath('controles-' + viewport.width + '.png') })
    await draw(page, [3, 2])
    await expect(picker(page)).toHaveValue(custom)
    for (const [col, invalid] of [[4, '#abc'], [5, '#00XX00'], [6, '#11223344']] as const) {
      await hex(page).fill(invalid)
      await expect(hex(page)).toHaveAttribute('aria-invalid', 'true')
      await expect(hex(page)).toHaveAccessibleDescription('Use o formato #RRGGBB.')
      await expect(picker(page)).toHaveValue(custom)
      await draw(page, [col, 2])
    }
    await page.screenshot({ path: info.outputPath('hex-invalido-' + viewport.width + '.png') })
    await eraser.click()
    await hex(page).fill('#FFFFFF')
    await expect(hex(page)).toHaveAttribute('aria-invalid', 'false')
    await expect(button(page, 'Branco')).toHaveAttribute('aria-pressed', 'true')
    await draw(page, [7, 2])
    expect(await pixels(page, block(2, 2, 7, 1))).toEqual([black, custom, custom, custom, custom, '#ffffff', empty])
    expect(await pixels(page, [[113, 40]], false)).toEqual(['#8e8a80'])
    expect(errors).toEqual([])
  })

  test('C4/C7 desfaz e refaz o apagamento com foco no tamanho em ' + viewport.width, async ({ page }, info) => {
    await page.setViewportSize(viewport)
    await create(page)
    const sample: Cell[] = [[2, 2], [3, 2], [4, 2]]
    const painted = [black, custom, empty]
    const erased = [empty, empty, empty]

    await draw(page, sample[0])
    await hex(page).fill(custom)
    await draw(page, sample[1])
    expect(await pixels(page, sample)).toEqual(painted)

    await button(page, 'Borracha').click()
    await size(page).selectOption('3')
    await draw(page, sample[0])
    expect(await pixels(page, sample)).toEqual(erased)

    await button(page, 'Borracha').focus()
    await page.keyboard.press('Tab')
    await expect(size(page)).toBeFocused()
    await page.keyboard.press('Control+z')
    expect(await pixels(page, sample)).toEqual(painted)
    await expect(size(page)).toBeFocused()
    await page.screenshot({ path: info.outputPath('desfazer-seletor.png') })

    await page.keyboard.press('Tab')
    await expect(picker(page)).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(hex(page)).toBeFocused()
    for (const shortcut of ['Control+z', 'Control+y']) {
      await page.keyboard.press(shortcut)
      expect(await pixels(page, sample)).toEqual(painted)
    }

    await button(page, 'Renomear').click()
    const name = page.getByRole('dialog').getByLabel('Nome do bordado')
    await expect(name).toBeFocused()
    for (const shortcut of ['Control+z', 'Control+y']) {
      await page.keyboard.press(shortcut)
      expect(await pixels(page, sample)).toEqual(painted)
    }
    await page.keyboard.press('Escape')

    await button(page, 'Borracha').focus()
    await page.keyboard.press('Tab')
    await expect(size(page)).toBeFocused()
    await page.keyboard.press('Control+y')
    expect(await pixels(page, sample)).toEqual(erased)
    await expect(size(page)).toBeFocused()
    await page.screenshot({ path: info.outputPath('refazer-seletor.png') })
  })
}

test('C3 recorta os quatro tamanhos no centro, na borda e no canto com zoom e rolagem', async ({ page }, info) => {
  await create(page)
  const sample = [...block(3, 3, 11), ...block(0, 20, 6, 11), ...block(54, 54, 6)]
  for (const [left, right, top, bottom] of [[3, 13, 3, 13], [0, 5, 20, 30], [54, 59, 54, 59]]) {
    for (let row = top; row <= bottom; row++) await draw(page, [left, row], [right, row])
  }
  const eraser = button(page, 'Borracha')
  await expect(size(page)).toHaveValue('1')
  await eraser.click()
  for (const percent of [100, 400]) {
    if (percent === 400) await zoom(page)
    for (const [x, y] of [[8, 8], [0, 25], [59, 59]]) {
      const [left, top] = await area(page).evaluate((view, [x, y]) => {
        const canvas = view.querySelector('canvas')!
        view.scrollTo(canvas.clientWidth * (x + 0.5) / 60 - view.clientWidth / 2,
          canvas.clientHeight * (y + 0.5) / 60 - view.clientHeight / 2)
        return [view.scrollLeft, view.scrollTop]
      }, [x, y])
      if (percent === 400 && x === 59) expect(Math.min(left, top)).toBeGreaterThan(0)
      for (const side of [1, 3, 5, 9]) {
        await size(page).selectOption(String(side))
        await draw(page, [x, y])
        expect(await pixels(page, sample)).toEqual(sample.map(([col, row]) =>
          Math.max(Math.abs(col - x), Math.abs(row - y)) <= (side - 1) / 2 ? empty : black))
        if (percent === 400 && x === 59 && side === 9) {
          await page.screenshot({ path: info.outputPath('canto-9x9-400.png') })
        }
        await page.keyboard.press('Control+z')
        expect(await pixels(page, sample)).toEqual(sample.map(() => black))
      }
    }
  }
  await button(page, 'Ajustar à tela').click()
  await button(page, 'Azul-claro').click()
  await draw(page, [18, 18], [22, 18])
  expect(await pixels(page, block(17, 17, 7, 3))).toEqual(block(17, 17, 7, 3).map(([x, y]) =>
    y === 18 && x >= 18 && x <= 22 ? blue : empty))
})

test('C4 apaga todo o trajeto oblíquo em um gesto, inclusive com controles alterados durante o arraste', async ({ page }) => {
  await create(page)
  const sample = block(0, 0, 13, 10)
  for (let row = 1; row < 9; row++) {
    await button(page, row % 2 ? 'Verde-claro' : 'Branco').click()
    await draw(page, [1, row], [11, row])
  }
  const original = await pixels(page, sample)
  const originalGrid = await grid(page).evaluate(canvas => canvas.toDataURL())
  const crossing: Cell[] = [[2, 2], [3, 2], [4, 2], [4, 3], [5, 3], [6, 3]]
  const erased = original.map((color, i) => crossing.some(([x, y]) =>
    Math.abs(x - sample[i][0]) <= 1 && Math.abs(y - sample[i][1]) <= 1) ? empty : color)
  const eraser = button(page, 'Borracha')
  await eraser.click()
  await size(page).selectOption('3')
  await page.mouse.move(...await position(page, [2, 2]))
  await page.mouse.down()
  await size(page).selectOption('9')
  await button(page, 'Azul-claro').evaluate(element => element.click())
  await page.mouse.move(...await position(page, [6, 3]))
  await page.mouse.move(...await position(page, [2, 2]))
  await page.mouse.up()
  await page.mouse.move(...await position(page, [8, 7]))
  expect(await pixels(page, sample)).toEqual(erased)
  const boundary = Array.from({ length: 61 }, (_, i): Cell => [i * 16, 40])
  expect(await pixels(page, boundary, false)).toEqual(boundary.map((_, i) => i % 10 ? '#b5b8ab' : '#535e4d'))

  await eraser.click()
  await size(page).selectOption('5')
  await page.mouse.move(...await position(page, [7, 4]))
  await page.mouse.down()
  await grid(page).evaluate(canvas => canvas.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1, bubbles: true })))
  await page.mouse.move(...await position(page, [10, 8]))
  await page.mouse.up()
  const afterCancel = erased.map((color, i) => {
    const [x, y] = sample[i]
    return Math.abs(x - 7) <= 2 && Math.abs(y - 4) <= 2 ? empty : color
  })
  expect(await pixels(page, sample)).toEqual(afterCancel)
  await page.keyboard.press('Control+z')
  expect(await pixels(page, sample)).toEqual(erased)
  await page.keyboard.press('Control+z')
  expect(await grid(page).evaluate(canvas => canvas.toDataURL())).toBe(originalGrid)
  await page.keyboard.press('Control+y')
  expect(await pixels(page, sample)).toEqual(erased)
  await button(page, 'Azul-claro').click()
  await draw(page, [0, 0])
  await page.keyboard.press('Control+y')
  expect(await pixels(page, sample)).toEqual([blue, ...erased.slice(1)])
})

async function paintProjects(page: Page) {
  await create(page)
  await hex(page).fill('#7B2A04')
  await draw(page, [1, 2], [5, 2])
  await button(page, 'Azul').click()
  await draw(page, [0, 2])
  await create(page, 'Maré', true)
  await button(page, 'Azul-claro').click()
  await draw(page, [0, 2], [5, 2])
  await button(page, 'Bordado 1: Jardim').click()
  await button(page, 'Borracha').click()
  await size(page).selectOption('3')
}

async function expectProjects(page: Page) {
  const cells = block(0, 2, 6, 1)
  await expect(page.getByRole('banner').getByRole('heading')).toHaveText('Jardim')
  expect(await pixels(page, cells)).toEqual(['#3066bd', custom, empty, empty, empty, custom])
  await button(page, 'Bordado 2: Maré').click()
  expect(await pixels(page, cells)).toEqual(cells.map(() => blue))
}

test('@C5 recupera o apagamento na recarga acionada pelo próprio pointerup', async ({ page }) => {
  await paintProjects(page)
  await page.evaluate(() => window.addEventListener('pointerup', () => location.reload(), { once: true }))
  const loaded = page.waitForEvent('load')
  await draw(page, [3, 2])
  await loaded
  await expectProjects(page)
})

test('@C5 fecha e reabre o navegador com o mesmo perfil', async ({ browser, baseURL, channel }) => {
  const profiles = join(process.cwd(), 'test-results')
  await mkdir(profiles, { recursive: true })
  const profile = await mkdtemp(join(profiles, 'p-'))
  const launch = () => browser.browserType().launchPersistentContext(profile, { baseURL, channel })
  try {
    let context = await launch()
    try {
      const [page] = context.pages()
      await paintProjects(page)
      await draw(page, [3, 2])
    } finally {
      await context.close()
    }
    context = await launch()
    try {
      const [page] = context.pages()
      await page.goto('/')
      await expectProjects(page)
    } finally {
      await context.close()
    }
  } finally {
    await rm(profile, { recursive: true, force: true })
  }
})

test('@C5 troca de bordado com a gravação ainda pendente', async ({ page, context }) => {
  await paintProjects(page)
  const blocker = await context.newPage()
  await blocker.goto('/')
  await blocker.evaluate(() => new Promise<void>((resolve, reject) => {
    const open = indexedDB.open('linha-a-bordo')
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const db = open.result
      const tx = db.transaction('projects', 'readwrite')
      const store = tx.objectStore('projects')
      let released = false
      window.addEventListener('release-project-store', () => { released = true }, { once: true })
      tx.oncomplete = () => db.close()
      tx.onabort = () => { db.close(); reject(tx.error) }
      function keepOpen() {
        if (!released) store.get(1).onsuccess = keepOpen
      }
      store.get(1).onsuccess = () => { keepOpen(); resolve() }
    }
  }))
  try {
    await page.bringToFront()
    await draw(page, [3, 2])
    await button(page, 'Bordado 2: Maré').click()
    await expect(page.getByRole('banner').getByRole('heading')).toHaveText('Maré')
    expect(await pixels(page, block(0, 2, 6, 1))).toEqual(Array(6).fill(blue))
    const pending = await page.evaluate(() => localStorage.getItem('linha-a-bordo:pending:1'))
    expect(pending).not.toBeNull()
  } finally {
    await blocker.evaluate(() => window.dispatchEvent(new Event('release-project-store')))
    await blocker.close()
  }
  await button(page, 'Bordado 1: Jardim').click()
  await page.reload()
  await expectProjects(page)
})
