import { expect, test } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { parseProject } from '../src/model'

test('enters a numbered chord without advancing and keeps the chord in print and on disk', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: /简谱弹唱/ }).click()
  await page.getByRole('navigation').getByRole('button', { name: '简谱', exact: true }).click()
  await page.getByRole('button', { name: '同拍叠音' }).click()
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
