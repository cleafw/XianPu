import { useEffect, useRef, type MouseEvent } from 'react'
import { useMeasureDrag } from './useMeasureDrag'
import type { AlphaTabApi } from '@coderline/alphatab'
import { useLanguage } from './i18n'
import { drawScore, scoreBeatIndex, scoreNoteIndex } from './score'
import type { Mode, Position, Project, ScoreLabelKind, Track } from './model'

type MasterBar = NonNullable<ReturnType<NonNullable<AlphaTabApi['boundsLookup']>['findMasterBarByIndex']>>
type StaffBar = MasterBar['bars'][number]
type ScoreScroll = { part: string | null; top: number; left: number }

function voiceIndices(track: Track, mode: Mode | undefined, staff: number, lane?: Position['lane']) {
  if (mode === 'numbered' || mode === 'staff-numbered' && (staff > 0 || lane === 'numbered')) return [staff]
  const extras = (track.voices ?? []).flatMap((voice, index) => mode !== 'piano' || (voice.staff ?? 0) === staff ? [index + 1] : [])
  return mode !== 'piano' || staff === 0 || !track.voices?.some((voice) => voice.staff === 1) ? [0, ...extras] : extras
}

function lanes(master: MasterBar, bar: StaffBar) {
  return master.bars.filter((entry) => entry.bar === bar.bar).sort((a, b) => a.realBounds.y - b.realBounds.y)
}

function entryLane(master: MasterBar, bar: StaffBar, mode?: Mode): Position['lane'] {
  if (mode === 'staff-numbered' && bar.bar.staff.index > 0) return 'numbered'
  const entries = lanes(master, bar)
  return entries.length > 1 ? entries[0] === bar ? 'staff' : mode === 'staff-numbered' ? 'numbered' : 'tab' : undefined
}

