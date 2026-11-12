import { invoke, isTauri } from '@tauri-apps/api/core'
import { open, save } from '@tauri-apps/plugin-dialog'

import { languageOf, type Language, type Translate } from './i18n'

const projectFilters = (t: Translate) => [{ name: t('叶子弦谱工程'), extensions: ['xianpu'] }]
export const desktop = isTauri()
export const maxProjectBytes = 16 * 1024 * 1024
export const recoveryKey = 'xianpu.recovery.v1'
export const readFile = (path: string) => invoke<string>('read_project', { path })
export const readMidi = async (path: string) => new Uint8Array(await invoke<ArrayBuffer>('read_midi', { path }))
export const writeFile = (path: string, data: string) => invoke('write_project', { path, data })
export const systemLanguage = (): Promise<Language> => desktop ? invoke('system_language') : Promise.resolve(languageOf(navigator.language))
export const openCreatorPage = () => invoke('open_creator_page')
export const pickProject = (t: Translate) => open({ title: t('打开工程'), filters: projectFilters(t), multiple: false })
export const pickMidi = (t: Translate) => open({ title: t('导入 MIDI'), filters: [{ name: t('MIDI 文件'), extensions: ['mid', 'midi'] }], multiple: false })
export const savePath = (name: string, t: Translate) => save({ title: t('保存工程'), filters: projectFilters(t), defaultPath: fileName(name, t) + '.xianpu' })
export const pickPdf = (name: string, t: Translate) => save({ title: t('导出 PDF'), filters: [{ name: t('PDF 乐谱'), extensions: ['pdf'] }], defaultPath: fileName(name, t) + '.pdf' })
export const pickPng = (name: string, t: Translate) => save({ title: t('导出 PNG 图片'), filters: [{ name: t('PNG 图片'), extensions: ['png'] }], defaultPath: fileName(name, t) + '.png' })
export const pickDirectory = (t: Translate, images = false) => open({ title: t(images ? '选择图片文件夹' : '选择分谱文件夹'), directory: true, multiple: false })
export const exportPdf = (path: string, replace: boolean, width: number, height: number) =>
  invoke('export_pdf', { path, replace, width, height })
export async function exportPng(path: string, replace: boolean, png: Blob) {
  const data = Array.from(new Uint8Array(await png.arrayBuffer()))
  await invoke('write_png', { path, replace, data })
}
export const fileName = (name: string, t: Translate) => name.replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ').trim().slice(0, 80).replace(/[. ]+$/, '') || t('未命名曲谱')
export function downloadProject(name: string, data: string, t: Translate) {
  downloadBlob(fileName(name, t) + '.xianpu', new Blob([data], { type: 'application/json' }))
}
export function downloadBlob(name: string, data: Blob) {
  const url = URL.createObjectURL(data)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
