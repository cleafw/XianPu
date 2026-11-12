import { expect, test } from '@playwright/test'
import { blank, createProject, parseProject } from '../src/model'

test('Space starts from the selected note, pauses, and resumes without losing the playhead', async ({ page }) => {
  const score = createProject('song')
  score.bpm = 100
  score.tracks = score.tracks.slice(0, 1)
  score.tracks[0].bars = score.measures.map(() =>
    [60, 62, 64, 65].map((midi) => ({ ...blank(), draft: false, notes: [{ midi }] })))
  await page.goto('/')
  await page.locator('input[type=file]').setInputFiles({
    name: 'audition-space.xianpu', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(score)),
  })
  const entry = page.getByRole('region', { name: '小节与录入位置' })
  const cursor = page.locator('.score-cursor')
  const toolbar = page.locator('[data-audition]')
  await page.getByRole('button', { name: '歌词与和弦', exact: true }).click()
  const lyric = page.getByRole('textbox', { name: '歌词', exact: true })
  await lyric.fill('A')
  await lyric.press('End')
  await lyric.press('Space')
  await expect(lyric).toHaveValue('A ')
  await expect(toolbar).toHaveText('▶ 试听')

  await entry.getByRole('button', { name: '简谱位置 2', exact: true }).click()
  await page.keyboard.press('Space')
  await expect(cursor).toHaveClass(/is-playing/, { timeout: 20_000 })
  await expect(cursor).toHaveAttribute('data-play-beat', '1')
  await expect(cursor).toHaveAttribute('data-play-beat', '2')
  await page.keyboard.press('Space')
  await expect(cursor).toHaveClass(/is-paused/)
  await expect(toolbar).toHaveText('▶ 继续试听')
  const pausedBeat = await cursor.getAttribute('data-play-beat')
  expect(Number(pausedBeat)).toBeGreaterThanOrEqual(2)
  await page.waitForTimeout(650)
  await expect(cursor).toHaveAttribute('data-play-beat', pausedBeat!)

  await page.keyboard.press('Space')
  await expect(cursor).toHaveClass(/is-playing/)
  await expect(cursor).toHaveAttribute('data-play-beat', pausedBeat!)
  await expect(cursor).toHaveAttribute('data-play-measure', '1')
  await page.keyboard.press('Space')
  await expect(toolbar).toHaveText('▶ 继续试听')
  await entry.getByRole('button', { name: /^第 3 小节，/ }).click()
  await entry.getByRole('button', { name: '简谱位置 3', exact: true }).click()
  await page.keyboard.press('Space')
  await expect(cursor).toHaveClass(/is-playing/)
  await expect(cursor).toHaveAttribute('data-play-measure', '2')
  await expect(cursor).toHaveAttribute('data-play-beat', '2')
  await toolbar.click()
  await expect(toolbar).toHaveText('▶ 试听')
})

