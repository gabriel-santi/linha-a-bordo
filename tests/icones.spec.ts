import { expect, test, type Page } from '@playwright/test'

const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true })

async function createProject(page: Page) {
  await page.goto('/')
  await page.getByLabel('Nome do bordado').fill('Ícones')
  await page.getByRole('button', { name: 'Criar bordado' }).click()
  await expect(page.getByRole('banner').getByRole('heading')).toHaveText('Ícones')
}

test('declara favicon e ícone do app em PNG quadrado e transparente', async ({ page }) => {
  await page.goto('/')
  const links = [
    { selector: 'link[rel="icon"][sizes="32x32"]', href: '/favicon-32x32.png', size: 32 },
    { selector: 'link[rel="icon"][sizes="346x346"]', href: '/favicon.png', size: 346 },
    { selector: 'link[rel="apple-touch-icon"]', href: '/apple-touch-icon.png', size: 180 },
  ]
  for (const { selector, href, size } of links) {
    const link = page.locator(selector)
    await expect(link).toHaveAttribute('href', href)
    await expect(link).toHaveAttribute('type', 'image/png')
    await expect(link).toHaveAttribute('sizes', `${size}x${size}`)

    const response = await page.request.get(href)
    expect(response.status()).toBe(200)
    expect(response.headers()['content-type']).toBe('image/png')
    const image = await page.evaluate(async src => {
      const img = new Image()
      img.src = src
      await img.decode()
      const canvas = new OffscreenCanvas(img.width, img.height)
      const ctx = canvas.getContext('2d')!
      ctx.drawImage(img, 0, 0)
      const alpha = ctx.getImageData(0, 0, img.width, img.height).data.filter((_, index) => index % 4 === 3)
      return { width: img.width, height: img.height, corner: alpha[0], opaque: alpha.some(value => value > 0) }
    }, href)
    expect(image).toEqual({ width: size, height: size, corner: 0, opaque: true })
  }
})

test('botões só com ícone mantêm o nome e mostram a dica no hover e no foco', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  await createProject(page)
  await button(page, 'Nova camada').click()
  await button(page, 'Aumentar zoom').click()
  await button(page, 'Descer camada').click()

  for (const name of ['Diminuir zoom', 'Aumentar zoom', 'Subir camada', 'Excluir camada']) {
    const control = button(page, name)
    const tip = control.locator('.tip')
    await expect(control).toHaveAccessibleName(name)
    await expect(control.locator('svg')).toHaveAttribute('aria-hidden', 'true')
    await expect(tip).toHaveText(name)
    await expect(tip).toHaveAttribute('aria-hidden', 'true')
    await expect(tip).toBeHidden()
    const box = (await control.boundingBox())!
    expect(box.width).toBeGreaterThanOrEqual(24)
    expect(box.height).toBeGreaterThanOrEqual(24)

    await control.hover()
    await expect(tip).toBeVisible()
    await expect(tip).toHaveCSS('opacity', '1')
    await expect(tip).toHaveCSS('pointer-events', 'none')
    await page.mouse.move(640, 700)
    await expect(tip).toBeHidden()

    // Keyboard focus shows the tip; Escape dismisses it without moving focus.
    await control.focus()
    await page.keyboard.press('Shift+Tab')
    await page.keyboard.press('Tab')
    await expect(control).toBeFocused()
    await expect(tip).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(tip).toBeHidden()
    await expect(control).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(control).not.toBeFocused()
    await expect(tip).toBeHidden()
    await page.evaluate(() => (document.activeElement as HTMLElement).blur())
  }

  // The tip does not block the pointer: the delete button stays clickable under its own tip.
  await button(page, 'Excluir camada').hover()
  await button(page, 'Excluir camada').click()
  await expect(button(page, 'Excluir camada')).toBeDisabled()
})

