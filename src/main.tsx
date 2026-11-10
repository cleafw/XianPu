import { createRoot } from 'react-dom/client'
import { useEffect, useReducer, useRef, useState, type ChangeEvent, type MouseEvent } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { Editor } from './Editor'
import { appName, displayMessage, languageKey, languageOf, LanguageContext, message, readLanguagePreference, translate, useLanguage,
  type Language, type LanguagePreference, type Message, type Translate } from './i18n'
import { ScoreView } from './ScoreView'
import { useMeasureDrag } from './useMeasureDrag'
import type { SpanEnd } from './notationMarks'
import { PrintSheet } from './PrintSheet'
import { renderPng } from './exportImage'
import { PaperEditor } from './PaperEditor'
import { SoundEditor } from './SoundEditor'
import { NavigationEditor, navigationMessage } from './NavigationEditor'
import { resolveScoreNavigation } from './scoreNavigation'
import { paperDimensions, paperMargin } from './paper'
import { beatList, beatRange, blank, changeBeat, createProject, createTrack, keyNames, kinds, measureDifference, measureSettings, modes, paperFor, parseProject,
  pitchNames, shiftedEndings, shiftedLayout, techniqueGroups, voiceBars, type Beat, type Kind, type Layout, type Measure, type Mode, type Position, type Project, type Track } from './model'
import { playScore, stopPlayback } from './playback'
import { copyMeasures, pasteMeasures, type MeasureClipboard, type PasteMode } from './measureClipboard'
import * as storage from './storage'
import './styles.css'

type History = { past: Project[]; value: Project | null; future: Project[] }
type Action = { type: 'open'; score: Project | null } | { type: 'edit'; edit: (score: Project) => Project } | { type: 'undo' | 'redo' }
function history(state: History, action: Action): History {
  if (action.type === 'open') return { past: [], value: action.score, future: [] }
  if (!state.value) return state
  if (action.type === 'edit') return { past: [...state.past.slice(-149), state.value], value: action.edit(state.value), future: [] }
  if (action.type === 'undo' && state.past.length) return { past: state.past.slice(0, -1), value: state.past.at(-1)!, future: [state.value, ...state.future] }
  if (action.type === 'redo' && state.future.length) return { past: [...state.past, state.value], value: state.future[0], future: state.future.slice(1) }
  return state
}

const templates = [
  { id: 'song', title: '简谱弹唱', notation: '1  2  3  5', description: '人声简谱、中文歌词和吉他伴奏。' },
  { id: 'guitar', title: '吉他指弹', notation: '─ 0 ─ 2 ─ 3 ─', description: '在六线谱上按弦号和品位写谱。' },
  { id: 'ensemble', title: '多乐器总谱', notation: '♩  ♪  ♫', description: '用简谱、五线谱和六线谱组织乐器与分谱。' },
] as const
const creditFields = { subtitle: '副标题', lyricist: '作词', composer: '作曲', arranger: '编曲', engraver: '制谱' } as const
const meters = [2, 4, 8, 16].flatMap((unit) => Array.from({ length: 12 }, (_, i) => (i + 1) + '/' + unit))

type PrintJob = { part: string | null; key: number; project: Project }
type ExportMode = 'current' | 'score' | 'parts'
type ExportFormat = 'pdf' | 'png'
const scoreName = (score: Project, part: string | null, t: Translate) => score.tracks.find((track) => track.id === part)?.name ?? t('总谱')

function readRecovery() {
  try {
    const raw = localStorage.getItem(storage.recoveryKey)
    return raw ? parseProject(raw) : null
  } catch { return null }
}
function measuresChange(score: Project, index: number, insert: boolean): Project {
  const delta = insert ? 1 : -1
  const measures = shiftedEndings(score.measures, index, delta)
  if (insert) measures.splice(index, 0, {})
  else {
    const simile = measures[index].simile
    const other = simile === 'double' ? index + 1 : simile === 'double-second' ? index - 1 : -1
    if (measures[other]) measures[other] = { ...measures[other], simile: undefined }
    measures.splice(index, 1)
  }
  const splice = (original: Beat[][]) => {
    const bars = original.slice()
    if (insert) bars.splice(index, 0, [])
    else {
      const removed = new Set(bars[index].flatMap((beat) => beat.spans?.map(({ id }) => id) ?? []))
      bars.splice(index, 1)
      if (removed.size) return bars.map((bar) => bar.map((beat) => beat.spans?.some(({ id }) => removed.has(id))
        ? { ...beat, spans: beat.spans.filter(({ id }) => !removed.has(id)) } : beat))
    }
    return bars
  }
  return { ...score, measures, layout: shiftedLayout(score.layout, index, delta), tracks: score.tracks.map((track) => ({
    ...track, bars: splice(track.bars), layout: shiftedLayout(track.layout, index, delta),
    voices: track.voices?.map((voice) => ({ ...voice, bars: splice(voice.bars) })),
  })) }
}
function updateTrack(score: Project, id: string, edit: (track: Track) => Track): Project {
  return { ...score, tracks: score.tracks.map((track) => track.id === id ? edit(track) : track) }
}

function retune(track: Track, tuning: number[], capo = track.capo): Track {
  const delta = (capo ?? 0) - (track.capo ?? 0)
  const shift = (bars: Beat[][]) => bars.map((bar) => bar.map((beat) => ({ ...beat,
    grace: beat.grace?.map((pitch) => pitch + delta),
    notes: beat.notes.map((note) => note.string ? { ...note, midi: tuning[note.string - 1] + note.fret! } : note),
  })))
  return { ...track, capo, tuning, bars: shift(track.bars),
    voices: track.voices?.map((voice) => ({ ...voice, bars: shift(voice.bars) })),
  }
}

