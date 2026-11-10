import { useEffect, useRef, type PointerEvent } from 'react'
import type { AlphaTabApi } from '@coderline/alphatab'
import { useLanguage } from './i18n'
import { drawScore } from './score'
import type { Position, Project } from './model'

type MasterBar = NonNullable<ReturnType<NonNullable<AlphaTabApi['boundsLookup']>['findMasterBarByIndex']>>
type StaffBar = MasterBar['bars'][number]

function lanes(master: MasterBar, bar: StaffBar) {
  return master.bars.filter((entry) => entry.bar === bar.bar).sort((a, b) => a.realBounds.y - b.realBounds.y)
}

export function ScoreView({ project, part, position, scale = 1, onSelect, onReady, onError }: {
  project: Project; part: string | null; position?: Position; scale?: number; onSelect?: (position: Position) => void;
  onReady?: (systems: number) => void; onError?: (error: Error) => void
}) {
  const { language, t } = useLanguage()
  const container = useRef<HTMLDivElement>(null)
  const cursor = useRef<HTMLDivElement>(null)
  const apiRef = useRef<AlphaTabApi | null>(null)
  const callbacks = useRef({ onReady, onError, position })
  callbacks.current = { onReady, onError, position }

  function selectAtPointer(event: PointerEvent<HTMLDivElement>) {
    const lookup = apiRef.current?.boundsLookup
    const surface = container.current?.querySelector('.at-surface')
    if (!onSelect || !lookup || !surface || event.button !== 0) return
    const rect = surface.getBoundingClientRect()
    const x = event.clientX - rect.left
    const y = event.clientY - rect.top
    const system = lookup.staffSystems.find(({ realBounds: bounds }) => y >= bounds.y && y <= bounds.y + bounds.h)
    const master = system?.findBarAtPos(x)
    if (!master) return

    // alphaTab's default hit test chooses a beat horizontally across the whole
    // master bar. Select the individual staff vertically before finding its beat.
    let nearest: StaffBar | undefined
    let bestDistance = Infinity
    let bestCenter = Infinity
    for (const candidate of master.bars) {
      const bounds = candidate.realBounds
      const distance = Math.max(bounds.y - y, y - (bounds.y + bounds.h), 0)
      const center = Math.abs(y - (bounds.y + bounds.h / 2))
      if (distance < bestDistance || (distance === bestDistance && center < bestCenter)) {
        nearest = candidate
        bestDistance = distance
        bestCenter = center
      }
    }
    if (!nearest) return
    const target = nearest.findBeatAtPos(x)
    const track = part ?? project.tracks[nearest.bar.staff.track.index]?.id
    if (!target || !track) return
    const sameTrack = lanes(master, nearest)
    const lane = sameTrack.length > 1 ? (sameTrack[0] === nearest ? 'staff' : 'tab') : undefined
    onSelect({ track, bar: nearest.bar.index, beat: target.beat.index, lane })
  }

  function markPosition() {
    const marker = cursor.current
    const api = apiRef.current
    const selected = callbacks.current.position
    if (!marker || !api || !selected) return
    const index = part ? 0 : project.tracks.findIndex((track) => track.id === selected.track)
    const master = api.boundsLookup?.findMasterBarByIndex(selected.bar)
    const trackBars = master?.bars.filter((bar) => bar.bar.staff.track.index === index)
      .sort((a, b) => a.realBounds.y - b.realBounds.y)
    const staff = selected.lane === 'staff' ? trackBars?.[0] : trackBars?.at(-1)
    const bounds = staff?.beats.find(({ beat }) => beat.index === selected.beat)
    marker.hidden = !bounds
    if (bounds) {
      const visual = bounds.visualBounds
      marker.style.left = (bounds.onNotesX - 8) + 'px'
      marker.style.top = (visual.y - 3) + 'px'
      marker.style.height = Math.max(visual.h + 6, 18) + 'px'
    }
  }

  useEffect(() => {
    const element = container.current!
    try {
      const api = drawScore(element, project, part, scale, language, () => {
        callbacks.current.onReady?.(apiRef.current?.boundsLookup?.staffSystems.length ?? 0)
        markPosition()
      }, (error) => callbacks.current.onError?.(error))
      apiRef.current = api
      return () => { apiRef.current = null; api.destroy(); element.replaceChildren() }
    } catch (error) {
      callbacks.current.onError?.(error instanceof Error ? error : new Error(String(error)))
    }
  }, [project, part, scale, language])
  useEffect(markPosition, [position])
  return <div className="score-frame">
    <div ref={container} className="score-render" data-testid="score-render"
      aria-label={t('可点击的乐谱')} onPointerDown={onSelect ? selectAtPointer : undefined} />
    {position && <div ref={cursor} className="score-cursor" aria-hidden="true" hidden />}
  </div>
}
