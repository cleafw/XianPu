import { useEffect, useId, useRef, useState, type PointerEvent, type ReactNode } from 'react'
import { useLanguage } from './i18n'

type Point = { x: number; y: number }
let topPanel = 25
const clamp = (point: Point, width: number): Point => ({
  x: Math.max(8, Math.min(point.x, window.innerWidth - width - 8)),
  y: Math.max(8, Math.min(point.y, window.innerHeight - 90)),
})

export function ToolPanel({ label, hint, initialOpen = false, children }: {
  label: string; hint?: string; initialOpen?: boolean; children: ReactNode
}) {
  const { t } = useLanguage()
  const id = useId()
  const [open, setOpen] = useState(initialOpen)
  const [floating, setFloating] = useState<Point | null>(null)
  const [order, setOrder] = useState(25)
  const box = useRef<HTMLDivElement>(null)
  const dock = useRef<HTMLDivElement>(null)
  const drag = useRef<{ id: number; x: number; y: number } | null>(null)
  const show = open || !!floating
  function raise() { setOrder(++topPanel) }
  function returnToDock() { drag.current = null; setFloating(null) }

  useEffect(() => {
    function resize() { setFloating((point) => point && clamp(point, box.current?.offsetWidth ?? 325)) }
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [])

  function detach() {
    const rect = dock.current?.getBoundingClientRect()
    const width = Math.min(325, window.innerWidth - 16)
    setFloating(clamp({ x: rect ? rect.left - width - 12 : window.innerWidth - width - 20,
      y: rect ? Math.min(rect.top, window.innerHeight / 3) : 90 }, width))
    raise()
  }

  function startDrag(event: PointerEvent<HTMLDivElement>) {
    if (!floating || event.button !== 0 || event.target instanceof Element && event.target.closest('button')) return
    drag.current = { id: event.pointerId, x: event.clientX - floating.x, y: event.clientY - floating.y }
    event.currentTarget.setPointerCapture(event.pointerId)
    event.preventDefault()
  }
  function moveDrag(event: PointerEvent<HTMLDivElement>) {
    const active = drag.current
    if (active?.id === event.pointerId) {
      setFloating(clamp({ x: event.clientX - active.x, y: event.clientY - active.y }, box.current?.offsetWidth ?? 325))
    }
  }
  function endDrag(event: PointerEvent<HTMLDivElement>) {
    if (drag.current?.id === event.pointerId) drag.current = null
  }

  const floatLabel = t('弹出{panel}', { panel: label })
  const dockLabel = t('将{panel}贴回右栏', { panel: label })
  return <section className="tool-panel">
    <div ref={dock} className="tool-panel-header">
      <button type="button" className="tool-panel-toggle" aria-expanded={show} aria-controls={id}
        onClick={() => floating ? raise() : setOpen(!open)}>
        <span aria-hidden="true">{floating ? '◇' : open ? '▾' : '▸'} </span>{label}
      </button>
      {(floating || hint) && <span className="tool-panel-hint">{floating ? t('已弹出') : hint}</span>}
      <button type="button" aria-label={floating ? dockLabel : floatLabel} title={floating ? dockLabel : floatLabel}
        onClick={floating ? returnToDock : detach}>{floating ? '↙' : '↗'}</button>
    </div>
    <div ref={box} className={floating ? 'tool-panel-window' : undefined}
      role={floating ? 'region' : undefined} aria-label={floating ? label : undefined}
      style={floating ? { left: floating.x, top: floating.y, zIndex: order, maxHeight: 'min(70vh, calc(100vh - ' + (floating.y + 8) + 'px))' } : undefined}
      onPointerDownCapture={floating ? raise : undefined} onKeyDown={floating ? (event) => {
        if (event.key === 'Escape') { event.stopPropagation(); returnToDock() }
      } : undefined}>
      {floating && <div className="tool-panel-header" title={t('拖动{panel}', { panel: label })}
        onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag} onLostPointerCapture={endDrag}>
        <strong>{label}</strong>
        <button type="button" aria-label={dockLabel} title={dockLabel} onClick={returnToDock}>↙</button>
      </div>}
      <div id={id} className="tool-panel-body" hidden={!show}>{children}</div>
    </div>
  </section>
}
