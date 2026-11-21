import { chromium, expect, test, type Page } from '@playwright/test'

const white = '#ffffff'
const blue = '#3066bd'
const black = '#222222'
const empty = '#fffcf6'
const names = ['Ipês', 'Azulejos', 'Estrelas']

function cells(...inks: (string | null)[]) {
  return [...inks, ...Array(3600 - inks.length).fill(null)]
}

function buttons(page: Page) {
  return page.getByRole('navigation', { name: 'Bordados locais' }).getByRole('button')
}

async function expectOpen(page: Page, number: number, name: string, colors: string[] = [empty]) {
  await expect(page.getByRole('banner').getByRole('heading')).toHaveText(name)
  await expect(page.getByRole('button', { name: 'Bordado ' + number + ': ' + name, exact: true })).toHaveAttribute('aria-current', 'true')
  await expect(page.getByRole('banner').getByText(/Bordado nº/)).toHaveCount(0)
  const actual = await page.locator('canvas').evaluate((canvas: HTMLCanvasElement, length) =>
    Array.from({ length }, (_, col) => {
      const pixels = canvas.getContext('2d')!.getImageData(col * 16 + 8, 8, 1, 1).data
      return '#' + Array.from(pixels.slice(0, 3), value => value.toString(16).padStart(2, '0')).join('')
    }), colors.length)
  expect(actual).toEqual(colors)
}

