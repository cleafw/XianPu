import { expect, test } from '@playwright/test'
import { blank, createProject } from '../src/model'

test('audition follows beats and repeated measures, scrolling into view without changing the edit selection', async ({ page }) => {
  const score = createProject('ensemble')
  score.bpm = 300
  score.meter = [2, 4]
  score.measures = Array.from({ length: 12 }, (_, index) => index === 1 ? { start: true } : index === 2 ? { end: true } : {})
  score.layout.barsPerLine = 1
  score.tracks = [score.tracks[0]]
  score.tracks[0].bars = score.measures.map((_, bar) => [0, 1].map((beat) =>
    ({ ...blank(), draft: false, notes: [{ midi: 60 + (bar + beat) % 12 }] })))
  await page.goto('/')
  await page.locator('input[type=file]').setInputFiles({
    name: 'playhead.xianpu', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(score)),
  })
  const cursor = page.locator('.score-cursor')
  await expect(cursor).toBeVisible()
  await page.evaluate(() => {
    const marker = document.querySelector('.score-cursor')!
    const points: string[] = []
    const read = () => {
      const bar = marker.getAttribute('data-play-measure')
      const beat = marker.getAttribute('data-play-beat')
      const point = bar + ':' + beat
      if (bar !== null && beat !== null && points.at(-1) !== point) points.push(point)
    }
    new MutationObserver(read).observe(marker, { attributes: true, attributeFilter: ['data-play-measure', 'data-play-beat'] })
    Object.assign(window, { playheadPoints: points })
  })
  await page.getByRole('button', { name: '▶ 试听' }).click()
  await expect(cursor).toHaveClass(/is-playing/, { timeout: 20_000 })
  await expect.poll(() => page.evaluate(() => (window as Window & { playheadPoints?: string[] }).playheadPoints?.join(' ')),
    { timeout: 10_000 }).toContain('0:0 0:1 1:0 1:1 2:0 2:1 1:0 1:1 2:0')
  await expect.poll(() => page.locator('.canvas').evaluate((canvas) => canvas.scrollTop), { timeout: 8_000 }).toBeGreaterThan(150)
  await page.getByRole('button', { name: '■ 停止' }).click()
  await expect(cursor).not.toHaveClass(/is-playing/)
  await expect(page.getByText('第 1 小节 · 位置 1', { exact: true })).toBeVisible()
})

test('collapses controls and keeps independent draggable panels connected to the selected note', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '打开弹唱示例' }).click()
  const inspector = page.getByRole('region', { name: '录入面板' })
  for (const panel of ['时值', '音高', '歌词与和弦', '连线与常用技巧']) {
    const toggle = inspector.getByRole('button', { name: panel, exact: true })
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  }
  await expect(inspector.getByRole('button', { name: '升八度', exact: true })).toHaveCount(0)
  await inspector.getByRole('button', { name: '弹出记号面板', exact: true }).click()
  const marks = page.getByRole('region', { name: '记号面板', exact: true })
  await expect(marks).toBeVisible()
  const title = marks.getByTitle('拖动记号面板')
  const from = (await title.boundingBox())!
  await page.mouse.move(from.x + 30, from.y + from.height / 2)
  await page.mouse.down()
  await page.mouse.move(from.x - 210, from.y + 80, { steps: 10 })
  await page.mouse.up()
  await expect.poll(async () => (await marks.boundingBox())!.x).toBeLessThan(from.x - 150)
  await marks.getByRole('searchbox', { name: '搜索记号' }).fill('跳音')
  await marks.getByRole('button', { name: '添加记号' }).click()
  await expect(page.locator('.canvas [data-code=staccato]')).toHaveCount(1)
  await inspector.getByRole('button', { name: '弹出倚音与成组连音', exact: true }).click()
  const ornaments = page.getByRole('region', { name: '倚音与成组连音', exact: true })
  await expect(ornaments).toBeVisible()
  await expect(marks).toBeVisible()
  await ornaments.getByRole('button', { name: '添加前倚音' }).click()
  await expect(ornaments.getByRole('button', { name: '移除倚音' })).toBeVisible()
  await ornaments.getByRole('button', { name: '将倚音与成组连音贴回右栏' }).click()
  await expect(ornaments).toHaveCount(0)
  await expect(marks.getByRole('searchbox', { name: '搜索记号' })).toHaveValue('跳音')
  await marks.getByRole('button', { name: '将记号面板贴回右栏' }).click()
  await expect(marks).toHaveCount(0)
  await inspector.getByRole('button', { name: '记号面板', exact: true }).click()
  await expect(inspector.getByRole('searchbox', { name: '搜索记号' })).toHaveValue('跳音')
})

test('moves the entry position into a separate document and keeps the score and shortcuts connected', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '打开弹唱示例' }).click()
  const inspector = page.getByRole('region', { name: '录入面板' })
  const navigation = inspector.getByRole('group', { name: '拍位导航' })
  await expect(navigation.getByRole('button', { name: '上一拍' })).toBeVisible()
  await expect(navigation.getByRole('button', { name: '下一拍' })).toBeVisible()
  await expect(inspector.getByRole('group', { name: '移除操作' }).getByRole('button', { name: '清空' })).toBeVisible()

  // Chromium supplies the popup here. Tauri supplies its native host in the desktop app.
  await page.evaluate(() => Object.assign(window, { isTauri: true }))
  const [popup] = await Promise.all([
    page.waitForEvent('popup'),
    page.getByRole('button', { name: '弹出录入位置' }).click(),
  ])
  const entry = popup.getByRole('region', { name: '录入位置', exact: true })
  await expect(entry.getByRole('group', { name: '移除操作' }).getByRole('button', { name: '删除小节' })).toBeVisible()
  const second = entry.getByRole('button', { name: /^第 2 小节，/ })
  const fourth = entry.getByRole('button', { name: /^第 4 小节，/ })
  const start = (await second.boundingBox())!
  const end = (await fourth.boundingBox())!
  await popup.mouse.move(start.x + start.width / 2, start.y + start.height / 2)
  await popup.mouse.down()
  await popup.mouse.move(end.x + end.width / 2, end.y + end.height / 2, { steps: 8 })
  await popup.mouse.up()
  await expect(entry.locator('.measure-list [aria-pressed="true"]')).toHaveCount(3)
  await expect(inspector.getByText('第 2 小节 · 位置 1', { exact: true })).toBeVisible()
  await popup.keyboard.press('Control+c')
  await expect(entry.getByRole('button', { name: '在前面插入粘贴' })).toBeEnabled()
  await popup.keyboard.press('Control+v')
  await expect(page.locator('.status-bar').getByRole('status')).toHaveText('已粘贴 3 小节。')
  await fourth.click({ button: 'right' })
  await expect(popup.getByRole('group', { name: '小节操作' })).toBeVisible()
  await entry.getByRole('button', { name: '将录入位置贴回底部' }).focus()
  await popup.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: '弹出录入位置' })).toBeVisible()
  await expect(page.getByRole('group', { name: '小节操作' })).toHaveCount(0)
})
