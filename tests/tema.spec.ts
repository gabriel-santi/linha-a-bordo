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
    // The header shows the logo; its accessible name keeps the product name.
    const logo = header.getByRole('img', { name: 'Linha a bordo', exact: true })
    await expect(logo).toBeVisible()
    await expect(logo).toHaveAttribute('alt', 'Linha a bordo')
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
    const download = header.getByRole('button', { name: 'Baixar PNG' })
    // "Novo bordado" follows the last numbered project in the bottom bar.
    const newProject = page.locator('.project-dock').getByRole('button', { name: 'Novo bordado' })
    const projectButtons = page.getByRole('navigation').getByRole('button')

    await projectButtons.last().focus()
    await page.keyboard.press('Tab')
    await expect(newProject).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(dialog).toHaveAccessibleName('Novo bordado')
    await expect(input).toBeFocused()
    await expect(create).toBeDisabled()
    await capture('criar')
    await page.keyboard.press('Escape')
    await expect(newProject).toBeFocused()

    // The pencil beside the title comes right before the header's download action.
    await download.focus()
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
    await expect(logo).toBeVisible()
    await expect(page.getByRole('navigation').getByRole('button')).toHaveAttribute('aria-current', 'true')
    await capture('editor')
  })
}
