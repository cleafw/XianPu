import { expect, test } from '@playwright/test'

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
  await expect(dialog.getByRole('combobox', { name: '人声', exact: true })).toHaveValue('52')
  await expect(dialog.getByRole('combobox', { name: '吉他', exact: true })).toHaveValue('24')
  await expect(dialog.getByRole('combobox', { name: '五线谱乐器', exact: true }).locator('option')).toHaveCount(66)
  await dialog.getByRole('combobox', { name: '吉他', exact: true }).selectOption('40')
  await expect(dialog.getByRole('combobox', { name: '人声', exact: true })).toHaveValue('52')
  await dialog.getByRole('button', { name: '关闭', exact: true }).click()
  await page.getByRole('button', { name: '▶ 试听' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-sound-heard', 'yes', { timeout: 20000 })
  await page.getByRole('button', { name: '■ 停止' }).click()
  await page.locator('html').evaluate((el) => el.removeAttribute('data-sound-heard'))
  await page.getByRole('button', { name: '试听音色', exact: true }).click()
  await dialog.getByRole('button', { name: '应用到所有声部' }).click()
  await expect(dialog.getByRole('combobox', { name: '吉他', exact: true })).toHaveValue('52')
  await expect(dialog.getByRole('combobox', { name: '五线谱乐器', exact: true })).toHaveValue('52')
  await dialog.getByRole('button', { name: '关闭', exact: true }).click()
  await page.getByRole('button', { name: '▶ 试听' }).click()
  await expect(page.getByRole('button', { name: '■ 停止' })).toHaveAttribute('aria-busy', 'false', { timeout: 20000 })
  await expect(page.locator('html')).toHaveAttribute('data-sound-heard', 'yes', { timeout: 5000 })
  await page.getByRole('button', { name: '■ 停止' }).click()
  await page.reload()
  await page.getByRole('button', { name: '恢复草稿' }).click()
  await page.getByRole('button', { name: '试听音色', exact: true }).click()
  const guitar = dialog.getByRole('combobox', { name: '吉他', exact: true })
  await expect(guitar).toHaveValue('52')
  await guitar.selectOption('128')
  await dialog.getByRole('button', { name: '关闭', exact: true }).click()
  await page.getByRole('navigation').getByRole('button', { name: '吉他', exact: true }).click()
  await page.getByRole('button', { name: '▶ 试听' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-sound-heard', 'yes', { timeout: 20000 })
})

test('uses A3 on the full score, inherits in parts, and previews a custom part width', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '打开弹唱示例' }).click()
  const sidebar = page.getByRole('navigation', { name: '总谱与乐器' })
  const paperSettings = sidebar.getByRole('button', { name: '纸张设置', exact: true })
  await paperSettings.click()
  await page.getByLabel('纸张尺寸').selectOption('a3')
  await page.getByRole('button', { name: '应用纸张设置' }).click()
  await sidebar.getByRole('button', { name: '吉他', exact: true }).click()
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
  await expect(preview.getByText('自定义纸张预览 · 吉他')).toBeVisible()
  await expect(preview.locator('.print-page').first()).toBeVisible()
  expect(await preview.locator('.print-sheet').evaluate((el) => el.getBoundingClientRect().width)).toBeCloseTo(330 * 96 / 25.4, 0)
  await preview.getByLabel('导出范围').selectOption('score')
  await expect(preview.getByText('A3 预览 · 总谱')).toBeVisible()
  await expect(preview.locator('.print-page').first()).toBeVisible()
  expect(await preview.locator('.print-sheet').evaluate((el) => el.getBoundingClientRect().width)).toBeCloseTo(297 * 96 / 25.4, 0)
})
