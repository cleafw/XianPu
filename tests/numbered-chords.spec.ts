import { expect, test } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { blank, createProject, parseProject } from '../src/model'

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

test('centers two- and three-note stacks on the single-note baseline in the score and export', async ({ page }) => {
  const project = createProject('song')
  project.tracks = project.tracks.slice(0, 1)
  project.tracks[0].bars[0] = [[62], [60, 64], [65, 67, 69], [71]].map((pitches) => ({
    ...blank(), draft: false, notes: pitches.map((midi) => ({ midi })),
  }))
  await page.goto('/')
  await page.locator('input[type=file]').setInputFiles({
    name: 'centered-stacks.xianpu', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(project)),
  })
  async function check(scope: string) {
    const numbers = page.locator(scope + ' svg text').filter({ hasText: /^[1-7]$/ })
    await expect(numbers.filter({ hasText: /^7$/ })).toBeVisible()
    const heights = await numbers.evaluateAll((items) =>
      Object.fromEntries(items.map((item) => [item.textContent, Number(item.getAttribute('y'))])))
    expect((heights[1] + heights[3]) / 2).toBeCloseTo(heights[2], 1)
    expect(heights[5]).toBeCloseTo(heights[2], 1)
    expect((heights[4] + heights[6]) / 2).toBeCloseTo(heights[2], 1)
  }
  await check('.canvas .score-render')
  await page.getByRole('button', { name: '导出', exact: true }).click()
  await check('.preview-scroll .print-page')
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
