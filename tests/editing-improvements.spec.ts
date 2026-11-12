import { expect, test } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { blank, createProject, parseProject } from '../src/model'

test('edits multiple bars from the entry panel and undoes each batch together', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '打开弹唱示例' }).click()
  const entry = page.getByRole('region', { name: '小节与录入位置' })
  const count = entry.getByRole('spinbutton', { name: '小节数量' })
  const bars = entry.locator('[data-measure-index]')
  const insert = entry.getByRole('button', { name: '插入小节', exact: true })
  const deleteSelected = entry.getByRole('button', { name: '从选中处删除小节' })
  const deleteEnd = entry.getByRole('button', { name: '从曲尾删除小节' })
  const undo = page.getByRole('button', { name: '撤销', exact: true })
  const readDraft = () => page.evaluate(() => JSON.parse(localStorage.getItem('xianpu.recovery.v1')!))
  const original = await readDraft()

  await count.fill('0')
  await expect(insert).toBeDisabled()
  await expect(deleteEnd).toBeDisabled()
  await count.fill('3')
  await bars.nth(1).click()
  await insert.click()
  await expect(bars).toHaveCount(11)
  await expect(bars.nth(2)).toHaveAttribute('data-current', 'true')
  for (const [index, track] of (await readDraft()).tracks.entries()) {
    expect(track.bars).toEqual([...original.tracks[index].bars.slice(0, 2), [], [], [], ...original.tracks[index].bars.slice(2)])
  }
  await undo.click()
  await expect(bars).toHaveCount(8)

  await count.fill('2')
  await bars.nth(3).click()
  await bars.nth(1).click({ modifiers: ['Shift'] })
  await deleteSelected.click()
  await expect(bars).toHaveCount(6)
  expect((await readDraft()).tracks[0].bars).toEqual([original.tracks[0].bars[0], ...original.tracks[0].bars.slice(3)])
  await undo.click()
  await expect(bars).toHaveCount(8)

  await bars.last().click()
  await expect(deleteSelected).toBeDisabled()
  await deleteEnd.click()
  await expect(bars).toHaveCount(6)
  expect((await readDraft()).tracks[0].bars).toEqual(original.tracks[0].bars.slice(0, 6))
  await undo.click()
  await expect(bars).toHaveCount(8)
  await count.fill('8')
  await expect(deleteEnd).toBeDisabled()
})

test('repeated measure insertion preserves the scrolled score and advances to the inserted bar', async ({ page }) => {
  const project = createProject('demo')
  project.layout.barsPerLine = 1
  project.measures = Array.from({ length: 20 }, () => ({}))
  project.tracks = [project.tracks[0]]
  const original = project.tracks[0].bars
  project.tracks[0].bars = project.measures.map((_, index) => original[index % original.length])
  await page.goto('/')
  await page.locator('input[type=file]').setInputFiles({
    name: 'long-score.xianpu', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(project)),
  })
  const canvas = page.locator('.canvas')
  const cursor = canvas.locator('.score-cursor')
  await expect(cursor).toBeVisible()
  await page.getByRole('combobox', { name: '缩放' }).selectOption('150')
  const entry = page.getByRole('region', { name: '小节与录入位置' })
  await entry.getByRole('button', { name: /^第 18 小节，/ }).click()
  await entry.getByRole('button', { name: '简谱位置 2', exact: true }).click()
  const insert = entry.getByRole('button', { name: '插入小节' })
  await insert.scrollIntoViewIfNeeded()
  const paper = canvas.locator('.paper-scroll')
  await paper.evaluate((node) => { node.scrollLeft = 110 })
  const top = await canvas.evaluate((node) => node.scrollTop)
  const left = await paper.evaluate((node) => node.scrollLeft)
  expect(top).toBeGreaterThan(500)
  expect(left).toBeGreaterThan(50)

  for (const bar of [19, 20]) {
    const previous = await canvas.locator('.score-render svg').first().elementHandle()
    await insert.click()
    await expect(page.getByText(`第 ${bar} 小节 · 位置 1`, { exact: true })).toBeVisible()
    await expect.poll(() => previous!.evaluate((node) => node.isConnected)).toBe(false)
    await expect(cursor).toBeVisible()
    await expect.poll(() => canvas.evaluate((node) => node.scrollTop)).toBeCloseTo(top, 0)
    await expect.poll(() => paper.evaluate((node) => node.scrollLeft)).toBeCloseTo(left, 0)
  }
})

