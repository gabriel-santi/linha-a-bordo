import { expect, test } from '@playwright/test'

test.use({ colorScheme: 'light' })

for (const viewport of [{ width: 1280, height: 720 }, { width: 1920, height: 1080 }]) {
  test('mantém a interface escura com sistema claro e navegação por teclado em ' + viewport.width, async ({ page }, info) => {
    await page.setViewportSize(viewport)
    await page.goto('/')
    const root = page.locator('html')
    const header = page.getByRole('banner')
    const input = page.getByLabel('Nome do bordado')
    const create = page.getByRole('button', { name: 'Criar bordado' })
    const dialog = page.getByRole('dialog')
    const capture = async (screen: string) => {
      if (info.repeatEachIndex === 0) await page.screenshot({ path: info.outputPath(screen + '.png') })
    }

    await expect(page).toHaveTitle('Linha a bordo')
    await expect(header).toHaveText('Linha a bordo')
    await expect(root).toHaveCSS('color-scheme', 'dark')
    await expect(create).toBeDisabled()
    await page.keyboard.press('Tab')
    await expect(input).toBeFocused()
    await expect(input).toHaveCSS('outline-style', 'solid')
    await capture('inicio')

    await input.fill('Linha lilás')
    await page.keyboard.press('Enter')
    await expect(header.getByRole('heading')).toHaveText('Linha lilás')
    const rename = header.getByRole('button', { name: 'Renomear' })
    const newProject = header.getByRole('button', { name: 'Novo bordado' })

    await rename.focus()
    await page.keyboard.press('Tab')
    await expect(newProject).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(dialog).toHaveAccessibleName('Novo bordado')
    await expect(input).toBeFocused()
    await expect(create).toBeDisabled()
    await capture('criar')
    await page.keyboard.press('Escape')
    await expect(newProject).toBeFocused()

    await page.keyboard.press('Shift+Tab')
    await expect(rename).toBeFocused()
    await page.keyboard.press('Space')
    await expect(dialog).toHaveAccessibleName('Renomear bordado')
    await expect(input).toHaveValue('Linha lilás')
    await expect(input).toBeFocused()
    await capture('renomear')
    await page.keyboard.press('Escape')
    await expect(rename).toBeFocused()

    await page.reload()
    await expect(root).toHaveCSS('color-scheme', 'dark')
    await expect(header.getByRole('heading')).toHaveText('Linha lilás')
    await expect(page.getByRole('navigation').getByRole('button')).toHaveAttribute('aria-current', 'true')
    await capture('editor')
  })
}
