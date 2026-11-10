import { expect, test, type Page } from '@playwright/test'

async function clickRenderedStaff(page: Page, staffLine: number, beatIndex: number) {
  const svg = page.locator('.canvas svg').filter({ has: page.locator('rect') }).first()
  const click = await svg.evaluate((system, { staffLine, beatIndex }) => {
    const rest = [...system.querySelectorAll('text')].filter((text) => text.textContent === '0')[beatIndex]
    const rect = rest.getBoundingClientRect()
    const x = rect.left + rect.width / 2
    const lines = [...system.querySelectorAll('rect')]
      .map((line) => line.getBoundingClientRect())
      .filter((line) => line.width > 40 && line.height < 3 && x >= line.left && x <= line.right)
      .sort((a, b) => a.top - b.top)
    return { x, y: lines[staffLine].top + lines[staffLine].height / 2 }
  }, { staffLine, beatIndex })
  await page.mouse.click(click.x, click.y)
}

test('clicking blank guitar and staff lanes in the full score routes input to the clicked track and beat', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: /多乐器总谱/ }).click()
  await expect(page.locator('.canvas svg').filter({ has: page.locator('rect') }).first()).toBeVisible()
  await clickRenderedStaff(page, 2, 5)
  await expect(page.locator('.inspector-head strong')).toHaveText('吉他六线谱')
  await expect(page.locator('.inspector-head')).toContainText('第 2 小节 · 位置 2')
  await page.keyboard.type('7')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('button', { name: '吉他六线谱位置 2' })).toContainText('7')

  // Choose the lower staff at another position in the same bar.
  // Entered pitches do not alter the numbered voice's blank rest targets.
  await clickRenderedStaff(page, 8, 6)
  await expect(page.locator('.inspector-head strong')).toHaveText('五线谱')
  await expect(page.locator('.inspector-head')).toContainText('第 2 小节 · 位置 3')
  await page.keyboard.press('e')
  await expect(page.getByRole('button', { name: '五线谱位置 3' })).toContainText('E')
  await expect(page.getByRole('button', { name: '简谱位置 3' })).toContainText('·')
  await expect(page.getByRole('button', { name: '总谱', exact: true })).toHaveAttribute('aria-current', 'page')
})

test('paired guitar staves select the clicked notation lane', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: /多乐器总谱/ }).click()
  await clickRenderedStaff(page, 2, 0)
  await page.getByLabel('谱式').selectOption('staff-tab')
  await clickRenderedStaff(page, 2, 0)
  await expect(page.locator('.inspector-head')).toContainText('吉他六线谱 · 五线谱')
  await clickRenderedStaff(page, 7, 0)
  await expect(page.locator('.inspector-head')).toContainText('吉他六线谱')
})

test.describe('a system using another language', () => {
  test.use({ locale: 'ja-JP' })
  test('falls back to English and persists a manual override without losing score edits', async ({ page }) => {
    await page.goto('/')
    await expect(page).toHaveTitle('Yezi XianPu')
    await expect(page.getByRole('heading', { name: 'Start with the first bar' })).toBeVisible()
    await expect(page.getByLabel('Language')).toHaveValue('system')
    await page.getByRole('button', { name: /Voice & Guitar/ }).click()
    await page.keyboard.press('1')
    await expect(page.getByRole('button', { name: 'Numbered position 1' })).toContainText('C')
    await page.getByLabel('Language').selectOption('zh')
    await expect(page).toHaveTitle('叶子弦谱')
    await expect(page.getByRole('button', { name: 'Numbered位置 1' })).toContainText('C')
    await expect(page.getByRole('button', { name: '导出', exact: true })).toBeVisible()
    await page.reload()
    await expect(page.getByLabel('界面语言')).toHaveValue('zh')
    await page.getByRole('button', { name: '恢复草稿' }).click()
    await page.getByLabel('界面语言').selectOption('en')
    await page.getByRole('button', { name: 'Export', exact: true }).click()
    await expect(page.getByRole('dialog').getByText('A4 preview · Full Score')).toBeVisible()
    await expect(page.getByRole('dialog').locator('.sheet-label')).toHaveText('Full Score · 1')
    await page.getByRole('button', { name: 'Close', exact: true }).click()
    await page.getByLabel('Language').selectOption('system')
    await expect(page).toHaveTitle('Yezi XianPu')
  })
})