test('drags measures, covers and inserts a copied range, and changes an existing octave', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '打开弹唱示例' }).click()
  await expect(page.locator('.score-cursor')).toBeVisible()
  const measures = page.getByRole('region', { name: '小节与录入位置' })
  const bar = (n: number) => measures.getByRole('button', { name: new RegExp('^第 ' + n + ' 小节') })
  const center = async (n: number) => {
    const box = (await bar(n).boundingBox())!
    return [box.x + box.width / 2, box.y + box.height / 2] as const
  }
  await bar(2).scrollIntoViewIfNeeded()
  await page.mouse.move(...await center(2))
  await page.mouse.down()
  await page.mouse.move(...await center(4), { steps: 8 })
  await page.mouse.up()
  for (const n of [2, 3, 4]) await expect(bar(n)).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('.score-measure-highlight')).toHaveCount(3)
  await page.keyboard.press('Control+c')
  await bar(6).click()
  const firstNote = page.getByRole('button', { name: '简谱位置 1' })
  await expect(firstNote).toContainText('C')
  await page.keyboard.press('Control+v')
  await expect(page.getByRole('status')).toContainText('已粘贴 3 小节')
  await expect(firstNote).toContainText('A')
  await page.keyboard.press('Control+z')
  await expect(firstNote).toContainText('C')
  await bar(6).click({ button: 'right' })
  await page.getByRole('button', { name: '在后面插入粘贴', exact: true }).click()
  await expect(bar(11)).toBeVisible()
  await bar(7).click()
  await page.getByRole('button', { name: '简谱位置 1' }).click()
  await page.keyboard.press('Shift+ArrowUp')
  await expect(page.getByText('所选音：A5 · 八度 1')).toBeVisible()
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: '保存 •' }).click()
  const score = parseProject(await readFile((await (await download).path())!, 'utf8'))
  expect(score.tracks[0].bars[6][0].notes[0].midi).toBe(81)
  expect(score.tracks[1].bars.slice(6, 9)).toEqual([[], [], []])
  expect(score.tracks[2].bars).toHaveLength(11)
})

test('Delete clears a dragged measure range in one edit and still works on single notes', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '打开弹唱示例' }).click()
  await page.getByRole('navigation').getByRole('button', { name: '简谱', exact: true }).click()
  const lyrics = page.locator('.canvas .score-render svg text')
  const first = lyrics.filter({ hasText: /^晚$/ }).first()
  const last = lyrics.filter({ hasText: /^我$/ }).first()
  await first.scrollIntoViewIfNeeded()
  const from = (await first.boundingBox())!
  const to = (await last.boundingBox())!
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
  await page.mouse.down()
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 })
  await page.mouse.up()
  await expect(page.getByText('简谱 · 所选小节 1, 2, 3', { exact: true })).toBeVisible()
  await page.keyboard.press('Delete')
  await expect(first).toHaveCount(0)
  await expect(last).toHaveCount(0)
  await expect(lyrics.filter({ hasText: /^歌$/ })).toHaveCount(1)
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: '保存 •' }).click()
  const score = parseProject(await readFile((await (await download).path())!, 'utf8'))
  const original = createProject('demo')
  expect(score.tracks[0].bars.slice(0, 3)).toEqual([[], [], []])
  expect(score.tracks[0].bars.slice(3)).toEqual(original.tracks[0].bars.slice(3))
  expect(score.tracks.slice(1).map(({ bars }) => bars)).toEqual(original.tracks.slice(1).map(({ bars }) => bars))
  expect(score.measures).toEqual(original.measures)

  await page.keyboard.press('Control+z')
  await expect(first).toBeVisible()
  await expect(last).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('.score-measure-highlight')).toHaveCount(0)
  await page.getByRole('button', { name: '简谱位置 1', exact: true }).click()
  await page.keyboard.press('Delete')
  await expect(first).toHaveCount(0)
  await expect(last).toBeVisible()
})