test('botões com texto ganham ícone decorativo sem mudar o nome', async ({ page }) => {
  await createProject(page)
  for (const name of ['Borracha', 'Ajustar à tela', 'Redimensionar', 'Nova camada', 'Importar imagem', 'Baixar PNG', 'Renomear', 'Novo bordado']) {
    const control = button(page, name)
    await expect(control).toHaveAccessibleName(name)
    await expect(control).toHaveText(name)
    await expect(control.locator('svg')).toHaveCount(1)
    await expect(control.locator('svg')).toHaveAttribute('aria-hidden', 'true')
  }
  await expect(page.locator('.swatch svg, .project-bar svg, .layer-list svg')).toHaveCount(0)
})

test('Novo bordado fica só com ícone logo depois do último bordado, com 1 e 8 bordados', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  await createProject(page)
  const header = page.getByRole('banner')
  const nav = page.getByRole('navigation', { name: 'Bordados locais' })
  const projects = nav.getByRole('button')
  const add = page.locator('.project-dock').getByRole('button', { name: 'Novo bordado', exact: true })
  const tip = add.locator('.tip')
  await expect(header.getByRole('button', { name: 'Novo bordado' })).toHaveCount(0)
  await expect(nav.getByRole('button', { name: 'Novo bordado' })).toHaveCount(0)
  await expect(add).toHaveAccessibleName('Novo bordado')
  await expect(add.locator('svg')).toHaveAttribute('aria-hidden', 'true')
  await expect(tip).toHaveText('Novo bordado')
  await expect(tip).toBeHidden()

  // Same size as the numbered items, on their line, one gap after the last one.
  const placement = async () => {
    const last = (await projects.last().boundingBox())!
    const box = (await add.boundingBox())!
    expect(box.width).toBe(last.width)
    expect(box.height).toBe(last.height)
    expect(box.y).toBe(last.y)
    expect(box.x - (last.x + last.width)).toBe(8)
    await expect(add).toBeInViewport({ ratio: 1 })
  }
  await placement()

  await add.hover()
  await expect(tip).toBeVisible()
  await expect(tip).toHaveCSS('pointer-events', 'none')
  await expect(tip).toBeInViewport({ ratio: 1 })
  await add.click()
  await expect(page.getByRole('dialog')).toHaveAccessibleName('Novo bordado')
  await page.getByRole('dialog').getByLabel('Nome do bordado').fill('Segundo')
  await page.keyboard.press('Enter')
  await expect(projects).toHaveText(['1', '2'])
  await expect(nav.locator('[aria-current="true"]')).toHaveText('2')

  for (let number = 3; number <= 8; number++) {
    await projects.last().focus()
    await page.keyboard.press('Tab')
    await expect(add).toBeFocused()
    await expect(tip).toBeVisible()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('dialog')).toHaveAccessibleName('Novo bordado')
    await page.keyboard.type('Bordado ' + number)
    await page.keyboard.press('Enter')
    await expect(page.getByRole('dialog')).toHaveCount(0)
  }
  await expect(projects).toHaveText(['1', '2', '3', '4', '5', '6', '7', '8'])
  await expect(nav.locator('[aria-current="true"]')).toHaveText('8')
  await placement()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('lápis ao lado do nome abre o renomear e continua visível com nome longo', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  await createProject(page)
  const header = page.getByRole('banner')
  const title = header.getByRole('heading')
  const rename = header.getByRole('button', { name: 'Renomear', exact: true })
  const tip = rename.locator('.tip')
  await expect(header.getByRole('button')).toHaveCount(2)
  await expect(rename).toHaveAccessibleName('Renomear')
  await expect(tip).toHaveText('Renomear')
  await expect(rename.locator('svg')).toHaveAttribute('aria-hidden', 'true')

  await rename.hover()
  await expect(tip).toBeVisible()
  await expect(tip).toBeInViewport({ ratio: 1 })
  await rename.click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toHaveAccessibleName('Renomear bordado')
  await expect(dialog.getByLabel('Nome do bordado')).toHaveValue('Ícones')
  await dialog.getByLabel('Nome do bordado').fill('Ipê')
  await page.keyboard.press('Enter')
  await expect(title).toHaveText('Ipê')
  await expect(rename).toBeFocused()

  const long = 'Jardim de ipês amarelos com beija-flores, borboletas e lírios sobre o rio ao entardecer de uma longa primavera'
  await button(page, 'Baixar PNG').focus()
  await page.keyboard.press('Shift+Tab')
  await expect(rename).toBeFocused()
  await expect(tip).toBeVisible()
  await page.keyboard.press('Space')
  await expect(dialog).toHaveAccessibleName('Renomear bordado')
  await dialog.getByLabel('Nome do bordado').fill(long)
  await page.keyboard.press('Enter')
  await expect(title).toHaveText(long)
  await expect(title).toHaveCSS('text-overflow', 'ellipsis')
  expect(await title.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true)
  await expect(rename).toBeInViewport({ ratio: 1 })
  const [logo, name, pencil, download] = await Promise.all([
    header.getByRole('img').boundingBox(), title.boundingBox(), rename.boundingBox(), button(page, 'Baixar PNG').boundingBox(),
  ])
  expect(name!.x).toBeGreaterThanOrEqual(logo!.x + logo!.width)
  expect(pencil!.x).toBeGreaterThanOrEqual(name!.x + name!.width)
  expect(pencil!.x + pencil!.width).toBeLessThanOrEqual(download!.x)

  const file = page.waitForEvent('download')
  await button(page, 'Baixar PNG').click()
  expect((await file).suggestedFilename()).toBe(Array.from(long).slice(0, 54).join('').trim() + '.png')
})

