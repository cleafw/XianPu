import { expect, test } from '@playwright/test'
import { blank, createProject, parseProject } from '../src/model'
import { pxPerMm } from '../src/paper'

test('export presets and custom margins control preview, PDF, and PNG geometry', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '打开弹唱示例' }).click()
  await page.getByRole('button', { name: '导出', exact: true }).click()
  const dialog = page.getByRole('dialog')
  const preset = dialog.getByRole('combobox', { name: '页边距', exact: true })
  const sheet = dialog.locator('.print-page').first()
  const save = dialog.getByRole('button', { name: '选择保存位置' })
  const geometry = () => sheet.evaluate((paper) => {
    const style = getComputedStyle(paper)
    const score = paper.querySelector(':scope > svg')!.getBoundingClientRect()
    const box = paper.getBoundingClientRect()
    return {
      padding: [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft].map(parseFloat),
      width: score.width, left: score.left - box.left, pageWidth: box.width, pageHeight: box.height,
    }
  })
  await expect(save).toBeEnabled()
  const standard = await geometry()
  expect(standard.padding[0]).toBeCloseTo(12 * pxPerMm, 3)
  await preset.selectOption('wide')
  await expect(save).toBeEnabled()
  expect((await geometry()).width).toBeLessThan(standard.width)
  await preset.selectOption('narrow')
  await expect(save).toBeEnabled()
  expect((await geometry()).width).toBeGreaterThan(standard.width)

  await preset.selectOption('custom')
  const top = dialog.getByRole('spinbutton', { name: '上边距（mm）' })
  await top.fill('')
  await expect(save).toBeDisabled()
  await expect(dialog.getByRole('alert')).toContainText('页边距须为')
  await top.fill('7')
  await dialog.getByRole('spinbutton', { name: '右边距（mm）' }).fill('17')
  await dialog.getByRole('spinbutton', { name: '下边距（mm）' }).fill('23')
  await dialog.getByRole('spinbutton', { name: '左边距（mm）' }).fill('4')
  await expect(save).toBeEnabled()
  const custom = await geometry()
  for (const [index, value] of [7, 17, 23, 4].entries()) expect(custom.padding[index]).toBeCloseTo(value * pxPerMm, 3)
  expect(custom.left).toBeCloseTo(4 * pxPerMm, 1)
  expect(custom.pageWidth).toBeCloseTo(210 * pxPerMm, 1)
  expect(custom.pageHeight).toBeCloseTo(297 * pxPerMm, 1)
  expect(await page.locator('.print-only > style').textContent()).toContain('margin: 7mm 17mm 23mm 4mm')
  const pdf = await page.pdf({ preferCSSPageSize: true })
  expect(pdf.toString('latin1').match(/\/Type \/Page\b/g)).toHaveLength(1)

  await dialog.getByLabel('导出格式').selectOption('png')
  const png = await sheet.evaluate(async (paper) => {
    const { renderPng } = await import('/src/exportImage.ts') as typeof import('../src/exportImage')
    const blob = await renderPng(paper as HTMLElement)
    const image = await createImageBitmap(blob)
    return { width: image.width, height: image.height }
  })
  expect(png).toEqual({ width: Math.round(custom.pageWidth * 2), height: Math.round(custom.pageHeight * 2) })
})

