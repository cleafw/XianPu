import { invoke, isTauri } from '@tauri-apps/api/core'
import { open, save } from '@tauri-apps/plugin-dialog'

import { languageOf, type Language, type Translate } from './i18n'

const projectFilters = (t: Translate) => [{ name: t('叶子弦谱工程'), extensions: ['xianpu'] }]
export const desktop = isTauri()
export const recoveryKey = 'xianpu.recovery.v1'
export const readFile = (path: string) => invoke<string>('read_project', { path })
export const writeFile = (path: string, data: string) => invoke('write_project', { path, data })
export const systemLanguage = (): Promise<Language> => desktop ? invoke('system_language') : Promise.resolve(languageOf(navigator.language))
export const pickProject = (t: Translate) => open({ title: t('打开工程'), filters: projectFilters(t), multiple: false })
export const savePath = (name: string, t: Translate) => save({ title: t('保存工程'), filters: projectFilters(t), defaultPath: fileName(name, t) + '.xianpu' })
export const pickPdf = (name: string, t: Translate) => save({ title: t('导出 PDF'), filters: [{ name: t('PDF 乐谱'), extensions: ['pdf'] }], defaultPath: fileName(name, t) + '.pdf' })
export const pickDirectory = (t: Translate) => open({ title: t('选择分谱文件夹'), directory: true, multiple: false })
export const exportPdf = (path: string, replace: boolean) => invoke('export_pdf', { path, replace })
export const fileName = (name: string, t: Translate) => name.replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ').trim().slice(0, 80).replace(/[. ]+$/, '') || t('未命名曲谱')
export function downloadProject(name: string, data: string, t: Translate) {
  const url = URL.createObjectURL(new Blob([data], { type: 'application/json' }))
  const link = document.createElement('a')
  link.href = url
  link.download = fileName(name, t) + '.xianpu'
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
