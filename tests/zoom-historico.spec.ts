import { expect, test, type Locator, type Page } from '@playwright/test'

type Cell = [col: number, row: number]

const empty = '#fffcf6'
const black = '#222222'
const red = '#c82e37'
const blue = '#3066bd'
const white = '#ffffff'

function pixel(canvas: Locator, x: number, y: number) {
  return canvas.evaluate((element: HTMLCanvasElement, [x, y]) => {
    const { data } = element.getContext('2d')!.getImageData(x, y, 1, 1)
    return '#' + [...data.slice(0, 3)].map(value => value.toString(16).padStart(2, '0')).join('')
  }, [x, y])
}

async function colors(canvas: Locator, cells: Cell[]) {
  return Promise.all(cells.map(([col, row]) => pixel(canvas, col * 16 + 8, row * 16 + 8)))
}

async function draw(page: Page, canvas: Locator, [first, ...rest]: Cell[]) {
  const box = (await canvas.boundingBox())!
  const move = ([col, row]: Cell) => page.mouse.move(
    box.x + (col * 16 + 8) * box.width / 962,
    box.y + (row * 16 + 8) * box.height / 962,
  )
  await move(first)
  await page.mouse.down()
  for (const cell of rest) await move(cell)
  await page.mouse.up()
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto('/')
  await page.getByLabel('Nome do bordado').fill('Detalhes de ipê')
  await page.getByRole('button', { name: 'Criar bordado' }).click()
})

test('navega pela grade ampliada, edita as bordas e volta à vista inteira', async ({ page }) => {
  const canvas = page.locator('canvas')
  const area = page.getByRole('region', { name: 'Área da grade' })
  const zoom = page.getByRole('group', { name: 'Zoom da grade' })
  const zoomIn = zoom.getByRole('button', { name: 'Aumentar zoom' })
  const fit = zoom.getByRole('button', { name: 'Ajustar à tela' })
  await expect(canvas).toBeInViewport({ ratio: 1 })
  const initialWidth = (await canvas.boundingBox())!.width
  const center: Cell = [30, 30]
  await draw(page, canvas, [center])

  const zoomOut = zoom.getByRole('button', { name: 'Diminuir zoom' })
  const current = zoom.getByRole('status')
  await expect(current).toHaveText('100%')
  await expect(zoomOut).toBeDisabled()
  await expect(fit).toBeDisabled()
  const centerInCanvas = () => area.evaluate(element => {
    const view = element.getBoundingClientRect()
    const grid = element.querySelector('canvas')!.getBoundingClientRect()
    return [
      (view.left + element.clientWidth / 2 - grid.left) / grid.width,
      (view.top + element.clientHeight / 2 - grid.top) / grid.height,
    ]
  })
  for (const percent of [150, 200, 250, 300, 350, 400]) {
    const before = await centerInCanvas()
    await zoomIn.click()
    await expect(current).toHaveText(percent + '%')
    const width = (await canvas.boundingBox())!.width
    expect(width).toBeCloseTo(initialWidth * percent / 100)
    const after = await centerInCanvas()
    for (const [axis, coordinate] of after.entries()) {
      // The browser stores scroll offsets as whole CSS pixels.
      expect(Math.abs(coordinate - before[axis]) * width).toBeLessThanOrEqual(1)
    }
  }
  await expect(zoomIn).toBeDisabled()
  for (const percent of [350, 300, 250, 200, 150, 100]) {
    await zoomOut.click()
    await expect(current).toHaveText(percent + '%')
  }
  await expect(zoomOut).toBeDisabled()
  for (let step = 0; step < 3; step++) await zoomIn.click()
  await expect(current).toHaveText('250%')


  await area.hover()
  await page.mouse.wheel(-5000, -5000)
  await expect.poll(() => area.evaluate(element => [element.scrollLeft, element.scrollTop])).toEqual([0, 0])
  const first: Cell = [0, 0]
  await page.getByRole('button', { name: 'Azul' }).click()
  await draw(page, canvas, [first])
  const firstNeighbors: Cell[] = [first, [1, 0], [0, 1]]
  expect(await colors(canvas, firstNeighbors)).toEqual([blue, empty, empty])
  await page.getByRole('button', { name: 'Borracha' }).click()
  await draw(page, canvas, [first])
  expect(await colors(canvas, firstNeighbors)).toEqual([empty, empty, empty])
  await page.keyboard.press('Control+z')
  expect(await colors(canvas, firstNeighbors)).toEqual([blue, empty, empty])
  await page.getByRole('button', { name: 'Azul' }).click()
  for (let step = 0; step < 3; step++) await zoomIn.click()
  await expect(current).toHaveText('400%')

  await area.hover()
  await page.mouse.wheel(5000, 5000)
  await expect.poll(() => area.evaluate(element => [
    element.scrollWidth - element.clientWidth - element.scrollLeft,
    element.scrollHeight - element.clientHeight - element.scrollTop,
  ])).toEqual([0, 0])
  const last: Cell = [59, 59]
  await draw(page, canvas, [last])
  expect(await colors(canvas, [last, [58, 59], [59, 58]])).toEqual([blue, empty, empty])
  await page.getByRole('button', { name: 'Borracha' }).click()
  await draw(page, canvas, [last])
  expect(await colors(canvas, [last, [58, 59], [59, 58]])).toEqual([empty, empty, empty])
  expect(await pixel(canvas, 960, 952)).toBe('#535e4d')
  expect(await pixel(canvas, 952, 944)).toBe('#b5b8ab')

  await fit.click()
  await expect(zoom.getByRole('status')).toHaveText('100%')
  await expect(canvas).toBeInViewport({ ratio: 1 })
  expect((await canvas.boundingBox())!.width).toBe(initialWidth)
  expect(await colors(canvas, [first, center, last])).toEqual([blue, black, empty])
  await page.keyboard.press('Control+z')
  expect(await colors(canvas, [first, center, last])).toEqual([blue, black, blue])
  await page.keyboard.press('Control+y')
  expect(await colors(canvas, [first, center, last])).toEqual([blue, black, empty])
})

