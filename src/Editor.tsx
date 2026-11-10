import { useEffect, useRef, useState } from 'react'
import { useLanguage, type TextKey } from './i18n'
import { NotationEditor } from './NotationEditor'
import { ToolPanel } from './ToolPanel'
import type { SpanEnd } from './notationMarks'
import { blank, durations, measureSettings, midiForDegree, pitchNames, previousBeat, matchingTie, staffAccidental, ticks, tonic, writtenKey, type Beat, type Duration, type Mode, type Position, type Project, type Track } from './model'

type Entry = { duration: Duration; dots: Beat['dots']; triplet: boolean; octave: number; accidental?: number; string: number }
const initial: Entry = { duration: 4, dots: 0, triplet: false, octave: 0, string: 1 }
const longValues = [{ duration: 4, dots: 0 }, { duration: 2, dots: 0 }, { duration: 2, dots: 1 }, { duration: 1, dots: 0 }] as const

export function Editor({ score, track, position, mode, beat, edit, putSpan, removeSpan, putTuplet, next, previous, suspended = false }: {
  score: Project; track: Track; position: Position; mode: Mode; beat: Beat;
  edit: (fn: (b: Beat) => Beat) => void; putSpan: (from: Position, to: Position, span: SpanEnd) => boolean; removeSpan: (id: string) => void; putTuplet: (from: Position, to: Position, ratio?: [number, number]) => boolean; next: () => void; previous: () => void; suspended?: boolean
}) {
  const { language, t } = useLanguage()
  const [entry, setEntry] = useState<Entry>(initial)
  const [fret, setFret] = useState('')
  const [diagram, setDiagram] = useState('')
  const [wholeChord, setWholeChord] = useState(false)
  const [verse, setVerse] = useState(0)
  const [gracePitch, setGracePitch] = useState<number | null>(null)
  const [tupletStart, setTupletStart] = useState<Position | null>(null)
  const [ratio, setRatio] = useState<[number, number]>([3, 2])
  useEffect(() => setTupletStart(null), [score.measures])
  const [error, setError] = useState<TextKey | ''>('')
  const guitar = track.kind === 'guitar'
  const tab = guitar && mode !== 'staff' && mode !== 'numbered'
  const percussion = mode === 'percussion'
  const staff = !tab && mode !== 'numbered' && !percussion
  const transposition = track.transpose ?? 0
  const keySignature = writtenKey(measureSettings(score, position.bar).key, transposition)
  const clef = mode === 'piano' ? track.voices?.[(position.voice ?? 0) - 1]?.staff === 1 ? 'bass' : 'treble' : track.clef ?? 'treble'
  const base = clef === 'bass' ? 48 : 60
  const previousEntry = previousBeat(score, track, position)
  const validTie = !!previousEntry?.notes.some((note) => beat.notes.some((target) => matchingTie(note, target)))
  const current = guitar ? beat.notes.find((tone) => tone.string === entry.string) ?? beat.notes[0] : beat.notes[position.note ?? 0] ?? beat.notes[0]
  const octaveOf = (midi: number) => Math.floor((midi + transposition - (staff ? base : tonic(keySignature))) / 12)
  const selectedKey = position.track + '/' + (position.voice ?? 0) + '/' + position.bar + '/' + position.beat
  const previousKey = useRef('')
  useEffect(() => { if (position.string) setEntry((old) => ({ ...old, string: position.string! })) }, [position.string, selectedKey])
  useEffect(() => {
    if (previousKey.current !== selectedKey) {
      previousKey.current = selectedKey
      setFret('')
      setError('')
      setDiagram(beat.diagram?.join(' ') ?? '')
      setGracePitch(null)
      if (!beat.draft) setEntry((old) => ({ ...old, duration: beat.duration, dots: beat.dots, triplet: beat.triplet }))
    }
  }, [selectedKey, beat])
  const rhythm = { duration: entry.duration, dots: entry.dots, triplet: entry.triplet }
  function changePitch(amount: number) {
    if (!current) return
    if (percussion) return
    const notes = beat.notes.map((tone) => {
      if (tone !== current && !wholeChord) return tone
      return { ...tone, midi: tone.midi + amount, fret: tone.fret === undefined ? undefined : tone.fret + amount }
    })
    if (notes.some(({ midi }) => midi < 0 || midi > 127)) { setError('音高超出可记谱范围。'); return }
    if (notes.some(({ fret }) => fret !== undefined && (fret < 0 || fret > 36))) { setError('当前定弦无法弹出这个音。'); return }
    setError('')
    edit((old) => ({ ...old, notes }))
  }
  function putPitch(midi: number) {
    if (midi < 0 || midi > 127) { setError('音高超出可记谱范围。'); return }
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
    edit((old) => ({ ...old, ...rhythm, notes: [], draft: false, tie: false, slur: false, lyric: undefined, verses: undefined, grace: undefined }))
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
    else putPitch(midiForDegree(value, keySignature, entry.octave, entry.accidental ?? 0) - transposition)
  }
  const staffPitch = (name: string) => {
    const degreeByLetter = 'cdefgab'.indexOf(name)
    return base + [0, 2, 4, 5, 7, 9, 11][degreeByLetter] + entry.octave * 12 + (entry.accidental ?? staffAccidental(name, keySignature))
  }
  function setRhythm(value: Partial<Pick<Entry, 'duration' | 'dots' | 'triplet'>>) {
    setEntry((old) => ({ ...old, ...value }))
    if (!beat.draft) edit((old) => ({ ...old, ...value }))
  }
  function stepRhythm(amount: number, long = false) {
    if (long) {
      const index = longValues.findIndex((value) => value.duration === entry.duration && value.dots === entry.dots)
      const nextValue = longValues[index + amount]
      if (index >= 0 && nextValue) setRhythm(nextValue)
    } else {
      const duration = durations[durations.indexOf(entry.duration) + amount]
      if (duration) setRhythm({ duration })
    }
  }
  useEffect(() => {
    function keyDown(event: KeyboardEvent) {
      if (suspended || event.defaultPrevented || event.isComposing || event.ctrlKey || event.altKey || event.metaKey ||
        (event.target instanceof HTMLElement && (event.target.matches('input, textarea, select') || event.target.isContentEditable))) return
      const key = event.key.toLowerCase()
      if (event.shiftKey && (key === 'arrowup' || key === 'arrowdown')) {
        event.preventDefault()
        changePitch(key === 'arrowup' ? 12 : -12)
      } else if (key === '[' || key === ']') {
        event.preventDefault()
        stepRhythm(key === '[' ? 1 : -1)
      } else if (key === 'arrowright' || key === 'arrowleft') {
        event.preventDefault()
        if (key === 'arrowright') next()
        else previous()
      } else if (key === 'delete') {
        event.preventDefault()
        edit(() => blank())
      } else if (!percussion && !tab && !staff && /^[0-7]$/.test(key)) {
        event.preventDefault()
        degree(Number(key))
      } else if (staff && /^[a-g]$/.test(key)) {
        event.preventDefault()
        putPitch(staffPitch(key) - transposition)
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
  return <section className="inspector editor" hidden={suspended} aria-label={t('录入面板')}>
    <div className="inspector-head"><span className="eyebrow">{t('当前录入')}</span><strong>{track.name} · {t(percussion ? '打击乐谱' : tab ? '六线谱' : staff ? '五线谱' : '简谱')}</strong><small>{t('第 {bar} 小节 · 位置 {beat}', { bar: position.bar + 1, beat: position.beat + 1 })}</small></div>
    <div className="inspector-body">
      <ToolPanel label={t('时值')} initialOpen hint={t('{beats} 拍', { beats: new Intl.NumberFormat(language, { maximumFractionDigits: 2 })
        .format(ticks({ ...blank(), ...rhythm, tuplet: beat.tuplet }) / (3840 / measureSettings(score, position.bar).meter[1])) })}>
      <div className="button-grid rhythm">{durations.map((duration) =>
        <button key={duration} aria-pressed={entry.duration === duration} onClick={() => setRhythm({ duration })}>{t(({ 1: '全音符', 2: '二分', 4: '四分', 8: '八分', 16: '十六分', 32: '三十二分', 64: '六十四分' } as const)[duration])}</button>)}</div>
      <div className="inline small-gap"><button aria-pressed={entry.dots === 1} onClick={() => setRhythm({ dots: entry.dots === 1 ? 0 : 1 })}>{t('附点')}</button>
      <button aria-pressed={entry.dots === 2} onClick={() => setRhythm({ dots: entry.dots === 2 ? 0 : 2 })}>{t('双附点')}</button>
      <button disabled={!!beat.tuplet} aria-pressed={entry.triplet} onClick={() => setRhythm({ triplet: !entry.triplet })}>{t('三连音')}</button></div>
      <div className="inline small-gap">
        <button title="[" disabled={entry.duration === 64} onClick={() => stepRhythm(1)}>{t(mode === 'numbered' ? '加减时线' : '缩短时值')}</button>
        <button title="]" disabled={mode === 'numbered' ? entry.duration <= 4 : entry.duration === 1} onClick={() => stepRhythm(-1)}>{t(mode === 'numbered' ? '去减时线' : '延长时值')}</button>
        {mode === 'numbered' && <>
          <button disabled={!longValues.some((value, i) => i < 3 && value.duration === entry.duration && value.dots === entry.dots)} onClick={() => stepRhythm(1, true)}>{t('加增时线')}</button>
          <button disabled={!longValues.some((value, i) => i > 0 && value.duration === entry.duration && value.dots === entry.dots)} onClick={() => stepRhythm(-1, true)}>{t('去增时线')}</button>
        </>}
      </div>
      </ToolPanel>
      <ToolPanel label={t(tab ? '弦号与品位' : '音高')} initialOpen>
      {percussion ? <div className="button-grid">{([['底鼓', 36], ['军鼓', 38], ['闭合踩镲', 42], ['开放踩镲', 46],
        ['嗵鼓', 47], ['吊镲', 49], ['叮叮镲', 51]] as const).map(([label, midi]) =>
        <button key={midi} onClick={() => putPitch(midi)}>{t(label)}</button>)}</div> : tab ? <>
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
          <label>{t('变音')}<select value={entry.accidental ?? 'auto'} onChange={(e) => setEntry({ ...entry, accidental: e.target.value === 'auto' ? undefined : Number(e.target.value) })}>
            <option value="auto">{t('跟随调号')}</option>
            <option value="-1">{t('降半音 ♭')}</option><option value="0">{t('还原 ♮')}</option><option value="1">{t('升半音 ♯')}</option></select></label>
        </div>
        {staff ? <div className="staff-input" aria-label={t('五线谱音高录入')}>{[...Array(9)].map((_, index) => {
          const ascending = 8 - index
          const start = clef === 'bass' ? -3 : clef === 'alto' ? -4 : 2
          const degree = start + ascending
          const letter = 'cdefgab'[(degree + 7) % 7]
          const midi = staffPitch(letter) + Math.floor(degree / 7) * 12
          return <button key={index} className={index % 2 === 0 ? 'on-line' : ''} title={pitchNames[midi % 12] + String(Math.floor(midi / 12) - 1)}
            aria-label={t('录入 {note}', { note: letter.toUpperCase() + String(Math.floor(midi / 12) - 1) })} onClick={() => putPitch(midi - transposition)}><span>●</span></button>
        })}</div> : <div className="button-grid degrees">{[1, 2, 3, 4, 5, 6, 7].map((value) =>
          <button key={value} aria-label={t('录入简谱 {degree}', { degree: value })} onClick={() => degree(value)}>{value}</button>)}</div>}
      </>}
      {beat.notes.length > 1 && <label className="checkbox"><input type="checkbox" checked={wholeChord}
        onChange={(event) => setWholeChord(event.target.checked)} />{t('一起移动和弦音')}</label>}
      {current && <small>{t('所选音：{pitch} · 八度 {octave}', { pitch: pitchNames[current.midi % 12] + (Math.floor(current.midi / 12) - 1), octave: octaveOf(current.midi) })}</small>}
      {!percussion && <div className="inline small-gap">
        <button title="Shift+↑" disabled={!current} onClick={() => changePitch(12)}>{t('升八度')}</button>
        <button title="Shift+↓" disabled={!current} onClick={() => changePitch(-12)}>{t('降八度')}</button>
        <button disabled={!current} onClick={() => changePitch(1)}>{t('升半音')}</button>
        <button disabled={!current} onClick={() => changePitch(-1)}>{t('降半音')}</button>
      </div>}
      <div className="inline small-gap"><button onClick={rest}>{t('休止')}</button><button onClick={() => edit(() => blank())}>{t('清空')}</button>
        <button onClick={previous}>{t('上一拍')}</button><button onClick={next}>{t('下一拍')}</button></div>
      </ToolPanel>
      <ToolPanel label={t('歌词与和弦')} initialOpen>
      {track.kind === 'voice' && <label>{t('歌词段落')}<select value={verse} onChange={(event) => setVerse(Number(event.target.value))}>
        {Array.from({ length: 5 }, (_, index) => <option key={index} value={index}>{t('第 {number} 段', { number: index + 1 })}</option>)}
      </select></label>}
      <label>{t('歌词')}<input maxLength={200} value={(track.kind === 'voice' && verse ? beat.verses?.[verse - 1] : beat.lyric) ?? ''} placeholder={t('当前拍的歌词')}
        onChange={(e) => {
          const value = e.target.value
          edit((old) => {
            if (track.kind !== 'voice' || !verse) return { ...old, draft: false, lyric: value }
            const verses = Array.from({ length: Math.max(verse, old.verses?.length ?? 0) }, (_, index) => index === verse - 1 ? value : old.verses?.[index] ?? '')
            return { ...old, draft: false, verses }
          })
        }}
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) next() }} /></label>
      <label>{t('和弦名')}<input maxLength={30} value={beat.chord ?? ''} placeholder={t('例如 Am')}
        onChange={(e) => edit((old) => ({ ...old, draft: false, chord: e.target.value }))} /></label>
      </ToolPanel>
      <ToolPanel label={t('连线与常用技巧')} initialOpen>
      <div className="inline small-gap">
        <button disabled={!validTie && !beat.tie} aria-pressed={!!beat.tie} onClick={() => edit((old) => ({ ...old, tie: !old.tie }))}>{t('接延音线')}</button>
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
      </ToolPanel>
      <ToolPanel label={t('倚音与成组连音')}>
        {!percussion && <div className="inline small-gap">
          <label>{t('倚音音高')}<select value={gracePitch ?? Math.min(127, (current?.midi ?? 60) + 2)}
            onChange={(event) => setGracePitch(Number(event.target.value))}>
            {Array.from({ length: 128 }, (_, midi) => <option value={midi} key={midi}>{pitchNames[midi % 12]}{Math.floor(midi / 12) - 1}</option>)}
          </select></label>
          <button disabled={!current || (beat.grace?.length ?? 0) >= 4} onClick={() => {
            const pitch = gracePitch ?? Math.min(127, (current?.midi ?? 60) + 2)
            if (guitar && !track.tuning.some((open) => pitch >= open && pitch - open <= 36)) { setError('当前定弦无法弹出这个音。'); return }
            setError('')
            edit((old) => ({ ...old, grace: [...old.grace ?? [], pitch] }))
          }}>{t('添加前倚音')}</button>
        </div>}
        {beat.grace?.map((midi, index) => <div className="inline small-gap" key={index}>
          <span>{pitchNames[midi % 12]}{Math.floor(midi / 12) - 1}</span>
          <button onClick={() => edit((old) => ({ ...old, grace: old.grace?.filter((_, i) => i !== index) }))}>{t('移除倚音')}</button>
        </div>)}
        <div className="inline small-gap">
          <label>{t('连音个数')}<select value={ratio[0]} onChange={(event) => setRatio([Number(event.target.value), ratio[1]])}>
            {[2, 3, 4, 5, 6, 7, 8, 9].map((value) => <option key={value}>{value}</option>)}
          </select></label>
          <label>{t('占用原时值个数')}<select value={ratio[1]} onChange={(event) => setRatio([ratio[0], Number(event.target.value)])}>
            {[1, 2, 3, 4, 5, 6, 7, 8].map((value) => <option key={value}>{value}</option>)}
          </select></label>
        </div>
        <div className="inline small-gap">{tupletStart ? <>
          <button onClick={() => {
            if (putTuplet(tupletStart, position, ratio)) { setTupletStart(null); setError('') }
            else setError('请在同一小节选择相应数量的音符或休止。')
          }}>{t('在这里结束')}</button>
          <button onClick={() => {
            if (putTuplet(tupletStart, position)) { setTupletStart(null); setError('') }
            else setError('请在同一小节选择相应数量的音符或休止。')
          }}>{t('清除这组连音')}</button>
          <button onClick={() => setTupletStart(null)}>{t('取消起点')}</button>
        </> : <button disabled={!!beat.draft} onClick={() => setTupletStart(position)}>{t('设置连音起点')}</button>}</div>
      </ToolPanel>
      <NotationEditor beat={beat} position={position} measures={score.measures} technique={track.technique ?? (track.kind === 'guitar' ? '吉他' : undefined)} guitarString={guitar ? current?.string : undefined} edit={edit} putSpan={putSpan} removeSpan={removeSpan} />
      {error && <p className="inline-error" role="alert">{t(error)}</p>}
    </div>
  </section>
}
