import { test, expect } from '@playwright/test'

for (const viewport of [{ width: 1280, height: 720 }, { width: 1920, height: 1080 }]) {
  test(`cria bordado com grade completa em ${viewport.width} × ${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport)
    await page.goto('/')
    await page.getByLabel('Nome do bordado').fill('Jardim de ipês')
    await page.getByRole('button', { name: 'Criar bordado' }).click()
    await expect(page.getByRole('banner').getByRole('heading')).toHaveText('Jardim de ipês')
    const canvas = page.locator('canvas')
    await expect(canvas).toBeInViewport({ ratio: 1 })

    // Lê cortes do bitmap fora das interseções para contar linhas e células nos dois eixos.
    const scans = await canvas.evaluate(element => {
      const { width, height } = element
      const ctx = element.getContext('2d')!
      const { data } = ctx.getImageData(0, 0, width, height)
      function scan(length: number, stride: number, start: number) {
        const runs: { shade: number, length: number }[] = []
        for (let i = 0; i < length; i++) {
          const shade = data[4 * (start + i * stride)]
          const last = runs.at(-1)
          if (last?.shade === shade) last.length++
          else runs.push({ shade, length: 1 })
        }
        return runs
      }
      return [scan(width, 1, 5 * width), scan(height, width, 5)]
    })
    for (const runs of scans) {
      expect(runs).toHaveLength(121) // 61 limites alternam com 60 interiores
      const [major, interior, fine] = runs
      expect(major.shade).toBeLessThan(fine.shade)
      expect(fine.shade).toBeLessThan(interior.shade)
      expect(major.length).toBeGreaterThan(fine.length)
      const pitch = major.length + interior.length
      for (let line = 0; line <= 60; line++) {
        const boundary = runs[2 * line]
        expect(boundary).toEqual(line % 10 === 0 ? major : fine)
        if (line < 60) {
          const cell = runs[2 * line + 1]
          expect(cell.shade).toBe(interior.shade)
          expect(boundary.length + cell.length).toBe(pitch)
        }
      }
    }
    expect(scans[0]).toEqual(scans[1])
  })
}