test('selects an extension dash, follows it in audition, and deletes only its sustain', async ({ page }) => {
  const score = createProject('song')
  score.bpm = 150
  score.tracks = score.tracks.slice(0, 1)
  score.tracks[0].bars[0] = [
    { ...blank(2), dots: 1, draft: false, notes: [{ midi: 60 }] },
    { ...blank(), draft: false, notes: [{ midi: 62 }] },
  ]
  await page.goto('/')
  await page.locator('input[type=file]').setInputFiles({
    name: 'extension-dash.xianpu', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(score)),
  })
  const dashes = page.locator('.canvas g[class^="xianpu-extension-"] > rect')
  await expect(dashes).toHaveCount(2)
  const cursor = page.locator('.score-cursor')
  const first = (await dashes.first().boundingBox())!
  const second = (await dashes.last().boundingBox())!
  await page.mouse.click(first.x + first.width / 2, first.y + first.height / 2)
  await expect(cursor).toHaveAttribute('data-extension', '1')
  const selected = (await cursor.boundingBox())!
  expect(selected.x + selected.width / 2).toBeCloseTo(first.x + first.width / 2, 0)
  const playedDashes = await cursor.evaluateHandle((marker) => {
    const positions: Record<string, number> = {}
    new MutationObserver(() => {
      const extension = marker.getAttribute('data-extension')
      if (extension && marker.classList.contains('is-playing')) {
        const box = marker.getBoundingClientRect()
        positions[extension] = box.x + box.width / 2
      }
    }).observe(marker, { attributes: true, attributeFilter: ['data-extension', 'style', 'class'] })
    return positions
  })
  await page.getByRole('button', { name: '▶ 试听' }).click()
  await expect(cursor).toHaveClass(/is-playing/, { timeout: 20_000 })
  await expect.poll(() => playedDashes.evaluate((positions) => positions['2'])).toBeCloseTo(second.x + second.width / 2, 0)
  await page.getByRole('button', { name: '■ 停止' }).click()
  await expect(cursor).toHaveAttribute('data-extension', '1')
  await page.keyboard.press('Delete')
  await expect(dashes).toHaveCount(1)
  const draft = await page.evaluate(() => localStorage.getItem('xianpu.recovery.v1')!)
  expect(parseProject(draft).tracks[0].bars[0].map(({ duration, dots, notes }) => [duration, dots, notes[0]?.midi]))
    .toEqual([[2, 0, 60], [4, 0, undefined], [4, 0, 62]])
  await page.getByRole('button', { name: '撤销', exact: true }).click()
  await expect(dashes).toHaveCount(2)
  const restored = (await dashes.last().boundingBox())!
  await page.mouse.click(restored.x + restored.width / 2, restored.y + restored.height / 2, { button: 'right' })
  await page.getByRole('group', { name: '音符编辑' }).getByRole('button', { name: '去增时线' }).click()
  await expect(dashes).toHaveCount(1)
})

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
  await page.getByRole('button', { name: '简谱位置 2', exact: true }).click()
  await page.evaluate(() => {
    const marker = document.querySelector<HTMLElement>('.score-cursor')!
    const points: string[] = []
    const locations = new Set<string>()
    const read = () => {
      const bar = marker.getAttribute('data-play-measure')
      const beat = marker.getAttribute('data-play-beat')
      const point = bar + ':' + beat
      if (bar !== null && beat !== null && points.at(-1) !== point) points.push(point)
      if (marker.classList.contains('is-playing') && !marker.hidden) {
        locations.add(marker.style.left + ':' + marker.style.top)
      }
    }
    new MutationObserver(read).observe(marker, { attributes: true, attributeFilter: ['data-play-measure', 'data-play-beat', 'style'] })
    Object.assign(window, { playheadPoints: points, playheadLocations: locations })
  })
  await page.getByRole('button', { name: '▶ 试听' }).click()
  await expect(cursor).toHaveClass(/is-playing/, { timeout: 20_000 })
  await expect.poll(() => page.evaluate(() => (window as Window & { playheadPoints?: string[] }).playheadPoints?.join(' ')),
    { timeout: 10_000 }).toMatch(/^0:1 1:0 1:1 2:0 2:1 1:0 1:1 2:0/)
  await expect.poll(() => page.evaluate(() => (window as Window & { playheadLocations?: Set<string> }).playheadLocations?.size)).toBeGreaterThan(3)
  await expect.poll(() => page.locator('.canvas').evaluate((canvas) => canvas.scrollTop), { timeout: 8_000 }).toBeGreaterThan(150)
  await page.getByRole('button', { name: '■ 停止' }).click()
  await expect(cursor).not.toHaveClass(/is-playing/)
  await expect(page.getByText('第 1 小节 · 位置 2', { exact: true })).toBeVisible()
})

test('audition MIDI excludes notes before the selected beat and inherits the active tempo', async ({ page }) => {
  const score = createProject('demo')
  const track = score.tracks[0]
  score.measures[1].bpm = 120
  await page.goto('/')
  const events = await page.evaluate(async ({ score, id }) => {
    const { buildPlaybackMidi } = await import('/src/playback.ts') as typeof import('../src/playback')
    const file = buildPlaybackMidi(score, id, { track: id, bar: 2, beat: 1 })
    return {
      notes: file.events.filter((event) => 'noteVelocity' in event && event.noteVelocity > 0).slice(0, 2)
        .map((event) => ({ tick: event.tick, key: 'noteKey' in event ? event.noteKey : null })),
      tempo: file.events.flatMap((event) => 'beatsPerMinute' in event ? [{ tick: event.tick, bpm: event.beatsPerMinute }] : []),
    }
  }, { score, id: track.id })
  expect(events.notes).toEqual([{ tick: 0, key: 64 }, { tick: 960, key: 67 }])
  expect(events.tempo).toEqual([{ tick: 0, bpm: 120 }])
})