async function create(page: Page, name: string, number: number) {
  if (number > 1) await page.getByRole('button', { name: 'Novo bordado' }).click()
  await page.getByLabel('Nome do bordado').fill(name)
  await page.getByRole('button', { name: 'Criar bordado' }).click()
  await expectOpen(page, number, name)
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

async function draw(page: Page, from: number, to = from) {
  const box = (await page.locator('canvas').boundingBox())!
  const move = (col: number) => page.mouse.move(box.x + (col * 16 + 8) * box.width / 962, box.y + 8 * box.height / 962)
  await move(from)
  await page.mouse.down()
  if (to !== from) await move(to)
  await page.mouse.up()
}

function solidButton(page: Page, name: string) {
  return page.getByRole('button', { name, exact: true })
}

for (const viewport of [{ width: 1280, height: 720 }, { width: 1920, height: 1080 }]) {
  test(`cria três bordados e alterna por mouse e teclado em ${viewport.width} × ${viewport.height}`, async ({ page }, info) => {
    await page.setViewportSize(viewport)
    await page.goto('/')
    const input = page.getByLabel('Nome do bordado')
    const submit = solidButton(page, 'Criar bordado')
    await expect(submit).toBeDisabled()
    await input.fill('   ')
    await input.press('Enter')
    await expect(submit).toBeDisabled()
    expect(await readLibrary(page)).toEqual({ projects: [], selected: undefined })

    await create(page, names[0], 1)
    await draw(page, 0)
    await solidButton(page, 'Novo bordado').click()
    if (info.repeatEachIndex === 0 && viewport.width === 1280) await page.screenshot({ path: info.outputPath('novo-bordado.png') })
    await input.fill('   ')
    await input.press('Enter')
    await expect(submit).toBeDisabled()
    await solidButton(page, 'Cancelar').click()
    expect(await readLibrary(page)).toEqual({
      projects: [{ number: 1, name: names[0], width: 60, height: 60, cells: cells(black) }],
      selected: 1,
    })
    await create(page, names[1], 2)
    await create(page, names[2], 3)
    await expect(buttons(page)).toHaveText(['1', '2', '3'])
    await expect(page.locator('canvas')).toBeInViewport({ ratio: 1 })
    for (const control of ['Novo bordado', 'Renomear', 'Borracha', 'Aumentar zoom']) {
      await expect(solidButton(page, control)).toBeInViewport({ ratio: 1 })
    }
    const canvas = (await page.locator('canvas').boundingBox())!
    const bar = (await page.getByRole('navigation').boundingBox())!
    expect(bar.y).toBeGreaterThanOrEqual(canvas.y + canvas.height)

    await buttons(page).nth(0).click()
    await expectOpen(page, 1, names[0], [black, empty])
    await page.keyboard.press('Tab')
    await expect(buttons(page).nth(1)).toBeFocused()
    await page.keyboard.press('Space')
    await expectOpen(page, 2, names[1])
    await page.keyboard.press('Tab')
    await expect(buttons(page).nth(2)).toBeFocused()
    await page.keyboard.press('Enter')
    await expectOpen(page, 3, names[2])

    await buttons(page).nth(0).click()
    await page.reload()
    await expectOpen(page, 1, names[0], [black, empty])
    expect(await readLibrary(page)).toEqual({
      projects: names.map((name, i) => ({ number: i + 1, name, width: 60, height: 60, cells: i === 0 ? cells(black) : cells() })),
      selected: 1,
    })
    if (info.repeatEachIndex === 0) await page.screenshot({ path: info.outputPath(`biblioteca-${viewport.width}.png`) })
  })
}

test('renomeia o bordado após pintar e preserva o desenho, o número e o histórico', async ({ page }, info) => {
  await page.goto('/')
  await create(page, names[0], 1)
  await draw(page, 0)
  await create(page, names[1], 2)
  await solidButton(page, 'Branco').click()
  await draw(page, 0)
  const rename = solidButton(page, 'Renomear')
  await rename.click()
  const input = page.getByLabel('Nome do bordado')
  await expect(input).toHaveValue(names[1])
  if (info.repeatEachIndex === 0) await page.screenshot({ path: info.outputPath('renomear.png') })
  const save = solidButton(page, 'Salvar nome')
  for (const invalid of ['', '   ']) {
    await input.fill(invalid)
    await input.press('Enter')
    await expect(save).toBeDisabled()
  }
  await input.fill('Descartar')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expectOpen(page, 2, names[1], [white, empty])

  await rename.click()
  await input.fill('  Maré  ')
  await save.click()
  await expectOpen(page, 2, 'Maré', [white, empty])
  await page.keyboard.press('Control+z')
  await expectOpen(page, 2, 'Maré')
  await page.keyboard.press('Control+y')
  await buttons(page).nth(0).click()
  await expectOpen(page, 1, names[0], [black, empty])
  await buttons(page).nth(1).click()
  await page.reload()
  await expectOpen(page, 2, 'Maré', [white, empty])
  expect(await readLibrary(page)).toEqual({
    projects: [{ number: 1, name: names[0], width: 60, height: 60, cells: cells(black) }, { number: 2, name: 'Maré', width: 60, height: 60, cells: cells(white) }],
    selected: 2,
  })
})

test('troca sob transação pendente e recupera as últimas edições nos bordados corretos', async ({ page, context }) => {
  await page.goto('/')
  await create(page, names[0], 1)
  await create(page, names[1], 2)
  const blocker = await context.newPage()
  await blocker.goto('/')
  await expectOpen(blocker, 2, names[1])

  await blocker.evaluate(() => new Promise<void>((resolve, reject) => {
    const open = indexedDB.open('linha-a-bordo')
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const db = open.result
      // Lock both stores until the app reloads, so neither the drawings nor selection can commit.
      const tx = db.transaction(['projects', 'settings'], 'readwrite')
      const store = tx.objectStore('projects')
      let released = false
      window.addEventListener('release-library', () => { released = true }, { once: true })
      tx.oncomplete = () => db.close()
      tx.onabort = () => { db.close(); reject(tx.error) }
      function keepOpen() {
        if (!released) store.get(1).onsuccess = keepOpen
      }
      store.get(1).onsuccess = () => { keepOpen(); resolve() }
    }
  }))

  await solidButton(page, 'Branco').click()
  await draw(page, 0)
  await solidButton(page, 'Azul').click()
  await draw(page, 1, 3)
  await solidButton(page, 'Borracha').click()
  await draw(page, 2, 3)
  await page.keyboard.press('Control+z')
  await page.keyboard.press('Control+y')
  await buttons(page).nth(0).click()
  await page.keyboard.press('Control+z')
  await expectOpen(page, 1, names[0])
  await draw(page, 0, 2)
  await buttons(page).nth(1).click()
  await expectOpen(page, 2, names[1], [white, blue, empty, empty])
  await page.keyboard.press('Control+y')
  await buttons(page).nth(0).click()
  const pending = await page.evaluate(() => Object.fromEntries(
    ['pending:1', 'pending:2', 'pending-selection'].map(key => [key, JSON.parse(localStorage.getItem(`linha-a-bordo:${key}`) ?? 'null')]),
  ))
  expect(pending['pending:1'].cells).toEqual(cells(black, black, black))
  expect(pending['pending:2'].cells).toEqual(cells(white, blue))
  expect(pending['pending-selection'].number).toBe(1)

  await page.reload()
  await blocker.evaluate(() => window.dispatchEvent(new Event('release-library')))
  await expectOpen(page, 1, names[0], [black, black, black, empty])
  expect(await readLibrary(page)).toEqual({
    projects: [{ number: 1, name: names[0], width: 60, height: 60, cells: cells(black, black, black) }, { number: 2, name: names[1], width: 60, height: 60, cells: cells(white, blue) }],
    selected: 1,
  })
  expect(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('linha-a-bordo:pending')))).toEqual([])
})