test('adds bamboo flute symbols from the grid and list and prints the same signs', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '打开弹唱示例' }).click()
  await page.getByRole('navigation').getByRole('button', { name: '简谱', exact: true }).click()
  const editor = page.getByRole('region', { name: '录入面板' })
  await editor.getByRole('button', { name: '记号面板', exact: true }).click()
  await editor.getByRole('combobox', { name: '记号类别' }).selectOption('竹笛')
  const choices = editor.getByRole('group', { name: '可用记号' })
  const trill = choices.getByRole('button', { name: '指颤音', exact: true })
  const previewGlyph = await trill.locator('.mark-preview-music').textContent()
  await trill.click()
  const score = page.locator('.canvas .score-render')
  await expect(score.locator('[data-code=fluteTrill] .at text')).toHaveText(previewGlyph!)

  await editor.getByRole('button', { name: '记号列表', exact: true }).click()
  const tail = choices.getByRole('button', { name: '赠音（尾音）', exact: true })
  await expect(tail).toContainText('赠音（尾音）')
  await tail.click()
  await expect(score.locator('[data-code=fluteZeng] text')).toHaveText('贝')
  await choices.getByRole('button', { name: '下滑音', exact: true }).click()
  await expect(score.locator('[data-code=fluteSlideDown] text')).toHaveText('↘')

  await page.getByRole('button', { name: '导出', exact: true }).click()
  const paper = page.getByRole('dialog').locator('.print-page')
  await expect(paper.locator('[data-code=fluteTrill] .at text')).toHaveText(previewGlyph!)
  await expect(paper.locator('[data-code=fluteZeng] text')).toHaveText('贝')
})

test('finds the two flute run signs by alias and prints the same graphics and grace notes', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '打开弹唱示例' }).click()
  await page.getByRole('navigation').getByRole('button', { name: '简谱', exact: true }).click()
  const editor = page.getByRole('region', { name: '录入面板' })
  await editor.getByRole('button', { name: '记号面板', exact: true }).click()
  const search = editor.getByRole('searchbox', { name: '搜索记号' })
  const category = editor.getByRole('combobox', { name: '记号类别' })
  await category.selectOption('竹笛')
  await search.fill('立音')
  const choices = editor.getByRole('group', { name: '可用记号' })
  const up = choices.getByRole('button', { name: '上历音', exact: true })
  const down = choices.getByRole('button', { name: '下历音', exact: true })
  const upPath = await up.locator('svg path').getAttribute('d')
  const downPath = await down.locator('svg path').getAttribute('d')
  expect(upPath).not.toBe(downPath)
  await up.click()
  await down.click()
  await expect(page.locator('.canvas [data-code=fluteRunUp] path')).toHaveAttribute('d', upPath!)
  await expect(page.locator('.canvas [data-code=fluteRunDown] path')).toHaveAttribute('d', downPath!)

  await category.selectOption('通用')
  await search.fill('分解和弦')
  await choices.getByRole('button', { name: '上行琶音', exact: true }).click()
  await search.fill('小音符')
  await editor.getByText('录入小音符（倚音）', { exact: true }).click()
  const pitch = editor.getByRole('combobox', { name: '倚音音高' })
  for (const value of ['1', '6', '7']) {
    await pitch.selectOption(value)
    await editor.getByRole('button', { name: '添加前倚音' }).click()
  }
  const data = await page.evaluate(() => JSON.parse(localStorage.getItem('xianpu.recovery.v1')!))
  expect(parseProject(JSON.stringify(data)).tracks[0].bars[0][0].grace).toEqual([60, 69, 71])
  await page.getByRole('button', { name: '导出', exact: true }).click()
  const paper = page.getByRole('dialog').locator('.print-page')
  await expect(paper.locator('[data-code=fluteRunUp] path')).toHaveAttribute('d', upPath!)
  await expect(paper.locator('[data-code=fluteRunDown] path')).toHaveAttribute('d', downPath!)
  await expect(paper.locator('[data-code=arpeggioUp] path')).toHaveCount(1)
})

