import { useEffect, useRef, useState } from 'react'
import { useLanguage, type TextKey } from './i18n'
import { blank, durations, midiForDegree, pitchNames, ticks, type Beat, type Duration, type Mode, type Position, type Project, type Track } from './model'

type Entry = { duration: Duration; dots: 0 | 1; triplet: boolean; octave: number; accidental: number; string: number }
const initial: Entry = { duration: 4, dots: 0, triplet: false, octave: 0, accidental: 0, string: 1 }

export function Editor({ score, track, position, mode, beat, edit, next, previous }: {
  score: Project; track: Track; position: Position; mode: Mode; beat: Beat;
  edit: (fn: (b: Beat) => Beat) => void; next: () => void; previous: () => void
}) {
  const { language, t } = useLanguage()
  const [entry, setEntry] = useState<Entry>(initial)
  const [fret, setFret] = useState('')
  const [diagram, setDiagram] = useState('')
  const [error, setError] = useState<TextKey | ''>('')
  const guitar = track.kind === 'guitar'
  const tab = guitar && mode !== 'staff' && mode !== 'numbered'
  const staff = !tab && mode !== 'numbered'
  const selectedKey = position.track + '/' + position.bar + '/' + position.beat
  const previousKey = useRef('')
  useEffect(() => {
    if (previousKey.current !== selectedKey) {
      previousKey.current = selectedKey
      setFret('')
      setError('')
      setDiagram(beat.diagram?.join(' ') ?? '')
      if (!beat.draft) setEntry((old) => ({ ...old, duration: beat.duration, dots: beat.dots, triplet: beat.triplet }))
    }
  }, [selectedKey, beat])
  const rhythm = { duration: entry.duration, dots: entry.dots, triplet: entry.triplet }
  function putPitch(midi: number) {
    if (guitar) {
      const candidates = track.tuning.map((pitch, index) => ({ string: index + 1, fret: midi - pitch }))
        .filter((candidate) => candidate.fret >= 0 && candidate.fret <= 36)
        .sort((a, b) => a.fret - b.fret)
      if (!candidates.length) { setError('当前定弦无法弹出这个音。'); return }
      edit((old) => ({ ...old, ...rhythm, draft: false, notes: [{ midi, ...candidates[0] }] }))
    } else edit((old) => ({ ...old, ...rhythm, draft: false, notes: [{ midi }] }))
    next()
  }
  function rest() {
    edit((old) => ({ ...old, ...rhythm, notes: [], draft: false, tie: false, slur: false, lyric: undefined }))
    next()
  }
  function putFret(raw: string) {
    const value = Number(raw)
    if (!/^\d{1,2}$/.test(raw) || value < 0 || value > 36) { setError('请输入 0 至 36 品。'); return }
    setError('')
    edit((old) => ({ ...old, ...rhythm, draft: false, notes: [
      ...old.notes.filter((note) => note.string !== entry.string),
      { string: entry.string, fret: value, midi: track.tuning[entry.string - 1] + value },
    ] }))
    setFret('')
  }
  function degree(value: number) {
    if (!value) rest()
    else putPitch(midiForDegree(value, score.key, entry.octave, entry.accidental))
  }
  const staffPitch = (name: string) => {
    const degreeByLetter = 'cdefgab'.indexOf(name)
    return 60 + [0, 2, 4, 5, 7, 9, 11][degreeByLetter] + entry.octave * 12 + entry.accidental
  }
  function setRhythm(value: Partial<Pick<Entry, 'duration' | 'dots' | 'triplet'>>) {
    setEntry((old) => ({ ...old, ...value }))
    if (!beat.draft) edit((old) => ({ ...old, ...value }))
  }
  useEffect(() => {
    function keyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.altKey || event.metaKey ||
        (event.target instanceof HTMLElement && (event.target.matches('input, textarea, select') || event.target.isContentEditable))) return
      const key = event.key.toLowerCase()
      if (key === 'arrowright' || key === 'arrowleft') {
        event.preventDefault()
        if (key === 'arrowright') next()
        else previous()
      } else if (key === 'delete') {
        event.preventDefault()
        edit(() => blank())
      } else if (!tab && !staff && /^[0-7]$/.test(key)) {
        event.preventDefault()
        degree(Number(key))
      } else if (staff && /^[a-g]$/.test(key)) {
        event.preventDefault()
        putPitch(staffPitch(key))
      } else if (tab && /^\d$/.test(key)) {
        event.preventDefault()
        setFret((old) => old.length >= 2 ? key : old + key)
      } else if (tab && key === 'enter' && fret) {
        event.preventDefault()
        putFret(fret)
      }
    }
    window.addEventListener('keydown', keyDown)
    return () => window.removeEventListener('keydown', keyDown)
  })
  return <section className="inspector editor" aria-label={t('录入面板')}>
    <div className="inspector-head"><span className="eyebrow">{t('当前录入')}</span><strong>{track.name} · {t(tab ? '六线谱' : staff ? '五线谱' : '简谱')}</strong><small>{t('第 {bar} 小节 · 位置 {beat}', { bar: position.bar + 1, beat: position.beat + 1 })}</small></div>
    <div className="inspector-body">
      <div className="section-caption">{t('时值')} <span>{t('{beats} 拍', { beats: new Intl.NumberFormat(language, { maximumFractionDigits: 2 }).format(ticks({ ...blank(), ...rhythm }) / 960) })}</span></div>
      <div className="button-grid rhythm">{durations.slice(0, 6).map((duration) =>
        <button key={duration} aria-pressed={entry.duration === duration} onClick={() => setRhythm({ duration })}>{t(({ 1: '全音符', 2: '二分', 4: '四分', 8: '八分', 16: '十六分', 32: '三十二分', 64: '六十四分' } as const)[duration])}</button>)}</div>
      <div className="inline small-gap"><button aria-pressed={!!entry.dots} onClick={() => setRhythm({ dots: entry.dots ? 0 : 1 })}>{t('附点')}</button>
      <button aria-pressed={entry.triplet} onClick={() => setRhythm({ triplet: !entry.triplet })}>{t('三连音')}</button></div>
      <div className="section-caption">{t(tab ? '弦号与品位' : '音高')}</div>
      {tab ? <>
        <div className="button-grid">{track.tuning.map((midi, index) =>
          <button key={index} aria-pressed={entry.string === index + 1} onClick={() => setEntry({ ...entry, string: index + 1 })}>{t('{string}弦', { string: index + 1 })}</button>)}</div>
        <div className="inline"><input aria-label={t('品位')} inputMode="numeric" placeholder={t('0–36 品')} value={fret} maxLength={2} onChange={(e) => setFret(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) putFret(fret) }} />
          <button className="primary" onClick={() => putFret(fret)}>{t('加入')}</button></div>
        <small>{t('加入后可继续选择另一根弦，完成后点「下一拍」。')}</small>
      </> : <>
        <div className="inline">
          <label>{t('八度')}<select value={entry.octave} onChange={(e) => setEntry({ ...entry, octave: Number(e.target.value) })}>
            {[-2, -1, 0, 1, 2].map((octave) => <option key={octave} value={octave}>{octave > 0 ? '+' + octave : octave}</option>)}</select></label>
          <label>{t('变音')}<select value={entry.accidental} onChange={(e) => setEntry({ ...entry, accidental: Number(e.target.value) })}>
            <option value="-1">{t('降半音 ♭')}</option><option value="0">{t('原音')}</option><option value="1">{t('升半音 ♯')}</option></select></label>
        </div>
        {staff ? <div className="staff-input" aria-label={t('五线谱音高录入')}>{[...Array(9)].map((_, index) => {
          const ascending = 8 - index
          const letter = 'efgabcd ef'.replace(' ', '')[ascending]
          const midi = [64, 65, 67, 69, 71, 72, 74, 76, 77][ascending] + 12 * entry.octave + entry.accidental
          return <button key={index} className={index % 2 === 0 ? 'on-line' : ''} title={pitchNames[midi % 12] + String(Math.floor(midi / 12) - 1)}
            aria-label={t('录入 {note}', { note: letter.toUpperCase() + String(Math.floor(midi / 12) - 1) })} onClick={() => putPitch(midi)}><span>●</span></button>
        })}</div> : <div className="button-grid degrees">{[1, 2, 3, 4, 5, 6, 7].map((value) =>
          <button key={value} aria-label={t('录入简谱 {degree}', { degree: value })} onClick={() => degree(value)}>{value}</button>)}</div>}
      </>}
      <div className="inline small-gap"><button onClick={rest}>{t('休止')}</button><button onClick={() => edit(() => blank())}>{t('清空')}</button>
        <button onClick={previous}>{t('上一拍')}</button><button onClick={next}>{t('下一拍')}</button></div>
      <div className="section-caption">{t('歌词与记号')}</div>
      <label>{t('歌词')}<input maxLength={200} value={beat.lyric ?? ''} placeholder={t('当前拍的歌词')}
        onChange={(e) => edit((old) => ({ ...old, draft: false, lyric: e.target.value }))}
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) next() }} /></label>
      <label>{t('和弦名')}<input maxLength={30} value={beat.chord ?? ''} placeholder={t('例如 Am')}
        onChange={(e) => edit((old) => ({ ...old, draft: false, chord: e.target.value }))} /></label>
      <div className="inline small-gap">
        <button disabled={!beat.notes.length} aria-pressed={!!beat.tie} onClick={() => edit((old) => ({ ...old, tie: !old.tie }))}>{t('接延音线')}</button>
        <button disabled={!beat.notes.length} aria-pressed={!!beat.slur} onClick={() => edit((old) => ({ ...old, slur: !old.slur }))}>{t('起连奏线')}</button>
      </div>
      {guitar && <><div className="inline small-gap">
        <button disabled={!beat.notes.length} aria-pressed={!!beat.notes[0]?.slide} onClick={() => edit((old) => ({ ...old, notes: old.notes.map((note) => ({ ...note, slide: !old.notes[0]?.slide })) }))}>{t('滑音')}</button>
        <button disabled={!beat.notes.length} aria-pressed={!!beat.notes[0]?.bend} onClick={() => edit((old) => ({ ...old, notes: old.notes.map((note) => ({ ...note, bend: !old.notes[0]?.bend })) }))}>{t('推弦')}</button>
      </div>
      <label>{t('和弦图 · 1 弦至 6 弦')}<input value={diagram} placeholder="0 1 0 2 3 x" onChange={(e) => setDiagram(e.target.value)} /></label>
      <button onClick={() => {
        const values = diagram.trim().split(/[ ,，]+/)
        if (diagram.trim() && (values.length !== 6 || values.some((value) => !/^(x|[0-9]|[12][0-9]|3[0-6])$/i.test(value)))) {
          setError('请填写 6 个品位，x 表示不弹。'); return
        }
        setError('')
        edit((old) => ({ ...old, draft: false, diagram: diagram.trim() ? values.map((value) => value.toLowerCase() === 'x' ? -1 : Number(value)) : undefined }))
      }}>{t('应用和弦图')}</button></>}
      {error && <p className="inline-error" role="alert">{t(error)}</p>}
    </div>
  </section>
}