test('desfaz e refaz cliques e arrastes de pintura com sobreposição', async ({ page }) => {
  const canvas = page.locator('canvas')
  const row: Cell[] = [[5, 6], [6, 6], [7, 6], [8, 6], [9, 6], [10, 6]]
  const [first, second, third, , fifth] = row
  await page.keyboard.press('Control+z')
  await page.keyboard.press('Control+y')
  expect(await colors(canvas, row)).toEqual(row.map(() => empty))

  await draw(page, canvas, [first])
  await page.getByRole('button', { name: 'Vermelho' }).click()
  await draw(page, canvas, [first, third, first])
  await page.getByRole('button', { name: 'Azul' }).click()
  await draw(page, canvas, [second, fifth])
  const final = [red, blue, blue, blue, blue, empty]
  expect(await colors(canvas, row)).toEqual(final)

  await page.keyboard.press('Control+z')
  expect(await colors(canvas, row)).toEqual([red, red, red, empty, empty, empty])
  await page.keyboard.press('Control+z')
  expect(await colors(canvas, row)).toEqual([black, empty, empty, empty, empty, empty])
  await page.keyboard.press('Control+z')
  await page.keyboard.press('Control+z')
  expect(await colors(canvas, row)).toEqual(row.map(() => empty))

  await page.keyboard.press('Control+y')
  expect(await colors(canvas, row)).toEqual([black, empty, empty, empty, empty, empty])
  await page.keyboard.press('Control+y')
  expect(await colors(canvas, row)).toEqual([red, red, red, empty, empty, empty])
  await page.keyboard.press('Control+y')
  await page.keyboard.press('Control+y')
  expect(await colors(canvas, row)).toEqual(final)
  expect(await colors(canvas, [[7, 5], [7, 7]])).toEqual([empty, empty])
})

test('restaura trecho multicolorido com branco e descarta o refazer ao editar', async ({ page }) => {
  const canvas = page.locator('canvas')
  const row: Cell[] = [[28, 30], [29, 30], [30, 30], [31, 30], [32, 30], [33, 30]]
  for (const [index, name] of ['Vermelho', 'Branco', 'Azul', 'Preto'].entries()) {
    await page.getByRole('button', { name, exact: true }).click()
    await draw(page, canvas, [row[index]])
  }

  const eraser = page.getByRole('button', { name: 'Borracha' })
  const restored = [red, white, blue, black, empty, empty]
  const erased = [empty, empty, empty, black, empty, empty]
  const whiteBorder = () => pixel(canvas, 29 * 16 + 1, 30 * 16 + 8)
  await page.getByRole('button', { name: 'Aumentar zoom' }).click()
  await eraser.click()
  await draw(page, canvas, [row[2], row[0]])
  expect(await colors(canvas, row)).toEqual(erased)
  expect(await whiteBorder()).toBe(empty)

  await page.keyboard.press('Control+z')
  expect(await colors(canvas, row)).toEqual(restored)
  expect(await whiteBorder()).toBe('#8e8a80')
  await page.getByRole('button', { name: 'Diminuir zoom' }).click()
  await page.keyboard.press('Control+y')
  expect(await colors(canvas, row)).toEqual(erased)
  await page.keyboard.press('Control+z')

  await draw(page, canvas, [row[4]])
  await page.keyboard.press('Control+y')
  expect(await colors(canvas, row)).toEqual(erased)
  await page.keyboard.press('Control+z')

  await draw(page, canvas, [row[3]])
  expect(await colors(canvas, row)).toEqual([red, white, blue, empty, empty, empty])
  await page.keyboard.press('Control+y')
  expect(await colors(canvas, row)).toEqual([red, white, blue, empty, empty, empty])
  await page.keyboard.press('Control+z')
  expect(await colors(canvas, row)).toEqual(restored)
  await page.keyboard.press('Control+y')
  expect(await colors(canvas, row)).toEqual([red, white, blue, empty, empty, empty])
})