function App({ preference, setPreference }: { preference: LanguagePreference; setPreference: (value: LanguagePreference) => void }) {
  const { language, t } = useLanguage()
  const [state, dispatch] = useReducer(history, { past: [], value: null, future: [] })
  const project = state.value
  const [saved, setSaved] = useState<Project | null>(null)
  const [path, setPath] = useState<string | null>(null)
  const [recovery, setRecovery] = useState(readRecovery)
  const [part, setPart] = useState<string | null>(null)
  const [selection, setSelection] = useState<Position>({ track: '', bar: 0, beat: 0 })
  const [selectedBars, setSelectedBars] = useState<number[]>([])
  const rangeAnchor = useRef<number | null>(null)
  const [barMenu, setBarMenu] = useState<{ x: number; y: number; position: Position } | null>(null)
  const [pasteStructure, setPasteStructure] = useState(false)
  const [pasteWarning, setPasteWarning] = useState<{ text: string; apply: () => void } | null>(null)
  const [notice, setNotice] = useState<Message | null>(null)
  const [error, setError] = useState<Message | null>(null)
  const [playhead, setPlayhead] = useState<Position | null>(null)
  const [audioState, setAudioState] = useState<'idle' | 'loading' | 'playing'>('idle')
  const [panel, setPanel] = useState<'settings' | 'export' | 'track' | 'paper' | 'sounds' | null>(null)
  const [confirm, setConfirm] = useState<(() => void) | null>(null)
  const [exportMode, setExportMode] = useState<ExportMode>('current')
  const [exportFormat, setExportFormat] = useState<ExportFormat>('pdf')
  const [exportParts, setExportParts] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [printJob, setPrintJob] = useState<PrintJob | null>(null)
  const [previewPages, setPreviewPages] = useState(0)
  const [zoom, setZoom] = useState(100)
  const fileInput = useRef<HTMLInputElement>(null)
  const copied = useRef<MeasureClipboard | null>(null)
  const afterRender = useRef<{ resolve: (pages: HTMLElement[]) => void; reject: (reason: Error) => void } | null>(null)
  const jobId = useRef(0)
  const dirty = !!project && saved !== project
  const activePart = project?.tracks.some((track) => track.id === part) ? part : null
  useEffect(() => {
    if (audioState !== 'idle') {
      stopPlayback()
      setAudioState('idle')
      setPlayhead(null)
    }
  }, [project, activePart])
  const track = project?.tracks.find((track) => track.id === (activePart ?? selection.track)) ?? project?.tracks[0]
  const barIndex = project ? Math.min(selection.bar, project.measures.length - 1) : 0
  const barSettings = project ? measureSettings(project, barIndex) : null
  const activeVoice = track?.id === selection.track && selection.voice && track.voices?.[selection.voice - 1] ? selection.voice : 0
  const beats = project && track ? beatList(project, voiceBars(track, activeVoice)[barIndex], barIndex) : []
  const position: Position = { track: track?.id ?? '', bar: barIndex, beat: Math.min(selection.beat, Math.max(0, beats.length - 1)),
    lane: track?.id === selection.track ? selection.lane : undefined, voice: activeVoice, note: selection.note, string: selection.string }
  const beat = beats[position.beat] ?? blank()
  const mode = track ? activePart ? track.layout.mode ?? track.mode : track.mode : 'numbered'
  const entryMode = mode === 'staff-tab' && position.lane === 'staff' ? 'staff'
    : mode === 'staff-numbered' ? position.lane === 'numbered' ? 'numbered' : 'staff' : mode
  const viewLayout = project && activePart ? track!.layout : project?.layout
  const page = project ? paperDimensions(paperFor(project, activePart)) : paperDimensions()
  const activeRef = useRef({ project, dirty, path, saved, busy })
  activeRef.current = { project, dirty, path, saved, busy }
  const commit = (edit: (score: Project) => Project) => dispatch({ type: 'edit', edit })
  const measureSelection = selectedBars.filter((index) => index < (project?.measures.length ?? 0))
  const measureDrag = useMeasureDrag(({ clientX, clientY }) => measureButton(document.elementFromPoint(clientX, clientY)), selectMeasureRange)

  function measureButton(element: Element | null) {
    const bar = element?.closest<HTMLButtonElement>('[data-measure-index]')?.dataset.measureIndex
    return bar === undefined ? undefined : { ...position, bar: Number(bar), beat: 0 }
  }

  useEffect(() => {
    if (!project) return
    try {
      if (dirty) localStorage.setItem(storage.recoveryKey, JSON.stringify(project))
      else localStorage.removeItem(storage.recoveryKey)
    } catch { setError(message('无法写入恢复草稿。请保存工程。')) }
  }, [project, dirty])

  function load(score: Project | null, filename: string | null = null, clean = false) {
    stopPlayback()
    setAudioState('idle')
    setError(null)
    setNotice(null)
    setPanel(null)
    setPart(null)
    setPath(filename)
    setSaved(clean ? score : null)
    setSelection({ track: score?.tracks[0].id ?? '', bar: 0, beat: 0 })
    setSelectedBars([])
    rangeAnchor.current = null
    if (copied.current?.all) copied.current = null
    setBarMenu(null)
    setPasteWarning(null)
    dispatch({ type: 'open', score })
  }
  async function persist(saveAs = false) {
    const current = activeRef.current
    if (!current.project) return false
    try {
      const data = JSON.stringify(current.project, null, 2)
      if (storage.desktop) {
        const target = !saveAs && current.path ? current.path : await storage.savePath(current.project.title, t)
        if (!target) return false
        await storage.writeFile(target, data)
        setPath(target)
      } else storage.downloadProject(current.project.title, data, t)
      setSaved(current.project)
      if (activeRef.current.project === current.project) {
        try { localStorage.removeItem(storage.recoveryKey) } catch { /* The file is already saved. */ }
      }
      setError(null)
      setNotice(message('工程已保存'))
      return true
    } catch (cause) {
      setError(message('保存失败。', undefined, cause))
      return false
    }
  }
  function whenClean(action: () => void) {
    if (activeRef.current.dirty) setConfirm(() => action)
    else action()
  }
  function discard(action: () => void) {
    try { localStorage.removeItem(storage.recoveryKey) } catch { /* Storage can be unavailable. */ }
    setRecovery(null)
    setConfirm(null)
    action()
  }
  async function openProject() {
    if (!storage.desktop) { fileInput.current?.click(); return }
    try {
      const file = await storage.pickProject(t)
      if (typeof file !== 'string') return
      const score = parseProject(await storage.readFile(file))
      whenClean(() => load(score, file, true))
    } catch (cause) { setError(message('打开失败。', undefined, cause)) }
  }
  async function fromBrowser(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0]
    event.currentTarget.value = ''
    if (!file) return
    try {
      if (file.size > 16 * 1024 * 1024) throw new Error('项目文件超过 16 MB。')
      const score = parseProject(await file.text())
      whenClean(() => load(score, null, true))
    } catch (cause) { setError(message('打开失败。', undefined, cause)) }
  }
  useEffect(() => {
    if (!storage.desktop) return
    let disposed = false
    let unlisten: (() => void) | undefined
    const windowHandle = getCurrentWindow()
    void windowHandle.onCloseRequested((event) => {
      if (activeRef.current.busy) { event.preventDefault(); return }
      if (activeRef.current.dirty) {
        event.preventDefault()
        setConfirm(() => () => { void windowHandle.destroy() })
      }
    }).then((stop) => { if (disposed) stop(); else unlisten = stop })
    return () => { disposed = true; unlisten?.() }
  }, [])
  useEffect(() => {
    if (storage.desktop || !dirty) return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])
  useEffect(() => {
    function shortcuts(event: KeyboardEvent) {
      if (event.isComposing) return
      if (event.key === 'Escape' && !panel && !confirm && !pasteWarning && !barMenu) {
        setSelectedBars([])
        rangeAnchor.current = null
      }
      if (!event.ctrlKey && !event.metaKey) return
      const key = event.key.toLowerCase()
      if (key === 's' && activeRef.current.project) {
        event.preventDefault()
        if (!activeRef.current.busy) void persist(event.shiftKey)
      }
      if (key === 'z' && !panel && !confirm && !pasteWarning && !barMenu && !(event.target instanceof HTMLElement && event.target.matches('input,textarea'))) {
        event.preventDefault()
        dispatch({ type: event.shiftKey ? 'redo' : 'undo' })
      }
      const textInput = event.target instanceof HTMLElement &&
        (event.target.matches('input, textarea, select') || event.target.isContentEditable)
      if (!project || panel || confirm || pasteWarning || busy || textInput || event.altKey || event.shiftKey) return
      if (key === 'c' || key === 'v') {
        event.preventDefault()
        if (key === 'c') copySelection()
        else pasteSelection(measureSelection.length > 1 ? 'selection' : 'overwrite', measureSelection[0] ?? barIndex)
      }
    }
    window.addEventListener('keydown', shortcuts)
    return () => window.removeEventListener('keydown', shortcuts)
  })

  function move(step: 1 | -1) {
    if (!project || !track) return
    setSelectedBars([])
    rangeAnchor.current = null
    // Wait for the current edit to update the available beat positions.
    setSelection((current) => {
      if (step < 0 && position.beat === 0) {
        if (!position.bar) return position
        return { ...position, bar: position.bar - 1, beat: beatList(project, voiceBars(track, activeVoice)[position.bar - 1], position.bar - 1).length - 1 }
      }
      return { ...current, ...position, beat: position.beat + step, note: undefined, string: undefined }
    })
  }
  // A newly entered duration can shrink the list. Advance to the next measure
  // only after the reducer has applied that duration.
  useEffect(() => {
    if (!project || !track || selection.beat < beats.length) return
    if (barIndex + 1 < project.measures.length) setSelection({ ...position, bar: barIndex + 1, beat: 0 })
    else setSelection({ ...position, beat: Math.max(0, beats.length - 1) })
  }, [project, track, barIndex, beats.length, selection.beat])

  function selectView(id: string | null) {
    setPart(id)
    setSelectedBars([])
    rangeAnchor.current = null
    setBarMenu(null)
    if (id) setSelection({ track: id, bar: barIndex, beat: 0, voice: id === position.track ? activeVoice : 0 })
  }
  function selectBeat(target: Position) {
    setSelectedBars([])
    rangeAnchor.current = null
    setBarMenu(null)
    setSelection(target)
  }
  function selectMeasure(target: Position, event: MouseEvent) {
    const anchor = rangeAnchor.current ?? barIndex
    const previous = target.track === position.track && (target.voice ?? 0) === activeVoice ? measureSelection : []
    let next = [target.bar]
    if (event.shiftKey) {
      const start = Math.min(anchor, target.bar)
      next = Array.from({ length: Math.abs(anchor - target.bar) + 1 }, (_, index) => start + index)
    } else {
      if ((event.ctrlKey || event.metaKey) && previous.length) {
        next = previous.includes(target.bar) ? previous.filter((index) => index !== target.bar) : [...previous, target.bar].sort((a, b) => a - b)
      }
      rangeAnchor.current = target.bar
    }
    setBarMenu(null)
    setSelectedBars(next)
    setSelection({ ...target, beat: 0, note: undefined, string: undefined })
  }
  function selectMeasureRange(start: Position, end: number) {
    const first = Math.min(start.bar, end)
    setSelectedBars(Array.from({ length: Math.abs(start.bar - end) + 1 }, (_, index) => first + index))
    setSelection({ ...start, beat: 0, note: undefined, string: undefined })
    rangeAnchor.current = start.bar
  }
  function putTuplet(from: Position, to: Position, ratio?: [number, number]) {
    if (!project || !track || from.track !== to.track || (from.voice ?? 0) !== (to.voice ?? 0) || from.bar !== to.bar) return false
    const range = beatRange(project, track, from, to)
    if (!range.length || range.some(({ beat }) => beat.draft) || ratio && range.length !== ratio[0]) return false
    const groups = new Set(range.map(({ beat }) => beat.tupletGroup).filter(Boolean))
    const all = voiceBars(track, from.voice)[from.bar]
    const cleared = all.flatMap((beat, index) => beat.tupletGroup && groups.has(beat.tupletGroup)
      ? [{ ...from, beat: index }] : [])
    const group = ratio ? crypto.randomUUID() : undefined
    commit((score) => {
      const without = cleared.reduce((current, position) => changeBeat(current, position, (beat) => ({
        ...beat, tuplet: undefined, tupletGroup: undefined, triplet: false,
      })), score)
      return range.reduce((current, { position }) => changeBeat(current, position, (beat) => ({
        ...beat, tuplet: ratio, tupletGroup: group, triplet: false,
      })), without)
    })
    return true
  }
  function putSpan(from: Position, to: Position, span: SpanEnd) {
    if (!project || !track || from.track !== to.track || (from.voice ?? 0) !== (to.voice ?? 0) || from.bar === to.bar && from.beat === to.beat) return false
    const bars = voiceBars(track, from.voice)
    if ([from, to].some(({ bar, beat }) => !bars[bar] ||
      !beatList(project, bars[bar], bar)[beat] || (bars[bar][beat]?.spans?.length ?? 0) >= 32)) return false
    const [first, last] = from.bar < to.bar || from.bar === to.bar && from.beat < to.beat ? [from, to] : [to, from]
    commit((score) => changeBeat(changeBeat(score, first, (beat) => ({
      ...beat, draft: false, spans: [...beat.spans ?? [], span],
    })), last, (beat) => ({ ...beat, draft: false, spans: [...beat.spans ?? [], { ...span, end: true }] })))
    return true
  }
  function removeSpan(id: string) {
    const remove = (bars: Beat[][]) => bars.map((bar) => bar.map((beat) => beat.spans?.some((point) => point.id === id)
      ? { ...beat, spans: beat.spans.filter((point) => point.id !== id) } : beat))
    commit((score) => updateTrack(score, position.track, (track) => ({ ...track,
      bars: remove(track.bars), voices: track.voices?.map((voice) => ({ ...voice, bars: remove(voice.bars) })),
    })))
  }
  function showBarMenu(target: Position, event: MouseEvent) {
    event.preventDefault()
    if (!measureSelection.includes(target.bar) || target.track !== position.track || (target.voice ?? 0) !== activeVoice) selectMeasure(target, event)
    setPasteStructure(false)
    setBarMenu({ x: Math.max(0, Math.min(event.clientX, window.innerWidth - 265)), y: Math.max(0, Math.min(event.clientY, window.innerHeight - 310)), position: target })
  }
  function copySelection(all = false) {
    if (!project || !track) return
    const indices = measureSelection.length ? measureSelection : [barIndex]
    copied.current = copyMeasures(project, indices, track.id, all, activeVoice)
    setError(null)
    setNotice(message(copied.current.omittedLink ? '已复制 {count} 小节，跨选区连线已略过。' : '已复制 {count} 小节。', { count: indices.length }))
    setBarMenu(null)
  }
  function pasteSelection(mode: PasteMode, anchor = barIndex, includeStructure = false) {
    if (!project || !track) return
    setBarMenu(null)
    const clip = copied.current
    if (!clip) { setNotice(message('请先复制一个小节')); return }
    if (clip.all && activePart) { setError(message('请回到总谱粘贴完整声部。')); return }
    const result = pasteMeasures(project, clip, track.id, mode, measureSelection, anchor, includeStructure, activeVoice)
    if (result.error === 'length') {
      setPasteWarning({ text: t('复制了 {copied} 小节，选中了 {selected} 小节。是否从选区首小节起连续覆盖？', { copied: clip.measures.length, selected: measureSelection.length }),
        apply: () => pasteSelection('overwrite', measureSelection[0], includeStructure) })
      return
    }
    if (result.error === 'end') {
      setPasteWarning({ text: t('覆盖将超出曲尾。是否把复制的小节插入到曲尾？'), apply: () => pasteSelection('append', anchor, includeStructure) })
      return
    }
    if (result.error) {
      setError(message(result.error === 'limit' ? '插入后会超过 256 小节。' : result.error === 'simile' ? '不能拆开两小节重复。' : '只能粘贴到定弦相同或同为非吉他的乐器。'))
      return
    }
    const apply = () => {
      if (activeRef.current.project !== project) return
      stopPlayback()
      setAudioState('idle')
      commit(() => result.score)
      setSelectedBars(result.targets)
      rangeAnchor.current = result.targets[0]
      setSelection({ ...position, bar: result.targets[0], beat: 0 })
      setError(null)
      setNotice(message('已粘贴 {count} 小节。', { count: result.targets.length }))
    }
    const route = resolveScoreNavigation(result.score.measures)
    const routeWarning = (includeStructure || mode === 'before' || mode === 'after' || mode === 'append') && route.diagnostics[0]
    const warnings = [
      routeWarning ? navigationMessage(t, language, routeWarning) : '',
      result.overfull.length ? t('以下小节超出拍数：{bars}', { bars: result.overfull.map((index) => index + 1).join(', ') }) : '',
      result.affectedLink ? t('粘贴边界有连线，继续会清除受影响的连线。') : '',
    ].filter(Boolean)
    if (warnings.length) setPasteWarning({ text: warnings.join(' '), apply })
    else apply()
  }
  function patchLayout(changes: Partial<Layout>) {
    commit((score) => activePart ? updateTrack(score, activePart, (item) => ({ ...item, layout: { ...item.layout, ...changes } }))
      : { ...score, layout: { ...score.layout, ...changes } })
  }
  function patchMeasure(changes: Partial<Measure>) {
    commit((score) => {
      const measures = score.measures.slice()
      const current = measures[barIndex]
      if (Object.hasOwn(changes, 'simile')) {
        if (current.simile === 'double' && measures[barIndex + 1]?.simile === 'double-second') {
          measures[barIndex + 1] = { ...measures[barIndex + 1], simile: undefined }
        }
        if (current.simile === 'double-second' && measures[barIndex - 1]?.simile === 'double') {
          measures[barIndex - 1] = { ...measures[barIndex - 1], simile: undefined }
        }
        if (changes.simile === 'double' && measures[barIndex + 1]) {
          if (measures[barIndex + 1].simile === 'double' && measures[barIndex + 2]?.simile === 'double-second') {
            measures[barIndex + 2] = { ...measures[barIndex + 2], simile: undefined }
          }
          measures[barIndex + 1] = { ...measures[barIndex + 1], simile: 'double-second' }
        }
      }
      measures[barIndex] = { ...current, ...changes }
      return { ...score, measures }
    })
  }
  function addVoice(staff: 0 | 1) {
    if (!project || !track || (track.voices?.length ?? 0) >= 3) return
    const voice = (track.voices?.length ?? 0) + 1
    commit((score) => updateTrack(score, track.id, (item) => ({ ...item,
      voices: [...item.voices ?? [], { staff, bars: score.measures.map(() => []) }],
    })))
    selectBeat({ ...position, voice, beat: 0 })
  }
  function selectMode(next: Mode) {
    if (!track) return
    if (activePart) patchLayout({ mode: next })
    else commit((score) => updateTrack(score, track.id, (item) => ({ ...item, mode: next })))
  }
  function printRendered(pages: HTMLElement[]) {
    afterRender.current?.resolve(pages)
    afterRender.current = null
  }
  function showExport() {
    setExportMode('current')
    setExportParts(project!.tracks.map((item) => item.id))
    setPreviewPages(0)
    setPanel('export')
  }
  const previewPart = exportMode === 'score' ? null : exportMode === 'parts' ? exportParts[0] ?? activePart : activePart
  const previewPaper = project ? paperFor(project, previewPart) : undefined
  const printDimensions = printJob ? paperDimensions(paperFor(printJob.project, printJob.part)) : paperDimensions(previewPaper)
  async function exportSelection() {
    if (!project || busy) return
    setError(null)
    const images = exportFormat === 'png'
    if (!storage.desktop && !images) { window.print(); return }
    const batch = exportMode === 'parts'
    const targets = batch ? exportParts : [previewPart]
    if (!targets.length) { setError(message('请至少选择一份分谱。')); return }
    const folder = batch || (images && previewPages > 1)
    setBusy(true)
    let completed = 0
    try {
      const scoreTitle = storage.fileName(project.title, t)
      const targetName = (id: string | null) => storage.fileName(scoreName(project, id, t), t)
      const title = scoreTitle + ' - ' + targetName(targets[0])
      const pickFile = images ? storage.pickPng : storage.pickPdf
      const destination = storage.desktop
        ? folder ? await storage.pickDirectory(t, images) : await pickFile(title, t)
        : ''
      if (destination === null) return
      for (const [index, item] of targets.entries()) {
        const name = batch ? scoreTitle + ' - ' + String(index + 1).padStart(2, '0') + ' ' + targetName(item) : title
        const pages = await new Promise<HTMLElement[]>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('乐谱排版超时。')), 15000)
          afterRender.current = {
            resolve: (pages) => { clearTimeout(timeout); requestAnimationFrame(() => requestAnimationFrame(() => resolve(pages))) },
            reject: (cause) => { clearTimeout(timeout); reject(cause) },
          }
          setPrintJob({ project, part: item, key: ++jobId.current })
        })
        await document.fonts.ready
        if (images) {
          for (const [pageIndex, page] of pages.entries()) {
            const suffix = pages.length > 1 ? t(' - 第 {page} 页', { page: String(pageIndex + 1).padStart(2, '0') }) : ''
            const filename = name + suffix + '.png'
            const png = await renderPng(page)
            if (storage.desktop) {
              await storage.exportPng(folder ? destination + '\\' + filename : destination, !folder, png)
            } else {
              storage.downloadBlob(filename, png)
            }
            completed++
          }
        } else {
          const { width, height } = paperDimensions(paperFor(project, item))
          await storage.exportPdf(folder ? destination + '\\' + name + '.pdf' : destination, !folder, width, height)
          completed++
        }
      }
      setNotice(message(images ? '已导出 {count} 张 PNG 图片' : '已导出 {count} 份 PDF', { count: completed }))
      setPanel(null)
    } catch (cause) {
      setError(message('导出中断，已完成 {count} 份。', { count: completed }, cause))
    } finally {
      afterRender.current = null
      setBusy(false)
      setPrintJob(null)
    }
  }
  async function togglePlay() {
    if (!project) return
    if (audioState !== 'idle') { stopPlayback(); setAudioState('idle'); setPlayhead(null); return }
    const problem = resolveScoreNavigation(project.measures).diagnostics[0]
    if (problem) { setError(message('无法试听。', undefined, navigationMessage(t, language, problem))); return }
    try {
      setAudioState('loading')
      await playScore(project, activePart, () => { setAudioState('idle'); setPlayhead(null) }, () => setAudioState('playing'), position, setPlayhead)
    }
    catch (cause) { setAudioState('idle'); setPlayhead(null); setError(message('无法试听。', undefined, cause)) }
  }

  function startProject(template: Parameters<typeof createProject>[0]) {
    load(createProject(template, {
      untitled: t('未命名曲谱'), demo: t('沿着晚风'), demoAuthor: t('叶子弦谱示例'),
      tracks: { voice: t(kinds.voice), guitar: t(kinds.guitar), instrument: t(kinds.instrument) },
    }))
  }

  const visible = project?.tracks.filter((item) => !activePart || item.id === activePart) ?? []
  return <>
    <input ref={fileInput} type="file" accept=".xianpu" hidden onChange={fromBrowser} />
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="https://space.bilibili.com/40005809" target="_blank" rel="noopener noreferrer"
          aria-label={t('{name} · 打开 B 站主页', { name: t(appName) })} onClick={(event) => {
            if (!storage.desktop) return
            event.preventDefault()
            void storage.openCreatorPage().catch(() => setError(message('无法打开 B 站主页。')))
          }}>
          <span className="brand-icon" aria-hidden="true">♬</span>
          <span><strong>{t(appName)}</strong>{language === 'zh' && <small>YEZI XIANPU</small>}</span>
        </a>
        <div className="toolbar" aria-label={t('主工具栏')}>
          {project && <button onClick={() => whenClean(() => load(null))}>{t('新建')}</button>}
          <button disabled={!!recovery && !project} onClick={() => void openProject()}>{t('打开')}</button>
          {project && <><button onClick={() => void persist()}>{t('保存')}{dirty ? ' •' : ''}</button><button onClick={() => void persist(true)}>{t('另存为')}</button>
          <span className="toolbar-rule" /><button disabled={!state.past.length} onClick={() => dispatch({ type: 'undo' })}>{t('撤销')}</button>
          <button disabled={!state.future.length} onClick={() => dispatch({ type: 'redo' })}>{t('重做')}</button></>}
        </div>
        <div className="top-actions"><select className="language-select" aria-label={t('界面语言')} value={preference}
          disabled={busy} onChange={(event) => setPreference(event.target.value as LanguagePreference)}>
          <option value="system">{t('跟随系统')}</option><option value="zh" lang="zh-CN">简体中文</option><option value="en" lang="en">English</option>
        </select>{project ? <>
          <button className="quiet" aria-busy={audioState === 'loading'} onClick={() => void togglePlay()}>{audioState !== 'idle' ? '■ ' + t('停止') : '▶ ' + t('试听')}</button>
          <button className="primary" onClick={showExport}>{t('导出')}</button>
        </> : <span className="tag">{t('离线写谱工作台')}</span>}</div>
      </header>
      {!project ? <main className="home">
        <div className="home-copy"><span className="eyebrow">{t('你的本地乐谱工作台')}</span><h1>{t('从第一小节开始')}</h1>
          <p>{t('写简谱、吉他谱，或把乐队的声部放进同一份总谱。')}</p></div>
        {recovery && <div className="recover"><div><strong>{t('发现未保存的草稿')}</strong><p>{recovery.title}</p></div>
          <button className="primary" onClick={() => { load(recovery); setRecovery(null) }}>{t('恢复草稿')}</button>
          <button onClick={() => discard(() => {})}>{t('丢弃草稿')}</button></div>}
        <div className="templates">{templates.map((template) => <button key={template.id} className="template" disabled={!!recovery} onClick={() => startProject(template.id)}>
          <span className="notation">{template.notation}</span><strong>{t(template.title)}</strong><span>{t(template.description)}</span><span className="template-action">{t('新建乐谱')} ↗</span>
        </button>)}</div>
        <div className="demo-callout"><div><strong>{t('打开一份已经写好的谱')}</strong><p>{t('8 小节，包含人声、吉他与五线谱乐器。')}</p></div>
          <button disabled={!!recovery} onClick={() => startProject('demo')}>{t('打开弹唱示例')}</button></div>
      </main> : <main className="workspace">
        <nav className="sidebar" aria-label={t('总谱与乐器')}>
          <span className="eyebrow">{t('曲谱视图')}</span>
          <button aria-label={t('总谱')} aria-current={!activePart ? 'page' : undefined} onClick={() => selectView(null)}><span aria-hidden="true">▤</span> {t('总谱')}</button>
          <div className="sidebar-caption">{t('乐器分谱')}</div>
          {project.tracks.map((item) => <button key={item.id} aria-label={item.name} aria-current={activePart === item.id ? 'page' : undefined} onClick={() => selectView(item.id)}>
            <span>{item.kind === 'voice' ? '♪' : item.kind === 'guitar' ? '≋' : '♩'}</span><span>{item.name}</span></button>)}
          <details><summary>＋ {t('添加乐器')}</summary><div className="add-list">{(['voice', 'guitar', 'instrument'] as Kind[]).map((kind, index) =>
            <button key={kind} disabled={project.tracks.length >= 24} onClick={(event) => {
              const added = createTrack(project, kind, t(kinds[kind]))
              const count = project.tracks.filter((item) => item.kind === kind).length
              if (count) added.name += ' ' + (count + 1)
              commit((score) => ({ ...score, tracks: [...score.tracks, added] }))
              setSelection({ track: added.id, bar: barIndex, beat: 0 })
              setPart(added.id)
              event.currentTarget.closest('details')?.removeAttribute('open')
            }}>{t((['人声简谱', '吉他六线谱', '五线谱乐器'] as const)[index])}</button>)}</div></details>
          <div className="sidebar-foot">
            <button onClick={() => setPanel('settings')}>{t('曲谱设置')}</button>
            <button onClick={() => setPanel('track')}>{t('乐器设置')}</button>
            <button onClick={() => setPanel('sounds')}>{t('试听音色')}</button>
            <button onClick={() => setPanel('paper')}>{t('纸张设置')}</button>
          </div>
        </nav>
        <section className="canvas" aria-label={t('谱面工作区')}>
          <div className="canvas-heading"><div><span className="eyebrow">{scoreName(project, activePart, t)}</span>
            <h1><button className="score-title" onClick={() => setPanel('settings')} title={t('编辑谱头')}>{project.title || t('未命名曲谱')}</button></h1>
            <button className="score-heading-details" onClick={() => setPanel('settings')} aria-label={t('编辑谱头')}>
              {keyNames[barSettings!.key + 7]} · {barSettings!.meter.join('/')} · ♩ = {barSettings!.bpm}{project.author ? ' · ' + project.author : ''}
            </button></div>
            <div className="canvas-controls"><label>{t('谱式')}<select value={mode} onChange={(event) => selectMode(event.target.value as Mode)}>
              {Object.entries(modes).filter(([key]) => track?.kind === 'guitar'
                ? key !== 'piano' && key !== 'percussion' : key !== 'tab' && key !== 'staff-tab')
                .map(([key, value]) => <option key={key} value={key}>{t(value)}</option>)}</select></label>
              <label>{t('每行小节')}<select value={viewLayout!.barsPerLine} onChange={(e) => patchLayout({ barsPerLine: Number(e.target.value) })}>
                {Array.from({ length: 12 }, (_, i) => <option key={i + 1}>{i + 1}</option>)}</select></label>
              <label>{t('每页谱行')}<select value={viewLayout!.systemsPerPage} onChange={(e) => patchLayout({ systemsPerPage: Number(e.target.value) })}>
                {Array.from({ length: 6 }, (_, i) => <option key={i + 1}>{i + 1}</option>)}</select></label>
              <label>{t('缩放')}<select value={zoom} onChange={(e) => setZoom(Number(e.target.value))}>{[75, 90, 100, 125, 150].map((n) => <option key={n} value={n}>{n}%</option>)}</select></label></div></div>
          <div className="paper-scroll"><div className="paper" style={{ width: page.width * zoom / 100 + 'mm', paddingInline: paperMargin * zoom / 100 + 'mm' }}>
            <ScoreView project={project} part={activePart} position={position} playhead={audioState === 'playing' ? playhead : null} selectedBars={measureSelection} scale={zoom / 100} onSelect={selectBeat}
              onBarSelect={selectMeasure} onBarRange={selectMeasureRange} onBarMenu={showBarMenu} onError={(cause) => setError(message('谱面绘制失败。', undefined, cause))} />
          </div></div>
          <section className="position-panel" aria-label={t('小节与录入位置')}>
            <div className="position-header"><div><strong>{t('录入位置')}</strong><small>{t('可直接点谱面，也可在这里选择。')}</small>
              {!!track?.voices?.length && <label>{t('编辑声部')}<select value={activeVoice} onChange={(event) =>
                selectBeat({ ...position, voice: Number(event.target.value), beat: 0 })}>
                <option value={0}>{t('主声部')}</option>
                {track.voices.map((voice, index) => <option value={index + 1} key={index}>{t('附加声部 {number}', { number: index + 1 })}
                  {voice.staff === 1 ? ' · ' + t('下谱表') : ''}</option>)}
              </select></label>}
            </div>
              <div className="inline">
                <button disabled={project.measures.length >= 256 || project.measures[barIndex].simile === 'double'}
                  title={project.measures[barIndex].simile === 'double' ? t('不能拆开两小节重复。') : undefined} onClick={() => {
                  commit((score) => measuresChange(score, barIndex + 1, true)); selectBeat({ ...position, bar: barIndex + 1, beat: 0 })
                }}>{t('插入小节')}</button>
                <button disabled={project.measures.length <= 1} onClick={() => {
                  commit((score) => measuresChange(score, barIndex, false)); selectBeat({ ...position, bar: Math.min(barIndex, project.measures.length - 2), beat: 0 })
                }}>{t('删除小节')}</button>
                <button title="Ctrl+C" onClick={() => copySelection()}>{t('复制小节')}</button>
                <button title="Ctrl+V" onClick={() => pasteSelection(measureSelection.length > 1 ? 'selection' : 'overwrite', measureSelection[0] ?? barIndex)}>{t('粘贴小节')}</button>
                <button disabled={!copied.current} onClick={() => pasteSelection('before')}>{t('在前面插入粘贴')}</button>
              </div></div>
            {measureSelection.length > 0 && <small>{t('{track} · 所选小节 {bars}', { track: track!.name, bars: measureSelection.map((index) => index + 1).join(', ') })}</small>}
            <div className="measure-list" aria-label={t('选择小节')} {...measureDrag.handlers} onPointerDown={(event) => {
              const target = measureButton(event.target instanceof Element ? event.target : null)
              if (!target || event.button !== 0 || event.shiftKey || event.ctrlKey || event.metaKey) return
              selectMeasure(target, event)
              measureDrag.start(event, target)
            }}>
              {project.measures.map((_, index) => {
                const difference = measureDifference(project, track!, index, activeVoice)
                const hint = difference ? t(difference > 0 ? '还差 {beats} 拍' : '超出 {beats} 拍', { beats: formatBeats(difference, language) }) : t('拍数完整')
                return <button key={index} data-measure-index={index} aria-label={t('第 {bar} 小节，{status}', { bar: index + 1, status: hint })}
                  aria-pressed={measureSelection.includes(index)} data-current={index === barIndex} title={hint}
                  onClick={(event) => {
                    if (!event.detail || event.shiftKey || event.ctrlKey || event.metaKey) selectMeasure({ ...position, bar: index }, event)
                  }} onContextMenu={(event) => showBarMenu({ ...position, bar: index }, event)}>
                  {index + 1}<span aria-label={hint} className={difference < 0 ? 'over' : difference > 0 ? 'under' : 'full'}>●</span>
                </button>
              })}
            </div>
            {track && measureDifference(project, track, barIndex, activeVoice) !== 0 && <p className={'measure-status ' + (measureDifference(project, track, barIndex, activeVoice) < 0 ? 'over' : 'under')}>
              {t('{track}第 {bar} 小节{status}', { track: track.name, bar: barIndex + 1,
                status: t(measureDifference(project, track, barIndex, activeVoice) > 0 ? '还差 {beats} 拍' : '超出 {beats} 拍',
                  { beats: formatBeats(measureDifference(project, track, barIndex, activeVoice), language) }) })}
            </p>}
            {visible.map((item) => <div className="beat-row" key={item.id}><strong>{item.name}</strong><div>
              {beatList(project, voiceBars(item, item.id === position.track ? activeVoice : 0)[barIndex], barIndex).map((value, index) => <button key={index}
                aria-label={t('{track}位置 {beat}', { track: item.name, beat: index + 1 })} aria-pressed={item.id === position.track && index === position.beat}
                onClick={() => selectBeat({ track: item.id, bar: barIndex, beat: index, voice: item.id === position.track ? activeVoice : 0 })}>
                <small>{index + 1}</small><span>{value.draft ? '·' : value.notes.length ? value.notes.map((note) => note.string ? note.fret : pitchNames[note.midi % 12]).join('·') : t('休')}</span>
              </button>)}
            </div></div>)}
          </section>
        </section>
        {track && <Editor suspended={!!(panel || confirm || pasteWarning || barMenu)} score={project} track={track} position={position} mode={entryMode} beat={beat}
          edit={(edit) => commit((score) => changeBeat(score, position, edit))} putSpan={putSpan} removeSpan={removeSpan} putTuplet={putTuplet} next={() => move(1)} previous={() => move(-1)} />}
        {(panel || confirm || pasteWarning || barMenu) && <div className="inspector inspector-placeholder" aria-hidden="true" />}
      </main>}
      <footer className="status-bar"><span>{project ? (dirty ? '● ' + t('未保存') : '✓ ' + t('已保存')) : t('叶子弦谱 · 本地工作区')}</span>
        <span role="status">{audioState === 'loading' ? t('正在载入音色…') : notice ? displayMessage(t, notice) : t(project ? '乐谱与草稿保存在本机' : '选择模板，或打开已有工程')}</span></footer>
      {error && panel !== 'export' && <div role="alert" className="toast"><span>{displayMessage(t, error)}</span><button aria-label={t('关闭提示')} onClick={() => setError(null)}>×</button></div>}
    </div>
    {barMenu && <div className="bar-menu-layer" onPointerDown={() => setBarMenu(null)} onKeyDown={(event) => { if (event.key === 'Escape') setBarMenu(null) }}>
      <div className="bar-menu" role="group" aria-label={t('小节操作')} style={{ left: barMenu.x, top: barMenu.y }} onPointerDown={(event) => event.stopPropagation()}>
        <button autoFocus onClick={() => copySelection()}>{t('复制小节')}</button>
        {!activePart && <button onClick={() => copySelection(true)}>{t('复制整段总谱')}</button>}
        <button disabled={!copied.current || measureSelection.length < 2} onClick={() => pasteSelection('selection', barMenu.position.bar, pasteStructure)}>{t('覆盖所选小节')}</button>
        <button disabled={!copied.current} onClick={() => pasteSelection('overwrite', barMenu.position.bar, pasteStructure)}>{t('从这里开始覆盖')}</button>
        <button disabled={!copied.current} onClick={() => pasteSelection('before', barMenu.position.bar, pasteStructure)}>{t('在前面插入粘贴')}</button>
        <button disabled={!copied.current} onClick={() => pasteSelection('after', barMenu.position.bar, pasteStructure)}>{t('在后面插入粘贴')}</button>
        {copied.current?.all && !activePart && <label className="checkbox"><input type="checkbox" checked={pasteStructure} onChange={(event) => setPasteStructure(event.target.checked)} />{t('包含结构记号')}</label>}
      </div>
    </div>}
    {pasteWarning && <Modal title={t('确认粘贴')} close={() => setPasteWarning(null)}>
      <p>{pasteWarning.text}</p>
      <div className="inline"><button className="primary" onClick={() => { setPasteWarning(null); pasteWarning.apply() }}>{t('继续粘贴')}</button>
        <button onClick={() => setPasteWarning(null)}>{t('取消')}</button></div>
    </Modal>}
    {project && panel === 'sounds' && <Modal title={t('试听音色')} close={() => setPanel(null)}>
      <SoundEditor tracks={project.tracks} onChange={(sound, id) => {
        stopPlayback()
        setAudioState('idle')
        commit((score) => ({ ...score, tracks: score.tracks.map((item) => !id || item.id === id ? { ...item, sound } : item) }))
      }} />
    </Modal>}
    {project && panel === 'paper' && <Modal title={t('纸张设置')} close={() => setPanel(null)}>
      <PaperEditor paper={viewLayout?.paper} inherited={activePart ? project.layout.paper ?? { size: 'a4' } : undefined}
        onApply={(paper) => { patchLayout({ paper }); setPanel(null) }} />
    </Modal>}
    {project && panel === 'settings' && <Modal title={t('曲谱设置')} close={() => setPanel(null)}>
      <label>{t('曲名')}<input maxLength={200} value={project.title} onChange={(e) => commit((score) => ({ ...score, title: e.target.value }))} /></label>
      <label>{t('作者')}<input maxLength={200} value={project.author} onChange={(e) => commit((score) => ({ ...score, author: e.target.value }))} /></label>
      {Object.entries(creditFields).map(([key, label]) => {
        const field = key as keyof typeof creditFields
        return <label key={field}>{t(label)}<input maxLength={200} value={project.credits?.[field] ?? ''}
          onChange={(event) => commit((score) => ({ ...score, credits: { ...score.credits, [field]: event.target.value } }))} /></label>
      })}
      <div className="inline"><label>{t('调号')}<select value={project.key} onChange={(e) => commit((score) => ({ ...score, key: Number(e.target.value) }))}>
        {keyNames.map((name, i) => <option key={name} value={i - 7}>{t('{name} 大调', { name })}</option>)}</select></label>
        <label>{t('拍号')}<select value={project.meter.join('/')} onChange={(e) => {
          const meter = e.target.value.split('/').map(Number) as [number, number]
          commit((score) => ({ ...score, meter, pickup: Math.min(score.pickup, meter[0] - 1) }))
        }}>{meters.map((meter) => <option key={meter}>{meter}</option>)}</select></label>
        <label>{t('速度 BPM')}<input type="number" key={project.bpm} defaultValue={project.bpm} min={20} max={300}
          onBlur={(e) => { const bpm = Math.min(300, Math.max(20, Number(e.target.value) || project.bpm)); if (bpm !== project.bpm) commit((score) => ({ ...score, bpm })) }} /></label>
      </div>
      <label>{t('弱起 · 首小节拍数')}<select value={project.pickup} onChange={(e) => commit((score) => ({ ...score, pickup: Number(e.target.value) }))}>
        <option value={0}>{t('无弱起')}</option>{Array.from({ length: project.meter[0] - 1 }, (_, i) => <option key={i + 1} value={i + 1}>{i + 1}</option>)}</select></label>
      <fieldset><legend>{t('第 {bar} 小节的调号、拍号与速度', { bar: barIndex + 1 })}</legend><div className="inline small-gap">
        <label>{t('曲中调号')}<select value={project.measures[barIndex].key ?? ''} onChange={(event) =>
          patchMeasure({ key: event.target.value ? Number(event.target.value) : undefined })}>
          <option value="">{t('沿用前文')}</option>{keyNames.map((name, i) => <option key={name} value={i - 7}>{name}</option>)}
        </select></label>
        <label>{t('曲中拍号')}<select value={project.measures[barIndex].meter?.join('/') ?? ''} onChange={(event) =>
          patchMeasure({ meter: event.target.value ? event.target.value.split('/').map(Number) as Measure['meter'] : undefined })}>
          <option value="">{t('沿用前文')}</option>{meters.map((meter) => <option key={meter}>{meter}</option>)}
        </select></label>
        <label>{t('曲中速度')}<input key={barIndex} type="number" min={20} max={300} placeholder={t('沿用前文')} defaultValue={project.measures[barIndex].bpm ?? ''}
          onBlur={(event) => {
            const bpm = event.target.value ? Math.round(Math.min(300, Math.max(20, Number(event.target.value)))) : undefined
            if (bpm !== project.measures[barIndex].bpm) patchMeasure({ bpm })
          }} /></label>
      </div></fieldset>
      <fieldset><legend>{t('第 {bar} 小节的反复记号', { bar: barIndex + 1 })}</legend>
        {(['start', 'end'] as const).map((side) => <label className="checkbox" key={side}>
          <input type="checkbox" checked={!!project.measures[barIndex][side]} onChange={(e) => commit((score) => ({ ...score,
            measures: score.measures.map((m, i) => i === barIndex ? { ...m, [side]: e.target.checked } : m) }))} />
          {t(side === 'start' ? '反复开始' : '反复结束')}</label>)}
        {project.measures[barIndex].end && <label>{t('反复遍数')}<select value={project.measures[barIndex].repeatCount ?? 2}
          onChange={(event) => patchMeasure({ repeatCount: Number(event.target.value) })}>
          {Array.from({ length: 7 }, (_, index) => <option key={index + 2}>{index + 2}</option>)}
        </select></label>}</fieldset>
      <NavigationEditor measures={project.measures} index={barIndex} apply={patchMeasure} />
      <fieldset><legend>{t('第 {bar} 小节的版式', { bar: barIndex + 1 })}</legend>
        {(['systemBreaks', 'pageBreaks'] as const).map((key) => <label className="checkbox" key={key}>
          <input type="checkbox" disabled={!barIndex || project.measures[barIndex].simile === 'double-second'} checked={viewLayout?.[key]?.includes(barIndex) ?? false} onChange={(event) =>
            patchLayout({ [key]: event.target.checked ? [...viewLayout?.[key] ?? [], barIndex] : viewLayout?.[key]?.filter((item) => item !== barIndex) })} />
          {t(key === 'systemBreaks' ? '此小节起另起谱行' : '此小节起另起一页')}</label>)}
        {activePart && <label className="checkbox"><input type="checkbox" checked={viewLayout?.compressRests ?? false}
          onChange={(event) => patchLayout({ compressRests: event.target.checked })} />{t('分谱导出合并连续休止小节')}</label>}
        <label>{t('打印页眉')}<input maxLength={80} value={viewLayout?.printHeader ?? ''}
          onChange={(event) => patchLayout({ printHeader: event.target.value })} /></label>
        <label>{t('打印页脚')}<input maxLength={80} value={viewLayout?.printFooter ?? ''}
          onChange={(event) => patchLayout({ printFooter: event.target.value })} /></label>
        <label className="checkbox"><input type="checkbox" checked={viewLayout?.showPageNumbers !== false}
          onChange={(event) => patchLayout({ showPageNumbers: event.target.checked })} />{t('打印页码')}</label>
      </fieldset>
    </Modal>}
    {project && track && panel === 'track' && <Modal title={t('乐器设置')} close={() => setPanel(null)}>
      <label>{t('乐器名称')}<input maxLength={200} value={track.name} onChange={(e) => commit((score) => updateTrack(score, track.id, (item) => ({ ...item, name: e.target.value })))}/></label>
      <label>{t('乐器谱头说明')}<input maxLength={80} placeholder={t('如 G 调曲笛、筒音作 5，或古筝 D 调定弦')}
        value={track.scoreNote ?? ''} onChange={(event) => commit((score) => updateTrack(score, track.id, (item) => ({ ...item, scoreNote: event.target.value })))}/></label>
      <label>{t('乐器技巧组')}<select value={track.technique ?? (track.kind === 'voice' ? '人声' : track.kind === 'guitar' ? '吉他' : '通用')}
        onChange={(event) => commit((score) => updateTrack(score, track.id, (item) => ({ ...item, technique: event.target.value as Track['technique'] })))}>
        {Object.entries(techniqueGroups).map(([name, label]) => <option key={name} value={name}>{language === 'zh' ? name : label}</option>)}
      </select></label>
      {track.kind !== 'guitar' && <>
        <label>{t('谱号')}<select value={track.clef ?? 'treble'} onChange={(event) =>
          commit((score) => updateTrack(score, track.id, (item) => ({ ...item, clef: event.target.value as Track['clef'] })))}>
          <option value="treble">{t('高音谱号')}</option><option value="alto">{t('中音谱号')}</option><option value="bass">{t('低音谱号')}</option>
        </select></label>
        <label>{t('移调乐器')}<select value={track.transpose ?? 0} title={t('实际发声 C 在谱面上的偏移（半音）')}
          onChange={(event) => commit((score) => updateTrack(score, track.id, (item) => ({ ...item, transpose: Number(event.target.value) })))}>
          {[0, -12, -9, -7, -5, -3, -2, 2, 3, 5, 7, 9, 12].map((value) => <option key={value} value={value}>
            {value ? (value > 0 ? '+' : '') + value : t('不移调')}</option>)}
        </select></label>
        <div className="inline small-gap">
          <button disabled={(track.voices?.length ?? 0) >= 3} onClick={() => { addVoice(0); setPanel(null) }}>{t('添加同谱表声部')}</button>
          {mode === 'piano' && <button disabled={(track.voices?.length ?? 0) >= 3} onClick={() => { addVoice(1); setPanel(null) }}>{t('添加下谱表声部')}</button>}
        </div>
      </>}
      {track.kind === 'guitar' && <><p>{t('定弦从 1 弦到 6 弦排列。修改定弦时保留原弦号和品位。')}</p>
      <label>{t('变调夹')}<select value={track.capo ?? 0} onChange={(event) => {
        const capo = Number(event.target.value)
        commit((score) => updateTrack(score, track.id, (item) =>
          retune(item, item.tuning.map((pitch) => pitch + capo - (item.capo ?? 0)), capo)))
      }}>
        {Array.from({ length: 13 }, (_, capo) => <option key={capo} value={capo}
          disabled={track.tuning.some((pitch) => pitch + capo - (track.capo ?? 0) > 91)}>{capo}</option>)}
      </select></label>
      <div className="tuning">{track.tuning.map((note, i) => <label key={i}>{t('{string} 弦', { string: i + 1 })}<select value={note - (track.capo ?? 0)}
        onChange={(event) => {
          const pitch = Number(event.target.value)
          commit((score) => updateTrack(score, track.id, (item) =>
            retune(item, item.tuning.map((old, j) => i === j ? pitch + (item.capo ?? 0) : old))))
        }}>{Array.from({ length: 92 - (track.capo ?? 0) }, (_, n) => <option key={n} value={n}>{pitchNames[n % 12]}{Math.floor(n / 12) - 1}</option>)}</select></label>)}</div></>}
    </Modal>}
    {project && panel === 'export' && <Modal title={t('导出')} close={() => { if (!busy) setPanel(null) }} wide>
      <div className="export-controls">
      <label>{t('导出格式')}<select disabled={busy} value={exportFormat} onChange={(e) => setExportFormat(e.target.value as ExportFormat)}>
        <option value="pdf">{t('PDF 乐谱')}</option><option value="png">{t('PNG 图片')}</option>
      </select></label>
      <label>{t('导出范围')}<select disabled={busy} value={exportMode} onChange={(e) => { setPreviewPages(0); setExportMode(e.target.value as ExportMode) }}>
        <option value="current">{t('当前谱')}</option><option value="score">{t('整份总谱')}</option><option value="parts">{t('批量导出分谱')}</option>
      </select></label><button className="primary" disabled={busy || !previewPages || (exportMode === 'parts' && !exportParts.length)} onClick={() => void exportSelection()}>
        {t(busy ? '正在导出…' : '选择保存位置')}</button></div>
      {exportMode === 'parts' && <fieldset><legend>{t('选择需要导出的分谱')}</legend>{project.tracks.map((item) => <label className="checkbox" key={item.id}>
        <input type="checkbox" disabled={busy} checked={exportParts.includes(item.id)} onChange={(e) => {
          const next = e.target.checked ? [...exportParts, item.id] : exportParts.filter((id) => id !== item.id)
          if ((next[0] ?? activePart) !== previewPart) setPreviewPages(0)
          setExportParts(next)
        }} />{item.name}</label>)}</fieldset>}
      {exportFormat === 'png' && <p className="preview-label">{t('每页保存为一张 PNG 图片。')}</p>}
      {error && <p className="inline-error" role="alert">{displayMessage(t, error)}</p>}<div className="preview-label">{t(previewPaper?.size === 'a3' ? 'A3 预览' : previewPaper?.size === 'custom' ? '自定义纸张预览' : 'A4 预览')} · {scoreName(project, previewPart, t)}{exportMode === 'parts' ? t('（预览第一份）') : ''}</div>
      <div className="preview-scroll"><PrintSheet key={exportMode + ":" + previewPart} project={project} part={previewPart} onReady={(pages) => setPreviewPages(pages.length)} onError={(cause) => setError(message('无法为这份乐谱生成打印版面。', undefined, cause.message === '无法为这份乐谱生成打印版面。' ? undefined : cause))} /></div>
    </Modal>}
    {confirm && <Modal title={t('保存当前工程？')} close={() => setConfirm(null)}>
      <p>{t('当前工程有未保存的改动。')}</p><div className="inline"><button className="primary" onClick={async () => {
        if (await persist()) { setConfirm(null); confirm() }
      }}>{t('保存并继续')}</button><button onClick={() => discard(confirm)}>{t('放弃改动')}</button><button onClick={() => setConfirm(null)}>{t('取消')}</button></div>
    </Modal>}
    {(printJob || (!storage.desktop && project && panel === 'export' && exportFormat === 'pdf')) && <div className="print-only" aria-hidden="true">
      <style>{'@page { size: ' + printDimensions.width + 'mm ' + printDimensions.height + 'mm; margin: ' + paperMargin + 'mm; }'}</style>
      <PrintSheet key={printJob?.key ?? 0} project={printJob?.project ?? project!} part={printJob ? printJob.part : previewPart}
        onReady={printRendered} onError={(cause) => { afterRender.current?.reject(cause); setError(message('无法为这份乐谱生成打印版面。', undefined, cause.message === '无法为这份乐谱生成打印版面。' ? undefined : cause)) }} />
    </div>}
  </>
}

