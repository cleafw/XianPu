import { expect, test } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { blank, createProject, parseProject } from '../src/model'

test('uses the minus key to turn a selected rest or the following note into an extension dash', async ({ page }) => {
  const project = createProject('song')
  project.tracks = project.tracks.slice(0, 1)
  project.tracks[0].bars[0] = [60, 0, 64, 65].map((midi) => ({ ...blank(), draft: false, notes: midi ? [{ midi }] : [] }))
  await page.goto('/')
  await page.locator('input[type=file]').setInputFiles({
    name: 'dash.xianpu', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(project)),
  })
  await page.getByRole('button', { name: '简谱位置 2', exact: true }).click()
  await page.keyboard.press('-')
  await expect(page.getByText('第 1 小节 · 位置 1', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '简谱位置 2', exact: true }).click()
  await page.keyboard.press('-')
  await expect(page.getByRole('button', { name: '第 1 小节，拍数完整' })).toBeVisible()
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: '保存 •' }).click()
  const saved = parseProject(await readFile((await (await download).path())!, 'utf8'))
  expect(saved.tracks[0].bars[0].map(({ duration, notes }) => [duration, notes[0].midi])).toEqual([[2, 60], [2, 64]])
})

test('edits the time value of a clicked numbered rest and keeps the lines in export', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: /简谱弹唱/ }).click()
  await page.getByRole('navigation').getByRole('button', { name: '简谱', exact: true }).click()
  const score = page.locator('.canvas .score-render')
  const zero = score.locator('svg text').filter({ hasText: /^0$/ }).first()
  const underlines = () => zero.evaluate((node) => {
    const x = Number(node.getAttribute('x'))
    const y = Number(node.getAttribute('y'))
    return [...(node as SVGTextElement).ownerSVGElement!.querySelectorAll('rect')].filter((rect) =>
      Math.abs(rect.x.baseVal.value - x) < 0.1 && rect.y.baseVal.value > y && rect.width.baseVal.value > rect.height.baseVal.value).length
  })
  const point = await zero.evaluate((node) => {
    const glyph = node as SVGTextElement
    const { x, width } = glyph.getBoundingClientRect()
    const anchor = new DOMPoint(0, Number(glyph.getAttribute('y'))).matrixTransform(glyph.getScreenCTM()!)
    return { x: x + width / 2, y: anchor.y }
  })
  await page.mouse.click(point.x, point.y)
  const shorten = page.getByRole('button', { name: '加减时线', exact: true })
  await shorten.click()
  await expect.poll(underlines).toBe(1)
  await shorten.click()
  await expect.poll(underlines).toBe(2)
  const removeUnderline = page.getByRole('button', { name: '去减时线', exact: true })
  await removeUnderline.click()
  await removeUnderline.click()
  await expect.poll(underlines).toBe(0)
  await page.getByRole('button', { name: '加增时线', exact: true }).click()
  await page.getByRole('button', { name: '简谱位置 2', exact: true }).click()
  await page.keyboard.press('1')
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: '保存 •' }).click()
  const project = parseProject(await readFile((await (await download).path())!, 'utf8'))
  expect(project.tracks[0].bars[0][0]).toMatchObject({ notes: [], duration: 2, draft: false })
  const firstNote = await page.evaluate(async (project) => {
    const { buildPlaybackMidi } = await import('/src/playback.ts') as typeof import('../src/playback')
    return buildPlaybackMidi(project, project.tracks[0].id).events.find((event) =>
      'noteVelocity' in event && event.noteVelocity > 0)?.tick
  }, project)
  expect(firstNote).toBe(1920)

  await page.getByRole('button', { name: '导出', exact: true }).click()
  const printZero = page.getByRole('dialog').locator('.print-page svg text').filter({ hasText: /^0$/ }).first()
  const hasDash = await printZero.evaluate((node) => {
    const x = Number(node.getAttribute('x'))
    const y = Number(node.getAttribute('y'))
    const svg = (node as SVGTextElement).ownerSVGElement!
    const next = [...svg.querySelectorAll('text')].find((text) => text.textContent === '1' && Number(text.getAttribute('x')) > x)!
    return [...svg.querySelectorAll('rect')].some((rect) => rect.x.baseVal.value > x &&
      rect.x.baseVal.value < Number(next.getAttribute('x')) && Math.abs(rect.y.baseVal.value - y) < 4 &&
      rect.width.baseVal.value > rect.height.baseVal.value)
  })
  expect(hasDash).toBe(true)
})

