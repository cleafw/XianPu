import { listen } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'

const keyboardHandlers = new Set<(event: KeyboardEvent) => void>()
const windows = new Set<Window>()

export function listenWorkspaceKeys(handler: (event: KeyboardEvent) => void) {
  keyboardHandlers.add(handler)
  window.addEventListener('keydown', handler)
  for (const popup of windows) popup.addEventListener('keydown', handler)
  return () => {
    keyboardHandlers.delete(handler)
    window.removeEventListener('keydown', handler)
    for (const popup of windows) popup.removeEventListener('keydown', handler)
  }
}

export function eventElement(target: EventTarget | null): HTMLElement | null {
  return (target as Node | null)?.nodeType === 1 ? target as HTMLElement : null
}

export function openPanelWindow(title: string, width: number, onClosed: () => void) {
  const id = 'xianpu-panel-' + crypto.randomUUID()
  const opened = window.open('about:blank#' + id, id, [
    'popup=yes', 'width=' + width, 'height=120',
    'left=' + (window.screenX + Math.max(24, window.outerWidth - width - 32)),
    'top=' + (window.screenY + 85),
  ].join(','))
  if (!opened || opened.closed) return null
  const popup = opened

  let disposed = false
  let unlisten: (() => void) | undefined
  let unregister: (() => void) | undefined
  const watchdog = window.setInterval(() => { if (popup.closed) close() }, 400)
  function close() {
    if (disposed) return
    disposed = true
    window.clearInterval(watchdog)
    unlisten?.()
    unregister?.()
    onClosed()
    if (!popup.closed) popup.close()
  }
  void listen<string>('tool-panel-closed', ({ payload }) => { if (payload === id) close() })
    .then((stop) => { if (disposed) stop(); else unlisten = stop }).catch(() => {})

  const ready = new Promise<Document>((resolve, reject) => {
    let attempts = 0
    function prepare() {
      if (disposed || popup.closed) { reject(new Error('Panel closed')); return }
      try {
        const doc = popup.document
        if (doc.body && popup.location.hash === '#' + id) {
          doc.title = title
          doc.documentElement.lang = document.documentElement.lang
          for (const style of document.querySelectorAll('style, link[rel="stylesheet"]')) {
            const copy = doc.importNode(style, true)
            if (style instanceof HTMLLinkElement) (copy as HTMLLinkElement).href = style.href
            doc.head.append(copy)
          }
          doc.body.className = 'tool-popup'
          windows.add(popup)
          for (const handler of keyboardHandlers) popup.addEventListener('keydown', handler)
          popup.addEventListener('pagehide', close, { once: true })
          unregister = () => {
            windows.delete(popup)
            popup.removeEventListener('pagehide', close)
            for (const handler of keyboardHandlers) popup.removeEventListener('keydown', handler)
          }
          resolve(doc)
          return
        }
      } catch { /* Wait for the same-origin blank document. */ }
      if (++attempts < 35) window.setTimeout(prepare, 40)
      else reject(new Error('Panel could not open'))
    }
    prepare()
  })
  function fitHeight(height: number, title: string) {
    if (!disposed && !popup.closed) void invoke('fit_tool_panel', { label: id, height, title }).catch(() => {})
  }
  return { popup, ready, close, fitHeight }
}
