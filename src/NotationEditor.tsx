import { useEffect, useState, type ReactNode } from 'react'
import { useLanguage } from './i18n'
import { ToolPanel } from './ToolPanel'
import { markSymbol, type MarkSymbol } from './markGlyphs'
import { defaultMarkPlace, markHasPlayback, spanHasPlayback, spanKinds, spanLabels, symbolAliases, symbols, type ScoreMark, type SpanEnd, type SymbolCode } from './notationMarks'
import { techniqueGroups, type Beat, type Measure, type Position, type Track } from './model'

const views = [['grid', '图标网格', '▦'], ['list', '记号列表', '☰'], ['select', '下拉选择', '▾']] as const
type MarkView = typeof views[number][0]
const spanSymbols: Record<SpanEnd['kind'], string> = {
  slur: '⌒', crescendo: '＜', diminuendo: '＞', roll: '∿', custom: '┄', flutter: '★∿',
  palmMute: 'P.M.', ottavaUp: '8va', ottavaDown: '8vb', pedal: 'Ped.', lyricExtend: '⎯',
  trillLine: 'tr∿', glissandoLine: '∿', letRingLine: 'l.r.', pipaLongRoll: '*—',
}

function MarkPalette<T extends string>({ items, view, label, name, symbol, pick, disabled }: {
  items: readonly T[]; view: 'grid' | 'list'; label: string; name: (item: T) => string;
  symbol: (item: T) => MarkSymbol; pick: (item: T) => void; disabled?: boolean
}) {
  return <div className={'mark-palette mark-palette-' + view} role="group" aria-label={label}>
    {items.map((item) => {
      const glyph = symbol(item)
      const music = typeof glyph === 'number'
      return <button key={item} type="button" aria-label={name(item)} title={name(item)} disabled={disabled} onClick={() => pick(item)}>
        <span className={'mark-preview' + (music ? ' mark-preview-music' : '')} aria-hidden="true">
          {typeof glyph === 'object' ? <svg width="22" height="22" viewBox="-9 -9 18 18">
            <path d={glyph.path} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg> : music ? String.fromCodePoint(glyph) : glyph}
        </span>
        {view === 'list' && <span>{name(item)}</span>}
      </button>
    })}
  </div>
}