export function ScoreView({ project, part, position, playhead, selectedBars = [], selectedNotes = [], scale = 1, print = false, onSelect, onNoteSelect, onNoteRange, onLabelSelect, onBarSelect, onBarRange, onBarMenu, onReady, onError }: {
  project: Project; part: string | null; position?: Position; playhead?: Position | null; selectedBars?: number[]; scale?: number; print?: boolean; onSelect?: (position: Position) => void;
  selectedNotes?: Position[]; onNoteSelect?: (position: Position, event: MouseEvent) => void;
  onNoteRange?: (start: Position, end: Position) => void;
  onBarSelect?: (position: Position, event: MouseEvent) => void;
  onBarRange?: (start: Position, end: number) => void;
  onBarMenu?: (position: Position, event: MouseEvent) => void;
  onLabelSelect?: (kind: ScoreLabelKind, bar: number) => void;
  onReady?: (systems: number, firstBars: number[]) => void; onError?: (error: Error) => void
}) {
  const { language, t } = useLanguage()
  const container = useRef<HTMLDivElement>(null)
  const cursor = useRef<HTMLDivElement>(null)
  const highlights = useRef<HTMLDivElement>(null)
  const stackGlyphs = useRef(new Map<number, SVGTextElement>())
  const apiRef = useRef<AlphaTabApi | null>(null)
  const pendingScroll = useRef<ScoreScroll | null>(null)
  const callbacks = useRef({ onReady, onError, position, playhead, selectedBars, selectedNotes })
  callbacks.current = { onReady, onError, position, playhead, selectedBars, selectedNotes }

  function positionAt(event: { clientX: number; clientY: number }, doc = container.current?.ownerDocument): (Position & { noteHit: boolean }) | undefined {
    const lookup = apiRef.current?.boundsLookup
    const surface = container.current?.querySelector('.at-surface')
    if (!lookup || !surface) return
    const rect = surface.getBoundingClientRect()
    const x = event.clientX - rect.left
    const y = event.clientY - rect.top
    const system = lookup.staffSystems.find(({ realBounds: bounds }) => y >= bounds.y && y <= bounds.y + bounds.h)
    const master = system?.findBarAtPos(x)
    if (!master) return

    const hit = doc?.elementFromPoint(event.clientX, event.clientY)?.closest('g[class^="xianpu-stack-note-"]')
    let stackId = hit ? Number(hit.getAttribute('class')!.slice('xianpu-stack-note-'.length)) : undefined
    if (stackId === undefined && stackGlyphs.current.size) {
      // Other music glyphs can have tall text boxes even where they paint no ink.
      // Use the rendered number's box so those glyphs don't intercept a stack layer.
      let closest = Infinity
      for (const bar of master.bars) for (const beat of bar.beats) {
        if (beat.beat.notes.length < 2) continue
        for (const note of beat.beat.notes) {
          const box = stackGlyphs.current.get(note.id)?.getBoundingClientRect()
          if (!box || event.clientX < box.left || event.clientX > box.right ||
            event.clientY < box.top || event.clientY > box.bottom) continue
          const distance = Math.abs(event.clientY - box.top - box.height / 2)
          if (distance < closest) { closest = distance; stackId = note.id }
        }
      }
    }
    const stackBeat = (bar: StaffBar) => stackId === undefined ? undefined
      : entryLane(master, bar, 'staff-numbered') === 'staff' ? undefined
        : bar.beats.find(({ notes }) => notes?.some(({ note }) => note.id === stackId))
    // alphaTab's default hit test chooses a beat horizontally across the whole
    // master bar. Select the individual staff vertically before finding its beat.
    let nearest: StaffBar | undefined
    let bestDistance = Infinity
    let bestCenter = Infinity
    for (const candidate of master.bars) {
      if (stackBeat(candidate)) { nearest = candidate; break }
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
    const mode = part ? track.layout.mode ?? track.mode : track.mode
    const lane = entryLane(master, nearest, mode)
    const voices = voiceIndices(track, mode, nearest.bar.staff.index, lane)
    const precise = nearest.beats.find((entry) => entry.findNoteAtPos(x, y))
    const preferred = track.id === position?.track ? voices.indexOf(position.voice ?? 0) : -1
    const candidates = preferred < 0 ? [] : nearest.beats.filter((entry) => entry.beat.voice.index === preferred)
    const target = stackBeat(nearest) ?? precise ?? candidates.find((entry) => x >= entry.realBounds.x && x <= entry.realBounds.x + entry.realBounds.w)
      ?? nearest.findBeatAtPos(x)
    if (!target) return
    const note = target.beat.graceType ? null : target.notes?.find(({ note }) => note.id === stackId)?.note ?? target.findNoteAtPos(x, y)
    const visual = target.visualBounds
    const noteHit = !!note || (target.beat.isRest || target.beat.notes.length > 0) && Math.abs(target.onNotesX - x) <= 10 * scale &&
      Math.abs(visual.y + visual.h / 2 - y) <= 14 * scale
    return { track: track.id, bar: nearest.bar.index, beat: scoreBeatIndex(target.beat), lane, voice: voices[target.beat.voice.index] ?? 0,
      note: note ? scoreNoteIndex(note) : undefined, string: note?.string ? 7 - note.string : undefined, noteHit }
  }

  const drag = useMeasureDrag(positionAt, onBarRange, onNoteRange)
  function selectLabel(target: EventTarget | null) {
    if (!onLabelSelect || !(target instanceof Element)) return false
    const label = target.closest('[data-score-label-kind]')
    const kind = label?.getAttribute('data-score-label-kind')
    if (kind !== 'key' && kind !== 'tempo') return false
    onLabelSelect(kind, Number(label?.getAttribute('data-score-label-bar')))
    return true
  }

  function locate(target: Position, api: AlphaTabApi) {
    const master = api.boundsLookup?.findMasterBarByIndex(target.bar)
    const track = project.tracks.find(({ id }) => id === target.track)
    if (!master || !track || part && part !== track.id) return
    const index = part ? 0 : project.tracks.indexOf(track)
    const mode = part ? track.layout.mode ?? track.mode : track.mode
    const eligible = master.bars.filter((entry) => {
      if (entry.bar.staff.track.index !== index) return false
      const lane = entryLane(master, entry, mode)
      return (!target.lane || !lane || target.lane === lane) &&
        voiceIndices(track, mode, entry.bar.staff.index, lane).includes(target.voice ?? 0)
    }).sort((a, b) => a.realBounds.y - b.realBounds.y)
    const staff = mode === 'piano' ? eligible[0] : eligible.at(-1)
    if (!staff) return { master }
    const lane = entryLane(master, staff, mode)
    const voice = voiceIndices(track, mode, staff.bar.staff.index, lane).indexOf(target.voice ?? 0)
    const beats = staff.beats.filter(({ beat }) => !beat.graceType && beat.voice.index === voice)
    const bounds = beats.find(({ beat }) => scoreBeatIndex(beat) === target.beat)
    return { master, staff, lane, bounds, lastBeat: bounds === beats.at(-1) }
  }

  function cursorBox(visual: StaffBar['visualBounds'], x: number) {
    const top = visual.y - 3
    return { left: x - 8, right: x + 8, top, bottom: top + Math.max(visual.h + 6, 18) }
  }

  function stackFrame(target: Position, bounds: StaffBar['beats'][number]) {
    if (target.note === undefined || bounds.beat.notes.length < 2) return
    const note = bounds.beat.notes.find((note) => scoreNoteIndex(note) === target.note)
    const glyph = note && stackGlyphs.current.get(note.id)
    const surface = glyph?.closest('.at-surface')
    if (!glyph || !surface) return
    const origin = surface.getBoundingClientRect()
    const box = glyph.getBoundingClientRect()
    return { left: box.left - origin.left - 2, right: box.right - origin.left + 2,
      top: box.top - origin.top, bottom: box.bottom - origin.top }
  }

  function noteFrames(api: AlphaTabApi, selection: Position[]) {
    type Frame = ReturnType<typeof cursorBox>
    const groups = new Map<string, { target: Position; frame: Frame; lastBeat: boolean }[]>()
    const frames: Frame[] = []
    for (const target of selection) {
      const location = locate(target, api)
      if (!location?.bounds || !location.staff) continue
      const { master, staff, lane, bounds, lastBeat } = location
      const layer = lane !== 'staff' && lane !== 'tab' ? stackFrame(target, bounds) : undefined
      if (layer) { frames.push(layer); continue }
      const key = JSON.stringify([master.staffSystemBounds?.index, target.track, staff.bar.staff.index, lane, target.voice ?? 0])
      const group = groups.get(key) ?? []
      if (group.some((item) => item.target.bar === target.bar && item.target.beat === target.beat)) continue
      group.push({ target, frame: cursorBox(bounds.visualBounds, bounds.onNotesX), lastBeat })
      groups.set(key, group)
    }
    for (const group of groups.values()) {
      group.sort((a, b) => a.target.bar - b.target.bar || a.target.beat - b.target.beat)
      let previous: typeof group[number] | undefined
      let current: Frame | undefined
      for (const item of group) {
        const adjacent = previous && (item.target.bar === previous.target.bar && item.target.beat === previous.target.beat + 1 ||
          item.target.bar === previous.target.bar + 1 && item.target.beat === 0 && previous.lastBeat)
        const { frame } = item
        if (current && adjacent) {
          current.left = Math.min(current.left, frame.left)
          current.right = Math.max(current.right, frame.right)
          current.top = Math.min(current.top, frame.top)
          current.bottom = Math.max(current.bottom, frame.bottom)
        } else {
          current = { ...frame }
          frames.push(current)
        }
        previous = item
      }
    }
    return frames.map(({ left, right, top, bottom }) => {
      const item = document.createElement('div')
      item.className = 'score-note-highlight'
      Object.assign(item.style, { left: left + 'px', top: top + 'px', width: right - left + 'px', height: bottom - top + 'px' })
      return item
    })
  }

  function markPosition() {
    const marker = cursor.current
    const api = apiRef.current
    const active = callbacks.current.playhead
    const selected = active ?? callbacks.current.position
    if (!marker || !api || !selected) return
    const index = part ? 0 : project.tracks.findIndex((track) => track.id === selected.track)
    const measureHighlights = (active ? [] : callbacks.current.selectedBars).flatMap((bar) => {
      const bounds = api.boundsLookup?.findMasterBarByIndex(bar)?.bars.filter((entry) => entry.bar.staff.track.index === index) ?? []
      return bounds.map(({ realBounds: area }) => {
        const item = document.createElement('div')
        item.className = 'score-measure-highlight'
        Object.assign(item.style, { left: area.x + 'px', top: area.y + 'px', width: area.w + 'px', height: area.h + 'px' })
        return item
      })
    })
    const noteHighlights = active ? [] : noteFrames(api, callbacks.current.selectedNotes)
    highlights.current?.replaceChildren(...measureHighlights, ...noteHighlights)
    const { master, staff, lane, bounds } = locate(selected, api) ?? {}
    const simile = active && master && project.measures[selected.bar]?.simile
    marker.hidden = !bounds && !simile || !active && !!callbacks.current.selectedNotes.length
    if (bounds || simile) {
      const visual = bounds?.visualBounds ?? staff?.visualBounds ?? master!.visualBounds
      const frame = (!active && bounds && lane !== 'staff' && lane !== 'tab' && stackFrame(selected, bounds)) ||
        cursorBox(visual, bounds?.onNotesX ?? visual.x + visual.w / 2)
      marker.style.left = frame.left + 'px'
      marker.style.width = frame.right - frame.left + 'px'
      marker.style.top = frame.top + 'px'
      marker.style.height = frame.bottom - frame.top + 'px'
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
        stackGlyphs.current = new Map([...element.querySelectorAll<SVGTextElement>('g[class^="xianpu-stack-note-"] > text')]
          .map((glyph) => [Number(glyph.parentElement!.getAttribute('class')!.slice('xianpu-stack-note-'.length)), glyph]))
        if (onLabelSelect) for (const label of element.querySelectorAll('[data-score-label-kind]')) {
          label.setAttribute('role', 'button')
          label.setAttribute('tabindex', '0')
          label.setAttribute('aria-label', t(label.getAttribute('data-score-label-kind') === 'key' ? '编辑此处调号' : '编辑此处速度'))
        }
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
  useEffect(markPosition, [position, playhead, selectedBars, selectedNotes])
  return <div className="score-frame">
    <div ref={container} className="score-render" data-testid="score-render"
      {...drag.handlers} aria-label={t('可点击的乐谱')} onPointerDown={onSelect ? (event) => {
        if (event.button !== 0) return
        if (selectLabel(event.target)) return
        const target = positionAt(event)
        if (!target) return
        const clicked = event.target instanceof Element ? event.target.closest('text') : null
        const isBarNumber = clicked?.textContent === String(target.bar + 1) && /c80000|200,\s*0,\s*0/i.test(clicked.getAttribute('fill') ?? '')
        const modifier = event.shiftKey || event.ctrlKey || event.metaKey
        const note = target.noteHit && !isBarNumber
        if (modifier && note && onNoteSelect) {
          onNoteSelect(target, event)
        } else if (onBarSelect && (modifier || isBarNumber)) {
          onBarSelect(target, event)
        } else onSelect(target)
        if (!modifier && (onBarRange || onNoteRange)) drag.start(event, target, note && !!onNoteRange)
      } : undefined} onKeyDown={onLabelSelect ? (event) => {
        if ((event.key === 'Enter' || event.key === ' ') && selectLabel(event.target)) event.preventDefault()
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