test('enters a numbered chord without advancing and keeps the chord in print and on disk', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: /简谱弹唱/ }).click()
  await page.getByRole('navigation').getByRole('button', { name: '简谱', exact: true }).click()
  await page.getByRole('button', { name: '简谱叠音录入' }).click()
  await expect(page.getByRole('button', { name: '同拍叠音' })).toHaveAttribute('aria-pressed', 'true')
  await page.getByRole('button', { name: '录入简谱 5' }).click()
  await page.getByRole('button', { name: '录入简谱 1' }).click()
  await page.getByRole('combobox', { name: '八度', exact: true }).selectOption('1')
  await page.getByRole('button', { name: '录入简谱 3' }).click()
  await expect(page.getByText('第 1 小节 · 位置 1', { exact: true })).toBeVisible()

  async function verifyStack(scope: string) {
    const groups = page.locator(scope + ' svg g:has(> text)')
    const read = () => groups.evaluateAll((items) => items.map((group) => [...group.querySelectorAll(':scope > text')]
      .filter((item) => /^[135]$/.test(item.textContent ?? ''))
      .map((item) => {
        const box = item.getBoundingClientRect()
        return { degree: item.textContent, x: box.left + box.width / 2, y: box.top + box.height / 2 }
      }))
      .find((notes) => notes.map(({ degree }) => degree).join('') === '153') ?? [])
    await expect.poll(async () => (await read()).length).toBe(3)
    const notes = await read()
    expect(notes.map(({ degree }) => degree)).toEqual(['1', '5', '3'])
    expect(Math.max(...notes.map(({ x }) => x)) - Math.min(...notes.map(({ x }) => x))).toBeLessThan(1)
    expect(notes[2].y).toBeLessThan(notes[1].y)
    expect(notes[1].y).toBeLessThan(notes[0].y)
    return notes
  }
  const notes = await verifyStack('.canvas')
  await page.mouse.click(notes[2].x, notes[2].y)
  await expect(page.getByText('所选音：E5 · 八度 1')).toBeVisible()
  await page.keyboard.press('Shift+ArrowDown')
  await expect(page.getByText('所选音：E4 · 八度 0')).toBeVisible()
  await page.keyboard.press('Shift+ArrowUp')
  await verifyStack('.canvas')
  await page.getByRole('button', { name: '下一拍' }).click()
  await expect(page.getByText('第 1 小节 · 位置 2', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '导出', exact: true }).click()
  await verifyStack('.preview-scroll')
  await page.getByRole('dialog').getByRole('button', { name: '关闭' }).click()
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: '保存 •' }).click()
  const score = parseProject(await readFile((await (await download).path())!, 'utf8'))
  expect(score.tracks[0].bars[0][0].notes.map(({ midi }) => midi)).toEqual([67, 60, 76])
})