test('enters and changes numbered grace notes by degree and octave in the current key', async ({ page }) => {
  const project = createProject('song')
  project.tracks = project.tracks.slice(0, 1)
  project.measures[1] = { key: 1 }
  project.tracks[0].bars[1] = [{ ...blank(), draft: false, notes: [{ midi: 67 }] }]
  await page.goto('/')
  await page.locator('input[type=file]').setInputFiles({
    name: 'numbered-grace.xianpu', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(project)),
  })
  const entry = page.getByRole('region', { name: '小节与录入位置' })
  await entry.getByRole('button', { name: /^第 2 小节，/ }).click()
  const editor = page.getByRole('region', { name: '录入面板' })
  await editor.getByRole('button', { name: '倚音与成组连音', exact: true }).click()
  const pitch = editor.getByRole('combobox', { name: '倚音音高' })
  const octave = editor.getByRole('combobox', { name: '倚音八度' })
  await expect(pitch.locator('option')).toHaveText(['1', '2', '3', '4', '5', '6', '7'])
  await pitch.selectOption('2')
  await octave.selectOption('1')
  await editor.getByRole('button', { name: '添加前倚音' }).click()
  await expect(editor.getByText('2 · 八度 1', { exact: true })).toBeVisible()
  await pitch.selectOption('1')
  await octave.selectOption('-1')
  await editor.getByRole('button', { name: '添加前倚音' }).click()
  const readGrace = async () => {
    const draft = await page.evaluate(() => localStorage.getItem('xianpu.recovery.v1')!)
    return parseProject(draft).tracks[0].bars[1][0].grace
  }
  expect(await readGrace()).toEqual([81, 55])
  await editor.getByRole('button', { name: '第 1 个倚音降八度' }).click()
  await editor.getByRole('button', { name: '第 2 个倚音升八度' }).click()
  expect(await readGrace()).toEqual([69, 67])

  await page.getByRole('combobox', { name: '谱式' }).selectOption('staff')
  await expect(pitch.locator('option[value="69"]')).toHaveText('A4')
  await expect(octave).toHaveCount(0)
})

