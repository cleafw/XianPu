import { expect, test, type Locator } from '@playwright/test'

async function expectAligned(...controls: Locator[]) {
  for (const control of controls) await expect(control).toBeVisible()
  const [first, ...rest] = await Promise.all(controls.map((control) => control.boundingBox()))
  for (const box of rest) {
    expect(Math.abs(box!.y - first!.y)).toBeLessThanOrEqual(1)
    expect(Math.abs(box!.height - first!.height)).toBeLessThanOrEqual(1)
  }
}

test('aligns fields with their actions in dialogs, docked panels and floating panels', async ({ page }) => {
  await page.setViewportSize({ width: 840, height: 680 })
  await page.goto('/')
  await page.getByRole('button', { name: '打开弹唱示例' }).click()
  await page.getByRole('button', { name: '试听音色', exact: true }).click()
  const sounds = page.getByRole('dialog', { name: '试听音色' })
  await expectAligned(sounds.getByLabel('统一音色'), sounds.getByRole('button', { name: '应用到所有声部' }))
  await sounds.getByRole('button', { name: '关闭' }).click()

  const inspector = page.getByRole('region', { name: '录入面板' })
  await inspector.getByRole('button', { name: '倚音与成组连音', exact: true }).click()
  await expectAligned(inspector.getByLabel('倚音音高'), inspector.getByLabel('倚音八度'))
  await inspector.getByRole('button', { name: '弹出倚音与成组连音' }).click()
  const ornaments = page.getByRole('region', { name: '倚音与成组连音', exact: true })
  await expectAligned(ornaments.getByLabel('倚音音高'), ornaments.getByLabel('倚音八度'))
  await ornaments.getByRole('button', { name: '将倚音与成组连音贴回右栏' }).click()

  await page.getByRole('navigation').getByRole('button', { name: '吉他六线谱', exact: true }).click()
  await expectAligned(inspector.getByRole('textbox', { name: '品位' }), inspector.getByRole('button', { name: '加入', exact: true }))

  await page.getByRole('button', { name: '导出', exact: true }).click()
  const exportDialog = page.getByRole('dialog', { name: '导出' })
  await expectAligned(exportDialog.getByLabel('导出格式'), exportDialog.getByLabel('导出范围'),
    exportDialog.getByRole('button', { name: '选择保存位置' }))
  await exportDialog.getByRole('button', { name: '关闭' }).click()
  await page.getByRole('button', { name: '纸张设置', exact: true }).click()
  const paper = page.getByRole('dialog', { name: '纸张设置' })
  await paper.getByLabel('纸张尺寸').selectOption('custom')
  await expectAligned(paper.getByLabel('纸张宽度（mm）'), paper.getByLabel('纸张高度（mm）'))
})
