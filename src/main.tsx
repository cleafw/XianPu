import { createRoot } from 'react-dom/client'
import { createPortal } from 'react-dom'
import { PanelWidthHandle, ToolPanel, PanelsSuspended } from './ToolPanel'
import { eventElement, listenWorkspaceKeys } from './panelWindows'
import { useEffect, useReducer, useRef, useState, type ChangeEvent, type CSSProperties, type MouseEvent } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { Editor } from './Editor'
import { appName, displayMessage, languageKey, languageOf, LanguageContext, message, readLanguagePreference, translate, useLanguage,
  type Language, type LanguagePreference, type Message, type TextKey, type Translate } from './i18n'
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
import { beatList, beatRange, blank, changeBeat, changeMeasures, clearMeasureContents, createProject, createTrack, defaultWatermarkStyle, extendNumberedBeat, keyNames, kinds, measureDifference, measureSettings, modes, paperFor, parseProject,
  pitchNames, techniqueGroups, ticks, trackGapLimits, voiceBars, watermarkLimits, watermarkMaxLength,
  type Beat, type IntroRange, type Kind, type Layout, type Measure, type Mode, type Position, type Project, type ScoreLabelKind, type Track, type WatermarkStyle } from './model'
import { playScore, stopPlayback } from './playback'
import { copyMeasures, pasteMeasures, type MeasureClipboard, type PasteMode } from './measureClipboard'
import * as storage from './storage'
import { importMidi, maxMidiBytes } from './midiImport'
import { changeKeySignature, type KeyChangeError, type KeyChangeMode } from './keyChange'
import { clearSelectedNotes, copySelectedNotes, editRhythmSelection, pasteSelectedNotes, sameBeat, sameVoice, selectedBeats, shiftSelectedPitches, type NoteClipboard } from './noteSelection'
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
const creatorPage = 'https://space.bilibili.com/40005809'
const keyChangeErrors: Record<KeyChangeError, TextKey> = {
  'pitch-range': '移调后的音高超出可记谱范围。',
  'guitar-range': '按当前定弦，吉他无法演奏移调后的部分音符或和弦。',
}

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
  const [recentProjects, setRecentProjects] = useState(storage.readRecentProjects)
  const [verifiedRecentPaths, setVerifiedRecentPaths] = useState<Set<string>>()
  const [part, setPart] = useState<string | null>(null)
  const [selection, setSelection] = useState<Position & { editDraftRest?: boolean }>({ track: '', bar: 0, beat: 0 })
  const [selectedBars, setSelectedBars] = useState<number[]>([])
  const [measureCountInput, setMeasureCountInput] = useState('1')
  const [selectedNotes, setSelectedNotes] = useState<Position[]>([])
  const [noteClipboard, setNoteClipboard] = useState<NoteClipboard | null>(null)
  const noteAnchor = useRef<Position | null>(null)
  const noteRange = useRef<{ from: Position; to: Position } | null>(null)
  const rangeAnchor = useRef<number | null>(null)
  const [barMenu, setBarMenu] = useState<{ x: number; y: number; position: Position; document: Document; kind: 'measure' | 'note' } | null>(null)
  const [pasteStructure, setPasteStructure] = useState(false)
  const [pasteWarning, setPasteWarning] = useState<{ text: string; apply: () => void } | null>(null)
  const [notice, setNotice] = useState<Message | null>(null)
  const [midiWarnings, setMidiWarnings] = useState<TextKey[]>([])
  const [error, setError] = useState<Message | null>(null)
  const [playhead, setPlayhead] = useState<Position | null>(null)
  const [audioState, setAudioState] = useState<'idle' | 'loading' | 'playing'>('idle')
  const [panel, setPanel] = useState<'settings' | 'intro' | 'export' | 'track' | 'paper' | 'sounds' | 'remove-part' | 'midi-report' | null>(null)
  const [keyChangeMode, setKeyChangeMode] = useState<KeyChangeMode>('pitch')
  const [keyChangeError, setKeyChangeError] = useState<{ reason: KeyChangeError; bar?: number }>()
  const [scoreLabel, setScoreLabel] = useState<{ kind: ScoreLabelKind; bar: number } | null>(null)
  const [introDraft, setIntroDraft] = useState<IntroRange>([0, 0])
  const [partToRemove, setPartToRemove] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<(() => void) | null>(null)
  const pendingConfirmation = useRef<(() => void) | null>(null)
  const [exportMode, setExportMode] = useState<ExportMode>('current')
  const [exportFormat, setExportFormat] = useState<ExportFormat>('pdf')
  const [exportParts, setExportParts] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [printJob, setPrintJob] = useState<PrintJob | null>(null)
  const [previewPages, setPreviewPages] = useState(0)
  const [zoom, setZoom] = useState(100)
  const [inspectorWidth, setInspectorWidth] = useState<number>()
  const workspace = useRef<HTMLElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const openRequest = useRef(0)
  const saving = useRef(false)
  const projectSession = useRef(0)
  const copied = useRef<MeasureClipboard | null>(null)
  const afterRender = useRef<{ resolve: (pages: HTMLElement[]) => void; reject: (reason: Error) => void } | null>(null)
  const jobId = useRef(0)
  const dirty = !!project && saved !== project
  const home = !project
  const visibleRecentProjects = recentProjects.filter(({ path }) => verifiedRecentPaths?.has(path))
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
  const measureTotal = project?.measures.length ?? 0
  const measureCount = Number(measureCountInput)
  const validMeasureCount = Number.isInteger(measureCount) && measureCount > 0
  const deleteStart = measureSelection[0] ?? barIndex
  const canDeleteFromEnd = validMeasureCount && measureCount < measureTotal
  const canDeleteFromSelection = canDeleteFromEnd && deleteStart + measureCount <= measureTotal
  const noteTargets = project ? selectedBeats(project, selectedNotes) : []
  const spanSelection = noteTargets.length > 1
    ? noteTargets.every(({ position }) => sameVoice(position, noteTargets[0].position))
      ? [noteTargets[0].position, noteTargets.at(-1)!.position] as const : null
    : undefined
  const copyTargets = !project || measureSelection.length ? [] : noteTargets.length ? noteTargets
    : beat.draft ? [] : selectedBeats(project, [position])
  const measureDrag = useMeasureDrag(({ clientX, clientY }, doc) => measureButton(doc.elementFromPoint(clientX, clientY)), selectMeasureRange)

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

  useEffect(() => {
    if (storage.desktop) storage.saveRecentProjects(recentProjects)
  }, [recentProjects])

  useEffect(() => {
    if (!home || !recentProjects.length) {
      setVerifiedRecentPaths(undefined)
      return
    }
    let disposed = false
    let checking = false
    async function refresh() {
      if (checking) return
      checking = true
      try {
        const paths = new Set(await storage.existingProjectPaths(recentProjects.map(({ path }) => path)))
        if (disposed) return
        setVerifiedRecentPaths(paths)
        const existing = recentProjects.filter(({ path }) => paths.has(path))
        if (existing.length !== recentProjects.length) {
          setRecentProjects((current) => current === recentProjects ? existing : current)
        }
      } catch {
        if (!disposed) setVerifiedRecentPaths(undefined)
      } finally {
        checking = false
      }
    }
    void refresh()
    window.addEventListener('focus', refresh)
    const timer = window.setInterval(refresh, 5000)
    return () => {
      disposed = true
      window.removeEventListener('focus', refresh)
      window.clearInterval(timer)
    }
  }, [home, recentProjects])

  function load(score: Project | null, filename: string | null = null, clean = false) {
    openRequest.current++
    projectSession.current++
    stopPlayback()
    setAudioState('idle')
    setError(null)
    setKeyChangeError(undefined)
    setScoreLabel(null)
    setNotice(null)
    setMidiWarnings([])
    setPanel(null)
    setPart(null)
    setPath(filename)
    if (filename && score) {
      setRecentProjects((entries) => storage.rememberProject(entries, { path: filename, title: score.title }))
    }
    setSaved(clean ? score : null)
    setSelection({ track: score?.tracks[0].id ?? '', bar: 0, beat: 0 })
    setSelectedBars([])
    setMeasureCountInput('1')
    clearNoteSelection()
    rangeAnchor.current = null
    if (copied.current?.all) copied.current = null
    setBarMenu(null)
    setPasteWarning(null)
    dispatch({ type: 'open', score })
  }
  async function persist(saveAs = false) {
    const current = activeRef.current
    const session = projectSession.current
    if (!current.project || saving.current) return false
    saving.current = true
    try {
      let data = JSON.stringify(current.project, null, 2)
      if (new Blob([data]).size > storage.maxProjectBytes) data = JSON.stringify(current.project)
      if (new Blob([data]).size > storage.maxProjectBytes) {
        setError(message('项目文件超过 16 MB。'))
        return false
      }
      let target = current.path
      if (storage.desktop) {
        target = !saveAs && current.path ? current.path : await storage.savePath(current.project.title, t)
        if (!target) return false
        await storage.writeFile(target, data)
        const entry = { path: target, title: current.project.title }
        setRecentProjects((entries) => storage.rememberProject(entries, entry))
      } else storage.downloadProject(current.project.title, data, t)
      if (projectSession.current !== session) return true
      if (storage.desktop) setPath(target)
      setSaved(current.project)
      if (activeRef.current.project === current.project) {
        try { localStorage.removeItem(storage.recoveryKey) } catch { /* The file is already saved. */ }
      }
      setError(null)
      setNotice(message('工程已保存'))
      return true
    } catch (cause) {
      if (projectSession.current === session) setError(message('保存失败。', undefined, cause))
      return false
    } finally {
      saving.current = false
    }
  }
  function setConfirmation(action: (() => void) | null) {
    pendingConfirmation.current = action
    setConfirm(() => action)
  }
  function whenClean(action: () => void) {
    if (activeRef.current.dirty) setConfirmation(action)
    else action()
  }
  function discard(action: () => void) {
    try { localStorage.removeItem(storage.recoveryKey) } catch { /* Storage can be unavailable. */ }
    setRecovery(null)
    setConfirmation(null)
    action()
  }
  async function openProject(recentPath?: string) {
    const request = ++openRequest.current
    if (!storage.desktop) { pickBrowserFile('.xianpu'); return }
    try {
      const file = recentPath ?? await storage.pickProject(t)
      if (typeof file !== 'string' || openRequest.current !== request) return
      const score = parseProject(await storage.readFile(file))
      if (openRequest.current === request) whenClean(() => load(score, file, true))
    } catch (cause) {
      if (recentPath && openRequest.current === request) {
        const exists = await storage.existingProjectPaths([recentPath]).then((paths) => paths.includes(recentPath), () => undefined)
        if (openRequest.current !== request) return
        if (exists === false) {
          setRecentProjects((entries) => entries.filter(({ path }) => path !== recentPath))
          setError(message('工程文件已移动或删除。'))
          return
        }
      }
      if (openRequest.current === request) setError(message('打开失败。', undefined, cause))
    }
  }
  function pickBrowserFile(accept: string) {
    const input = fileInput.current
    if (!input) return
    input.accept = accept
    input.click()
  }
  function openMidi(bytes: Uint8Array, filename: string) {
    const { project: score, noteCount, warnings } = importMidi(bytes, filename, language)
    whenClean(() => {
      load(score)
      setNotice(message('已导入 MIDI · {tracks} 个乐器 · {bars} 小节 · {notes} 个音符。',
        { tracks: score.tracks.length, bars: score.measures.length, notes: noteCount }))
      setMidiWarnings(warnings)
    })
  }
  async function pickMidi() {
    const request = ++openRequest.current
    if (!storage.desktop) { pickBrowserFile('.mid,.midi'); return }
    try {
      const file = await storage.pickMidi(t)
      if (typeof file !== 'string' || openRequest.current !== request) return
      const bytes = await storage.readMidi(file)
      if (openRequest.current === request) openMidi(bytes, file)
    } catch (cause) {
      if (openRequest.current === request) setError(message('MIDI 导入失败。', undefined, cause))
    }
  }
  async function fromBrowser(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0]
    event.currentTarget.value = ''
    if (!file) return
    const request = ++openRequest.current
    if (/\.midi?$/i.test(file.name) || event.currentTarget.accept === '.mid,.midi') {
      try {
        if (file.size > maxMidiBytes) throw new Error('MIDI 文件超过 16 MB。')
        const bytes = new Uint8Array(await file.arrayBuffer())
        if (openRequest.current === request) openMidi(bytes, file.name)
      } catch (cause) {
        if (openRequest.current === request) setError(message('MIDI 导入失败。', undefined, cause))
      }
      return
    }
    try {
      if (file.size > storage.maxProjectBytes) throw new Error('项目文件超过 16 MB。')
      const score = parseProject(await file.text())
      if (openRequest.current === request) whenClean(() => load(score, null, true))
    } catch (cause) {
      if (openRequest.current === request) setError(message('打开失败。', undefined, cause))
    }
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
        setConfirmation(() => { void windowHandle.destroy() })
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
      if (event.defaultPrevented || event.isComposing || scoreLabel) return
      if (event.key === 'Escape' && !panel && !confirm && !pasteWarning && !barMenu) {
        setSelectedBars([])
        rangeAnchor.current = null
        clearNoteSelection()
      }
      const target = eventElement(event.target)
      const textInput = target?.matches('input, textarea, select') || target?.isContentEditable
      if (event.key === 'Delete' && project && track && !panel && !confirm && !pasteWarning && !barMenu &&
        !busy && !textInput && !event.altKey && !event.ctrlKey && !event.metaKey) {
        event.preventDefault()
        if (event.repeat) return
        if (!noteTargets.length && measureSelection.length > 1) {
          const cleared = clearMeasureContents(project, position, measureSelection)
          if (cleared !== project) commit(() => cleared)
        } else deleteNotes()
        return
      }
      if (!event.ctrlKey && !event.metaKey) return
      const key = event.key.toLowerCase()
      if (key === 's' && activeRef.current.project) {
        event.preventDefault()
        if (!activeRef.current.busy) void persist(event.shiftKey)
      }
      if (key === 'z' && !panel && !confirm && !pasteWarning && !barMenu && !textInput) {
        event.preventDefault()
        dispatch({ type: event.shiftKey ? 'redo' : 'undo' })
      }
      if (!project || panel || confirm || pasteWarning || busy || textInput || event.altKey || event.shiftKey) return
      if (key === 'c' || key === 'v') {
        event.preventDefault()
        if (key === 'c') {
          if (measureSelection.length) copySelection()
          else copyNotes()
        } else if (noteClipboard) pasteNotes()
        else if (measureSelection.length && copied.current) pasteSelection(measureSelection.length > 1 ? 'selection' : 'overwrite', measureSelection[0])
      }
    }
    return listenWorkspaceKeys(shortcuts)
  })

  function move(step: 1 | -1) {
    if (!project || !track) return
    setSelectedBars([])
    clearNoteSelection()
    rangeAnchor.current = null
    // Wait for the current edit to update the available beat positions.
    setSelection((current) => {
      if (step < 0 && position.beat === 0) {
        if (!position.bar) return position
        return { ...position, bar: position.bar - 1, beat: beatList(project, voiceBars(track, activeVoice)[position.bar - 1], position.bar - 1).length - 1 }
      }
      return { ...current, ...position, beat: position.beat + step, note: undefined, string: undefined, editDraftRest: undefined }
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
    clearNoteSelection()
    rangeAnchor.current = null
    setBarMenu(null)
    if (id) setSelection({ track: id, bar: barIndex, beat: 0, voice: id === position.track ? activeVoice : 0 })
  }
  function removePart(id: string) {
    if (!project || project.tracks.length < 2) return
    const index = project.tracks.findIndex((item) => item.id === id)
    if (index < 0) return
    const tracks = project.tracks.filter((item) => item.id !== id)
    const next = tracks[Math.min(index, tracks.length - 1)].id
    commit((score) => ({ ...score, tracks: score.tracks.filter((item) => item.id !== id) }))
    if (activePart === id) selectView(next)
    else if (selection.track === id) {
      selectView(null)
      setSelection({ track: next, bar: barIndex, beat: 0 })
    }
    setPanel(null)
    setPartToRemove(null)
  }
  function selectBeat(target: Position, editDraftRest = false) {
    setSelectedBars([])
    clearNoteSelection()
    rangeAnchor.current = null
    setBarMenu(null)
    setSelection({ ...target, editDraftRest })
  }
  function editMeasureCount(index: number, delta: number) {
    if (!project) return
    const next = changeMeasures(project, index, delta)
    if (next === project) return
    commit(() => next)
    if (delta < 0 && barIndex < index) selectBeat(position, selection.editDraftRest)
    else selectBeat({ ...position, bar: Math.min(index, next.measures.length - 1), beat: 0, note: undefined, string: undefined })
    setError(null)
    setNotice(message(delta > 0 ? '已插入 {count} 小节。' : '已删除 {count} 小节。', { count: Math.abs(delta) }))
  }
  function clearNoteSelection() {
    setSelectedNotes([])
    noteAnchor.current = null
    noteRange.current = null
  }
  function deleteNotes() {
    if (!project) return
    if (noteTargets.length || entryMode === 'numbered' && position.note !== undefined) {
      const targets = noteTargets.length ? noteTargets : selectedBeats(project, [position])
      const cleared = clearSelectedNotes(project, targets)
      if (cleared !== project) commit(() => cleared)
      clearNoteSelection()
      // The stored tone indices can change when a layer is removed.
      setSelection({ ...position, note: undefined, string: undefined })
    } else {
      commit((score) => changeBeat(score, position, () => blank()))
    }
  }
  function selectNoteRange(from: Position, to: Position) {
    const item = project?.tracks.find(({ id }) => id === from.track)
    if (!project || !item || !sameVoice(from, to)) return
    setSelectedBars([])
    rangeAnchor.current = null
    setBarMenu(null)
    noteAnchor.current = from
    noteRange.current = { from, to }
    setSelectedNotes(beatRange(project, item, from, to).flatMap(({ position, beat }) =>
      !project.measures[position.bar].simile && (!beat.draft || sameBeat(position, from) || sameBeat(position, to))
        ? [{ ...position, lane: from.lane, note: sameBeat(from, to) ? to.note : undefined }] : []))
    setSelection({ ...to, editDraftRest: true })
  }
  function selectNote(target: Position, event: MouseEvent) {
    if (!project || project.measures[target.bar].simile) return
    const anchor = noteAnchor.current ?? position
    if (event.shiftKey) {
      selectNoteRange(sameVoice(anchor, target) ? anchor : target, target)
      return
    }
    const distinct = !sameBeat(position, target) || position.note !== undefined && target.note !== undefined && position.note !== target.note
    const initial = selectedNotes.length ? selectedNotes : !measureSelection.length && distinct &&
      (!beat.draft || selection.editDraftRest) ? [position] : []
    const whole = initial.find((item) => sameBeat(item, target) && item.note === undefined)
    const matching = initial.some((item) => sameBeat(item, target) && (item.note === target.note || target.note === undefined))
    let next = initial.filter((item) => !sameBeat(item, target) || item.note !== undefined && target.note !== undefined && item.note !== target.note)
    if (whole && target.note !== undefined) {
      const entry = selectedBeats(project, [whole])[0]
      next = next.concat(entry?.beat.notes.flatMap((_, note) => note !== target.note ? [{ ...whole, note }] : []) ?? [])
    } else if (!matching) next.push(target)
    setSelectedBars([])
    rangeAnchor.current = null
    setBarMenu(null)
    setSelectedNotes(next)
    noteAnchor.current = target
    noteRange.current = null
    setSelection({ ...(next.at(-1) ?? target), editDraftRest: true })
  }
  function selectMeasure(target: Position, event: MouseEvent) {
    clearNoteSelection()
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
    clearNoteSelection()
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
    const source = project?.tracks.find(({ id }) => id === from.track)
    if (!project || !source || !sameVoice(from, to) || sameBeat(from, to)) return false
    const bars = voiceBars(source, from.voice)
    if ([from, to].some(({ bar, beat }) => !bars[bar] || project.measures[bar].simile ||
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
  function showClipboardMenu(target: Position, event: MouseEvent, kind: 'measure' | 'note') {
    event.preventDefault()
    if (kind === 'note') {
      if (!noteTargets.some(({ position, notes }) => sameBeat(position, target) && (!notes || target.note !== undefined && notes.has(target.note)))) {
        selectBeat(target, true)
      }
    } else if (!measureSelection.includes(target.bar) || !sameVoice(target, position)) {
      selectMeasure(target, event)
    }
    setPasteStructure(false)
    const doc = event.currentTarget.ownerDocument
    const view = doc.defaultView ?? window
    setBarMenu({ x: Math.max(0, Math.min(event.clientX, view.innerWidth - 265)),
      y: Math.max(0, Math.min(event.clientY, view.innerHeight - (kind === 'note' ? 90 : 310))), position: target, document: doc, kind })
  }
  function copySelection(all = false) {
    if (!project || !track) return
    const indices = measureSelection.length ? measureSelection : [barIndex]
    copied.current = copyMeasures(project, indices, track.id, all, activeVoice)
    setNoteClipboard(null)
    setError(null)
    setNotice(message(copied.current.omittedLink ? '已复制 {count} 小节，跨选区连线已略过。' : '已复制 {count} 小节。', { count: indices.length }))
    setBarMenu(null)
  }
  function copyNotes() {
    if (!project || !copyTargets.length) return
    const source = project.tracks.find(({ id }) => id === copyTargets[0].position.track)!
    if (copyTargets.some(({ position }) => !sameVoice(position, copyTargets[0].position))) {
      setError(message('请在同一分谱的同一声部选择要复制的音符。'))
      return
    }
    let targets = copyTargets
    const range = noteRange.current
    if (range && !sameBeat(range.from, range.to)) {
      const first = Math.min(range.from.bar, range.to.bar)
      const last = Math.max(range.from.bar, range.to.bar)
      if (project.measures.slice(first, last + 1).some(({ simile }) => simile)) {
        setError(message('音符选区包含小节重复记号，请改用小节复制。'))
        return
      }
      // A continuous selection includes the time occupied by unfilled beats.
      targets = beatRange(project, source, range.from, range.to).map((entry) => ({ ...entry, notes: null }))
    }
    const clipboard = copySelectedNotes(project, targets, source)
    copied.current = null
    setNoteClipboard(clipboard)
    setBarMenu(null)
    setError(null)
    setNotice(message('已复制 {count} 个音符位置。', { count: copyTargets.length }))
  }
  function pasteNotes(target = position) {
    if (!project || !noteClipboard) return
    setBarMenu(null)
    const result = pasteSelectedNotes(project, target, noteClipboard)
    if ('error' in result) {
      setError(message(result.error === 'guitar' ? '当前定弦无法弹出这个音。' : result.error === 'barline'
        ? '粘贴的音符会跨过小节线，请换一个起始拍位。' : '目标位置后的可用拍位不足，无法粘贴。'))
      return
    }
    commit(() => result.score)
    setSelectedBars([])
    rangeAnchor.current = null
    setSelection({ ...result.positions[0], editDraftRest: true })
    setSelectedNotes(result.positions)
    noteAnchor.current = result.positions[0]
    noteRange.current = null
    setError(null)
    reportNoteOverflow(result.score, result.positions, message('已粘贴 {count} 个音符位置。', { count: result.positions.length }))
  }
  function reportNoteOverflow(updated: Project, positions: Position[], fallback: Message | null = null) {
    if (!project) return
    const checked = new Set<string>()
    const overfull = new Set<number>()
    for (const { track: id, voice = 0, bar } of positions) {
      const key = JSON.stringify([id, voice, bar])
      if (checked.has(key)) continue
      checked.add(key)
      const before = project.tracks.find(({ id: item }) => item === id)!
      const after = updated.tracks.find(({ id: item }) => item === id)!
      const difference = measureDifference(updated, after, bar, voice)
      if (difference < 0 && difference < measureDifference(project, before, bar, voice) - 1e-7) overfull.add(bar + 1)
    }
    setNotice(overfull.size ? message('以下小节超出拍数：{bars}', { bars: [...overfull].sort((a, b) => a - b).join(', ') }) : fallback)
  }
  function changeSelectedRhythm(update: (beat: Beat) => Partial<Beat> | undefined) {
    if (!project) return
    const score = editRhythmSelection(project, noteTargets, update)
    if (score !== project) {
      commit(() => score)
      reportNoteOverflow(score, noteTargets.map(({ position }) => position))
    }
  }
  function changeSelectedPitch(amount: number) {
    if (!project) return
    const result = shiftSelectedPitches(project, noteTargets, amount, activePart)
    if ('error' in result) return result.error === 'pitch' ? '音高超出可记谱范围。' : '当前定弦无法弹出这个音。'
    if (result.score !== project) commit(() => result.score)
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
      clearNoteSelection()
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
  function applyKeySignature(key: number | undefined, bar?: number) {
    if (!project) return false
    const result = changeKeySignature(project, key, keyChangeMode, bar)
    if ('error' in result) {
      setKeyChangeError({ reason: result.error, bar })
      return false
    }
    setKeyChangeError(undefined)
    if (result.score !== project) commit(() => result.score)
    return true
  }
  function openScoreLabel(kind: ScoreLabelKind, bar: number) {
    setKeyChangeError(undefined)
    setScoreLabel({ kind, bar })
  }
  function setLabelTempo(bpm: number | undefined, bar?: number) {
    commit((score) => bar === undefined ? { ...score, bpm: bpm ?? score.bpm }
      : { ...score, measures: score.measures.map((measure, index) => index === bar ? { ...measure, bpm } : measure) })
    setScoreLabel(null)
  }
  function changeBarMeter(value: string) {
    if (!project) return
    const meter = value ? value.split('/').map(Number) as Measure['meter'] : undefined
    patchMeasure({ meter })
    const measures = project.measures.slice()
    measures[barIndex] = { ...measures[barIndex], meter }
    const updated = { ...project, measures }
    const overfull: number[] = []
    for (let index = barIndex; index < measures.length && (index === barIndex || !measures[index].meter); index++) {
      if (project.tracks.some((track) => [track.bars, ...track.voices?.map(({ bars }) => bars) ?? []].some((_, voice) => {
        const difference = measureDifference(updated, track, index, voice)
        return difference < 0 && difference < measureDifference(project, track, index, voice) - 1e-7
      }))) overfull.push(index + 1)
    }
    setNotice(overfull.length ? message('以下小节超出拍数：{bars}', { bars: overfull.join(', ') }) : null)
  }
  function barMeterField(label: TextKey) {
    const meter = project?.measures[barIndex].meter
    const inherited = project ? measureSettings(project, barIndex - 1).meter.join('/') : ''
    return <label>{t(label)}<select value={meter?.join('/') ?? ''} onChange={(event) => changeBarMeter(event.target.value)}>
      <option value="">{t('沿用前文 · {meter}', { meter: inherited })}</option>
      {meters.map((value) => <option key={value}>{value}</option>)}
    </select></label>
  }
  function openIntro() {
    setIntroDraft(measureSelection.length > 1 ? [measureSelection[0], measureSelection.at(-1)!] : project?.intro ?? [0, barIndex])
    setPanel('intro')
  }
  function saveIntro(intro?: Project['intro']) {
    commit((score) => ({ ...score, intro }))
    setPanel(null)
  }
  function setIntroBar(endpoint: 0 | 1, bar: number) {
    setIntroDraft(([first, last, start, end]) => {
      const nextFirst = endpoint === 0 ? bar : Math.min(first, bar)
      const nextLast = endpoint === 1 ? bar : Math.max(last, bar)
      return [nextFirst, nextLast, nextFirst === first ? start ?? null : null, nextLast === last ? end ?? null : null]
    })
  }
  function extendBeat() {
    if (!project) return false
    const result = extendNumberedBeat(project, position)
    if (!result) return false
    commit(() => result.score)
    selectBeat({ ...position, beat: result.beat, note: undefined, string: undefined })
    return true
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
      const start = noteTargets[0]?.position ?? position
      await playScore(project, activePart, () => { setAudioState('idle'); setPlayhead(null) }, () => setAudioState('playing'), start, setPlayhead)
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
  const pendingPart = panel === 'remove-part' ? project?.tracks.find((item) => item.id === partToRemove) : undefined
  function openCreatorPage(event: MouseEvent<HTMLAnchorElement>) {
    if (!storage.desktop) return
    event.preventDefault()
    void storage.openCreatorPage().catch(() => setError(message('无法打开 B 站主页。')))
  }

  return <>
    <input ref={fileInput} type="file" accept=".xianpu" hidden onChange={fromBrowser} />
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href={creatorPage} target="_blank" rel="noopener noreferrer"
          aria-label={t('{name} · 打开 B 站主页', { name: t(appName) })} onClick={openCreatorPage}>
          <span className="brand-icon" aria-hidden="true">♬</span>
          <span><strong>{t(appName)}</strong>{language === 'zh' && <small>{translate('en', appName).toUpperCase()}</small>}</span>
        </a>
        <div className="toolbar" aria-label={t('主工具栏')}>
          {project && <button onClick={() => whenClean(() => load(null))}>{t('新建')}</button>}
          <button disabled={!!recovery && !project} onClick={() => void openProject()}>{t('打开')}</button>
          <button disabled={!!recovery && !project} onClick={() => void pickMidi()}>{t('导入 MIDI')}</button>
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
        </> : <span className="tag">{t('离线写谱工作台')}</span>}
          <a className="contact-link quiet" href={creatorPage} target="_blank" rel="noopener noreferrer"
            onClick={openCreatorPage}>{t('联系我们')}</a>
        </div>
      </header>
      {!project ? <main className="home">
        <div className="home-copy"><span className="eyebrow">{t('你的本地乐谱工作台')}</span><h1>{t('从第一小节开始')}</h1>
          <p>{t('写简谱、吉他谱，或把乐队的声部放进同一份总谱。')}</p></div>
        {recovery && <div className="recover"><div><strong>{t('发现未保存的草稿')}</strong><p>{recovery.title}</p></div>
          <button className="primary" onClick={() => { load(recovery); setRecovery(null) }}>{t('恢复草稿')}</button>
          <button onClick={() => discard(() => {})}>{t('丢弃草稿')}</button></div>}
        {storage.desktop && <section className="recent-projects" aria-labelledby="recent-projects-title">
          <h2 id="recent-projects-title">{t('最近工程')}</h2>
          {visibleRecentProjects.length > 0 ? <ul>{visibleRecentProjects.map(({ path, title }) =>
            <li key={path}><button disabled={!!recovery} title={path} onClick={() => void openProject(path)}>
              <strong>{title || path.split(/[\\/]/).at(-1)}</strong><small>{path}</small>
            </button></li>,
          )}</ul> : <p>{t('打开或保存工程后会显示在这里。')}</p>}
        </section>}
        <div className="templates">{templates.map((template) => <button key={template.id} className="template" disabled={!!recovery} onClick={() => startProject(template.id)}>
          <span className="notation">{template.notation}</span><strong>{t(template.title)}</strong><span>{t(template.description)}</span><span className="template-action">{t('新建乐谱')} ↗</span>
        </button>)}</div>
        <div className="demo-callout"><div><strong>{t('打开一份已经写好的谱')}</strong><p>{t('8 小节，包含简谱、吉他六线谱与五线谱。')}</p></div>
          <button disabled={!!recovery} onClick={() => startProject('demo')}>{t('打开弹唱示例')}</button></div>
      </main> : <main className="workspace" ref={workspace} style={{ '--inspector-width': inspectorWidth === undefined ? undefined : inspectorWidth + '%' } as CSSProperties}>
        <nav className="sidebar" aria-label={t('总谱与分谱')}>
          <span className="eyebrow">{t('曲谱视图')}</span>
          <button aria-label={t('总谱')} aria-current={!activePart ? 'page' : undefined} onClick={() => selectView(null)}><span aria-hidden="true">▤</span> {t('总谱')}</button>
          <div className="sidebar-caption">{t('分谱')}</div>
          {project.tracks.map((item) => <div className="part-row" key={item.id}>
            <PartName track={item} active={activePart === item.id} select={() => selectView(item.id)}
              rename={(name) => commit((score) => updateTrack(score, item.id, (part) => ({ ...part, name })))} />
            <button className="part-remove" disabled={project.tracks.length < 2}
              aria-label={t('删除分谱 {name}', { name: item.name })}
              title={project.tracks.length < 2 ? t('至少保留一份分谱。') : t('删除分谱 {name}', { name: item.name })}
              onClick={() => { setPartToRemove(item.id); setPanel('remove-part') }}>×</button>
          </div>)}
          <details><summary>＋ {t('添加分谱')}</summary><div className="add-list">{(Object.keys(kinds) as Kind[]).map((kind) =>
            <button key={kind} disabled={project.tracks.length >= 24} onClick={(event) => {
              const base = t(kinds[kind])
              let name = base
              for (let number = 2; project.tracks.some((item) => item.name === name); number++) name = base + ' ' + number
              const added = createTrack(project, kind, name)
              commit((score) => ({ ...score, tracks: [...score.tracks, added] }))
              setSelection({ track: added.id, bar: barIndex, beat: 0 })
              clearNoteSelection()
              setPart(added.id)
              event.currentTarget.closest('details')?.removeAttribute('open')
            }}>{t(kinds[kind])}</button>)}</div></details>
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
            <div className="field-row canvas-controls"><label>{t('谱式')}<select value={mode} onChange={(event) => selectMode(event.target.value as Mode)}>
              {Object.entries(modes).filter(([key]) => track?.kind === 'guitar'
                ? key !== 'piano' && key !== 'percussion' : key !== 'tab' && key !== 'staff-tab')
                .map(([key, value]) => <option key={key} value={key}>{t(value)}</option>)}</select></label>
              <label>{t('每行小节')}<select value={viewLayout!.barsPerLine} onChange={(e) => patchLayout({ barsPerLine: Number(e.target.value) })}>
                {Array.from({ length: 12 }, (_, i) => <option key={i + 1}>{i + 1}</option>)}</select></label>
              <label>{t('每页谱行')}<select value={viewLayout!.systemsPerPage} onChange={(e) => patchLayout({ systemsPerPage: Number(e.target.value) })}>
                {Array.from({ length: 6 }, (_, i) => <option key={i + 1}>{i + 1}</option>)}</select></label>
              <label>{t('缩放')}<select value={zoom} onChange={(e) => setZoom(Number(e.target.value))}>{[75, 90, 100, 125, 150].map((n) => <option key={n} value={n}>{n}%</option>)}</select></label></div></div>
          <div className="paper-scroll"><div className="paper" style={{ width: page.width * zoom / 100 + 'mm', paddingInline: paperMargin * zoom / 100 + 'mm' }}>
            <ScoreView key={projectSession.current} project={project} part={activePart} position={position} playhead={audioState === 'playing' ? playhead : null} selectedBars={measureSelection} selectedNotes={selectedNotes} scale={zoom / 100} onSelect={(target) => selectBeat(target, true)}
              onNoteSelect={selectNote} onNoteRange={selectNoteRange}
              onLabelSelect={openScoreLabel} onBarSelect={selectMeasure} onBarRange={selectMeasureRange} onClipboardMenu={showClipboardMenu} onError={(cause) => setError(message('谱面绘制失败。', undefined, cause))} />
          </div></div>
          <section className="position-panel" aria-label={t('小节与录入位置')}>
            <PanelsSuspended.Provider value={!!(panel || scoreLabel || confirm || pasteWarning || busy)}>
              <ToolPanel label={t('录入位置')} placement="bottom" initialOpen onDock={() => setBarMenu(null)}>
                <div className="position-header">
                  <div><small>{t('可直接点谱面，也可在这里选择。')}</small>
                    <small className="note-selection-help">{t('拖动或 Shift 连选音符，Ctrl 点选单个音符。')}</small>
                    {!!track?.voices?.length && <label>{t('编辑声部')}<select value={activeVoice} onChange={(event) =>
                      selectBeat({ ...position, voice: Number(event.target.value), beat: 0 })}>
                      <option value={0}>{t('主声部')}</option>
                      {track.voices.map((voice, index) => <option value={index + 1} key={index}>{t('附加声部 {number}', { number: index + 1 })}
                        {voice.staff === 1 ? ' · ' + t('下谱表') : ''}</option>)}
                    </select></label>}
                  </div>
                  <div className="tool-actions" role="group" aria-label={t('小节编辑')}>
                    {measureSelection.length
                      ? <button title="Ctrl+C" onClick={() => copySelection()}>{t('复制小节')}</button>
                      : <button title="Ctrl+C" disabled={!copyTargets.length} onClick={copyNotes}>{t('复制所选音符')}</button>}
                    {measureSelection.length && !noteClipboard ? <>
                      <button title="Ctrl+V" disabled={!copied.current} onClick={() => pasteSelection(measureSelection.length > 1 ? 'selection' : 'overwrite', measureSelection[0])}>{t('粘贴小节')}</button>
                      <button disabled={!copied.current} onClick={() => pasteSelection('before')}>{t('在前面插入粘贴')}</button>
                    </> : <>
                      <button title="Ctrl+V" disabled={!noteClipboard} onClick={() => pasteNotes()}>{t('粘贴音符')}</button>
                    </>}
                  </div>
                </div>
                <div className="position-header measure-operations">
                  <label>{t('小节数量')}<input type="number" min="1" max="256" step="1" value={measureCountInput}
                    onChange={(event) => setMeasureCountInput(event.target.value)} /></label>
                  <button disabled={!validMeasureCount || measureTotal + measureCount > 256 || project.measures[barIndex + 1]?.simile === 'double-second'}
                    title={t(project.measures[barIndex + 1]?.simile === 'double-second' ? '不能拆开两小节重复。'
                      : measureTotal + measureCount > 256 ? '插入后会超过 256 小节。' : '在当前小节后插入')}
                    onClick={() => editMeasureCount(barIndex + 1, measureCount)}>{t('插入小节')}</button>
                  <div className="tool-actions tool-actions-danger" role="group" aria-label={t('移除操作')}>
                    <button disabled={!canDeleteFromSelection} title={t('从第 {bar} 小节起删除', { bar: deleteStart + 1 })}
                      onClick={() => editMeasureCount(deleteStart, -measureCount)}>{t('从选中处删除小节')}</button>
                    <button disabled={!canDeleteFromEnd}
                      onClick={() => editMeasureCount(measureTotal - measureCount, -measureCount)}>{t('从曲尾删除小节')}</button>
                  </div>
                </div>
                <div className="position-header measure-structure">
                  {barMeterField('本小节起变拍')}
                  <button onClick={openIntro}>{t('前奏括号')}{project.intro && ` · ${project.intro[0] + 1}–${project.intro[1] + 1}`}</button>
                </div>
                <div className="measure-list" aria-label={t('选择小节')} {...measureDrag.handlers} onPointerDown={(event) => {
                  const target = measureButton(eventElement(event.target))
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
                      }} onContextMenu={(event) => showClipboardMenu({ ...position, bar: index }, event, 'measure')}>
                      {index + 1}<span aria-label={hint} className={difference < 0 ? 'over' : difference > 0 ? 'under' : 'full'}>●</span>
                    </button>
                  })}
                </div>
                {measureSelection.length > 0 && <small>{t('{track} · 所选小节 {bars}', { track: track!.name, bars: measureSelection.map((index) => index + 1).join(', ') })}</small>}
                {noteTargets.length > 0 && <small>{t('已选 {count} 个音符位置', { count: noteTargets.length })}</small>}
                {track && measureDifference(project, track, barIndex, activeVoice) !== 0 && <p className={'measure-status ' + (measureDifference(project, track, barIndex, activeVoice) < 0 ? 'over' : 'under')}>
                  {t('{track}第 {bar} 小节{status}', { track: track.name, bar: barIndex + 1,
                    status: t(measureDifference(project, track, barIndex, activeVoice) > 0 ? '还差 {beats} 拍' : '超出 {beats} 拍',
                      { beats: formatBeats(measureDifference(project, track, barIndex, activeVoice), language) }) })}
                </p>}
                {visible.map((item) => <div className="beat-row" key={item.id}><strong>{item.name}</strong><div>
                  {beatList(project, voiceBars(item, item.id === position.track ? activeVoice : 0)[barIndex], barIndex).map((value, index) => <button key={index}
                    aria-label={t('{track}位置 {beat}', { track: item.name, beat: index + 1 })}
                    aria-pressed={selectedNotes.length ? selectedNotes.some((note) => sameBeat(note, { track: item.id, bar: barIndex, beat: index, voice: item.id === position.track ? activeVoice : 0 }))
                      : item.id === position.track && index === position.beat}
                    onClick={(event) => {
                      const target = { track: item.id, bar: barIndex, beat: index, voice: item.id === position.track ? activeVoice : 0 }
                      if (event.shiftKey || event.ctrlKey || event.metaKey) selectNote(target, event)
                      else selectBeat(target, !value.notes.length)
                    }}>
                    <small>{index + 1}</small><span>{value.draft ? '·' : value.notes.length ? value.notes.map((note) => note.string ? note.fret : pitchNames[note.midi % 12]).join('·') : t('休')}</span>
                  </button>)}
                </div></div>)}
              </ToolPanel>
            </PanelsSuspended.Provider>
          </section>
        </section>
        <PanelsSuspended.Provider value={!!(panel || scoreLabel || confirm || pasteWarning || busy)}>
        {track && <Editor suspended={!!(panel || scoreLabel || confirm || pasteWarning || barMenu)} score={project} track={track} position={position} mode={entryMode} beat={beat} editDraftRest={!!selection.editDraftRest}
          deleteNotes={deleteNotes}
          batch={noteTargets.length ? { beats: noteTargets.map(({ beat }) => beat), changeRhythm: changeSelectedRhythm, changePitch: changeSelectedPitch } : undefined}
          edit={(edit) => { clearNoteSelection(); commit((score) => changeBeat(score, position, edit)) }} spanSelection={spanSelection}
          putSpan={putSpan} removeSpan={removeSpan} putTuplet={putTuplet} next={() => move(1)} previous={() => move(-1)} extendBeat={extendBeat} />}
        </PanelsSuspended.Provider>
        {(panel || scoreLabel || confirm || pasteWarning || barMenu) && <div className="inspector inspector-placeholder" aria-hidden="true" />}
        {track && !(panel || scoreLabel || confirm || pasteWarning || barMenu) && <PanelWidthHandle label={t('调整右侧栏宽度')} side="left"
          width={() => workspace.current?.querySelector('.inspector')?.getBoundingClientRect().width ?? 0}
          resize={(width) => {
            if (workspace.current) setInspectorWidth(Math.max(0, width) / workspace.current.clientWidth * 100)
          }} />}
      </main>}
      <footer className="status-bar"><span>{project ? (dirty ? '● ' + t('未保存') : '✓ ' + t('已保存')) : t('叶子弦谱 · 本地工作区')}</span>
        <div className="status-notice">
          <span role="status">{audioState === 'loading' ? t('正在载入音色…') : notice ? displayMessage(t, notice) : t(project ? '乐谱与草稿保存在本机' : '选择模板，或打开已有工程')}</span>
          {!!midiWarnings.length && <button onClick={() => setPanel('midi-report')}>{t('MIDI 导入详情')}</button>}
        </div>
      </footer>
      {error && panel !== 'export' && <div role="alert" className="toast"><span>{displayMessage(t, error)}</span><button aria-label={t('关闭提示')} onClick={() => setError(null)}>×</button></div>}
    </div>
    {barMenu && createPortal(<div className="bar-menu-layer" onPointerDown={() => setBarMenu(null)} onKeyDown={(event) => { if (event.key === 'Escape') setBarMenu(null) }}>
      <div className="bar-menu" role="group" aria-label={t(barMenu.kind === 'note' ? '音符编辑' : '小节操作')} style={{ left: barMenu.x, top: barMenu.y }} onPointerDown={(event) => event.stopPropagation()}>
        {barMenu.kind === 'note' ? <>
          <button autoFocus disabled={!copyTargets.length} onClick={copyNotes}>{t('复制所选音符')}</button>
          <button disabled={!noteClipboard} onClick={() => pasteNotes(barMenu.position)}>{t('粘贴音符')}</button>
        </> : <>
        <button autoFocus onClick={() => copySelection()}>{t('复制小节')}</button>
        {!activePart && <button onClick={() => copySelection(true)}>{t('复制整段总谱')}</button>}
        <button disabled={!copied.current || measureSelection.length < 2} onClick={() => pasteSelection('selection', barMenu.position.bar, pasteStructure)}>{t('覆盖所选小节')}</button>
        <button disabled={!copied.current} onClick={() => pasteSelection('overwrite', barMenu.position.bar, pasteStructure)}>{t('从这里开始覆盖')}</button>
        <button disabled={!copied.current} onClick={() => pasteSelection('before', barMenu.position.bar, pasteStructure)}>{t('在前面插入粘贴')}</button>
        <button disabled={!copied.current} onClick={() => pasteSelection('after', barMenu.position.bar, pasteStructure)}>{t('在后面插入粘贴')}</button>
        {copied.current?.all && !activePart && <label className="checkbox"><input type="checkbox" checked={pasteStructure} onChange={(event) => setPasteStructure(event.target.checked)} />{t('包含结构记号')}</label>}
        </>}
      </div>
    </div>, barMenu.document.body)}
    {pendingPart && <Modal title={t('删除分谱')} close={() => { setPanel(null); setPartToRemove(null) }}>
      <p>{t('删除「{name}」后，总谱也会移除此分谱及其内容。此操作可以撤销。', { name: pendingPart.name })}</p>
      <div className="tool-actions">
        <button autoFocus onClick={() => { setPanel(null); setPartToRemove(null) }}>{t('取消')}</button>
        <button className="danger-action" onClick={() => removePart(pendingPart.id)}>{t('删除分谱')}</button>
      </div>
    </Modal>}
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
    {project && panel === 'intro' && <Modal title={t('前奏括号')} close={() => setPanel(null)}>
      <p>{t('选择前奏的起止小节，也可以精确到音符。括号随总谱、分谱一起显示和导出。')}</p>
      <div className="field-row">
        {([0, 1] as const).map((endpoint) => {
          const bar = introDraft[endpoint]
          const selectedTick = introDraft[endpoint + 2]
          let time = 0
          const options = track ? beatList(project, voiceBars(track, activeVoice)[bar], bar).map((beat, index) => {
            const start = time
            time += ticks(beat)
            const description = beat.notes.map(({ midi }) => pitchNames[midi % 12] + (Math.floor(midi / 12) - 1)).join(' / ') || t('休止')
            return { index, time: endpoint ? time : start, description }
          }) : []
          return <div className="intro-endpoint" key={endpoint}>
            <label>{t(endpoint ? '结束小节' : '起始小节')}
              <select value={bar} onChange={(event) => setIntroBar(endpoint, Number(event.target.value))}>
                {project.measures.map((_, index) => <option value={index} key={index}>{index + 1}</option>)}
              </select>
            </label>
            <label>{t(endpoint ? '结束音符' : '起始音符')}
              <select value={selectedTick ?? ''} onChange={(event) => {
                const value = event.target.value
                setIntroDraft(([first, last, start, end]) => endpoint
                  ? [first, last, start ?? null, value === '' ? null : Number(value)]
                  : [first, last, value === '' ? null : Number(value), end ?? null])
              }}>
                <option value="">{t(endpoint ? '小节末尾' : '小节开头')}</option>
                {selectedTick != null && !options.some(({ time }) => time === selectedTick) &&
                  <option value={selectedTick}>{t('已保存的拍位')}</option>}
                {options.map(({ index, time, description }) => <option value={time} key={index}>{index + 1} · {description}</option>)}
              </select>
            </label>
          </div>
        })}
      </div>
      <div className="tool-actions">
        <button className="primary" disabled={introDraft[0] === introDraft[1] && (introDraft[2] ?? -1) >= (introDraft[3] ?? Infinity)}
          onClick={() => saveIntro(introDraft[2] != null || introDraft[3] != null ? [introDraft[0], introDraft[1], introDraft[2] ?? null, introDraft[3] ?? null] : [introDraft[0], introDraft[1]])}>{t('应用前奏括号')}</button>
      </div>
      {project.intro && <div className="tool-actions tool-actions-danger">
        <button onClick={() => saveIntro()}>{t('移除前奏括号')}</button>
      </div>}
    </Modal>}
    {project && scoreLabel && (() => {
      const { kind, bar } = scoreLabel
      const source = project.measures.findLastIndex((measure, index) => index <= bar &&
        (kind === 'key' ? measure.key : measure.bpm) !== undefined)
      const changeBar = source < 0 ? undefined : source
      const close = () => { setKeyChangeError(undefined); setScoreLabel(null) }
      return <Modal title={t(kind === 'key' ? '编辑此处调号' : '编辑此处速度')} close={close}>
        <p className="key-change-help">{t('第 {bar} 小节 · {scope}', { bar: bar + 1, scope: scoreName(project, activePart, t) })}</p>
        {activePart && <p className="key-change-help">{t('调号和速度的修改会同步到总谱和分谱。')}</p>}
        {kind === 'key' ? <>
          <KeyChangeChoice mode={keyChangeMode} onChange={(mode) => { setKeyChangeMode(mode); setKeyChangeError(undefined) }} />
          <label>{t('调号')}<select value={measureSettings(project, bar).key} onChange={(event) => {
            if (applyKeySignature(Number(event.target.value), changeBar)) close()
          }}>
            {keyNames.map((name, index) => <option key={name} value={index - 7}>{t('{name} 大调', { name })}</option>)}
          </select></label>
          {keyChangeError && <p role="alert" className="inline-error">{t(keyChangeErrors[keyChangeError.reason])}</p>}
        </> : <form className="field-row" onSubmit={(event) => {
          event.preventDefault()
          const bpm = Number(new FormData(event.currentTarget).get('bpm'))
          if (bpm >= 20 && bpm <= 300) setLabelTempo(bpm, changeBar)
        }}>
          <label>{t('速度 BPM')}<input type="number" name="bpm" required min={20} max={300} defaultValue={measureSettings(project, bar).bpm} /></label>
          <button className="primary" type="submit">{t('应用')}</button>
        </form>}
        <div className="tool-actions tool-actions-danger">
          {changeBar !== undefined && <button onClick={() => {
            if (kind === 'tempo') setLabelTempo(undefined, changeBar)
            else if (applyKeySignature(undefined, changeBar)) close()
          }}>{t(kind === 'key' ? '移除此处调号变化' : '移除此处速度变化')}</button>}
          <button onClick={() => {
            const hidden = viewLayout?.hiddenLabels
            patchLayout({ hiddenLabels: { ...hidden, [kind]: [...new Set([...(hidden?.[kind] ?? []), bar])] } })
            close()
          }}>{t('从当前谱面隐藏')}</button>
        </div>
      </Modal>
    })()}
    {project && panel === 'settings' && <Modal title={t('曲谱设置')} close={() => { setKeyChangeError(undefined); setPanel(null) }}>
      <div className="field-row">
        <label>{t('调号')}<select value={project.key} onChange={(event) => applyKeySignature(Number(event.target.value))}>
          {keyNames.map((name, i) => <option key={name} value={i - 7}>{t('{name} 大调', { name })}</option>)}
        </select></label>
        <KeyChangeChoice mode={keyChangeMode} onChange={(mode) => { setKeyChangeMode(mode); setKeyChangeError(undefined) }} />
      </div>
      <p id="key-change-help" className="key-change-help">{t(keyChangeMode === 'pitch'
        ? '试听音高保持原样，简谱唱名按新调号显示。'
        : '音符按新调移调。曲中调号只影响到下一处曲中调号之前。')}</p>
      {keyChangeError && keyChangeError.bar === undefined && <p role="alert" className="inline-error">{t(keyChangeErrors[keyChangeError.reason])}</p>}
      <label>{t('曲名')}<input maxLength={200} value={project.title} onChange={(e) => commit((score) => ({ ...score, title: e.target.value }))} /></label>
      <label>{t('作者')}<input maxLength={200} value={project.author} onChange={(e) => commit((score) => ({ ...score, author: e.target.value }))} /></label>
      {Object.entries(creditFields).map(([key, label]) => {
        const field = key as keyof typeof creditFields
        return <label key={field}>{t(label)}<input maxLength={200} value={project.credits?.[field] ?? ''}
          onChange={(event) => commit((score) => ({ ...score, credits: { ...score.credits, [field]: event.target.value } }))} /></label>
      })}
      <WatermarkSettings project={project} edit={commit} />
      <div className="field-row">
        <label>{t('拍号')}<select value={project.meter.join('/')} onChange={(e) => {
          const meter = e.target.value.split('/').map(Number) as [number, number]
          commit((score) => ({ ...score, meter, pickup: Math.min(score.pickup, meter[0] - 1) }))
        }}>{meters.map((meter) => <option key={meter}>{meter}</option>)}</select></label>
        <label>{t('速度 BPM')}<input type="number" key={project.bpm} defaultValue={project.bpm} min={20} max={300}
          onBlur={(e) => { const bpm = Math.min(300, Math.max(20, Number(e.target.value) || project.bpm)); if (bpm !== project.bpm) commit((score) => ({ ...score, bpm })) }} /></label>
      </div>
      <fieldset><legend>{t('调号与分谱间距')}</legend>
        <div className="field-row">
          <label>{t('总谱分谱间距')}<input type="number" min={trackGapLimits[0]} max={trackGapLimits[1]} key={project.layout.trackGap}
            defaultValue={project.layout.trackGap ?? 5} onBlur={(event) => {
              const trackGap = Math.max(trackGapLimits[0], Math.min(trackGapLimits[1], Math.round(event.target.valueAsNumber || 0)))
              if (trackGap !== (project.layout.trackGap ?? 5)) commit((score) => ({ ...score, layout: { ...score.layout, trackGap } }))
              else event.target.value = String(trackGap)
            }} /></label>
          {(['x', 'y'] as const).map((axis) => {
            const keyLayout = viewLayout?.numberedKey ?? project.layout.numberedKey
            const offset = keyLayout?.[axis] ?? 0
            return <label key={axis}>{t(axis === 'x' ? '简谱调号水平偏移' : '简谱调号垂直偏移')}
              <input type="number" min={-120} max={120} key={offset} defaultValue={offset} onBlur={(event) => {
                const value = Math.max(-120, Math.min(120, Math.round(event.target.valueAsNumber || 0)))
                if (value !== offset) patchLayout({ numberedKey: { ...keyLayout, [axis]: value } })
                else event.target.value = String(value)
              }} />
            </label>
          })}
        </div>
        <p className="key-change-help">{t('用负值缩小分谱间距，允许谱面重叠。')}</p>
        <label className="checkbox"><input type="checkbox" checked={!(viewLayout?.numberedKey ?? project.layout.numberedKey)?.hidden}
          onChange={(event) => patchLayout({ numberedKey: { ...(viewLayout?.numberedKey ?? project.layout.numberedKey), hidden: !event.target.checked } })} />
          {t('显示简谱调号')}</label>
        {activePart && viewLayout?.numberedKey && <button onClick={() => patchLayout({ numberedKey: undefined })}>{t('简谱调号跟随总谱')}</button>}
        {viewLayout?.hiddenLabels && <button onClick={() => patchLayout({ hiddenLabels: undefined })}>{t('恢复已隐藏的调号和速度')}</button>}
      </fieldset>
      <label>{t('弱起 · 首小节拍数')}<select value={project.pickup} onChange={(e) => commit((score) => ({ ...score, pickup: Number(e.target.value) }))}>
        <option value={0}>{t('无弱起')}</option>{Array.from({ length: project.meter[0] - 1 }, (_, i) => <option key={i + 1} value={i + 1}>{i + 1}</option>)}</select></label>
      <fieldset><legend>{t('第 {bar} 小节的调号、拍号与速度', { bar: barIndex + 1 })}</legend><div className="field-row">
        <label>{t('曲中调号')}<select value={project.measures[barIndex].key ?? ''} aria-describedby="key-change-help" onChange={(event) =>
          applyKeySignature(event.target.value ? Number(event.target.value) : undefined, barIndex)}>
          <option value="">{t('沿用前文')}</option>{keyNames.map((name, i) => <option key={name} value={i - 7}>{name}</option>)}
        </select></label>
        {barMeterField('曲中拍号')}
        <label>{t('曲中速度')}<input key={barIndex} type="number" min={20} max={300} placeholder={t('沿用前文')} defaultValue={project.measures[barIndex].bpm ?? ''}
          onBlur={(event) => {
            const bpm = event.target.value ? Math.round(Math.min(300, Math.max(20, Number(event.target.value)))) : undefined
            if (bpm !== project.measures[barIndex].bpm) patchMeasure({ bpm })
          }} /></label>
      </div>
        {keyChangeError?.bar === barIndex && <p role="alert" className="inline-error">{t(keyChangeErrors[keyChangeError.reason])}</p>}
      </fieldset>
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
      <div className="field-row export-controls">
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
    {panel === 'midi-report' && <Modal title={t('MIDI 导入详情')} close={() => setPanel(null)}>
      <ul>{midiWarnings.map((key) => <li key={key}>{t(key)}</li>)}</ul>
    </Modal>}
    {confirm && <Modal title={t('保存当前工程？')} close={() => setConfirmation(null)}>
      <p>{t('当前工程有未保存的改动。')}</p><div className="inline"><button className="primary" onClick={async () => {
        if (await persist() && pendingConfirmation.current === confirm) { setConfirmation(null); confirm() }
      }}>{t('保存并继续')}</button><button onClick={() => discard(confirm)}>{t('放弃改动')}</button><button onClick={() => setConfirmation(null)}>{t('取消')}</button></div>
    </Modal>}
    {(printJob || (!storage.desktop && project && panel === 'export' && exportFormat === 'pdf')) && <div className="print-only" aria-hidden="true">
      <style>{'@page { size: ' + printDimensions.width + 'mm ' + printDimensions.height + 'mm; margin: ' + paperMargin + 'mm; }'}</style>
      <PrintSheet key={printJob?.key ?? 0} project={printJob?.project ?? project!} part={printJob ? printJob.part : previewPart}
        onReady={printRendered} onError={(cause) => { afterRender.current?.reject(cause); setError(message('无法为这份乐谱生成打印版面。', undefined, cause.message === '无法为这份乐谱生成打印版面。' ? undefined : cause)) }} />
    </div>}
  </>
}

function PartName({ track, active, select, rename }: { track: Track; active: boolean; select: () => void; rename: (name: string) => void }) {
  const { t } = useLanguage()
  const [editing, setEditing] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  const name = track.name || t(kinds[track.kind])

  function finish(value?: string, restoreFocus = false) {
    setEditing(false)
    const trimmed = value?.trim()
    if (trimmed && trimmed !== track.name) rename(trimmed)
    if (restoreFocus) requestAnimationFrame(() => button.current?.focus())
  }

  if (editing) return <input className="part-name-input" aria-label={t('分谱名称')} defaultValue={track.name}
    maxLength={200} autoFocus onFocus={(event) => event.currentTarget.select()} onBlur={(event) => finish(event.currentTarget.value)}
    onKeyDown={(event) => {
      if (event.nativeEvent.isComposing || (event.key !== 'Enter' && event.key !== 'Escape')) return
      event.preventDefault()
      event.stopPropagation()
      finish(event.key === 'Enter' ? event.currentTarget.value : undefined, true)
    }} />

  return <button ref={button} aria-label={name} aria-current={active ? 'page' : undefined}
    title={t('选中后再次点击名称或按 F2 重命名')} onClick={() => active ? setEditing(true) : select()}
    onKeyDown={(event) => {
      if (event.key !== 'F2') return
      event.preventDefault()
      if (!active) select()
      setEditing(true)
    }}>
    <span aria-hidden="true">{track.kind === 'voice' ? '♪' : track.kind === 'guitar' ? '≋' : '♩'}</span>
    <span className="part-name-label">{name}</span>
    {active && <span className="part-name-pencil" aria-hidden="true">✎</span>}
  </button>
}

function WatermarkSettings({ project, edit }: { project: Project; edit: (update: (score: Project) => Project) => void }) {
  const { t } = useLanguage()
  const style = project.watermarkStyle ?? defaultWatermarkStyle
  const fields = [['size', '水印大小', '%'], ['angle', '旋转角度', '°'], ['opacity', '不透明度', '%']] as const
  function patch(changes: Partial<WatermarkStyle>) {
    edit((score) => ({ ...score, watermarkStyle: { ...(score.watermarkStyle ?? defaultWatermarkStyle), ...changes } }))
  }

  return <fieldset className="watermark-settings">
    <legend>{t('水印')}</legend>
    <label>{t('水印文字')}<input maxLength={watermarkMaxLength} value={project.watermark ?? ''} aria-describedby="watermark-help"
      onChange={(event) => {
        const watermark = event.target.value
        edit((score) => ({ ...score, watermark: watermark || undefined }))
      }} /></label>
    <small id="watermark-help">{t('留空关闭水印。总谱、分谱及导出的每一页使用同一水印。')}</small>
    <label>{t('水印样式')}<select value={style.layout}
      onChange={(event) => patch({ layout: event.target.value as WatermarkStyle['layout'] })}>
      <option value="single">{t('居中单张')}</option>
      <option value="tiled">{t('全页平铺')}</option>
    </select></label>
    <div className="field-row">
      {fields.map(([key, label, unit]) => <label key={key}>
        <span>{t(label)} <span aria-hidden="true">{style[key]}{unit}</span></span>
        <input type="range" min={watermarkLimits[key][0]} max={watermarkLimits[key][1]} value={style[key]}
          aria-label={t(label)} aria-valuetext={style[key] + unit}
          onChange={(event) => patch({ [key]: event.currentTarget.valueAsNumber })} />
      </label>)}
    </div>
  </fieldset>
}

function KeyChangeChoice({ mode, onChange }: { mode: KeyChangeMode; onChange: (mode: KeyChangeMode) => void }) {
  const { t } = useLanguage()
  return <label>{t('切换调号时')}<select value={mode} onChange={(event) => onChange(event.target.value === 'numbered' ? 'numbered' : 'pitch')}>
    <option value="pitch">{t('保留实际音高')}</option>
    <option value="numbered">{t('保留简谱唱名（移调）')}</option>
  </select></label>
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