test('aligns the lowest number and duration underlines of stacked and single notes', async ({ page }) => {
  const project = createProject('song')
  project.tracks = project.tracks.slice(0, 1)
  project.tracks[0].bars[0] = [[62], [60, 64], [65, 67, 69], [71]].map((pitches) => ({
    ...blank(8), draft: false, notes: pitches.map((midi) => ({ midi })),
  }))
  await page.goto('/')
  await page.locator('input[type=file]').setInputFiles({
    name: 'aligned-stacks.xianpu', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(project)),
  })
  async function check(scope: string) {
    const numbers = page.locator(scope + ' svg text').filter({ hasText: /^[1-7]$/ })
    await expect(numbers.filter({ hasText: /^7$/ })).toBeVisible()
    const heights = await numbers.evaluateAll((items) =>
      Object.fromEntries(items.map((item) => [item.textContent, Number(item.getAttribute('y'))])))
    expect(heights[1]).toBeCloseTo(heights[2], 1)
    expect(heights[4]).toBeCloseTo(heights[2], 1)
    expect(heights[3]).toBeLessThan(heights[1])
    expect(heights[6]).toBeLessThan(heights[5])
    expect(heights[5]).toBeLessThan(heights[4])
    const underlines = await numbers.first().evaluate((number) => {
      const glyph = number as SVGTextElement
      const y = Number(glyph.getAttribute('y'))
      const svg = glyph.ownerSVGElement!
      const anchors = [...svg.querySelectorAll('text')].filter((item) => /^[1247]$/.test(item.textContent ?? '') &&
        Math.abs(Number(item.getAttribute('y')) - y) < 1)
      return anchors.map((item) => {
        const x = Number(item.getAttribute('x'))
        const segments = [...svg.querySelectorAll('path')].flatMap((path) => {
          const line = path.getAttribute('d')?.trim().match(/^M\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*L\s*([\d.]+)\s*[, ]\s*([\d.]+)/i)
          if (!line) return []
          const [, left, top, right, end] = line.map(Number)
          return left - 1 <= x && x < right && top === end && top > y && top < y + 35 ? [top] : []
        })
        return Math.min(...segments)
      })
    })
    expect(underlines).toHaveLength(4)
    expect(underlines.every(Number.isFinite)).toBe(true)
    expect(Math.max(...underlines) - Math.min(...underlines)).toBeLessThan(0.2)
  }
  await check('.canvas .score-render')
  await page.getByRole('button', { name: '导出', exact: true }).click()
  await check('.preview-scroll .print-page')
})

test('drags notes, applies batch rhythm and pitch, and copies selected notes in score order', async ({ page }) => {
  const project = createProject('song')
  const staff = project.tracks[0]
  project.tracks = [staff]
  staff.bars[0] = [[60], [62, 67], [64], [65]].map((notes) => ({
    ...blank(), draft: false, notes: notes.map((midi) => ({ midi })),
  }))
  await page.goto('/')
  await page.locator('input[type=file]').setInputFiles({
    name: 'note-selection.xianpu', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(project)),
  })
  const score = page.locator('.canvas .score-render')
  const glyph = (value: number) => score.locator('svg text:not([fill*="c80000"]):not([fill*="200,0,0"]):not([fill*="200, 0, 0"])')
    .filter({ hasText: new RegExp('^' + value + '$') }).first()
  const center = async (value: number) => glyph(value).evaluate((node) => {
    const box = node.getBoundingClientRect()
    return [box.x + box.width / 2, box.y + box.height / 2] as const
  })
  await expect(glyph(3)).toBeVisible()
  const entry = page.getByRole('region', { name: '小节与录入位置' })
  await entry.getByRole('button', { name: '简谱位置 1', exact: true }).click()
  const single = (await page.locator('.score-cursor').boundingBox())!
  const start = await center(1)
  const end = await center(3)
  await page.mouse.move(...start)
  await page.mouse.down()
  await page.mouse.move(...end, { steps: 10 })
  await page.mouse.up()
  await expect(page.getByText('已选 3 个音符位置', { exact: true })).toBeVisible()
  const frames = score.locator('..').locator('.score-note-highlight')
  await expect(frames).toHaveCount(1)
  const continuous = (await frames.boundingBox())!
  expect(continuous.x).toBeCloseTo(single.x, 0)
  expect(continuous.y + continuous.height).toBeCloseTo(single.y + single.height, 0)
  expect(continuous.x + continuous.width).toBeGreaterThan(end[0])
  const recovered = () => page.evaluate(() => JSON.parse(localStorage.getItem('xianpu.recovery.v1')!))
  await page.getByRole('button', { name: '加减时线', exact: true }).click()
  expect((await recovered()).tracks[0].bars[0].slice(0, 4).map(({ duration }) => duration)).toEqual([8, 8, 8, 4])
  await page.keyboard.press('Shift+ArrowUp')
  expect((await recovered()).tracks[0].bars[0].slice(0, 4).map(({ notes }) => notes.map(({ midi }) => midi)))
    .toEqual([[72], [74, 79], [76], [65]])
  await page.getByRole('button', { name: '去减时线', exact: true }).click()
  await page.getByRole('button', { name: '加增时线', exact: true }).click()
  expect((await recovered()).tracks[0].bars[0].slice(0, 4).map(({ duration }) => duration)).toEqual([2, 2, 2, 4])
  await page.getByRole('button', { name: '去增时线', exact: true }).click()
  await page.keyboard.press('Escape')
  await entry.getByRole('button', { name: '简谱位置 4', exact: true }).click()
  await entry.getByRole('button', { name: '简谱位置 1', exact: true }).click({ modifiers: ['Control'] })
  await expect(page.getByText('已选 2 个音符位置', { exact: true })).toBeVisible()
  await expect(frames).toHaveCount(2)
  for (const frame of await frames.all()) expect((await frame.boundingBox())!.width).toBeCloseTo(single.width, 0)
  await page.keyboard.press('Control+c')
  await entry.getByRole('button', { name: /^第 2 小节，/ }).click()
  await entry.getByRole('button', { name: '简谱位置 2', exact: true }).click()
  await page.keyboard.press('Control+v')
  expect((await recovered()).tracks[0].bars[1].slice(1, 3).map(({ notes }) => notes[0].midi)).toEqual([72, 65])
  await page.keyboard.press('Control+z')
  expect((await recovered()).tracks[0].bars[1]).toEqual([])
})