test('reabre um número anterior ao fechar e relançar o navegador com o mesmo perfil', async ({ baseURL }, info) => {
  const launch = () => chromium.launchPersistentContext(info.outputPath('perfil'), {
    baseURL,
    channel: process.env.PLAYWRIGHT_CHANNEL || undefined,
  })
  let browser = await launch()
  try {
    const page = browser.pages()[0]
    await page.goto('/')
    await create(page, names[0], 1)
    await create(page, names[1], 2)
    await draw(page, 1)
    await buttons(page).nth(0).click()
    await solidButton(page, 'Branco').click()
    await draw(page, 0)
    await browser.close()

    browser = await launch()
    const reopened = browser.pages()[0]
    await reopened.goto('/')
    await expectOpen(reopened, 1, names[0], [white, empty])
    expect(await readLibrary(reopened)).toEqual({
      projects: [{ number: 1, name: names[0], width: 60, height: 60, cells: cells(white) }, { number: 2, name: names[1], width: 60, height: 60, cells: cells(null, black) }],
      selected: 1,
    })
  } finally {
    await browser.close()
  }
})

test('migra o banco v1 e recupera o journal do PR #5 sem reiniciar a numeração', async ({ page }) => {
  const stored = cells(white, blue, black)
  const pending = cells(white, null, black, blue)
  await page.route('**/__fixture-pr5', route => route.fulfill({ body: 'PR #5', contentType: 'text/plain' }))
  await page.goto('/__fixture-pr5')
  await page.evaluate(({ stored, pending }) => new Promise<void>((resolve, reject) => {
    const open = indexedDB.open('linha-a-bordo', 1)
    open.onupgradeneeded = () => {
      open.result.createObjectStore('projects', { keyPath: 'number', autoIncrement: true })
        .add({ number: 7, name: 'Acervo', cells: stored })
    }
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      open.result.close()
      localStorage.setItem('linha-a-bordo:pending:7', JSON.stringify({ revision: [15, 42], cells: pending }))
      resolve()
    }
  }), { stored, pending })
  await page.goto('/')
  await expectOpen(page, 7, 'Acervo', [white, empty, black, blue])
  await expect(buttons(page)).toHaveText(['7'])
  expect(await readLibrary(page)).toEqual({ projects: [{ number: 7, name: 'Acervo', width: 60, height: 60, cells: pending }], selected: 7 })
  expect(await page.evaluate(() => localStorage.getItem('linha-a-bordo:pending:7'))).toBeNull()

  await solidButton(page, 'Novo bordado').click()
  await page.getByLabel('Nome do bordado').fill('Outro')
  await solidButton(page, 'Criar bordado').click()
  await expect(buttons(page)).toHaveText(['7', '8'])
  await buttons(page).first().click()
  await page.reload()
  await expectOpen(page, 7, 'Acervo', [white, empty, black, blue])
  expect(await readLibrary(page)).toEqual({
    projects: [{ number: 7, name: 'Acervo', width: 60, height: 60, cells: pending }, { number: 8, name: 'Outro', width: 60, height: 60, cells: cells() }],
    selected: 7,
  })
})
