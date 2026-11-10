import { expect, test } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { parseProject } from '../src/model'
import { ensembleMidi } from './midi-fixtures'

test('imports MIDI through the toolbar, renders score and parts, and saves and reopens edits', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: /简谱弹唱/ }).click()
  await page.getByRole('button', { name: '录入简谱 3' }).click()
  const input = page.locator('input[type=file]')
  const title = page.locator('.score-title')
  const importButton = page.getByRole('button', { name: '导入 MIDI', exact: true })
  const fixture = { name: '合奏练习.midi', mimeType: 'audio/midi', buffer: ensembleMidi() }

  await input.setInputFiles({ ...fixture, buffer: fixture.buffer.subarray(0, -1) })
  await expect(page.getByRole('alert')).toContainText('MIDI 导入失败')
  await expect(title).toHaveText('未命名曲谱')
  await expect(page.getByRole('dialog')).toHaveCount(0)

  const picker = page.waitForEvent('filechooser')
  await importButton.click()
  await expect(input).toHaveAttribute('accept', '.mid,.midi')
  await (await picker).setFiles(fixture)
  const confirmation = page.getByRole('dialog', { name: '保存当前工程？' })
  await expect(confirmation).toBeVisible()
  await confirmation.getByRole('button', { name: '取消' }).click()
  await expect(title).toHaveText('未命名曲谱')

  await input.setInputFiles(fixture)
  const previousSave = page.waitForEvent('download')
  await confirmation.getByRole('button', { name: '保存并继续' }).click()
  const previousFile = await previousSave
  expect(previousFile.suggestedFilename()).toBe('未命名曲谱.xianpu')
  const previous = parseProject(await readFile((await previousFile.path())!, 'utf8'))
  expect(previous.tracks[0].bars[0][0].notes).toEqual([{ midi: 64 }])
  await expect(title).toHaveText('合奏练习')
  await expect(page.getByRole('status')).toHaveText('已导入 MIDI · 2 个乐器 · 3 小节 · 8 个音符。')
  await page.getByRole('button', { name: 'MIDI 导入详情' }).click()
  const report = page.getByRole('dialog', { name: 'MIDI 导入详情' })
  await expect(report.getByRole('listitem')).toHaveCount(3)
  await expect(report).toContainText('短音至少保留一格')
  await report.getByRole('button', { name: '关闭' }).click()

  const score = page.locator('.score-render')
  await expect(score).toContainText('三角钢琴')
  await expect(score).toContainText('尼龙弦吉他')
  const sustained = await page.evaluate(async () => {
    const { parseProject } = await import('/src/model.ts') as typeof import('../src/model')
    const { buildScore, scoreSettings } = await import('/src/score.ts') as typeof import('../src/score')
    const { buildPlaybackMidi } = await import('/src/playback.ts') as typeof import('../src/playback')
    const project = parseProject(localStorage.getItem('xianpu.recovery.v1')!)
    const part = project.tracks[0].id
    const { score } = buildScore(project, part, scoreSettings(), 'zh')
    const tied = score.tracks[0].staves[0].bars[1].voices[0].beats[0].notes[0]
    const attacks = buildPlaybackMidi(project, part).events.flatMap((event) =>
      'noteKey' in event && event.noteKey === 60 && 'noteVelocity' in event && event.noteVelocity > 0 ? [event.tick] : [])
    return { tieOrigin: tied.tieOrigin?.realValue, attacks }
  })
  expect(sustained).toEqual({ tieOrigin: 60, attacks: [0, 4800] })
  const parts = page.getByRole('navigation')
  await parts.getByRole('button', { name: /^尼龙弦吉他/ }).click()
  await expect(score.locator('svg').first()).toBeVisible()
  await expect(score).not.toContainText('三角钢琴')
  await parts.getByRole('button', { name: /^三角钢琴/ }).click()
  await expect(score.locator('svg').first()).toBeVisible()
  await expect(score).not.toContainText('尼龙弦吉他')
  await page.getByLabel('谱式').selectOption('numbered')
  await page.getByRole('button', { name: '录入简谱 5' }).click()
  await page.getByRole('button', { name: '▶ 试听' }).click()
  const stop = page.getByRole('button', { name: '■ 停止' })
  await expect(stop).toHaveAttribute('aria-busy', 'false', { timeout: 15000 })
  await stop.click()

  const savedFile = page.waitForEvent('download')
  await page.getByRole('button', { name: '另存为' }).click()
  const download = await savedFile
  expect(download.suggestedFilename()).toBe('合奏练习.xianpu')
  const bytes = await readFile((await download.path())!)
  const saved = parseProject(bytes.toString('utf8'))
  expect(saved.tracks[0].layout.mode).toBe('numbered')
  expect(saved.tracks[0].bars[0][0].notes).not.toEqual([{ midi: 60 }, { midi: 64 }, { midi: 67 }])
  expect(saved.tracks[1].mode).toBe('tab')
  await expect(page.getByRole('button', { name: 'MIDI 导入详情' })).toBeVisible()

  const reopen = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: '打开', exact: true }).click()
  await expect(input).toHaveAttribute('accept', '.xianpu')
  await (await reopen).setFiles({ name: '合奏练习.xianpu', mimeType: 'application/json', buffer: bytes })
  await expect(parts.getByRole('button', { name: '总谱', exact: true })).toHaveAttribute('aria-current', 'page')
  await expect(page.getByText('✓ 已保存')).toBeVisible()
  await expect(score).toContainText('尼龙弦吉他')
})

test('an earlier file read cannot replace a newer MIDI import', async ({ page }) => {
  await page.addInitScript(() => {
    const read = File.prototype.arrayBuffer
    File.prototype.arrayBuffer = async function () {
      if (this.name === '较早.mid') {
        await new Promise<void>((resolve) => Object.assign(window, { finishEarlierRead: resolve }))
        const bytes = await read.call(this)
        requestAnimationFrame(() => Object.assign(window, { earlierReadReturned: true }))
        return bytes
      }
      return read.call(this)
    }
  })
  await page.goto('/')
  const input = page.locator('input[type=file]')
  const fixture = { mimeType: 'audio/midi', buffer: ensembleMidi() }
  await input.setInputFiles({ name: '较早.mid', ...fixture })
  await page.waitForFunction(() => 'finishEarlierRead' in window)
  await input.setInputFiles({ name: '较新.mid', ...fixture })
  await expect(page.locator('.score-title')).toHaveText('较新')
  await page.evaluate(() => (window as Window & { finishEarlierRead: () => void }).finishEarlierRead())
  await page.waitForFunction(() => 'earlierReadReturned' in window)
  await expect(page.getByRole('dialog', { name: '保存当前工程？' })).toHaveCount(0)
  await expect(page.locator('.score-title')).toHaveText('较新')
})
