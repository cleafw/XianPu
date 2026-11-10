import { useEffect, useRef, type PointerEvent } from 'react'
import type { Position } from './model'

type Point = { clientX: number; clientY: number }

export function useMeasureDrag(hit: (point: Point) => Position | undefined, select?: (start: Position, end: number) => void) {
  const drag = useRef<{ id: number; start: Position; end: number; point: Point; scroll: HTMLElement | null } | null>(null)
  const frame = useRef<number | null>(null)
  const callbacks = useRef({ hit, select })
  callbacks.current = { hit, select }
  function cancelFrame() {
    if (frame.current !== null) cancelAnimationFrame(frame.current)
    frame.current = null
  }
  useEffect(() => cancelFrame, [])
  function update(point: Point) {
    const active = drag.current
    if (!active) return
    const next = callbacks.current.hit(point)
    if (!next || next.bar === active.end) return
    active.end = next.bar
    callbacks.current.select?.(active.start, active.end)
  }
  function scrollFrame() {
    frame.current = null
    const active = drag.current
    const scroll = active?.scroll
    if (!active || !scroll) return
    const { top, bottom, left, right } = scroll.getBoundingClientRect()
    const { clientX, clientY } = active.point
    if (clientX < left || clientX > right) return
    const margin = 34
    const dy = clientY < top + margin ? -10 : clientY > bottom - margin ? 10 : 0
    if (!dy) return
    const previous = scroll.scrollTop
    scroll.scrollTop += dy
    if (previous === scroll.scrollTop) return
    update({ clientX, clientY: Math.max(top + 2, Math.min(bottom - 2, clientY)) })
    frame.current = requestAnimationFrame(scrollFrame)
  }
  function finish(event: PointerEvent<HTMLElement>) {
    if (drag.current?.id !== event.pointerId) return
    drag.current = null
    cancelFrame()
  }
  return {
    start(event: PointerEvent<HTMLElement>, start: Position) {
      if (event.pointerType === 'touch') return
      drag.current = { id: event.pointerId, start, end: start.bar, point: event, scroll: event.currentTarget.closest('.canvas') }
      event.currentTarget.setPointerCapture(event.pointerId)
    },
    handlers: {
      onPointerMove(event: PointerEvent<HTMLElement>) {
        const active = drag.current
        if (!active || active.id !== event.pointerId) return
        active.point = { clientX: event.clientX, clientY: event.clientY }
        update(active.point)
        if (frame.current === null) frame.current = requestAnimationFrame(scrollFrame)
      },
      onPointerUp: finish,
      onPointerCancel: finish,
      onLostPointerCapture: finish,
    },
  }
}
