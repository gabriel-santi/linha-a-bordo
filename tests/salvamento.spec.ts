import { expect, test, type Page } from '@playwright/test'

const name = 'Jardim de ipês'
const empty = '#fffcf6'
const white = '#ffffff'
const blue = '#3066bd'

async function create(page: Page) {
  await page.goto('/')
  await page.getByLabel('Nome do bordado').fill(name)
  await page.getByRole('button', { name: 'Criar bordado' }).click()
  await expectProject(page)
}

async function expectProject(page: Page) {
  await expect(page.getByRole('banner').getByRole('heading')).toHaveText(name)
  await expect(page.getByRole('navigation').locator('[aria-current="true"]')).toHaveText('1')
}

function storedProjects(page: Page) {
  return page.evaluate(() => new Promise<{ number: number, name: string, width: 60, height: 60, cells: (string | null)[] }[]>((resolve, reject) => {
    const open = indexedDB.open('linha-a-bordo')
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const db = open.result
      const transaction = db.transaction('projects')
      const result = transaction.objectStore('projects').getAll()
      transaction.oncomplete = () => { db.close(); resolve(result.result) }
      transaction.onabort = () => { db.close(); reject(transaction.error) }
    }
  }))
}

async function draw(page: Page, from: number, to = from) {
  const box = (await page.locator('canvas').boundingBox())!
  const move = (col: number) => page.mouse.move(box.x + (col * 16 + 8) * box.width / 962, box.y + 8 * box.height / 962)
  await move(from)
  await page.mouse.down()
  if (to !== from) await move(to)
  await page.mouse.up()
}

function expectColors(page: Page, colors: string[]) {
  return expect.poll(() => page.locator('canvas').evaluate((canvas: HTMLCanvasElement, count) => {
    const ctx = canvas.getContext('2d')!
    return Array.from({ length: count }, (_, col) => {
      const { data } = ctx.getImageData(col * 16 + 8, 8, 1, 1)
      return '#' + [...data.slice(0, 3)].map(value => value.toString(16).padStart(2, '0')).join('')
    })
  }, colors.length)).toEqual(colors)
}

test('salva a identidade e todas as células mesmo com o bordado vazio', async ({ page }) => {
  await create(page)
  await page.reload()
  await expectProject(page)
  await expectColors(page, [empty])
  expect(await storedProjects(page)).toEqual([{ number: 1, name, width: 60, height: 60, cells: Array(3600).fill(null) }])
})

test('persiste pintura, borracha, undo e redo e reabre o desenho editável', async ({ page, context }) => {
  await create(page)
  await page.getByRole('button', { name: 'Branco' }).click()
  await draw(page, 0)
  await page.getByRole('button', { name: 'Azul', exact: true }).click()
  await draw(page, 1, 4)
  await page.reload()
  await expectColors(page, [white, blue, blue, blue, blue, empty])

  await page.getByRole('button', { name: 'Borracha' }).click()
  await draw(page, 2, 4)
  await page.keyboard.press('Control+z')
  await page.keyboard.press('Control+y')
  await page.reload()
  await expectColors(page, [white, blue, empty, empty, empty])

  await page.getByRole('button', { name: 'Azul', exact: true }).click()
  await draw(page, 2, 4)
  await draw(page, 0)
  await page.keyboard.press('Control+z')
  await page.keyboard.press('Control+z')
  await page.keyboard.press('Control+y')
  await page.keyboard.press('Control+z')
  await page.close()

  const reopened = await context.newPage()
  await reopened.goto('/')
  await expectProject(reopened)
  await expectColors(reopened, [white, blue, empty, empty, empty])
  const cells = Array<string | null>(3600).fill(null)
  cells[0] = white
  cells[1] = blue
  expect(await storedProjects(reopened)).toEqual([{ number: 1, name, width: 60, height: 60, cells }])

  await draw(reopened, 2)
  await reopened.reload()
  await expectColors(reopened, [white, blue, '#222222'])
})

for (const [exit, label] of [['reload', 'recarga imediata'], ['close', 'fechamento imediato']] as const) {
  test(`salva o gesto com ${label} da aba`, async ({ page }) => {
    await create(page)

    const popup = page.waitForEvent('popup')
    await page.evaluate(() => { window.open('/') })
    const editor = await popup
    await expectProject(editor)
    await editor.evaluate(exit => {
      // React handles pointerup at the root, before it reaches window.
      window.addEventListener('pointerup', () => {
        if (exit === 'reload') location.reload()
        else window.close()
      }, { once: true })
    }, exit)

    // Keep a write transaction ahead of the editor's save until the old document exits.
    await page.evaluate(() => new Promise<void>((resolve, reject) => {
      const open = indexedDB.open('linha-a-bordo')
      open.onerror = () => reject(open.error)
      open.onsuccess = () => {
        const db = open.result
        const transaction = db.transaction('projects', 'readwrite')
        const store = transaction.objectStore('projects')
        let released = false
        window.addEventListener('release-project-store', () => { released = true }, { once: true })
        transaction.oncomplete = () => db.close()
        transaction.onabort = () => { db.close(); reject(transaction.error) }
        function keepOpen() {
          if (!released) store.get(1).onsuccess = keepOpen
        }
        store.get(1).onsuccess = () => { keepOpen(); resolve() }
      }
    }))

    const exited = editor.waitForEvent(exit === 'reload' ? 'load' : 'close')
    await draw(editor, 2, 4)
    await exited
    await page.evaluate(() => window.dispatchEvent(new Event('release-project-store')))

    const reopened = exit === 'reload' ? editor : await page.context().newPage()
    if (exit === 'close') await reopened.goto('/')
    await expectProject(reopened)
    await expectColors(reopened, [empty, empty, '#222222', '#222222', '#222222'])
    const cells = Array<string | null>(3600).fill(null)
    cells.fill('#222222', 2, 5)
    expect(await storedProjects(reopened)).toEqual([{ number: 1, name, width: 60, height: 60, cells }])
    expect(await reopened.evaluate(() => localStorage.getItem('linha-a-bordo:pending:1'))).toBeNull()
  })
}

test('preserva o primeiro bordado quando duas abas tentam criar ao mesmo tempo', async ({ page, context }) => {
  const second = await context.newPage()
  await Promise.all([page.goto('/'), second.goto('/')])
  const names = [name, 'Flores azuis']
  const tabs = [page, second]
  await Promise.all(tabs.map((tab, index) => tab.getByLabel('Nome do bordado').fill(names[index])))
  await Promise.all(tabs.map(tab => tab.getByRole('button', { name: 'Criar bordado' }).click()))
  for (const tab of tabs) {
    await expect(tab.getByRole('navigation').locator('[aria-current="true"]')).toHaveText('1')
  }
  const projects = await storedProjects(second)
  expect(projects).toHaveLength(1)
  expect(names).toContain(projects[0].name)
  for (const tab of tabs) {
    await expect(tab.getByRole('banner').getByRole('heading')).toHaveText(projects[0].name)
  }
})
