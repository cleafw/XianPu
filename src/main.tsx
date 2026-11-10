import { createRoot } from 'react-dom/client'
import { useEffect, useReducer, useRef, useState, type ChangeEvent } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { Editor } from './Editor'
import { appName, displayMessage, languageKey, languageOf, LanguageContext, message, readLanguagePreference, translate, useLanguage,
  type Language, type LanguagePreference, type Message, type Translate } from './i18n'
import { ScoreView } from './ScoreView'
import { PrintSheet } from './PrintSheet'
import { beatList, blank, changeBeat, createProject, createTrack, keyNames, kinds, measureDifference, modes, parseProject,
  pitchNames, type Beat, type Kind, type Layout, type Mode, type Position, type Project, type Track } from './model'
import { playScore, stopPlayback } from './playback'
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

type PrintJob = { part: string | null; key: number; project: Project }
type ExportMode = 'current' | 'score' | 'parts'
const scoreName = (score: Project, part: string | null, t: Translate) => score.tracks.find((track) => track.id === part)?.name ?? t('总谱')

function readRecovery() {
  try {
    const raw = localStorage.getItem(storage.recoveryKey)
    return raw ? parseProject(raw) : null
  } catch { return null }
}
function measuresChange(score: Project, index: number, insert: boolean): Project {
  const measures = score.measures.slice()
  if (insert) measures.splice(index, 0, {})
  else measures.splice(index, 1)
  return { ...score, measures, tracks: score.tracks.map((track) => {
    const bars = track.bars.slice()
    if (insert) bars.splice(index, 0, [])
    else bars.splice(index, 1)
    return { ...track, bars }
  }) }
}
function updateTrack(score: Project, id: string, edit: (track: Track) => Track): Project {
  return { ...score, tracks: score.tracks.map((track) => track.id === id ? edit(track) : track) }
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
  const [notice, setNotice] = useState<Message | null>(null)
  const [error, setError] = useState<Message | null>(null)
  const [playing, setPlaying] = useState(false)
  const [panel, setPanel] = useState<'settings' | 'export' | 'track' | null>(null)
  const [confirm, setConfirm] = useState<(() => void) | null>(null)
  const [exportMode, setExportMode] = useState<ExportMode>('current')
  const [exportParts, setExportParts] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [printJob, setPrintJob] = useState<PrintJob | null>(null)
  const [printReady, setPrintReady] = useState(false)
  const [zoom, setZoom] = useState(100)
  const fileInput = useRef<HTMLInputElement>(null)
  const copied = useRef<{ beats: Beat[]; tuning: number[] } | null>(null)
  const afterRender = useRef<{ resolve: () => void; reject: (reason: Error) => void } | null>(null)
  const jobId = useRef(0)
  const dirty = !!project && saved !== project
  const activePart = project?.tracks.some((track) => track.id === part) ? part : null
  const track = project?.tracks.find((track) => track.id === (activePart ?? selection.track)) ?? project?.tracks[0]
  const barIndex = project ? Math.min(selection.bar, project.measures.length - 1) : 0
  const beats = project && track ? beatList(project, track.bars[barIndex], barIndex) : []
  const position: Position = { track: track?.id ?? '', bar: barIndex, beat: Math.min(selection.beat, Math.max(0, beats.length - 1)),
    lane: track?.id === selection.track ? selection.lane : undefined }
  const beat = beats[position.beat] ?? blank()
  const mode = track ? activePart ? track.layout.mode ?? track.mode : track.mode : 'numbered'
  const entryMode = mode === 'staff-tab' && position.lane === 'staff' ? 'staff' : mode
  const viewLayout = project && activePart ? track!.layout : project?.layout
  const activeRef = useRef({ project, dirty, path, saved, busy })
  activeRef.current = { project, dirty, path, saved, busy }
  const commit = (edit: (score: Project) => Project) => dispatch({ type: 'edit', edit })

  useEffect(() => {
    if (!project) return
    try {
      if (dirty) localStorage.setItem(storage.recoveryKey, JSON.stringify(project))
      else localStorage.removeItem(storage.recoveryKey)
    } catch { setError(message('无法写入恢复草稿。请保存工程。')) }
  }, [project, dirty])

  function load(score: Project | null, filename: string | null = null, clean = false) {
    stopPlayback()
    setPlaying(false)
    setError(null)
    setNotice(null)
    setPanel(null)
    setPart(null)
    setPath(filename)
    setSaved(clean ? score : null)
    setSelection({ track: score?.tracks[0].id ?? '', bar: 0, beat: 0 })
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
      if (event.isComposing || (!event.ctrlKey && !event.metaKey)) return
      const key = event.key.toLowerCase()
      if (key === 's' && activeRef.current.project) {
        event.preventDefault()
        if (!activeRef.current.busy) void persist(event.shiftKey)
      }
      if (key === 'z' && !panel && !confirm && !(event.target instanceof HTMLElement && event.target.matches('input,textarea'))) {
        event.preventDefault()
        dispatch({ type: event.shiftKey ? 'redo' : 'undo' })
      }
    }
    window.addEventListener('keydown', shortcuts)
    return () => window.removeEventListener('keydown', shortcuts)
  }, [panel, confirm, language])

  function move(step: 1 | -1) {
    if (!project || !track) return
    // Wait for the current edit to update the available beat positions.
    setSelection((current) => {
      if (step < 0 && position.beat === 0) {
        if (!position.bar) return position
        return { ...position, bar: position.bar - 1, beat: beatList(project, track.bars[position.bar - 1], position.bar - 1).length - 1 }
      }
      return { ...current, ...position, beat: position.beat + step }
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
    if (id) setSelection({ track: id, bar: barIndex, beat: 0 })
  }
  function patchLayout(changes: Partial<Layout>) {
    commit((score) => activePart ? updateTrack(score, activePart, (item) => ({ ...item, layout: { ...item.layout, ...changes } }))
      : { ...score, layout: { ...score.layout, ...changes } })
  }
  function selectMode(next: Mode) {
    if (!track) return
    if (activePart) patchLayout({ mode: next })
    else commit((score) => updateTrack(score, track.id, (item) => ({ ...item, mode: next })))
  }
  function printRendered() {
    setPrintReady(true)
    afterRender.current?.resolve()
    afterRender.current = null
  }
  function showExport() {
    setExportMode('current')
    setExportParts(project!.tracks.map((item) => item.id))
    setPrintReady(false)
    setPanel('export')
  }
  const previewPart = exportMode === 'score' ? null : exportMode === 'parts' ? exportParts[0] ?? activePart : activePart
  async function exportSelection() {
    if (!project || busy) return
    setError(null)
    if (!storage.desktop) { window.print(); return }
    const targets = exportMode === 'parts' ? exportParts : [previewPart]
    if (!targets.length) { setError(message('请至少选择一份分谱。')); return }
    const batch = exportMode === 'parts'
    setBusy(true)
    let completed = 0
    try {
      const title = storage.fileName(project.title, t) + ' - ' + storage.fileName(scoreName(project, targets[0], t), t)
      const destination = batch ? await storage.pickDirectory(t) : await storage.pickPdf(title, t)
      if (typeof destination !== 'string') return
      for (const [index, item] of targets.entries()) {
        const output = batch
          ? destination + '\\' + storage.fileName(project.title, t) + ' - ' + String(index + 1).padStart(2, '0') + ' ' + storage.fileName(scoreName(project, item, t), t) + '.pdf'
          : destination
        setPrintReady(false)
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('乐谱排版超时。')), 15000)
          afterRender.current = {
            resolve: () => { clearTimeout(timeout); requestAnimationFrame(() => requestAnimationFrame(() => resolve())) },
            reject: (cause) => { clearTimeout(timeout); reject(cause) },
          }
          setPrintJob({ project, part: item, key: ++jobId.current })
        })
        await document.fonts.ready
        await storage.exportPdf(output, !batch)
        completed++
      }
      setNotice(message('已导出 {count} 份 PDF', { count: completed }))
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
    if (playing) { stopPlayback(); setPlaying(false); return }
    try { setPlaying(true); await playScore(project, activePart, () => setPlaying(false)) }
    catch (cause) { setPlaying(false); setError(message('无法试听。', undefined, cause)) }
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
        <div className="brand"><div className="brand-icon" aria-hidden="true">♬</div><div><strong>{t(appName)}</strong>{language === 'zh' && <small>YEZI XIANPU</small>}</div></div>
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
          <button className="quiet" onClick={() => void togglePlay()}>{playing ? '■ ' + t('停止') : '▶ ' + t('试听')}</button>
          <button className="primary" onClick={showExport}>{t('导出 PDF')}</button>
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
          <div className="sidebar-foot"><button onClick={() => setPanel('settings')}>{t('曲谱设置')}</button><button onClick={() => setPanel('track')}>{t('乐器设置')}</button></div>
        </nav>
        <section className="canvas" aria-label={t('谱面工作区')}>
          <div className="canvas-heading"><div><span className="eyebrow">{scoreName(project, activePart, t)}</span><h1>{project.title}</h1></div>
            <div className="canvas-controls"><label>{t('谱式')}<select value={mode} onChange={(event) => selectMode(event.target.value as Mode)}>
              {Object.entries(modes).filter(([key]) => track?.kind === 'guitar' || key === 'staff' || key === 'numbered')
                .map(([key, value]) => <option key={key} value={key}>{t(value)}</option>)}</select></label>
              <label>{t('每行小节')}<select value={viewLayout!.barsPerLine} onChange={(e) => patchLayout({ barsPerLine: Number(e.target.value) })}>
                {Array.from({ length: 12 }, (_, i) => <option key={i + 1}>{i + 1}</option>)}</select></label>
              <label>{t('每页谱行')}<select value={viewLayout!.systemsPerPage} onChange={(e) => patchLayout({ systemsPerPage: Number(e.target.value) })}>
                {Array.from({ length: 6 }, (_, i) => <option key={i + 1}>{i + 1}</option>)}</select></label>
              <label>{t('缩放')}<select value={zoom} onChange={(e) => setZoom(Number(e.target.value))}>{[75, 90, 100, 125, 150].map((n) => <option key={n} value={n}>{n}%</option>)}</select></label></div></div>
          <div className="paper-scroll"><div className="paper" style={{ width: zoom + '%' }}>
            <ScoreView project={project} part={activePart} position={position} scale={zoom / 100} onSelect={setSelection} onError={(cause) => setError(message('谱面绘制失败。', undefined, cause))} />
          </div></div>
          <section className="position-panel" aria-label={t('小节与录入位置')}>
            <div className="position-header"><div><strong>{t('录入位置')}</strong><small>{t('可直接点谱面，也可在这里选择。')}</small></div>
              <div className="inline">
                <button disabled={project.measures.length >= 256} onClick={() => {
                  commit((score) => measuresChange(score, barIndex + 1, true)); setSelection({ ...position, bar: barIndex + 1, beat: 0 })
                }}>{t('插入小节')}</button>
                <button disabled={project.measures.length <= 1} onClick={() => {
                  commit((score) => measuresChange(score, barIndex, false)); setSelection({ ...position, bar: Math.min(barIndex, project.measures.length - 2), beat: 0 })
                }}>{t('删除小节')}</button>
                <button onClick={() => { copied.current = { beats: structuredClone(track!.bars[barIndex]), tuning: track!.tuning }; setNotice(message('已复制当前小节')) }}>{t('复制小节')}</button>
                <button onClick={() => {
                  const source = copied.current
                  if (!source) { setNotice(message('请先复制一个小节')); return }
                  if (source.tuning.join() !== track!.tuning.join()) { setError(message('只能粘贴到定弦相同或同为非吉他的乐器。')); return }
                  commit((score) => updateTrack(score, track!.id, (item) => ({ ...item, bars: item.bars.map((b, i) => i === barIndex ? structuredClone(source.beats) : b) })))
                }}>{t('粘贴小节')}</button>
              </div></div>
            <div className="measure-list" aria-label={t('选择小节')}>
              {project.measures.map((_, index) => {
                const difference = measureDifference(project, track!, index)
                const hint = difference ? t(difference > 0 ? '还差 {beats} 拍' : '超出 {beats} 拍', { beats: formatBeats(difference, language) }) : t('拍数完整')
                return <button key={index} aria-label={t('第 {bar} 小节，{status}', { bar: index + 1, status: hint })} aria-pressed={index === barIndex} title={hint} onClick={() => setSelection({ ...position, bar: index, beat: 0 })}>
                  {index + 1}<span aria-label={hint} className={difference < 0 ? 'over' : difference > 0 ? 'under' : 'full'}>●</span>
                </button>
              })}
            </div>
            {track && measureDifference(project, track, barIndex) !== 0 && <p className={'measure-status ' + (measureDifference(project, track, barIndex) < 0 ? 'over' : 'under')}>
              {t('{track}第 {bar} 小节{status}', { track: track.name, bar: barIndex + 1,
                status: t(measureDifference(project, track, barIndex) > 0 ? '还差 {beats} 拍' : '超出 {beats} 拍',
                  { beats: formatBeats(measureDifference(project, track, barIndex), language) }) })}
            </p>}
            {visible.map((item) => <div className="beat-row" key={item.id}><strong>{item.name}</strong><div>
              {beatList(project, item.bars[barIndex], barIndex).map((value, index) => <button key={index}
                aria-label={t('{track}位置 {beat}', { track: item.name, beat: index + 1 })} aria-pressed={item.id === position.track && index === position.beat}
                onClick={() => setSelection({ track: item.id, bar: barIndex, beat: index })}>
                <small>{index + 1}</small><span>{value.draft ? '·' : value.notes.length ? value.notes.map((note) => note.string ? note.fret : pitchNames[note.midi % 12]).join('·') : t('休')}</span>
              </button>)}
            </div></div>)}
          </section>
        </section>
        {track && !panel && !confirm && <Editor score={project} track={track} position={position} mode={entryMode} beat={beat}
          edit={(edit) => commit((score) => changeBeat(score, position, edit))} next={() => move(1)} previous={() => move(-1)} />}
        {(panel || confirm) && <div className="inspector inspector-placeholder" aria-hidden="true" />}
      </main>}
      <footer className="status-bar"><span>{project ? (dirty ? '● ' + t('未保存') : '✓ ' + t('已保存')) : t('叶子弦谱 · 本地工作区')}</span>
        <span role="status">{notice ? displayMessage(t, notice) : t(project ? '乐谱与草稿保存在本机' : '选择模板，或打开已有工程')}</span></footer>
      {error && panel !== 'export' && <div role="alert" className="toast"><span>{displayMessage(t, error)}</span><button aria-label={t('关闭提示')} onClick={() => setError(null)}>×</button></div>}
    </div>
    {project && panel === 'settings' && <Modal title={t('曲谱设置')} close={() => setPanel(null)}>
      <label>{t('曲名')}<input maxLength={200} value={project.title} onChange={(e) => commit((score) => ({ ...score, title: e.target.value }))} /></label>
      <label>{t('作者')}<input maxLength={200} value={project.author} onChange={(e) => commit((score) => ({ ...score, author: e.target.value }))} /></label>
      <div className="inline"><label>{t('调号')}<select value={project.key} onChange={(e) => commit((score) => ({ ...score, key: Number(e.target.value) }))}>
        {keyNames.map((name, i) => <option key={name} value={i - 7}>{t('{name} 大调', { name })}</option>)}</select></label>
        <label>{t('拍号')}<select value={project.meter.join('/')} onChange={(e) => {
          const meter = e.target.value.split('/').map(Number) as [number, number]
          commit((score) => ({ ...score, meter, pickup: Math.min(score.pickup, meter[0] - 1) }))
        }}>{[2, 4, 8, 16].flatMap((unit) => Array.from({ length: 12 }, (_, i) => (i + 1) + '/' + unit)).map((meter) => <option key={meter}>{meter}</option>)}</select></label>
        <label>{t('速度 BPM')}<input type="number" key={project.bpm} defaultValue={project.bpm} min={20} max={300}
          onBlur={(e) => { const bpm = Math.min(300, Math.max(20, Number(e.target.value) || project.bpm)); if (bpm !== project.bpm) commit((score) => ({ ...score, bpm })) }} /></label>
      </div>
      <label>{t('弱起 · 首小节拍数')}<select value={project.pickup} onChange={(e) => commit((score) => ({ ...score, pickup: Number(e.target.value) }))}>
        <option value={0}>{t('无弱起')}</option>{Array.from({ length: project.meter[0] - 1 }, (_, i) => <option key={i + 1} value={i + 1}>{i + 1}</option>)}</select></label>
      <fieldset><legend>{t('第 {bar} 小节的反复记号', { bar: barIndex + 1 })}</legend>
        {(['start', 'end'] as const).map((side) => <label className="checkbox" key={side}>
          <input type="checkbox" checked={!!project.measures[barIndex][side]} onChange={(e) => commit((score) => ({ ...score,
            measures: score.measures.map((m, i) => i === barIndex ? { ...m, [side]: e.target.checked } : m) }))} />
          {t(side === 'start' ? '反复开始' : '反复结束（演奏两遍）')}</label>)}</fieldset>
    </Modal>}
    {project && track && panel === 'track' && <Modal title={t('乐器设置')} close={() => setPanel(null)}>
      <label>{t('乐器名称')}<input maxLength={200} value={track.name} onChange={(e) => commit((score) => updateTrack(score, track.id, (item) => ({ ...item, name: e.target.value })))}/></label>
      {track.kind === 'guitar' && <><p>{t('定弦从 1 弦到 6 弦排列。修改定弦时保留原弦号和品位。')}</p>
      <div className="tuning">{track.tuning.map((note, i) => <label key={i}>{t('{string} 弦', { string: i + 1 })}<select value={note}
        onChange={(event) => {
          const pitch = Number(event.target.value)
          commit((score) => updateTrack(score, track.id, (item) => ({ ...item,
            tuning: item.tuning.map((old, j) => i === j ? pitch : old),
            bars: item.bars.map((bar) => bar.map((b) => ({ ...b, notes: b.notes.map((n) => n.string === i + 1 ? { ...n, midi: pitch + n.fret! } : n) }))),
          })))
        }}>{Array.from({ length: 92 }, (_, n) => <option key={n} value={n}>{pitchNames[n % 12]}{Math.floor(n / 12) - 1}</option>)}</select></label>)}</div></>}
    </Modal>}
    {project && panel === 'export' && <Modal title={t('导出 PDF')} close={() => { if (!busy) setPanel(null) }} wide>
      <div className="export-controls"><label>{t('导出范围')}<select disabled={busy} value={exportMode} onChange={(e) => { setPrintReady(false); setExportMode(e.target.value as ExportMode) }}>
        <option value="current">{t('当前谱')}</option><option value="score">{t('整份总谱')}</option><option value="parts">{t('批量导出分谱')}</option>
      </select></label><button className="primary" disabled={busy || !printReady || (exportMode === 'parts' && !exportParts.length)} onClick={() => void exportSelection()}>
        {t(busy ? '正在导出…' : '选择保存位置')}</button></div>
      {exportMode === 'parts' && <fieldset><legend>{t('选择需要导出的分谱')}</legend>{project.tracks.map((item) => <label className="checkbox" key={item.id}>
        <input type="checkbox" disabled={busy} checked={exportParts.includes(item.id)} onChange={(e) => {
          const next = e.target.checked ? [...exportParts, item.id] : exportParts.filter((id) => id !== item.id)
          if (next[0] !== exportParts[0]) setPrintReady(false)
          setExportParts(next)
        }} />{item.name}</label>)}</fieldset>}
      {error && <p className="inline-error" role="alert">{displayMessage(t, error)}</p>}<div className="preview-label">{t('A4 预览')} · {scoreName(project, previewPart, t)}{exportMode === 'parts' ? t('（预览第一份）') : ''}</div>
      <div className="preview-scroll"><PrintSheet key={exportMode + ":" + previewPart} project={project} part={previewPart} onReady={() => setPrintReady(true)} onError={(cause) => setError(message('无法为这份乐谱生成打印版面。', undefined, cause.message === '无法为这份乐谱生成打印版面。' ? undefined : cause))} /></div>
    </Modal>}
    {confirm && <Modal title={t('保存当前工程？')} close={() => setConfirm(null)}>
      <p>{t('当前工程有未保存的改动。')}</p><div className="inline"><button className="primary" onClick={async () => {
        if (await persist()) { setConfirm(null); confirm() }
      }}>{t('保存并继续')}</button><button onClick={() => discard(confirm)}>{t('放弃改动')}</button><button onClick={() => setConfirm(null)}>{t('取消')}</button></div>
    </Modal>}
    {(printJob || (!storage.desktop && project && panel === 'export')) && <div className="print-only" aria-hidden="true">
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