test('shows one numbered key per change and lets overlapping spacing and part labels be edited', async ({ page }) => {
  const project = createProject('demo')
  project.key = -2
  project.meter = [3, 4]
  project.intro = [0, 3]
  project.measures[2].bpm = 106
  const first = project.tracks[0]
  first.bars = first.bars.map((bar) => bar.slice(0, 3))
  const second = structuredClone(first)
  second.id = 'second-numbered'
  second.name = '笛子'
  project.tracks = [first, second]
  first.bars[0][0].marks = [{ id: 'key-clearance', code: 'text', text: '技巧', place: 'above', dx: -27, dy: 0 }]
  first.bars[0][0].spans = [{ id: 'hairpin', kind: 'diminuendo', end: false }]
  first.bars[1][2].spans = [{ id: 'hairpin', kind: 'diminuendo', end: true }]
  await page.goto('/')
  await page.locator('input[type=file]').setInputFiles({
    name: 'key-clearance.xianpu', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(project)),
  })
  const keys = page.locator('.canvas [data-numbered-key]')
  await expect(keys).toHaveCount(1)
  const mark = page.locator('.canvas [data-mark=key-clearance] text')
  const markBox = (await mark.boundingBox())!
  const keyBox = (await keys.first().locator(':scope > text').boundingBox())!
  const chordBox = (await page.locator('.canvas svg text[text-anchor="middle"]').filter({ hasText: /^C$/ }).first().boundingBox())!
  const overlapsKey = (box: typeof keyBox) => box.x + box.width > keyBox.x + 2 && keyBox.x + keyBox.width > box.x + 2 &&
    box.y + box.height > keyBox.y + 2 && keyBox.y + keyBox.height > box.y + 2
  expect(overlapsKey(markBox)).toBe(false)
  expect(overlapsKey(chordBox)).toBe(false)
  const spacing = async () => {
    const [upper, lower] = await page.locator('.canvas [data-intro-parenthesis=start]').evaluateAll((nodes) =>
      nodes.map((node) => node.getBoundingClientRect().top))
    return lower - upper
  }
  const before = await spacing()
  const settings = page.getByRole('button', { name: '曲谱设置', exact: true })
  const close = page.getByRole('dialog').getByRole('button', { name: '关闭' })
  await settings.click()
  await page.getByLabel('总谱分谱间距').fill('55')
  await page.getByLabel('总谱分谱间距').press('Tab')
  await close.click()
  await expect.poll(spacing).toBeGreaterThan(before + 40)
  await settings.click()
  await page.getByLabel('总谱分谱间距').fill('-80')
  await page.getByLabel('总谱分谱间距').press('Tab')
  await close.click()
  await expect.poll(spacing).toBeLessThan(before - 20)
  const sidebar = page.getByRole('navigation')
  await sidebar.getByRole('button', { name: '笛子', exact: true }).click()
  await page.getByRole('button', { name: '编辑此处调号' }).click()
  await page.getByRole('button', { name: '从当前谱面隐藏' }).click()
  await expect(keys).toHaveCount(0)
  await settings.click()
  await page.getByRole('button', { name: '恢复已隐藏的调号和速度' }).click()
  await close.click()
  await expect(keys).toHaveCount(1)
  const tempo = page.locator('.canvas [data-score-label-kind=tempo][data-score-label-bar="2"]')
  await tempo.click()
  await page.getByLabel('速度 BPM').fill('110')
  await page.getByRole('button', { name: '应用', exact: true }).click()
  await expect(tempo).toContainText('110')
  await tempo.click()
  await page.getByRole('button', { name: '移除此处速度变化' }).click()
  await expect(tempo).toHaveCount(0)
  await sidebar.getByRole('button', { name: '总谱', exact: true }).click()
  await expect(page.locator('.canvas [data-numbered-key]:visible')).toHaveCount(1)
  await page.getByRole('button', { name: '导出', exact: true }).click()
  await expect(page.getByRole('dialog').locator('.print-page [data-numbered-key]:visible')).toHaveCount(1)
})

test('edits a key directly on the score with either pitch or numbered degrees preserved', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '打开弹唱示例' }).click()
  const sidebar = page.getByRole('navigation')
  await sidebar.getByRole('button', { name: '简谱', exact: true }).click()
  const renderedKey = page.getByRole('button', { name: '编辑此处调号' })
  await expect(renderedKey).toHaveText('1 = C')
  const noteText = page.locator('.canvas svg text').filter({ hasText: /^[0-7]$/ })
  const original = await noteText.allTextContents()
  const dialog = page.getByRole('dialog')
  const firstNote = page.getByRole('button', { name: '简谱位置 1', exact: true })

  await renderedKey.click()
  await expect(dialog.getByLabel('切换调号时')).toHaveValue('pitch')
  await dialog.getByRole('combobox', { name: '调号', exact: true }).selectOption('2')
  await expect(renderedKey).toHaveText('1 = D')
  await expect(firstNote).toContainText('C')
  expect(await noteText.allTextContents()).not.toEqual(original)
  await page.getByRole('button', { name: '撤销', exact: true }).click()
  await expect(renderedKey).toHaveText('1 = C')

  await renderedKey.click()
  await dialog.getByLabel('切换调号时').selectOption('numbered')
  await dialog.getByRole('combobox', { name: '调号', exact: true }).selectOption('2')
  await expect(renderedKey).toHaveText('1 = D')
  await expect(firstNote).toContainText('D')
  expect(await noteText.allTextContents()).toEqual(original)
  await sidebar.getByRole('button', { name: '五线谱', exact: true }).click()
  await renderedKey.first().click()
  await expect(dialog.getByRole('combobox', { name: '调号', exact: true })).toHaveValue('2')
  await dialog.getByRole('button', { name: '从当前谱面隐藏' }).click()
  await expect(page.locator('.canvas [data-score-label-kind=key][data-score-label-bar="0"]')).toHaveCount(0)
})

