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