test('collapses controls and keeps independent draggable panels connected to the selected note', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '打开弹唱示例' }).click()
  const inspector = page.getByRole('region', { name: '录入面板' })
  for (const panel of ['时值', '音高']) {
    const toggle = inspector.getByRole('button', { name: panel, exact: true })
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  }
  for (const panel of ['歌词与和弦', '连线与常用技巧', '倚音与成组连音', '记号面板']) {
    await expect(inspector.getByRole('button', { name: panel, exact: true })).toHaveAttribute('aria-expanded', 'false')
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
  await marks.getByRole('button', { name: '跳音', exact: true }).click()
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

test('reflows the mark palette when the sidebar, floating panel, and separate window get wider', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '打开弹唱示例' }).click()
  const inspector = page.getByRole('region', { name: '录入面板' })
  await inspector.getByRole('button', { name: '记号面板', exact: true }).click()
  const columns = (scope: typeof inspector) => scope.getByRole('group', { name: '可用记号' }).evaluate((node) =>
    getComputedStyle(node).gridTemplateColumns.split(' ').length)
  const narrow = await columns(inspector)
  const sidebarGrip = page.getByRole('separator', { name: '调整右侧栏宽度' })
  const grip = (await sidebarGrip.boundingBox())!
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2)
  await page.mouse.down()
  await page.mouse.move(grip.x - 245, grip.y + grip.height / 2, { steps: 8 })
  await page.mouse.up()
  await expect.poll(() => columns(inspector)).toBeGreaterThan(narrow)
  await inspector.getByRole('button', { name: '记号列表', exact: true }).click()
  await expect.poll(() => columns(inspector)).toBeGreaterThan(1)
  const list = inspector.getByRole('group', { name: '可用记号' })
  const listSize = await list.evaluate((node) => ({ height: node.clientHeight, overflow: getComputedStyle(node).overflowY }))
  expect(listSize.height).toBeGreaterThan(170)
  expect(listSize.overflow).toBe('visible')

  await inspector.getByRole('button', { name: '图标网格', exact: true }).click()
  await inspector.getByRole('button', { name: '弹出记号面板', exact: true }).click()
  const floating = page.getByRole('region', { name: '记号面板', exact: true })
  const before = await columns(floating)
  const floatingGrip = floating.getByRole('separator', { name: '调整记号面板宽度' })
  const edge = (await floatingGrip.boundingBox())!
  await page.mouse.move(edge.x + edge.width / 2, edge.y + edge.height / 2)
  await page.mouse.down()
  await page.mouse.move(edge.x + 190, edge.y + edge.height / 2, { steps: 8 })
  await page.mouse.up()
  await expect.poll(() => columns(floating)).toBeGreaterThan(before)
  await floating.getByRole('button', { name: '将记号面板贴回右栏' }).click()

  await page.evaluate(() => Object.assign(window, { isTauri: true }))
  const [popup] = await Promise.all([
    page.waitForEvent('popup'),
    inspector.getByRole('button', { name: '弹出记号面板', exact: true }).click(),
  ])
  const detached = popup.getByRole('region', { name: '记号面板', exact: true })
  await popup.setViewportSize({ width: 325, height: 350 })
  const detachedNarrow = await columns(detached)
  await popup.setViewportSize({ width: 640, height: 650 })
  await expect.poll(() => columns(detached)).toBeGreaterThan(detachedNarrow)
  await popup.close()
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
  // The browser test has no native host to apply the requested window size.
  await popup.setViewportSize({ width: 620, height: 450 })
  const entry = popup.getByRole('region', { name: '录入位置', exact: true })
  const removal = entry.getByRole('group', { name: '移除操作' })
  await expect(removal.getByRole('button', { name: '从选中处删除小节' })).toBeVisible()
  await expect(removal.getByRole('button', { name: '从曲尾删除小节' })).toBeVisible()
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
  await popup.keyboard.down('Escape').catch((error) => {
    if (!popup.isClosed()) throw error
  })
  await expect(page.getByRole('button', { name: '弹出录入位置' })).toBeVisible()
  await expect(page.getByRole('group', { name: '小节操作' })).toHaveCount(0)
})

test('fits each native panel to its own content and refits when the content changes', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '打开弹唱示例' }).click()
  await page.evaluate(() => {
    const panelHeights: Record<string, number> = {}
    Object.assign(window, {
      isTauri: true, panelHeights,
      __TAURI_INTERNALS__: {
        invoke: async (command: string, args: { label: string; height: number }) => {
          if (command === 'fit_tool_panel') panelHeights[args.label] = args.height
        },
      },
    })
  })
  const [popup] = await Promise.all([
    page.waitForEvent('popup'),
    page.getByRole('button', { name: '弹出倚音与成组连音', exact: true }).click(),
  ])
  const ornaments = popup.getByRole('region', { name: '倚音与成组连音', exact: true })
  const label = await popup.evaluate(() => location.hash.slice(1))
  const requestedHeight = () => page.evaluate((id) =>
    (window as Window & { panelHeights: Record<string, number> }).panelHeights[id] ?? 0, label)
  const contentHeight = () => ornaments.evaluate((panel) => Math.ceil(panel.getBoundingClientRect().height))
  await expect(ornaments).toBeVisible()
  await expect(popup).toHaveTitle('叶子弦谱 · 倚音与成组连音')
  const initial = await contentHeight()
  expect(initial).toBeLessThan(450)
  await expect.poll(requestedHeight).toBe(initial)

  await ornaments.getByRole('button', { name: '添加前倚音' }).click()
  await expect(ornaments.getByRole('button', { name: '移除倚音' })).toBeVisible()
  const expanded = await contentHeight()
  expect(expanded).toBeGreaterThan(initial)
  await expect.poll(requestedHeight).toBe(expanded)
  await ornaments.getByRole('button', { name: '移除倚音' }).click()
  await expect.poll(requestedHeight).toBe(initial)
})