test('keeps additional voices visible and individually editable when a staff switches to numbered notation', async ({ page }) => {
  const project = createProject('song')
  const track = project.tracks[0]
  project.tracks = [track]
  track.mode = 'staff-numbered'
  track.bars[0] = [{ ...blank(), draft: false, notes: [{ midi: 60 }] }]
  track.voices = [{ bars: [[{ ...blank(), draft: false, notes: [{ midi: 69 }] }], [], [], []] }]
  await page.goto('/')
  await page.locator('input[type=file]').setInputFiles({
    name: 'numbered-voices.xianpu', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(project)),
  })
  const six = page.locator('.canvas svg text').filter({ hasText: /^6$/ }).first()
  await expect(six).toBeVisible()
  await six.click()
  await expect(page.getByLabel('编辑声部')).toHaveValue('1')
  await page.keyboard.press('Shift+ArrowUp')
  await expect(page.getByText('所选音：A5 · 八度 1')).toBeVisible()
  const recovered = await page.evaluate(() => JSON.parse(localStorage.getItem('xianpu.recovery.v1')!))
  expect(recovered.tracks[0].bars[0][0].notes[0].midi).toBe(60)
  expect(recovered.tracks[0].voices[0].bars[0][0].notes[0].midi).toBe(81)
  await page.getByRole('button', { name: '导出', exact: true }).click()
  await expect(page.locator('.print-page svg text').filter({ hasText: /^6$/ }).first()).toBeVisible()
})

test('uses the same measure boundaries across rows in numbered parts and the full score', async ({ page }) => {
  await page.goto('/')
  const grids = await page.evaluate(async () => {
    const { createProject } = await import('/src/model.ts') as typeof import('../src/model')
    const { drawScore } = await import('/src/score.ts') as typeof import('../src/score')
    const project = createProject('demo')
    async function grid(part: string | null, print: boolean) {
      const host = document.createElement('div')
      host.style.width = '700px'
      document.body.append(host)
      return await new Promise<number[][]>((resolve, reject) => {
        const api = drawScore(host, project, part, 1, 'zh', () => {
          const rows = api.boundsLookup!.staffSystems.map(({ bars }) =>
            [...bars.map(({ realBounds }) => realBounds.x), bars.at(-1)!.realBounds.x + bars.at(-1)!.realBounds.w])
          setTimeout(() => { api.destroy(); host.remove(); resolve(rows) })
        }, reject, print)
      })
    }
    const full = [await grid(project.tracks[0].id, false), await grid(null, false), await grid(project.tracks[0].id, true)]
    project.measures.pop()
    for (const track of project.tracks) track.bars.pop()
    return [...full, await grid(project.tracks[0].id, true)]
  })
  for (const [first, second] of grids) {
    expect(first).toHaveLength(5)
    expect(second.length).toBeGreaterThanOrEqual(4)
    for (const [index, x] of second.entries()) expect(Math.abs(x - first[index])).toBeLessThan(1)
  }
})
