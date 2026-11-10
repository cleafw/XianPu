import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { chromium, expect } from '@playwright/test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'

const directory = resolve(process.argv[2] || 'artifacts/desktop-qa')
await mkdir(directory, { recursive: true })
const projectPath = join(directory, 'Windows 弹唱测试.xianpu')
const pdfPath = join(directory, 'Windows 总谱.pdf')
const pagedPdfPath = join(directory, 'Windows 分页总谱.pdf')
const lockedPdfPath = join(directory, 'Windows 占用测试.pdf')
let selectedPdf = pdfPath
const browser = await chromium.connectOverCDP(process.env.XIANPU_QA_CDP ?? 'http://127.0.0.1:9327', { timeout: 15000 })
const [page] = browser.contexts()[0].pages()
try {
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  const systemLanguage = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('system_language'))
  assert.ok(systemLanguage === 'zh' || systemLanguage === 'en')
  await expect(page).toHaveTitle(systemLanguage === 'zh' ? '叶子弦谱' : 'Yezi XianPu')
  const language = page.locator('.language-select')
  await expect(language).toHaveValue('system')
  await language.selectOption('en')
  await expect(page).toHaveTitle('Yezi XianPu')
  await expect(page.getByRole('button', { name: 'Open demo score' })).toBeVisible()
  await language.selectOption('zh')
  await expect(page).toHaveTitle('叶子弦谱')
  await page.getByRole('button', { name: '打开弹唱示例' }).click()
  await expect(page.locator('.canvas .score-render')).toContainText('五线谱乐器')
  await page.getByRole('button', { name: '▶ 试听' }).click()
  await expect(page.getByRole('button', { name: '■ 停止' })).toBeVisible()
  await page.getByRole('button', { name: '■ 停止' }).click()
  await expect(page.getByRole('button', { name: '▶ 试听' })).toBeVisible()

  // Only replace native dialog choices. Project I/O and PDF still use the app's actual Rust commands.
  await page.route((url) => url.hostname === 'ipc.localhost' && decodeURIComponent(url.pathname).startsWith('/plugin:dialog|'), async (route) => {
    const request = route.request()
    const headers = {
      'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*',
      'Access-Control-Expose-Headers': 'Tauri-Response', 'Tauri-Response': 'ok',
    }
    if (request.method() === 'OPTIONS') { await route.fulfill({ status: 204, headers }); return }
    const { options } = request.postDataJSON()
    const command = decodeURIComponent(new URL(request.url()).pathname)
    const value = command.endsWith('|save')
      ? options.defaultPath.endsWith('.pdf') ? selectedPdf : projectPath
      : options.directory ? directory : projectPath
    await route.fulfill({ status: 200, headers, json: value })
  })

  await page.getByRole('button', { name: '保存 •' }).click()
  await expect(page.getByRole('status')).toContainText('工程已保存')
  const contents = JSON.parse(await readFile(projectPath, 'utf8'))
  assert.equal(contents.version, 1)
  assert.equal(contents.measures.length, 8)
  await page.getByRole('button', { name: '打开', exact: true }).click()
  await expect(page.getByText('✓ 已保存')).toBeVisible()
  await page.getByRole('button', { name: '导出 PDF' }).click()
  await expect(page.getByRole('dialog').locator('.print-page')).toHaveCount(1)
  await page.getByRole('button', { name: '选择保存位置' }).click()
  await expect(page.getByRole('status')).toContainText('已导出 1 份 PDF', { timeout: 20000 })
  assert.equal((await readFile(pdfPath)).subarray(0, 5).toString(), '%PDF-')
  await page.getByRole('button', { name: '导出 PDF' }).click()
  await page.getByLabel('导出范围').selectOption('parts')
  await page.getByRole('button', { name: '选择保存位置' }).click()
  await expect(page.getByRole('status')).toContainText('已导出 3 份 PDF', { timeout: 30000 })
  const partPath = join(directory, '沿着晚风 - 02 吉他.pdf')
  assert.equal((await readFile(partPath)).subarray(0, 5).toString(), '%PDF-')

  await page.getByRole('button', { name: '导出 PDF' }).click()
  await page.getByLabel('导出范围').selectOption('parts')
  await page.getByRole('button', { name: '选择保存位置' }).click()
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('已完成 0 份', { timeout: 20000 })
  await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click()
  selectedPdf = pagedPdfPath
  await page.getByLabel('每页谱行').selectOption('1')
  await page.getByRole('button', { name: '导出 PDF' }).click()
  await expect(page.getByRole('dialog').locator('.print-page')).toHaveCount(2)
  await page.getByRole('button', { name: '选择保存位置' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 20000 })
  assert.equal((await readFile(pagedPdfPath)).subarray(0, 5).toString(), '%PDF-')

  selectedPdf = lockedPdfPath
  await writeFile(lockedPdfPath, '原文件')
  const locker = spawn('powershell.exe', ['-NoProfile', '-Command',
    '$f = [IO.File]::Open($env:XIANPU_LOCK_TEST, "Open", "Read", "Read"); try { [Console]::WriteLine("locked"); [Console]::ReadLine() } finally { $f.Dispose() }'],
    { env: { ...process.env, XIANPU_LOCK_TEST: lockedPdfPath }, windowsHide: true })
  try {
    await Promise.race([once(locker.stdout, 'data'), once(locker, 'exit').then(() => { throw new Error('未能锁定测试文件') })])
    await page.getByRole('button', { name: '导出 PDF' }).click()
    await page.getByRole('button', { name: '选择保存位置' }).click()
    await expect(page.getByRole('dialog').getByRole('alert')).toContainText('已完成 0 份', { timeout: 20000 })
    assert.equal(await readFile(lockedPdfPath, 'utf8'), '原文件')
    await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click()
  } finally {
    locker.stdin.end()
  }

  await writeFile(projectPath, '{"version":99}')
  await page.getByRole('button', { name: '打开', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('打开失败')
  await expect(page.locator('.canvas .score-render')).toContainText('五线谱乐器')
  assert.deepEqual(errors, [])
  await page.getByRole('button', { name: '关闭提示' }).click()
  await page.screenshot({ path: join(directory, '工作台.png') })
  console.log('Windows 烟测通过：系统语言、手动切换、渲染、试听、保存重开、A4 导出、批量分谱、冲突保护和损坏工程提示')
} finally {
  if (!page.isClosed()) {
    await page.evaluate(() => { void window.__TAURI_INTERNALS__.invoke('plugin:window|destroy', { label: 'main' }) }).catch(() => {})
  }
  await browser.close()
}
