import { readFile } from 'node:fs/promises'
import { expect, test, type Page, type TestInfo } from '@playwright/test'

const palette = [
  ['Preto', '#222222'], ['Cinza', '#777777'], ['Branco', '#ffffff'],
  ['Marrom', '#774631'], ['Bege', '#dcc29b'], ['Vermelho', '#c82e37'],
  ['Laranja', '#eb782b'], ['Amarelo', '#f3d344'], ['Verde', '#3b804a'],
  ['Azul', '#3066bd'], ['Roxo', '#773e9d'], ['Rosa', '#df72a3'],
  ['Verde-claro', '#90ce97'], ['Azul-claro', '#8dbbfa'],
] as const
const white = '#ffffff'
const blue = '#3066bd'
const black = '#222222'
const pink = '#df72a3'
const major = 0x535e4d
const fine = 0xb5b8ab

const projectName = 'Jardim de ipês'
const secondName = 'Maré'
const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true })
const selected = (page: Page) => page.getByRole('navigation').locator('[aria-current="true"]')

async function create(page: Page, name: string, number: number) {
  if (number > 1) await button(page, 'Novo bordado').click()
  await page.getByLabel('Nome do bordado').fill(name)
  await button(page, 'Criar bordado').click()
  await expectOpen(page, number, name)
}

async function expectOpen(page: Page, number: number, name: string) {
  await expect(page.getByRole('banner').getByRole('heading')).toHaveText(name)
  await expect(selected(page)).toHaveText(String(number))
  await expect(selected(page)).toHaveAccessibleName('Bordado ' + number + ': ' + name)
}

async function draw(page: Page, row: number, from: number, to = from) {
  const box = (await page.locator('canvas').boundingBox())!
  const move = (col: number) => page.mouse.move(
    box.x + (col * 16 + 8) * box.width / 962,
    box.y + (row * 16 + 8) * box.height / 962,
  )
  await move(from)
  await page.mouse.down()
  if (to !== from) await move(to)
  await page.mouse.up()
}

async function exportPng(page: Page, info: TestInfo, label: string, filename: string, activate: () => Promise<void>) {
  const [download] = await Promise.all([page.waitForEvent('download'), activate()])
  expect(download.suggestedFilename()).toBe(filename)
  expect(download.url()).toMatch(/^data:image\/png;base64,/)
  const path = info.outputPath(label + '.png')
  await download.saveAs(path)
  const bytes = await readFile(path)
  expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))

  return page.evaluate(async (encoded) => {
    const bytes = Uint8Array.from(atob(encoded), char => char.charCodeAt(0))
    const image = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
    const canvas = document.createElement('canvas')
    const { width, height } = image
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(image, 0, 0)
    image.close()
    const { data } = ctx.getImageData(0, 0, width, height)
    const rgb = (x: number, y: number) => {
      const i = 4 * (y * width + x)
      return data[i] * 65536 + data[i + 1] * 256 + data[i + 2]
    }
    return {
      width, height,
      opaque: data.every((value, index) => index % 4 !== 3 || value === 255),
      centers: Array.from({ length: 3600 }, (_, i) => rgb(i % 60 * 20 + 10, Math.floor(i / 60) * 20 + 10)),
      horizontal: Array.from({ length: width }, (_, x) => rgb(x, 10)),
      vertical: Array.from({ length: height }, (_, y) => rgb(10, y)),
      hash: Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data))),
    }
  }, bytes.toString('base64'))
}

function expectCenters(image: Awaited<ReturnType<typeof exportPng>>, cells: (string | null)[]) {
  expect([image.width, image.height]).toEqual([1200, 1200])
  expect(image.opaque).toBe(true)
  expect(image.centers).toEqual(cells.map(ink => Number.parseInt((ink ?? white).slice(1), 16)))
}

function readLibrary(page: Page) {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const open = indexedDB.open('linha-a-bordo')
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const db = open.result
      const tx = db.transaction(['projects', 'settings'])
      const projects = tx.objectStore('projects').getAll()
      const selected = tx.objectStore('settings').get('selected')
      tx.oncomplete = () => { db.close(); resolve({ projects: projects.result, selected: selected.result }) }
      tx.onabort = () => { db.close(); reject(tx.error) }
    }
  }))
}

