import { useEffect, useRef, type MouseEvent } from 'react'
import { useMeasureDrag } from './useMeasureDrag'
import type { AlphaTabApi } from '@coderline/alphatab'
import { useLanguage } from './i18n'
import { drawScore, scoreBeatIndex, scoreNoteIndex } from './score'
import type { Mode, Position, Project, Track } from './model'

type MasterBar = NonNullable<ReturnType<NonNullable<AlphaTabApi['boundsLookup']>['findMasterBarByIndex']>>
type StaffBar = MasterBar['bars'][number]
type ScoreScroll = { part: string | null; top: number; left: number }

function voiceIndices(track: Track, mode: Mode | undefined, staff: number) {
  const extras = (track.voices ?? []).flatMap((voice, index) => mode !== 'piano' || (voice.staff ?? 0) === staff ? [index + 1] : [])
  return mode !== 'piano' || staff === 0 || !track.voices?.some((voice) => voice.staff === 1) ? [0, ...extras] : extras
}

function lanes(master: MasterBar, bar: StaffBar) {
  return master.bars.filter((entry) => entry.bar === bar.bar).sort((a, b) => a.realBounds.y - b.realBounds.y)
}

export function ScoreView({ project, part, position, playhead, selectedBars = [], scale = 1, print = false, onSelect, onBarSelect, onBarRange, onBarMenu, onReady, onError }: {
  project: Project; part: string | null; position?: Position; playhead?: Position | null; selectedBars?: number[]; scale?: number; print?: boolean; onSelect?: (position: Position) => void;
  onBarSelect?: (position: Position, event: MouseEvent) => void;
  onBarRange?: (start: Position, end: number) => void;
  onBarMenu?: (position: Position, event: MouseEvent) => void;
  onReady?: (systems: number, firstBars: number[]) => void; onError?: (error: Error) => void
}) {
  const { language, t } = useLanguage()
  const container = useRef<HTMLDivElement>(null)
  const cursor = useRef<HTMLDivElement>(null)
  const highlights = useRef<HTMLDivElement>(null)
  const apiRef = useRef<AlphaTabApi | null>(null)
  const pendingScroll = useRef<ScoreScroll | null>(null)
  const callbacks = useRef({ onReady, onError, position, playhead, selectedBars })
  callbacks.current = { onReady, onError, position, playhead, selectedBars }

  function positionAt(event: { clientX: number; clientY: number }): Position | undefined {
    const lookup = apiRef.current?.boundsLookup
    const surface = container.current?.querySelector('.at-surface')
    if (!lookup || !surface) return
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
    const track = part ? project.tracks.find((item) => item.id === part) : project.tracks[nearest.bar.staff.track.index]
    if (!track) return
    const sameTrack = lanes(master, nearest)
    const mode = part ? track.layout.mode ?? track.mode : track.mode
    const lane = sameTrack.length > 1 ? (sameTrack[0] === nearest ? 'staff' : mode === 'staff-numbered' ? 'numbered' : 'tab') : undefined
    const voices = voiceIndices(track, mode, nearest.bar.staff.index)
    const precise = nearest.beats.find((entry) => entry.findNoteAtPos(x, y))
    const preferred = track.id === position?.track ? voices.indexOf(position.voice ?? 0) : -1
    const candidates = preferred < 0 ? [] : nearest.beats.filter((entry) => entry.beat.voice.index === preferred)
    const target = precise ?? candidates.find((entry) => x >= entry.realBounds.x && x <= entry.realBounds.x + entry.realBounds.w)
      ?? nearest.findBeatAtPos(x)
    if (!target) return
    const note = target.beat.graceType ? null : target.findNoteAtPos(x, y)
    return { track: track.id, bar: nearest.bar.index, beat: scoreBeatIndex(target.beat), lane, voice: voices[target.beat.voice.index] ?? 0,
      note: note ? scoreNoteIndex(note) : undefined, string: note?.string ? 7 - note.string : undefined }
  }

  const drag = useMeasureDrag(positionAt, onBarRange)

  function markPosition() {
    const marker = cursor.current
    const api = apiRef.current
    const active = callbacks.current.playhead
    const selected = active ?? callbacks.current.position
    if (!marker || !api || !selected) return
    const index = part ? 0 : project.tracks.findIndex((track) => track.id === selected.track)
    highlights.current?.replaceChildren(...(active ? [] : callbacks.current.selectedBars).flatMap((bar) => {
      const bounds = api.boundsLookup?.findMasterBarByIndex(bar)?.bars.filter((entry) => entry.bar.staff.track.index === index) ?? []
      return bounds.map(({ realBounds: area }) => {
        const item = document.createElement('div')
        item.className = 'score-measure-highlight'
        Object.assign(item.style, { left: area.x + 'px', top: area.y + 'px', width: area.w + 'px', height: area.h + 'px' })
        return item
      })
    }))
    const master = api.boundsLookup?.findMasterBarByIndex(selected.bar)
    const trackBars = master?.bars.filter((bar) => bar.bar.staff.track.index === index)
      .sort((a, b) => a.realBounds.y - b.realBounds.y)
    const track = project.tracks.find((item) => item.id === selected.track)
    const mode = part ? track?.layout.mode ?? track?.mode : track?.mode
    const staff = track && mode === 'piano' ? trackBars?.find((entry) => voiceIndices(track, mode, entry.bar.staff.index).includes(selected.voice ?? 0))
      : selected.lane === 'staff' ? trackBars?.[0] : trackBars?.at(-1)
    const voice = staff && track ? voiceIndices(track, mode, staff.bar.staff.index).indexOf(selected.voice ?? 0) : 0
    const bounds = staff?.beats.find(({ beat }) => scoreBeatIndex(beat) === selected.beat && !beat.graceType && beat.voice.index === voice)
    const simile = active && master && project.measures[selected.bar]?.simile
    marker.hidden = !bounds && !simile
    if (bounds || simile) {
      const visual = bounds?.visualBounds ?? staff?.visualBounds ?? master!.visualBounds
      marker.style.left = ((bounds?.onNotesX ?? visual.x + visual.w / 2) - 8) + 'px'
      marker.style.top = (visual.y - 3) + 'px'
      marker.style.height = Math.max(visual.h + 6, 18) + 'px'
      if (active) {
        const viewport = marker.closest('.canvas')
        const paper = marker.closest('.paper-scroll')
        const cursor = marker.getBoundingClientRect()
        if (viewport) {
          const box = viewport.getBoundingClientRect()
          if (cursor.top < box.top + 12 || cursor.bottom > box.bottom - 16) {
            viewport.scrollTop += cursor.top - box.top - Math.min(65, box.height / 5)
          }
        }
        if (paper) {
          const box = paper.getBoundingClientRect()
          if (cursor.left < box.left + 10) paper.scrollLeft += cursor.left - box.left - 18
          else if (cursor.right > box.right - 10) paper.scrollLeft += cursor.right - box.right + 18
        }
      }
    }
  }

  useEffect(() => {
    const element = container.current!
    const viewport = print ? null : element.closest<HTMLElement>('.canvas')
    const paper = print ? null : element.closest<HTMLElement>('.paper-scroll')
    let scroll = pendingScroll.current?.part === part ? pendingScroll.current : null
    pendingScroll.current = null
    if (!scroll) element.style.minHeight = ''
    function restoreScroll() {
      if (!scroll) return
      element.style.minHeight = ''
      if (viewport) viewport.scrollTop = scroll.top
      if (paper) paper.scrollLeft = scroll.left
      scroll = null
    }
    function reportError(error: Error) {
      restoreScroll()
      callbacks.current.onError?.(error)
    }
    try {
      const api = drawScore(element, project, part, scale, language, () => {
        restoreScroll()
        const systems = apiRef.current?.boundsLookup?.staffSystems ?? []
        callbacks.current.onReady?.(systems.length, systems.map((system) => system.bars[0]?.index ?? 0))
        markPosition()
      }, reportError, print)
      apiRef.current = api
      return () => {
        if (viewport && paper) {
          pendingScroll.current = { part, top: viewport.scrollTop, left: paper.scrollLeft }
          // Keep the scrollable area in place while alphaTab replaces its SVG.
          element.style.minHeight = element.offsetHeight + 'px'
        }
        apiRef.current = null
        api.destroy()
        element.replaceChildren()
      }
    } catch (error) {
      reportError(error instanceof Error ? error : new Error(String(error)))
    }
  }, [project, part, scale, language, print])
  useEffect(markPosition, [position, playhead, selectedBars])
  return <div className="score-frame">
    <div ref={container} className="score-render" data-testid="score-render"
      {...drag.handlers} aria-label={t('可点击的乐谱')} onPointerDown={onSelect ? (event) => {
        if (event.button !== 0) return
        const target = positionAt(event)
        if (!target) return
        const clicked = event.target instanceof Element ? event.target.closest('text') : null
        const isBarNumber = clicked?.textContent === String(target.bar + 1) && /c80000|200,\s*0,\s*0/i.test(clicked.getAttribute('fill') ?? '')
        if (onBarSelect && (event.shiftKey || event.ctrlKey || event.metaKey || isBarNumber)) {
          onBarSelect(target, event)
        } else onSelect(target)
        if (!event.shiftKey && !event.ctrlKey && !event.metaKey && onBarRange) drag.start(event, target)
      } : undefined} onContextMenu={onBarMenu ? (event) => {
        const target = positionAt(event)
        if (!target) return
        event.preventDefault()
        onBarMenu(target, event)
      } : undefined} />
    {position && <div ref={highlights} aria-hidden="true" />}
    {position && <div ref={cursor} className={'score-cursor' + (playhead ? ' is-playing' : '')} data-play-measure={playhead?.bar} data-play-beat={playhead?.beat} aria-hidden="true" hidden />}
  </div>
}