test('applies spanning marks directly to the earliest and latest selected notes', async ({ page }) => {
  const project = createProject('song')
  project.tracks = project.tracks.slice(0, 1)
  for (const [bar, pitches] of [[60, 64, 65, 67], [62, 69, 71, 72]].entries()) {
    project.tracks[0].bars[bar] = pitches.map((midi) => ({ ...blank(), draft: false, notes: [{ midi }] }))
  }
  await page.goto('/')
  await page.locator('input[type=file]').setInputFiles({
    name: 'span-selection.xianpu', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(project)),
  })
  const score = page.getByRole('region', { name: '谱面工作区' })
  const editor = page.getByRole('region', { name: '录入面板' })
  const glyph = (digit: number) => score.locator('svg text[style*="dominant-baseline: middle"]')
    .filter({ hasText: new RegExp('^' + digit + '$') }).first()
  await expect(glyph(2)).toBeVisible()
  async function clickDigit(digit: number) {
    const box = (await glyph(digit).boundingBox())!
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  }
  await clickDigit(2)
  await page.keyboard.down('Shift')
  await clickDigit(3)
  await page.keyboard.up('Shift')
  await expect(score.getByText('已选 4 个音符位置')).toBeVisible()

  await editor.getByRole('button', { name: '记号面板', exact: true }).click()
  const palette = editor.getByRole('group', { name: '跨音记号' })
  await palette.getByRole('button', { name: '渐强', exact: true }).click()
  await expect(score.locator('[data-kind=crescendo]')).toBeVisible()
  await expect(editor.getByRole('button', { name: '在这里结束' })).toHaveCount(0)
  await editor.getByRole('button', { name: '记号列表', exact: true }).click()
  await palette.getByRole('button', { name: '渐弱', exact: true }).click()
  await expect(score.locator('[data-kind=diminuendo]')).toBeVisible()
  await editor.getByRole('button', { name: '下拉选择', exact: true }).click()
  await editor.getByRole('combobox', { name: '跨音记号' }).selectOption('custom')
  await editor.getByRole('textbox', { name: '自定义文字或符号' }).fill('保持')
  await editor.getByRole('button', { name: '添加跨音记号' }).click()

  const draft = await page.evaluate(() => localStorage.getItem('xianpu.recovery.v1')!)
  const { bars } = parseProject(draft).tracks[0]
  const starts = bars[0][1].spans!
  const ends = bars[1][0].spans!
  expect(starts.map(({ kind, end }) => [kind, end])).toEqual([['crescendo', false], ['diminuendo', false], ['custom', false]])
  expect(ends.map(({ id, kind, text }) => [id, kind, text])).toEqual(starts.map(({ id, kind, text }) => [id, kind, text]))
  expect(ends.every(({ end }) => end)).toBe(true)
  expect(ends.at(-1)?.text).toBe('保持')
  await page.getByRole('button', { name: '撤销', exact: true }).click()
  const undone = parseProject(await page.evaluate(() => localStorage.getItem('xianpu.recovery.v1')!)).tracks[0].bars
  expect(undone[0][1].spans).toHaveLength(2)
  expect(undone[1][0].spans).toHaveLength(2)
})