for (const viewport of [{ width: 1280, height: 720 }, { width: 1920, height: 1080 }]) {
  test('baixa a grade vazia e mantém o controle acessível em ' + viewport.width, async ({ page }, info) => {
    await page.setViewportSize(viewport)
    await page.goto('/')
    await create(page, projectName, 1)

    const download = button(page, 'Baixar PNG')
    const canvas = page.locator('canvas')
    await expect(canvas).toBeInViewport({ ratio: 1 })
    await expect(download).toBeInViewport({ ratio: 1 })
    const gridBox = (await canvas.boundingBox())!
    const downloadBox = (await download.boundingBox())!
    expect(downloadBox.y + downloadBox.height).toBeLessThan(gridBox.y)
    for (const label of ['Renomear', 'Novo bordado', 'Aumentar zoom', 'Borracha']) {
      const control = button(page, label)
      await expect(control).toBeInViewport({ ratio: 1 })
      await control.click({ trial: true })
    }

    await button(page, 'Renomear').focus()
    await page.keyboard.press('Shift+Tab')
    await expect(download).toBeFocused()
    if (info.repeatEachIndex === 0) {
      await page.screenshot({ path: info.outputPath('editor-' + viewport.width + '.png') })
    }
    const image = await exportPng(page, info, 'grade-vazia', projectName + '.png',
      () => page.keyboard.press(viewport.width === 1280 ? 'Space' : 'Enter'))
    expectCenters(image, Array(3600).fill(null))

    // The two cuts cross all 60 cells and their 61 boundaries, away from intersections.
    const scan = Array.from({ length: 1200 }, (_, pixel) => {
      if (pixel >= 1198 || pixel % 200 < 2) return major
      return pixel % 20 === 0 ? fine : 0xffffff
    })
    expect(image.horizontal).toEqual(scan)
    expect(image.vertical).toEqual(scan)
  })
}