test('fills the available A4 page height by default and keeps explicit system limits', async ({ page }) => {
  const project = createProject('song')
  project.tracks = project.tracks.slice(0, 1)
  project.layout = { barsPerLine: 1, systemsPerPage: 3 }
  project.measures = Array.from({ length: 30 }, () => ({}))
  project.tracks[0].bars = project.measures.map(() =>
    [{ ...blank(1), draft: false, notes: [{ midi: 60 }] }])
  await page.goto('/')
  await page.locator('input[type=file]').setInputFiles({
    name: 'legacy-three-systems.xianpu', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(project)),
  })
  const limit = page.getByLabel('每页谱行')
  await expect(limit).toHaveValue('0')
  const exportButton = page.getByRole('button', { name: '导出', exact: true })
  await exportButton.click()
  const dialog = page.getByRole('dialog')
  const sheets = dialog.locator('.print-page')
  await expect(sheets.nth(1)).toBeVisible()
  const pages = await sheets.evaluateAll((pages) => pages.map((paper) => {
    const box = paper.getBoundingClientRect()
    const bottom = paper.querySelector(':scope > svg:last-of-type')!.getBoundingClientRect().bottom
    const systems = [...paper.querySelectorAll(':scope > svg')].filter((svg) =>
      svg.querySelector('text[style*="dominant-baseline: middle"]')).length
    return { filled: (bottom - box.top) / box.height, systems }
  }))
  expect(pages.length).toBeLessThan(10)
  expect(pages[0].systems).toBeGreaterThan(3)
  for (const sheet of pages.slice(0, -1)) expect(sheet.filled).toBeGreaterThan(0.83)
  expect(pages.reduce((total, sheet) => total + sheet.systems, 0)).toBe(30)
  const pdf = await page.pdf({ preferCSSPageSize: true })
  expect(pdf.toString('latin1').match(/\/Type \/Page\b/g)).toHaveLength(pages.length)

  const png = await sheets.first().evaluate(async (paper) => {
    const { renderPng } = await import('/src/exportImage.ts') as typeof import('../src/exportImage')
    const image = await createImageBitmap(await renderPng(paper as HTMLElement))
    const canvas = document.createElement('canvas')
    canvas.width = image.width
    canvas.height = image.height
    const context = canvas.getContext('2d')!
    context.drawImage(image, 0, 0)
    const start = Math.floor(image.height * 0.76)
    const data = context.getImageData(0, start, image.width, Math.floor(image.height * 0.13)).data
    const hasInk = data.some((value, index) => index % 4 === 0 && value < 100)
    return { hasInk, ratio: image.width / image.height }
  })
  expect(png.hasInk).toBe(true)
  expect(png.ratio).toBeCloseTo(210 / 297, 2)

  await dialog.getByRole('button', { name: '关闭' }).click()
  await limit.selectOption('3')
  const draft = await page.evaluate(() => localStorage.getItem('xianpu.recovery.v1')!)
  expect(parseProject(draft).layout.pageSystemLimit).toBe(3)
  await exportButton.click()
  await expect(sheets).toHaveCount(10)
})

