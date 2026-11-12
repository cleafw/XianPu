import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'

test('home reopens saved projects and forgets missing files', async ({ page }) => {
  const savedPath = 'C:\\Scores\\saved.xianpu'
  const openedPath = 'C:\\Scores\\opened.xianpu'
  const demo = readFileSync('examples/沿着晚风.xianpu', 'utf8')
  const files = new Map([[openedPath, demo]])
  let pickerCount = 0

  await page.exposeFunction('invokeDesktop', async (command: string, args: { path: string; paths: string[]; data: string }) => {
    switch (command) {
      case 'system_language': return 'zh'
      case 'plugin:event|listen': return 1
      case 'plugin:event|unlisten': return
      case 'plugin:dialog|save': return savedPath
      case 'plugin:dialog|open': pickerCount++; return openedPath
      case 'write_project': files.set(args.path, args.data); return
      case 'existing_project_paths': return args.paths.filter((path) => files.has(path))
      case 'read_project': {
        const data = files.get(args.path)
        if (data === undefined) throw new Error('Missing file')
        return data
      }
      default: throw new Error('Unexpected desktop command: ' + command)
    }
  })
  await page.addInitScript(() => {
    Object.assign(window, {
      isTauri: true,
      __TAURI_INTERNALS__: {
        metadata: { currentWindow: { label: 'main' } },
        transformCallback: () => 1,
        invoke: (window as unknown as { invokeDesktop: unknown }).invokeDesktop,
      },
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
    })
  })

  await page.goto('/')
  const recent = page.getByRole('region', { name: '最近工程' })
  const rows = recent.getByRole('button')
  await expect(rows).toHaveCount(0)
  await page.getByRole('button', { name: '打开弹唱示例' }).click()
  await page.getByRole('button', { name: /^保存/ }).click()
  await expect(page.getByRole('status')).toContainText('工程已保存')
  await page.getByRole('button', { name: '新建', exact: true }).click()
  await expect(rows).toHaveCount(1)
  await expect(rows.first()).toHaveAttribute('title', savedPath)

  await page.getByRole('button', { name: '打开', exact: true }).click()
  await expect(page.locator('.workspace')).toBeVisible()
  await page.getByRole('button', { name: '新建', exact: true }).click()
  await expect(rows).toHaveCount(2)
  await expect(rows.first()).toHaveAttribute('title', openedPath)

  files.delete(openedPath)
  await page.reload()
  await expect(rows).toHaveCount(1)
  await expect(rows.first()).toHaveAttribute('title', savedPath)
  await rows.first().click()
  await expect(page.locator('.workspace')).toBeVisible()
  expect(pickerCount).toBe(1)

  await page.getByRole('button', { name: '新建', exact: true }).click()
  await expect(rows).toHaveCount(1)
  files.delete(savedPath)
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(recent.getByText('打开或保存工程后会显示在这里。')).toBeVisible()
  await expect.poll(() => page.evaluate(() => localStorage.getItem('xianpu.recent-projects.v1'))).toBe('[]')
})