test('exporta as células atuais, inclusive fora do zoom, e preserva a biblioteca e o histórico', async ({ page }, info) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('/')
  await create(page, projectName, 1)
  const first = Array<string | null>(3600).fill(null)
  const second = Array<string | null>(3600).fill(null)
  const download = (label: string, name = projectName) =>
    exportPng(page, info, label, name + '.png', () => button(page, 'Baixar PNG').click())

  for (const [index, [name, color]] of palette.entries()) {
    await button(page, name).click()
    await draw(page, 0, index)
    first[index] = color
  }
  await button(page, 'Rosa').click()
  await draw(page, 59, 59)
  first[3599] = pink
  await button(page, 'Azul').click()
  await draw(page, 59, 0)
  first[3540] = blue
  await draw(page, 0, 59)
  first[59] = blue
  await draw(page, 2, 4, 8)
  first.fill(blue, 124, 129)
  await page.getByLabel('Hexadecimal').fill('#AB139F')
  await draw(page, 3, 7)
  await draw(page, 8, 8)
  first[187] = '#ab139f'
  first[488] = '#ab139f'
  expectCenters(await download('pintura'), first)

  await button(page, 'Borracha').click()
  await draw(page, 2, 4)
  first[124] = null
  expectCenters(await download('borracha-clique'), first)
  await page.getByLabel('Tamanho da borracha').selectOption('3')
  await draw(page, 2, 7)
  first.fill(null, 126, 129)
  first[187] = null
  expectCenters(await download('borracha-arraste'), first)
  await page.keyboard.press('Control+z')
  first.fill(blue, 126, 129)
  first[187] = '#ab139f'
  expectCenters(await download('desfazer'), first)
  await page.keyboard.press('Control+y')
  first.fill(null, 126, 129)
  first[187] = null

  const editor = page.locator('canvas')
  expect(await editor.evaluate(canvas => {
    const ctx = canvas.getContext('2d')!
    return [40, 232].map(x => Array.from(ctx.getImageData(x, 8, 1, 1).data))
  })).toEqual([[255, 255, 255, 255], [255, 252, 246, 255]])

  const full = await download('vista-integral')
  expectCenters(full, first)
  await page.reload()
  await expectOpen(page, 1, projectName)
  await expect(page.getByLabel('Zoom atual')).toHaveText('100%')
  const viewport = page.locator('.grid-area')
  const scrollPosition = () => viewport.evaluate(area => [area.scrollLeft, area.scrollTop])
  const before = await readLibrary(page)
  const editorBitmap = await editor.evaluate(canvas => canvas.toDataURL())
  for (const percent of [250, 400]) {
    for (let step = 0; step < 3; step++) await button(page, 'Aumentar zoom').click()
    await viewport.evaluate(area => area.scrollTo(0, 0))
    await viewport.evaluate(area => area.scrollTo(area.scrollWidth, area.scrollHeight))
    const zoomScroll = await scrollPosition()
    expect(zoomScroll[0]).toBeGreaterThan(0)
    expect(zoomScroll[1]).toBeGreaterThan(0)
    await expect(editor).not.toBeInViewport({ ratio: 1 })
    expect((await download('zoom-' + percent)).hash).toEqual(full.hash)
    await expectOpen(page, 1, projectName)
    await expect(page.getByLabel('Zoom atual')).toHaveText(percent + '%')
    expect(await scrollPosition()).toEqual(zoomScroll)
    expect(await editor.evaluate(canvas => canvas.toDataURL())).toBe(editorBitmap)
    expect(await readLibrary(page)).toEqual(before)
  }
  if (info.repeatEachIndex === 0) await page.screenshot({ path: info.outputPath('editor-zoom-400.png') })

  await draw(page, 59, 58)
  first[3598] = black
  expectCenters(await download('editado-com-zoom'), first)
  await page.keyboard.press('Control+z')
  expect((await download('zoom-desfeito')).hash).toEqual(full.hash)
  await page.keyboard.press('Control+y')
  const edited = await download('zoom-refeito')
  expectCenters(edited, first)

  await create(page, secondName, 2)
  await page.getByLabel('Cor', { exact: true }).fill('#2496df')
  await draw(page, 0, 14)
  second[14] = '#2496df'
  const secondPng = await download('segundo-bordado', secondName)
  expectCenters(secondPng, second)
  for (let step = 0; step < 6; step++) await button(page, 'Aumentar zoom').click()
  await viewport.evaluate(area => area.scrollTo(area.scrollWidth, area.scrollHeight))
  expect((await download('segundo-bordado-400', secondName)).hash).toEqual(secondPng.hash)
  await button(page, 'Bordado 1: ' + projectName).click()
  await page.reload()
  await expectOpen(page, 1, projectName)
  await expect(page.getByLabel('Zoom atual')).toHaveText('100%')
  expect((await download('bordado-reaberto')).hash).toEqual(edited.hash)
  expect(await readLibrary(page)).toEqual({
    projects: [{ number: 1, name: projectName, width: 60, height: 60, cells: first }, { number: 2, name: secondName, width: 60, height: 60, cells: second }],
    selected: 1,
  })
})

test('atualiza o nome do PNG a cada renomeação e preserva a sanitização', async ({ page }) => {
  await page.goto('/')
  await create(page, projectName, 1)

  async function expectFilename(filename: string) {
    const [download] = await Promise.all([page.waitForEvent('download'), button(page, 'Baixar PNG').click()])
    expect(download.suggestedFilename()).toBe(filename)
    expect(await download.failure()).toBeNull()
  }

  await expectFilename(projectName + '.png')
  for (const [name, filename] of [
    [secondName, secondName + '.png'],
    ['Mar <>:"/\\|?*', 'Mar _________.png'],
    ['<>:"/\\|?*', '_________.png'],
    ['a'.repeat(55), 'a'.repeat(54) + '.png'],
  ]) {
    await button(page, 'Renomear').click()
    await page.getByLabel('Nome do bordado').fill(name)
    await button(page, 'Salvar nome').click()
    await expectOpen(page, 1, name)
    await expectFilename(filename)
  }
})