export function NotationEditor({ beat, position, measures, technique, guitarString, graceControls, edit, spanSelection, putSpan, removeSpan }: {
  beat: Beat; position: Position; measures: Measure[]; technique?: Track['technique']; guitarString?: number; edit: (fn: (old: Beat) => Beat) => void
  putSpan: (start: Position, end: Position, span: SpanEnd) => boolean; removeSpan: (id: string) => void
  spanSelection?: readonly [Position, Position] | null
  graceControls?: ReactNode
}) {
  const { language, t } = useLanguage()
  const lang = language === 'zh' ? 0 : 1
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState(technique ?? '')
  const [view, setView] = useState<MarkView>('grid')
  useEffect(() => { setCategory(technique ?? '') }, [technique, position.track])
  const [code, setCode] = useState<ScoreMark['code']>('staccato')
  const [place, setPlace] = useState<ScoreMark['place'] | ''>('')
  const [text, setText] = useState('')
  const [specificString, setSpecificString] = useState(false)
  const [kind, setKind] = useState<SpanEnd['kind']>('slur')
  const [rangeText, setRangeText] = useState('')
  const [start, setStart] = useState<{ at: Position; span: SpanEnd } | null>(null)
  const [invalidEnd, setInvalidEnd] = useState(false)
  useEffect(() => { setStart(null); setInvalidEnd(false) }, [measures])
  const items = (Object.keys(symbols) as SymbolCode[]).filter((key) => {
    const row = symbols[key]
    return (!category || row[0] === category) && [key, ...row, symbolAliases[key] ?? '']
      .some((term) => term.toLowerCase().includes(search.trim().toLowerCase()))
  })
  const showCustom = !category && (!search || '自定义文字符号 custom text symbol'.includes(search.trim().toLowerCase()))
  const selected = code !== 'text' && items.includes(code) ? code : items[0] ?? (showCustom ? 'text' : '')
  const effective = code === 'text' && showCustom ? 'text' : selected
  const name = (key: ScoreMark['code']) => key === 'text' ? t('自定义文字或符号') : symbols[key][1 + lang]
  const rangeName = (key: SpanEnd['kind']) => spanLabels[key][lang]
  const full = (beat.marks?.length ?? 0) >= 32
  function addMark(key: ScoreMark['code']) {
    const custom = key === 'text' ? text.trim() : undefined
    if (full || (key === 'text' && !custom)) return
    const mark: ScoreMark = { id: crypto.randomUUID(), code: key, text: custom,
      place: place || defaultMarkPlace(key), dx: 0, dy: 0, string: specificString ? guitarString : undefined }
    edit((old) => ({ ...old, draft: false, marks: [...old.marks ?? [], mark] }))
  }
  const manualStart = spanSelection === undefined ? start : null
  function addSpan(key: SpanEnd['kind']) {
    const span: SpanEnd = { id: crypto.randomUUID(), kind: key, end: false,
      text: key === 'custom' ? rangeText.trim() || undefined : undefined }
    if (spanSelection === undefined) {
      setStart({ at: position, span })
      setInvalidEnd(false)
    } else if (spanSelection && putSpan(...spanSelection, span)) {
      setStart(null)
      setInvalidEnd(false)
    } else setInvalidEnd(true)
  }
  function patch(id: string, values: Partial<ScoreMark>) {
    edit((old) => ({ ...old, marks: old.marks?.map((mark) => mark.id === id ? { ...mark, ...values } : mark) }))
  }

  return <ToolPanel label={t('记号面板')}>
    <label>{t('搜索记号')}<input type="search" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
    <div className="mark-palette-toolbar">
      <label>{t('记号类别')}<select value={category} onChange={(event) => setCategory(event.target.value)}>
        <option value="">{t('全部记号')}</option>
        {[...new Set(Object.values(symbols).map((row) => row[0]))].map((key) => <option key={key} value={key}>{lang ? techniqueGroups[key] : key}</option>)}
      </select></label>
      <div className="mark-palette-views" role="group" aria-label={t('记号显示方式')}>
        {views.map(([value, caption, icon]) => <button key={value} type="button" aria-label={t(caption)} title={t(caption)}
          aria-pressed={view === value} onClick={() => setView(value)}>{icon}</button>)}
      </div>
    </div>
    {view === 'select' && <label>{t('可用记号')}<select value={effective} onChange={(event) => { setCode(event.target.value as ScoreMark['code']); setPlace('') }}>
      {!effective && <option value="">—</option>}
      {items.map((key) => <option key={key} value={key}>{name(key)}</option>)}
      {showCustom && <option value="text">{name('text')}</option>}
    </select></label>}
    <label>{t('记号位置')}<select value={view === 'select' ? place || defaultMarkPlace(effective || 'text') : place}
      onChange={(event) => setPlace(event.target.value as ScoreMark['place'] | '')}>
      {view !== 'select' && <option value="">{t('按记号默认位置')}</option>}
      <option value="above">{t('谱表上方')}</option><option value="below">{t('谱表下方')}</option><option value="gap">{t('当前拍之后')}</option>
    </select></label>
    {guitarString && <label className="checkbox"><input type="checkbox" checked={specificString}
      onChange={(event) => setSpecificString(event.target.checked)} />{t('仅当前弦')} · {guitarString}</label>}
    {view !== 'select' && <>
      {items.length > 0 && <MarkPalette view={view} label={t('可用记号')} items={items} name={name}
        symbol={(key) => markSymbol(key, (place || defaultMarkPlace(key)) === 'below')} disabled={full}
        pick={(key) => { setCode(key); addMark(key) }} />}
      {!items.length && !showCustom && <small>{t('没有匹配的记号')}</small>}
      {showCustom && effective !== 'text' && <button type="button" onClick={() => setCode('text')}>{name('text')}</button>}
    </>}
    {effective === 'text' && <label>{name('text')}<input maxLength={120} value={text} onChange={(event) => setText(event.target.value)} /></label>}
    {effective === 'grace' && graceControls && <details>
      <summary>{t('录入小音符（倚音）')}</summary>
      {graceControls}
    </details>}
    {(view === 'select' || effective === 'text') && <button disabled={!effective || effective === 'text' && !text.trim() || full}
      onClick={() => { if (effective) addMark(effective) }}>{t('添加记号')}</button>}
    {beat.marks?.map((mark) => <div className="notation-mark-item" key={mark.id}>
      <strong>{mark.text || name(mark.code)}</strong>
      <small>{t(markHasPlayback(mark.code) ? '谱面＋试听' : '仅谱面')}</small>
      <ToolPanel label={t('调整位置')}>
        <label>{t('水平偏移')}<input type="number" min={-120} max={120} value={mark.dx} onChange={(event) =>
          patch(mark.id, { dx: Math.round(Math.min(120, Math.max(-120, Number(event.target.value)))) })} /></label>
        <label>{t('垂直偏移')}<input type="number" min={-120} max={120} value={mark.dy} onChange={(event) =>
          patch(mark.id, { dy: Math.round(Math.min(120, Math.max(-120, Number(event.target.value)))) })} /></label>
        {mark.code === 'text' && <label>{name('text')}<input value={mark.text ?? ''} maxLength={120}
          onChange={(event) => patch(mark.id, { text: event.target.value })} /></label>}
      </ToolPanel>
      <div className="tool-actions tool-actions-danger">
        <button onClick={() => edit((old) => ({ ...old, marks: old.marks?.filter((item) => item.id !== mark.id) }))}>{t('删除记号')}</button>
      </div>
    </div>)}
    {view === 'select' ? <label>{t('跨音记号')}<select value={kind} onChange={(event) => setKind(event.target.value as SpanEnd['kind'])}>
      {spanKinds.map((item) => <option key={item} value={item}>{rangeName(item)}</option>)}
    </select></label> : !manualStart && <div className="mark-span-choices">
      <small>{t('跨音记号')}</small>
      <MarkPalette view={view} label={t('跨音记号')} items={spanKinds} name={rangeName} symbol={(key) => spanSymbols[key]}
        pick={(key) => { setKind(key); if (key !== 'custom') addSpan(key) }} />
    </div>}
    {!manualStart && kind === 'custom' && <label>{name('text')}<input maxLength={120} value={rangeText} onChange={(event) => setRangeText(event.target.value)} /></label>}
    {(manualStart || view === 'select' || kind === 'custom') && <div className="inline small-gap">{manualStart ? <>
      <small>{t('起点 · 第 {bar} 小节', { bar: manualStart.at.bar + 1 })} · {rangeName(manualStart.span.kind)}</small>
      <button onClick={() => {
        if (putSpan(manualStart.at, position, manualStart.span)) { setStart(null); setInvalidEnd(false) }
        else setInvalidEnd(true)
      }}>{t('在这里结束')}</button>
      <button onClick={() => { setStart(null); setInvalidEnd(false) }}>{t('取消起点')}</button>
    </> : <button onClick={() => addSpan(kind)}>{t(spanSelection === undefined ? '设置起点' : '添加跨音记号')}</button>}</div>}
    {invalidEnd && <small role="alert">{t('请在同一声部选择不同位置作为终点。')}</small>}
    {beat.spans?.map((point) => <div className="notation-mark-item" key={point.id}>
      <span>{rangeName(point.kind)}{point.text ? ' · ' + point.text : ''}</span>
      <small>{t(spanHasPlayback(point.kind) ? '谱面＋试听' : '仅谱面')}</small>
      <div className="tool-actions tool-actions-danger"><button onClick={() => removeSpan(point.id)}>{t('删除记号')}</button></div>
    </div>)}
  </ToolPanel>
}