function Modal({ title, close, wide, children }: React.PropsWithChildren<{ title: string; close: () => void; wide?: boolean }>) {
  const { t } = useLanguage()
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => { ref.current?.showModal() }, [])
  return <dialog ref={ref} className={wide ? 'modal modal-wide' : 'modal'} aria-label={title}
    onCancel={(event) => { event.preventDefault(); close() }}>
    <div className="modal-heading"><h2>{title}</h2><button aria-label={t('关闭')} onClick={close}>×</button></div>
    <div className="modal-body">{children}</div>
  </dialog>
}

function formatBeats(ticks: number, language: Language) {
  return new Intl.NumberFormat(language, { maximumFractionDigits: 2 }).format(Math.abs(ticks) / 960)
}

function AppRoot() {
  const [preference, setPreference] = useState(readLanguagePreference)
  const [systemLanguage, setSystemLanguage] = useState(() => languageOf(navigator.language))
  const language = preference === 'system' ? systemLanguage : preference

  useEffect(() => {
    let disposed = false
    async function refreshSystemLanguage() {
      const current = await storage.systemLanguage().catch(() => languageOf(navigator.language))
      if (!disposed) setSystemLanguage(current)
    }
    void refreshSystemLanguage()
    window.addEventListener('focus', refreshSystemLanguage)
    window.addEventListener('languagechange', refreshSystemLanguage)
    return () => {
      disposed = true
      window.removeEventListener('focus', refreshSystemLanguage)
      window.removeEventListener('languagechange', refreshSystemLanguage)
    }
  }, [])

  useEffect(() => {
    document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en'
    document.title = translate(language, appName)
    if (storage.desktop) void getCurrentWindow().setTitle(document.title).catch(() => {})
  }, [language])

  function changeLanguage(value: LanguagePreference) {
    setPreference(value)
    try { localStorage.setItem(languageKey, value) } catch { /* The choice still applies to this window. */ }
  }

  return <LanguageContext.Provider value={language}>
    <App preference={preference} setPreference={changeLanguage} />
  </LanguageContext.Provider>
}

createRoot(document.getElementById('root')!).render(<AppRoot />)
