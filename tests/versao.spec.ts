import { readFileSync } from 'node:fs'
import { expect, test, type Locator, type Page } from '@playwright/test'

// The expected text comes from package.json, the single source of the version.
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
const expected = 'v' + version

type Box = { x: number, y: number, width: number, height: number }

const footer = (page: Page) => page.locator('.app-footer')

// Area actually painted on screen: the element's box clipped by the scrolling content area.
async function visibleBox(locator: Locator) {
  return locator.evaluate(element => {
    const box = element.getBoundingClientRect()
    const clip = element.closest('.app-body')?.getBoundingClientRect()
    const top = Math.max(box.top, clip?.top ?? -Infinity), bottom = Math.min(box.bottom, clip?.bottom ?? Infinity)
    const left = Math.max(box.left, clip?.left ?? -Infinity), right = Math.min(box.right, clip?.right ?? Infinity)
    return bottom > top && right > left ? { x: left, y: top, width: right - left, height: bottom - top } : null
  })
}

const overlaps = (a: Box, b: Box) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

function luminance(color: string) {
  const [r, g, b] = color.match(/[\d.]+/g)!.slice(0, 3).map(Number).map(channel => {
    const c = channel / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

async function expectFooter(page: Page, others: Locator[]) {
  const text = footer(page)
  await expect(text).toHaveText(expected, { useInnerText: true })
  await expect(text).toBeInViewport({ ratio: 1 })
  // No new page scroll: header, content area and footer fit the viewport.
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight)).toBe(true)
  const box = (await text.boundingBox())!
  const size = page.viewportSize()!
  expect(box.y + box.height).toBeLessThanOrEqual(size.height)
  expect(box.x + box.width).toBeLessThanOrEqual(size.width)

  for (const other of others) {
    await expect(other).toBeVisible()
    const shown = await visibleBox(other)
    if (shown) expect(overlaps(box, shown), await other.evaluate(element => element.className || element.tagName)).toBe(false)
  }
}

async function expectStyle(page: Page) {
  const style = await footer(page).evaluate(element => {
    const css = getComputedStyle(element)
    const range = document.createRange()
    range.selectNodeContents(element)
    const text = range.getBoundingClientRect(), box = element.getBoundingClientRect()
    // The footer has no fill: the color behind it is the first painted ancestor's.
    let behind = 'rgba(0, 0, 0, 0)'
    for (let node: Element | null = element.parentElement; node; node = node.parentElement) {
      const fill = getComputedStyle(node).backgroundColor
      if (fill !== 'rgba(0, 0, 0, 0)') { behind = fill; break }
    }
    const probe = document.createElement('span')
    probe.style.color = 'var(--disabled-text)'
    document.body.append(probe)
    const secondary = getComputedStyle(probe).color
    probe.remove()
    return {
      color: css.color, secondary, behind, background: css.backgroundColor, backgroundImage: css.backgroundImage,
      borders: [css.borderTopWidth, css.borderRightWidth, css.borderBottomWidth, css.borderLeftWidth],
      outline: css.outlineStyle, shadow: css.boxShadow, align: css.textAlign,
      fontSize: parseFloat(css.fontSize), bodyFontSize: parseFloat(getComputedStyle(document.body).fontSize),
      textRight: text.right, contentRight: box.right - parseFloat(css.paddingRight), textLeft: text.left, boxCenter: box.left + box.width / 2,
    }
  })
  expect(style.color).toBe(style.secondary)
  expect(style.background).toBe('rgba(0, 0, 0, 0)')
  expect(style.backgroundImage).toBe('none')
  expect(style.borders).toEqual(['0px', '0px', '0px', '0px'])
  expect(style.outline).toBe('none')
  expect(style.shadow).toBe('none')
  expect(style.align).toBe('right')
  expect(style.fontSize).toBeLessThan(style.bodyFontSize)
  expect(style.fontSize).toBeLessThanOrEqual(13)
  expect(Math.abs(style.textRight - style.contentRight)).toBeLessThanOrEqual(1)
  expect(style.textLeft).toBeGreaterThan(style.boxCenter)
  const [light, dark] = [luminance(style.color), luminance(style.behind)].sort((a, b) => b - a)
  expect((light + 0.05) / (dark + 0.05)).toBeGreaterThanOrEqual(4.5)
}

for (const colorScheme of ['light', 'dark'] as const) {
  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    test(`mostra a versão do package.json no rodapé em ${viewport.width}×${viewport.height}, sistema ${colorScheme}`, async ({ page }, info) => {
      await page.emulateMedia({ colorScheme })
      await page.setViewportSize(viewport)
      const capture = async (screen: string) => {
        if (info.repeatEachIndex === 0) await page.screenshot({ path: info.outputPath(`${screen}-${viewport.width}x${viewport.height}-${colorScheme}.png`) })
      }
      const header = page.getByRole('banner')

      await page.goto('/')
      await expect(page.getByLabel('Nome do bordado')).toBeVisible()
      await expectFooter(page, [header, page.locator('.start form')])
      await expectStyle(page)
      await capture('inicio')

      await page.getByLabel('Nome do bordado').fill('Versão')
      await page.getByRole('button', { name: 'Criar bordado', exact: true }).click()
      await expect(page.getByRole('button', { name: 'Bordado 1: Versão', exact: true })).toHaveAttribute('aria-current', 'true')
      const grid = page.getByRole('region', { name: 'Área da grade' })
      const tools = page.locator('.editor-tools')
      const layers = page.locator('.layer-panel')
      const dock = page.locator('.project-dock')
      await expectFooter(page, [header, grid, tools, layers])
      await expectStyle(page)
      await capture('editor')

      // At the end of the scrolling content, the project bar sits above the footer.
      await page.locator('.app-body').evaluate(area => area.scrollTo(0, area.scrollHeight))
      await expect(dock).toBeInViewport({ ratio: 1 })
      await expectFooter(page, [header, dock])
      expect(await visibleBox(dock)).toEqual(await dock.boundingBox())

      // The footer stays in place behind the modal import dialog.
      const chooser = page.waitForEvent('filechooser')
      await page.getByRole('button', { name: 'Importar imagem', exact: true }).click()
      await (await chooser).setFiles({ name: 'cd.jpeg', mimeType: 'image/jpeg', buffer: readFileSync(new URL('./fixtures/arte-cd.jpeg', import.meta.url)) })
      const dialog = page.getByRole('dialog', { name: 'Importar imagem' })
      await expect(dialog).toBeVisible()
      await expect(page.getByRole('button', { name: 'Confirmar importação', exact: true })).toBeEnabled({ timeout: 20000 })
      await expect(footer(page)).toHaveText(expected, { useInnerText: true })
      await expect(footer(page)).toBeInViewport({ ratio: 1 })
      const box = (await footer(page).boundingBox())!
      const hit = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.tagName, [box.x + box.width / 2, box.y + box.height / 2])
      expect(hit).toBe('DIALOG')
      await page.keyboard.press('Escape')
      await expect(dialog).toBeHidden()
      await expectFooter(page, [header, dock])
    })
  }
}