for (const viewport of [{ width: 1280, height: 720 }, { width: 1920, height: 1080 }]) {
  test('logo com respiro no topo e minúsculas próximas do centro do título em ' + viewport.width, async ({ page }) => {
    await page.setViewportSize(viewport)
    await createProject(page)
    const measure = await page.evaluate(async () => {
      const img = document.querySelector<HTMLImageElement>('header img')!
      await img.decode()
      const { naturalWidth: width, naturalHeight: height } = img
      const context = new OffscreenCanvas(width, height).getContext('2d')!
      context.drawImage(img, 0, 0)
      const { data } = context.getImageData(0, 0, width, height)
      const opaque = (x: number, y: number) => data[(y * width + x) * 4 + 3] > 128
      // Lowercase letters start after the first empty column right of the needle-L.
      let split = 60
      while (split < width && Array.from({ length: height }, (_, y) => opaque(split, y)).some(Boolean)) split++
      const rows = Array.from({ length: height }, (_, y) => Array.from({ length: width - split }, (_, x) => opaque(split + x, y)).filter(Boolean).length)
      const max = Math.max(...rows)
      // The x-height band: rows where the lowercase bodies are, without ascenders and the i dot.
      const band = rows.flatMap((count, y) => count >= max * 0.3 ? [y] : [])
      const box = img.getBoundingClientRect()
      const scale = box.height / height
      const header = document.querySelector('header')!.getBoundingClientRect()
      const title = document.querySelector('header h1')!.getBoundingClientRect()
      return {
        natural: [width, height], rendered: box.height,
        top: box.top - header.top, bottom: header.bottom - 1 - box.bottom,
        band: box.top + (band[0] + band.at(-1)! + 1) / 2 * scale, title: title.top + title.height / 2,
      }
    })
    expect(measure.natural).toEqual([549, 106])
    expect(measure.rendered).toBe(37)
    expect(measure.top).toBeGreaterThanOrEqual(0)
    expect(measure.bottom).toBeGreaterThanOrEqual(0)
    expect(Math.abs(measure.top - 10)).toBeLessThanOrEqual(1)
    expect(Math.abs(measure.band - measure.title)).toBeLessThanOrEqual(6)
  })
}
