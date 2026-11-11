import { createContext, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { isTauri } from '@tauri-apps/api/core'
import { eventElement, openPanelWindow } from './panelWindows'
import { appName, useLanguage } from './i18n'

export const PanelsSuspended = createContext(false)

type Point = { x: number; y: number }
let topPanel = 25
const clamp = (point: Point, width: number): Point => ({
  x: Math.max(8, Math.min(point.x, window.innerWidth - width - 8)),
  y: Math.max(8, Math.min(point.y, window.innerHeight - 90)),
})

export function PanelWidthHandle({ label, side, width, resize }: {
  label: string; side: 'left' | 'right'; width: () => number; resize: (width: number) => void
}) {
  const drag = useRef<{ id: number; x: number; width: number } | null>(null)
  const direction = side === 'left' ? -1 : 1
  return <div className={'panel-width-handle panel-width-handle-' + side} role="separator" aria-orientation="vertical"
    aria-label={label} title={label} tabIndex={0}
    onPointerDown={(event) => {
      if (event.button !== 0) return
      drag.current = { id: event.pointerId, x: event.clientX, width: width() }
      event.currentTarget.setPointerCapture(event.pointerId)
      event.currentTarget.focus({ preventScroll: true })
      event.preventDefault()
    }}
    onPointerMove={(event) => {
      const start = drag.current
      if (start?.id === event.pointerId) resize(start.width + (event.clientX - start.x) * direction)
    }}
    onLostPointerCapture={() => { drag.current = null }}
    onKeyDown={(event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
      event.preventDefault()
      resize(width() + (event.key === 'ArrowLeft' ? -16 : 16) * direction)
    }} />
}

export function ToolPanel({ label, hint, initialOpen = false, placement = 'sidebar', onDock, children }: {
  label: string; hint?: string; initialOpen?: boolean; placement?: 'sidebar' | 'bottom'; onDock?: () => void; children: ReactNode
}) {
  const { t } = useLanguage()
  const windowTitle = t(appName) + ' · ' + label
  const bottom = placement === 'bottom'
  const initialWidth = bottom ? 620 : 325
  const [floatingWidth, setFloatingWidth] = useState<number>()
  const width = floatingWidth ?? initialWidth
  const id = useId()
  const suspended = useContext(PanelsSuspended)
  const [host] = useState(() => document.createElement('div'))
  const [detached, setDetached] = useState<Document | null>(null)
  const [opening, setOpening] = useState(false)
  const [failed, setFailed] = useState(false)
  const native = useRef<ReturnType<typeof openPanelWindow>>(null)
  const dockSlot = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(initialOpen)
  const [floating, setFloating] = useState<Point | null>(null)
  const [order, setOrder] = useState(25)
  const box = useRef<HTMLDivElement>(null)
  const dock = useRef<HTMLDivElement>(null)
  const drag = useRef<{ id: number; x: number; y: number } | null>(null)
  const floated = !!(floating || detached || opening)
  const show = open || floated
  function raise() {
    if (native.current) native.current.popup.focus()
    else setOrder(++topPanel)
  }
  function returnToDock() {
    if (native.current) native.current.close()
    else onDock?.()
    drag.current = null
    setFloating(null)
  }

  useLayoutEffect(() => {
    dockSlot.current?.append(host)
    return () => { native.current?.close(); host.remove() }
  }, [host])
  useEffect(() => {
    if (detached) {
      detached.title = windowTitle
      detached.documentElement.lang = document.documentElement.lang
    }
  }, [detached, windowTitle, t])
  useLayoutEffect(() => {
    const panel = native.current
    const content = box.current
    if (!detached || !panel || !content) return
    let previousHeight = 0
    let previousWidth = 0
    let frame = 0
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const bounds = content.getBoundingClientRect()
        const height = Math.ceil(bounds.height)
        if (height > 0 && (!previousHeight || (bounds.width === previousWidth && height !== previousHeight))) {
          panel.fitHeight(height, windowTitle)
        }
        previousHeight = height
        previousWidth = bounds.width
      })
    })
    observer.observe(content)
    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame)
    }
  }, [detached, windowTitle])

  useEffect(() => {
    function resize() { setFloating((point) => point && clamp(point, box.current?.offsetWidth ?? width)) }
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [width])

  function floatInPage() {
    const rect = dock.current?.getBoundingClientRect()
    const available = Math.min(preferredWidth(), window.innerWidth - 16)
    setFloatingWidth(available)
    setFloating(clamp({ x: rect ? rect.left - available - 12 : window.innerWidth - available - 20,
      y: rect ? Math.min(rect.top, window.innerHeight / 3) : 90 }, available))
    raise()
  }

  function preferredWidth() {
    return floatingWidth ?? Math.max(initialWidth, dock.current?.closest('.inspector')?.clientWidth ?? 0)
  }

  function detach() {
    setFailed(false)
    if (!isTauri()) { floatInPage(); return }
    const panel = openPanelWindow(windowTitle, Math.min(preferredWidth(), window.screen.availWidth), () => {
      dockSlot.current?.append(host)
      native.current = null
      setOpening(false)
      setDetached(null)
      onDock?.()
    })
    if (!panel) { setFailed(true); floatInPage(); return }
    native.current = panel
    setOpening(true)
    void panel.ready.then((doc) => {
      if (native.current !== panel) return
      doc.body.append(host)
      setDetached(doc)
      setOpening(false)
    }).catch(() => {
      if (native.current !== panel) return
      panel.close()
      setFailed(true)
      floatInPage()
    })
  }

  function startDrag(event: PointerEvent<HTMLDivElement>) {
    if (!floating || event.button !== 0 || eventElement(event.target)?.closest('button')) return
    drag.current = { id: event.pointerId, x: event.clientX - floating.x, y: event.clientY - floating.y }
    event.currentTarget.setPointerCapture(event.pointerId)
    event.preventDefault()
  }
  function moveDrag(event: PointerEvent<HTMLDivElement>) {
    const active = drag.current
    if (active?.id === event.pointerId) {
      setFloating(clamp({ x: event.clientX - active.x, y: event.clientY - active.y }, box.current?.offsetWidth ?? width))
    }
  }
  function endDrag(event: PointerEvent<HTMLDivElement>) {
    if (drag.current?.id === event.pointerId) drag.current = null
  }

  const floatLabel = t('弹出{panel}', { panel: label })
  const dockLabel = t(bottom ? '将{panel}贴回底部' : '将{panel}贴回右栏', { panel: label })
  return <section className="tool-panel">
    <div ref={dock} className="tool-panel-header">
      <button type="button" className="tool-panel-toggle" aria-expanded={show} aria-controls={id}
        onClick={() => floated ? raise() : setOpen(!open)}>
        <span aria-hidden="true">{floated ? '◇' : open ? '▾' : '▸'} </span>{label}
      </button>
      {(floated || hint) && <span className="tool-panel-hint">{floated ? t('已弹出') : hint}</span>}
      <button type="button" aria-label={floated ? dockLabel : floatLabel} title={floated ? dockLabel : floatLabel}
        onClick={floated ? returnToDock : detach}>{floated ? '↙' : '↗'}</button>
    </div>
    {failed && <small className="tool-panel-warning">{t('独立窗口未打开，已在主窗口内弹出。')}</small>}
    <div ref={dockSlot} />
    {createPortal(<div ref={box} className={floating ? 'tool-panel-window' : detached ? 'tool-panel-detached' : undefined}
      role={floating || detached ? 'region' : undefined} aria-label={floating || detached ? label : undefined}
      style={floating ? { width: 'min(' + width + 'px, calc(100vw - 16px))', left: floating.x, top: floating.y, zIndex: order, maxHeight: 'calc(100vh - ' + (floating.y + 8) + 'px)' } : undefined}
      onPointerDownCapture={floating ? raise : undefined} onKeyDown={floating || detached ? (event) => {
        if (event.key === 'Escape') { event.stopPropagation(); returnToDock() }
      } : undefined}>
      {floating && <div className="tool-panel-header" title={t('拖动{panel}', { panel: label })}
        onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag} onLostPointerCapture={endDrag}>
        <strong>{label}</strong>
        <button type="button" aria-label={dockLabel} title={dockLabel} onClick={returnToDock}>↙</button>
      </div>}
      {detached && <div className="tool-panel-header tool-panel-detached-header">
        <strong>{label}</strong>
        <button type="button" aria-label={dockLabel} title={dockLabel} onClick={returnToDock}>↙</button>
      </div>}
      {detached && suspended && <small className="tool-panel-warning">{t('请先处理主窗口的对话框。')}</small>}
      <div id={id} className="tool-panel-body" hidden={!show} inert={!!detached && suspended}>{children}</div>
      {floating && <PanelWidthHandle label={t('调整{panel}宽度', { panel: label })} side="right"
        width={() => box.current?.getBoundingClientRect().width ?? width}
        resize={(next) => setFloatingWidth(Math.min(window.innerWidth - floating.x - 8, Math.max(225, next)))} />}
    </div>, host)}
  </section>
}
