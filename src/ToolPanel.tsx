import { createContext, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { isTauri } from '@tauri-apps/api/core'
import { eventElement, openPanelWindow } from './panelWindows'
import { useLanguage } from './i18n'

export const PanelsSuspended = createContext(false)

type Point = { x: number; y: number }
let topPanel = 25
const clamp = (point: Point, width: number): Point => ({
  x: Math.max(8, Math.min(point.x, window.innerWidth - width - 8)),
  y: Math.max(8, Math.min(point.y, window.innerHeight - 90)),
})

export function ToolPanel({ label, hint, initialOpen = false, placement = 'sidebar', onDock, children }: {
  label: string; hint?: string; initialOpen?: boolean; placement?: 'sidebar' | 'bottom'; onDock?: () => void; children: ReactNode
}) {
  const { t } = useLanguage()
  const bottom = placement === 'bottom'
  const width = bottom ? 620 : 325
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
      detached.title = label
      detached.documentElement.lang = document.documentElement.lang
    }
  }, [detached, label, t])

  useEffect(() => {
    function resize() { setFloating((point) => point && clamp(point, box.current?.offsetWidth ?? width)) }
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [width])

  function floatInPage() {
    const rect = dock.current?.getBoundingClientRect()
    const available = Math.min(width, window.innerWidth - 16)
    setFloating(clamp({ x: rect ? rect.left - available - 12 : window.innerWidth - available - 20,
      y: rect ? Math.min(rect.top, window.innerHeight / 3) : 90 }, available))
    raise()
  }

  function detach() {
    setFailed(false)
    if (!isTauri()) { floatInPage(); return }
    const panel = openPanelWindow(label, width, bottom ? 450 : 520, () => {
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
      style={floating ? { width: 'min(' + width + 'px, calc(100vw - 16px))', left: floating.x, top: floating.y, zIndex: order, maxHeight: 'min(70vh, calc(100vh - ' + (floating.y + 8) + 'px))' } : undefined}
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
    </div>, host)}
  </section>
}