test('writes printable marks, a pitched grace note, and a cross-system range', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '打开弹唱示例' }).click()
  await page.getByRole('navigation').getByRole('button', { name: '简谱', exact: true }).click()
  const score = page.getByRole('region', { name: '谱面工作区' })
  const editor = page.getByRole('region', { name: '录入面板' })
  await editor.getByRole('button', { name: '记号面板', exact: true }).click()
  await editor.getByRole('button', { name: '下拉选择', exact: true }).click()
  await editor.getByRole('searchbox', { name: '搜索记号' }).fill('跳音')
  await editor.getByRole('combobox', { name: '可用记号' }).selectOption('staccato')
  await editor.getByRole('button', { name: '添加记号' }).click()
  await expect(score.locator('[data-code=staccato]')).toHaveCount(1)
  await editor.getByRole('button', { name: '图标网格', exact: true }).click()
  await editor.getByRole('group', { name: '跨音记号' }).getByRole('button', { name: '渐强', exact: true }).click()
  await score.getByRole('button', { name: /^第 5 小节/ }).click()
  await editor.getByRole('button', { name: '在这里结束' }).click()
  await expect(score.locator('[data-kind=crescendo]')).toHaveCount(2)
  await score.getByRole('button', { name: /^第 1 小节/ }).click()
  await editor.getByRole('button', { name: '倚音与成组连音', exact: true }).click()
  await editor.getByRole('button', { name: '添加前倚音' }).click()
  await expect(editor.getByRole('button', { name: '移除倚音' })).toBeVisible()
  await expect(score.locator('[data-code=staccato]')).toHaveCount(1)
  await editor.getByRole('button', { name: '歌词与和弦', exact: true }).click()
  await editor.getByRole('combobox', { name: '歌词段落' }).selectOption('1')
  await editor.getByRole('textbox', { name: '歌词', exact: true }).fill('第二段')
  await expect(score.locator('.score-render')).toContainText('第二段')
  await page.getByRole('button', { name: '导出', exact: true }).click()
  const preview = page.getByRole('dialog').locator('.print-page')
  await expect(preview.locator('[data-code=staccato]')).toHaveCount(1)
  await expect(preview.locator('[data-kind=crescendo]')).toHaveCount(2)
  await expect(preview.getByText('第二段', { exact: true })).toHaveCount(1)
  await page.getByLabel('导出格式').selectOption('png')
  const region = await preview.first().evaluate((sheet) => {
    const paper = sheet.getBoundingClientRect()
    const mark = sheet.querySelector('[data-code=staccato]')!.getBoundingClientRect()
    return { x: (mark.left - paper.left) / paper.width, y: (mark.top - paper.top) / paper.height,
      width: mark.width / paper.width, height: mark.height / paper.height }
  })
  const downloaded = page.waitForEvent('download')
  await page.getByRole('button', { name: '选择保存位置' }).click()
  const image = await readFile((await (await downloaded).path())!)
  expect(image.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
  const ink = await page.evaluate(async ({ png, region }) => {
    const data = Uint8Array.from(atob(png), (character) => character.charCodeAt(0))
    const bitmap = await createImageBitmap(new Blob([data], { type: 'image/png' }))
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const context = canvas.getContext('2d')!
    context.drawImage(bitmap, 0, 0)
    const sample = context.getImageData(Math.floor(region.x * bitmap.width), Math.floor(region.y * bitmap.height),
      Math.max(1, Math.ceil(region.width * bitmap.width)), Math.max(1, Math.ceil(region.height * bitmap.height)))
    return sample.data.filter((value, index) => index % 4 === 0 && value < 120).length
  }, { png: image.toString('base64'), region })
  expect(ink).toBeGreaterThan(2)
})

test('a part page break and page headings are independent of the full score', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '打开弹唱示例' }).click()
  await page.getByRole('navigation').getByRole('button', { name: '简谱', exact: true }).click()
  await page.getByRole('button', { name: /^第 3 小节/ }).click()
  await page.getByRole('button', { name: '曲谱设置', exact: true }).click()
  const settings = page.getByRole('dialog')
  await settings.getByRole('checkbox', { name: '此小节起另起一页' }).check()
  await settings.getByRole('textbox', { name: '打印页眉' }).fill('人声校样')
  await settings.getByRole('textbox', { name: '打印页脚' }).fill('练习用')
  await settings.getByRole('button', { name: '关闭', exact: true }).click()
  await page.getByRole('button', { name: '导出', exact: true }).click()
  const preview = page.getByRole('dialog').locator('.print-page')
  await expect(preview).toHaveCount(2)
  await expect(preview.first()).toContainText('人声校样 · 1')
  await expect(preview.last()).toContainText('人声校样 · 2')
  await expect(preview.last()).toContainText('练习用')
  await page.getByLabel('导出范围').selectOption('score')
  await expect(preview.first()).not.toContainText('人声校样')
})