test('assigns distinct NeuralNote sounds and plays the score with the bundled bank', async ({ page }) => {
  await page.addInitScript(() => {
    // Measure the actual output from the sampler after its audio handler runs.
    const original = AudioContext.prototype.createScriptProcessor
    AudioContext.prototype.createScriptProcessor = function (...args) {
      const output = original.apply(this, args)
      const handler = Object.getOwnPropertyDescriptor(ScriptProcessorNode.prototype, 'onaudioprocess')!
      Object.defineProperty(output, 'onaudioprocess', {
        set(callback: (event: AudioProcessingEvent) => void) {
          handler.set!.call(output, (event: AudioProcessingEvent) => {
            callback.call(output, event)
            const samples = event.outputBuffer.getChannelData(0)
            if (samples.some((value) => Math.abs(value) > 0.001)) document.documentElement.dataset.soundHeard = 'yes'
          })
        },
      })
      return output
    }
  })
  await page.goto('/')
  await page.getByRole('button', { name: '打开弹唱示例' }).click()
  await page.getByRole('button', { name: '试听音色', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '试听音色' })
  await expect(dialog.getByRole('combobox', { name: '简谱', exact: true })).toHaveValue('52')
  await expect(dialog.getByRole('combobox', { name: '吉他六线谱', exact: true })).toHaveValue('24')
  await expect(dialog.getByRole('combobox', { name: '五线谱', exact: true }).locator('option')).toHaveCount(66)
  await dialog.getByRole('combobox', { name: '吉他六线谱', exact: true }).selectOption('40')
  await expect(dialog.getByRole('combobox', { name: '简谱', exact: true })).toHaveValue('52')
  await dialog.getByRole('button', { name: '关闭', exact: true }).click()
  await page.getByRole('button', { name: '▶ 试听' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-sound-heard', 'yes', { timeout: 20000 })
  await page.getByRole('button', { name: '■ 停止' }).click()
  await page.locator('html').evaluate((el) => el.removeAttribute('data-sound-heard'))
  await page.getByRole('button', { name: '试听音色', exact: true }).click()
  await dialog.getByRole('button', { name: '应用到所有声部' }).click()
  await expect(dialog.getByRole('combobox', { name: '吉他六线谱', exact: true })).toHaveValue('52')
  await expect(dialog.getByRole('combobox', { name: '五线谱', exact: true })).toHaveValue('52')
  await dialog.getByRole('button', { name: '关闭', exact: true }).click()
  await page.getByRole('button', { name: '▶ 试听' }).click()
  await expect(page.getByRole('button', { name: '■ 停止' })).toHaveAttribute('aria-busy', 'false', { timeout: 20000 })
  await expect(page.locator('html')).toHaveAttribute('data-sound-heard', 'yes', { timeout: 5000 })
  await page.getByRole('button', { name: '■ 停止' }).click()
  await page.reload()
  await page.getByRole('button', { name: '恢复草稿' }).click()
  await page.getByRole('button', { name: '试听音色', exact: true }).click()
  const guitar = dialog.getByRole('combobox', { name: '吉他六线谱', exact: true })
  await expect(guitar).toHaveValue('52')
  await guitar.selectOption('128')
  await dialog.getByRole('button', { name: '关闭', exact: true }).click()
  await page.getByRole('navigation').getByRole('button', { name: '吉他六线谱', exact: true }).click()
  await page.getByRole('button', { name: '▶ 试听' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-sound-heard', 'yes', { timeout: 20000 })
})

test('uses A3 on the full score, inherits in parts, and previews a custom part width', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '打开弹唱示例' }).click()
  const sidebar = page.getByRole('navigation', { name: '总谱与分谱' })
  const paperSettings = sidebar.getByRole('button', { name: '纸张设置', exact: true })
  await paperSettings.click()
  await page.getByLabel('纸张尺寸').selectOption('a3')
  await page.getByRole('button', { name: '应用纸张设置' }).click()
  await sidebar.getByRole('button', { name: '吉他六线谱', exact: true }).click()
  await paperSettings.click()
  await expect(page.getByLabel('纸张尺寸')).toHaveValue('inherit')
  await expect(page.getByText('预览和 PDF 使用 297 × 420 mm。')).toBeVisible()
  await page.getByLabel('纸张尺寸').selectOption('custom')
  await page.getByLabel('纸张宽度（mm）').fill('79')
  await expect(page.getByRole('button', { name: '应用纸张设置' })).toBeDisabled()
  await page.getByLabel('纸张宽度（mm）').fill('330')
  await page.getByLabel('纸张高度（mm）').fill('220')
  await page.getByRole('button', { name: '应用纸张设置' }).click()
  await page.getByRole('button', { name: '导出', exact: true }).click()
  const preview = page.getByRole('dialog', { name: '导出', exact: true })
  await expect(preview.getByText('自定义纸张预览 · 吉他六线谱')).toBeVisible()
  await expect(preview.locator('.print-page').first()).toBeVisible()
  expect(await preview.locator('.print-sheet').evaluate((el) => el.getBoundingClientRect().width)).toBeCloseTo(330 * 96 / 25.4, 0)
  await preview.getByLabel('导出范围').selectOption('score')
  await expect(preview.getByText('A3 预览 · 总谱')).toBeVisible()
  await expect(preview.locator('.print-page').first()).toBeVisible()
  expect(await preview.locator('.print-sheet').evaluate((el) => el.getBoundingClientRect().width)).toBeCloseTo(297 * 96 / 25.4, 0)
})
