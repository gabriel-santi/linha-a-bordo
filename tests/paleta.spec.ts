import { test, expect, type Locator } from '@playwright/test'

const palette = {
  Preto: '#222222', Cinza: '#777777', Branco: '#ffffff', Marrom: '#774631',
  Bege: '#dcc29b', Vermelho: '#c82e37', Laranja: '#eb782b', Amarelo: '#f3d344',
  Verde: '#3b804a', Azul: '#3066bd', Roxo: '#773e9d', Rosa: '#df72a3',
  'Verde-claro': '#90ce97', 'Azul-claro': '#8dbbfa',
}
const empty = '#fffcf6'
const pitch = 16
const canvasSize = 962

async function pixel(canvas: Locator, x: number, y: number) {
  return canvas.evaluate((element: HTMLCanvasElement, [x, y]) => {
    const { data } = element.getContext('2d')!.getImageData(x, y, 1, 1)
    return '#' + [...data.slice(0, 3)].map(value => value.toString(16).padStart(2, '0')).join('')
  }, [x, y])
}

function cellColor(canvas: Locator, col: number, row: number) {
  return pixel(canvas, col * pitch + 8, row * pitch + 8)
}

async function cellPosition(canvas: Locator, col: number, row: number) {
  const box = (await canvas.boundingBox())!
  return {
    x: box.x + (col * pitch + 8) * box.width / canvasSize,
    y: box.y + (row * pitch + 8) * box.height / canvasSize,
  }
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto('/')
  await page.getByLabel('Nome do bordado').fill('Jardim de ipês')
  await page.getByRole('button', { name: 'Criar bordado' }).click()
})

test('aplica as 14 cores fixas por teclado e distingue branco de vazio até apagar', async ({ page }) => {
  const canvas = page.locator('canvas')
  const tools = page.getByRole('group', { name: 'Paleta de cores e borracha' })
  const eraser = tools.getByRole('button', { name: 'Borracha' })
  await expect(tools.getByRole('button')).toHaveCount(15)
  await expect(tools.getByRole('button', { name: 'Preto', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await page.getByRole('button', { name: 'Baixar PNG' }).focus()

  for (const [col, [name, color]] of Object.entries(palette).entries()) {
    const swatch = tools.getByRole('button', { name, exact: true })
    await page.keyboard.press('Tab')
    await expect(swatch).toBeFocused()
    await page.keyboard.press(col % 2 === 0 ? 'Space' : 'Enter')
    await expect(swatch).toHaveAttribute('aria-pressed', 'true')
    await expect(swatch).toHaveCSS('box-shadow', /rgb\(243, 237, 246\)/)
    const { x, y } = await cellPosition(canvas, col, 0)
    await page.mouse.click(x, y)
    expect(await cellColor(canvas, col, 0)).toBe(color)
    await swatch.focus()
  }
  expect(await cellColor(canvas, 2, 1)).toBe(empty)
  expect(await pixel(canvas, 2 * pitch + 1, 8)).toBe('#8e8a80')
  await eraser.click()
  await expect(eraser).toHaveAttribute('aria-pressed', 'true')
  const white = await cellPosition(canvas, 2, 0)
  await page.mouse.click(white.x, white.y)
  expect(await cellColor(canvas, 2, 0)).toBe(empty)
  expect(await pixel(canvas, 2 * pitch + 1, 8)).toBe(empty)
  expect(await cellColor(canvas, 1, 0)).toBe(palette.Cinza)
})

test('pinta e apaga entre eventos espaçados e encerra os gestos ao soltar', async ({ page }) => {
  const canvas = page.locator('canvas')
  const row = 10
  async function moveTo(col: number, targetRow = row) {
    const { x, y } = await cellPosition(canvas, col, targetRow)
    await page.mouse.move(x, y)
  }

  await page.getByRole('button', { name: 'Azul', exact: true }).click()
  await moveTo(6)
  await page.mouse.down()
  await moveTo(19)
  await page.mouse.up()
  await moveTo(22)

  for (let col = 6; col <= 19; col++) {
    expect(await cellColor(canvas, col, row)).toBe(palette.Azul)
    expect(await cellColor(canvas, col, row - 1)).toBe(empty)
    expect(await cellColor(canvas, col, row + 1)).toBe(empty)
  }
  expect(await cellColor(canvas, 5, row)).toBe(empty)
  expect(await cellColor(canvas, 20, row)).toBe(empty)
  expect(await cellColor(canvas, 22, row)).toBe(empty)

  await page.getByRole('button', { name: 'Borracha' }).click()
  await moveTo(15)
  await page.mouse.down()
  await moveTo(9)
  await page.mouse.up()
  await moveTo(6)

  for (let col = 6; col <= 19; col++) {
    expect(await cellColor(canvas, col, row)).toBe(col >= 9 && col <= 15 ? empty : palette.Azul)
  }

  await expect(canvas).toBeInViewport({ ratio: 1 })
  for (let line = 0; line <= 60; line++) {
    const color = line % 10 === 0 ? '#535e4d' : '#b5b8ab'
    expect(await pixel(canvas, line * pitch, row * pitch + 8)).toBe(color)
    expect(await pixel(canvas, 8 * pitch + 8, line * pitch)).toBe(color)
  }
})

test('pinta as células atravessadas por um arraste oblíquo', async ({ page }) => {
  const canvas = page.locator('canvas')
  const start = await cellPosition(canvas, 2, 2)
  const end = await cellPosition(canvas, 6, 3)
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await page.mouse.move(end.x, end.y)
  await page.mouse.up()

  for (const [col, row] of [[2, 2], [3, 2], [4, 2], [4, 3], [5, 3], [6, 3]]) {
    expect(await cellColor(canvas, col, row)).toBe(palette.Preto)
  }
  for (const [col, row] of [[3, 3], [5, 2], [7, 3]]) {
    expect(await cellColor(canvas, col, row)).toBe(empty)
  }
})
