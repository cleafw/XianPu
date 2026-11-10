import { isSound } from './sounds.ts'
import { validPaper, type Paper } from './paper.ts'
import { spanKinds, symbols, type ScoreMark, type SpanEnd } from './notationMarks.ts'
import type { NavigationDirection, NavigationMeasure } from './scoreNavigation.ts'

export type Mode = 'numbered' | 'tab' | 'staff' | 'staff-tab' | 'staff-numbered' | 'piano' | 'percussion'
export type Kind = 'voice' | 'guitar' | 'instrument'
export type Duration = 1 | 2 | 4 | 8 | 16 | 32 | 64
export type Meter = [number, number]
export type Credits = { subtitle?: string; lyricist?: string; composer?: string; arranger?: string; engraver?: string }
export const navigationDirections: Record<NavigationDirection, string> = {
  segno: 'Segno', fine: 'Fine', toCoda: 'To Coda', coda: 'Coda',
  daCapo: 'D.C.', daCapoAlFine: 'D.C. al Fine', daCapoAlCoda: 'D.C. al Coda',
  dalSegno: 'D.S.', dalSegnoAlFine: 'D.S. al Fine', dalSegnoAlCoda: 'D.S. al Coda',
}
export type Measure = NavigationMeasure & {
  meter?: Meter; key?: number; bpm?: number; barline?: 'double' | 'final'; rehearsal?: string
  simile?: 'single' | 'double' | 'double-second'
}
export type Tone = { midi: number; string?: number; fret?: number; slide?: boolean; bend?: boolean }
export type Beat = {
  duration: Duration; dots: 0 | 1 | 2; triplet: boolean; notes: Tone[];
  tuplet?: [number, number]; tupletGroup?: string; grace?: number[];
  marks?: ScoreMark[]; spans?: SpanEnd[]; verses?: string[];
  draft?: boolean; lyric?: string; chord?: string; diagram?: number[]; tie?: boolean; slur?: boolean
}
export type Layout = { mode?: Mode; barsPerLine: number; systemsPerPage: number; paper?: Paper; systemBreaks?: number[]; pageBreaks?: number[]; compressRests?: boolean; printHeader?: string; printFooter?: string; showPageNumbers?: boolean }
export type Voice = { staff?: 0 | 1; bars: Beat[][] }
export type Track = {
  id: string; name: string; kind: Kind; mode: Mode; sound?: number; tuning: number[]; bars: Beat[][]; layout: Layout
  clef?: 'treble' | 'alto' | 'bass'; transpose?: number; capo?: number; scoreNote?: string; voices?: Voice[]; technique?: keyof typeof techniqueGroups
}
export const techniqueGroups = { '通用': 'General', '人声': 'Voice', '竹笛': 'Bamboo flute', '古筝': 'Guzheng', '吉他': 'Guitar',
  '弓弦': 'Bowed strings', '管乐': 'Winds', '键盘': 'Keyboard', '打击乐': 'Percussion' } as const
export function voiceBars(track: Track, voice = 0) {
  return voice ? track.voices?.[voice - 1]?.bars ?? track.bars : track.bars
}
export type Project = {
  version: 1; title: string; author: string; credits?: Credits; bpm: number; key: number;
  meter: Meter; pickup: number; measures: Measure[];
  tracks: Track[]; layout: Layout
}
export type Position = { track: string; bar: number; beat: number; lane?: 'staff' | 'tab' | 'numbered'; voice?: number; note?: number; string?: number }
export const modes = { numbered: '简谱', tab: '吉他六线谱', staff: '五线谱', 'staff-tab': '五线谱＋六线谱', 'staff-numbered': '五线谱＋简谱', piano: '钢琴大谱表', percussion: '打击乐谱' } as const
export const kinds = { voice: modes.numbered, guitar: modes.tab, instrument: modes.staff } as const
export const guitarTuning = [64, 59, 55, 50, 45, 40]
export const durations: Duration[] = [1, 2, 4, 8, 16, 32, 64]
export const keyNames = ['C♭', 'G♭', 'D♭', 'A♭', 'E♭', 'B♭', 'F', 'C', 'G', 'D', 'A', 'E', 'B', 'F♯', 'C♯']
export const pitchNames = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B']
const intervals = [0, 2, 4, 5, 7, 9, 11]
export const layout = (): Layout => ({ barsPerLine: 4, systemsPerPage: 3 })
export function shiftedLayout(layout: Layout, index: number, delta: number): Layout {
  const shift = (breaks?: number[]) => breaks?.flatMap((bar) =>
    delta < 0 && bar === index ? [] : [bar >= index ? bar + delta : bar]).filter((bar) => bar > 0 && bar < 256)
  return { ...layout, systemBreaks: shift(layout.systemBreaks), pageBreaks: shift(layout.pageBreaks) }
}
export function shiftedEndings(measures: Measure[], index: number, delta: number) {
  return measures.map((measure, bar) => {
    const previous = measures[bar - 1]?.ending
    if (delta < 0 && bar === index + 1 && previous && (previous.length ?? 1) > 1 && !measure.ending) {
      return { ...measure, ending: { ...previous, length: previous.length! - 1 } }
    }
    const end = measure.ending
    return end && bar < index && index < bar + (end.length ?? 1)
      ? { ...measure, ending: { ...end, length: Math.max(1, (end.length ?? 1) + delta) } }
      : measure
  })
}
export function paperFor(score: Project, part: string | null): Paper {
  return score.tracks.find((track) => track.id === part)?.layout.paper ?? score.layout.paper ?? { size: 'a4' }
}
export const blank = (duration: Duration = 4): Beat => ({ duration, dots: 0, triplet: false, notes: [], draft: true })
export function ticks(beat: Beat) {
  const [actual, normal] = beat.tuplet ?? (beat.triplet ? [3, 2] : [1, 1])
  return 3840 / beat.duration * (2 - 1 / 2 ** beat.dots) * normal / actual
}
export function measureSettings(score: Project, bar: number) {
  let { meter, key, bpm } = score
  for (let i = 0; i <= bar; i++) {
    const measure = score.measures[i]
    meter = measure?.meter ?? meter
    key = measure?.key ?? key
    bpm = measure?.bpm ?? bpm
  }
  return { meter, key, bpm }
}
export function capacity(score: Project, bar: number) {
  const [count, unit] = measureSettings(score, bar).meter
  return (bar === 0 && score.pickup ? Math.min(score.pickup, count) : count) * 3840 / unit
}
export function tonic(key: number) {
  // Match the written middle octave of the numbered staff, including C-flat.
  return [59, 66, 61, 68, 63, 70, 65, 60, 67, 62, 69, 64, 71, 66, 61][key + 7]
}
export function writtenKey(key: number, transpose: number) {
  if (transpose % 12 === 0) return key
  const fifths = ((key + transpose * 7) % 12 + 12) % 12
  if (fifths === 6) return key < 0 ? -6 : 6
  return fifths > 6 ? fifths - 12 : fifths
}
export function staffAccidental(letter: string, key: number) {
  return (key > 0 ? 'fcgdaeb' : 'beadgcf').slice(0, Math.abs(key)).includes(letter)
    ? Math.sign(key) : 0
}
export function midiForDegree(degree: number, key: number, octave: number, accidental: number) {
  return Math.max(0, Math.min(127, tonic(key) + intervals[degree - 1] + octave * 12 + accidental))
}
export function beatList(score: Project, bar: Beat[], index: number) {
  const end = bar.findLastIndex((beat) => !beat.draft)
  const placed = bar.slice(0, end + 1)
  let missing = capacity(score, index) - placed.reduce((sum, beat) => sum + ticks(beat), 0)
  const fill: Beat[] = []
  const unit = 3840 / measureSettings(score, index).meter[1]
  const options = durations.flatMap((duration) => [blank(duration), { ...blank(duration), triplet: true }, { ...blank(duration), dots: 1 as const }])
    .sort((a, b) => ticks(b) - ticks(a))
  while (missing > 1e-7 && fill.length < 64) {
    const next = options.find((beat) => ticks(beat) <= Math.min(missing, unit) && missing % 5 === ticks(beat) % 5)
      ?? options.find((beat) => ticks(beat) <= Math.min(missing, unit))
    if (!next) break
    fill.push(next)
    missing -= ticks(next)
  }
  return placed.concat(fill.length || placed.length ? fill : [blank()])
}
export function createTrack(score: Project, kind: Kind, name: string = kinds[kind]): Track {
  const mode = kind === 'voice' ? 'numbered' : kind === 'guitar' ? 'tab' : 'staff'
  return { id: crypto.randomUUID(), name, kind, mode, tuning: kind === 'guitar' ? [...guitarTuning] : [],
    bars: score.measures.map(() => []), layout: layout() }
}
export function createProject(template: 'song' | 'guitar' | 'ensemble' | 'demo', labels?: {
  untitled: string; demo: string; demoAuthor: string; tracks: Record<Kind, string>
}): Project {
  const length = template === 'demo' ? 8 : 4
  const score: Project = { version: 1, title: template === 'demo' ? labels?.demo ?? '沿着晚风' : labels?.untitled ?? '未命名曲谱', author: '',
    bpm: 90, key: 0, meter: [4, 4], pickup: 0, measures: Array.from({ length }, () => ({})), tracks: [], layout: layout() }
  const instruments: Kind[] = template === 'guitar' ? ['guitar'] : template === 'song' ? ['voice', 'guitar'] : ['voice', 'guitar', 'instrument']
  score.tracks = instruments.map((kind) => createTrack(score, kind, labels?.tracks[kind]))
  if (template === 'demo') {
    score.author = labels?.demoAuthor ?? '叶子弦谱示例'
    const words = '晚风轻轻穿过街角我把这首歌留给你抬头看看漫天星光听见回响'
    const melody = [[60, 62, 64, 67], [69, 67, 64, 62], [60, 64, 67, 69], [67, 64, 62, 60],
      [64, 65, 67, 69], [72, 69, 67, 64], [62, 65, 64, 62], [60, 64, 62, 60]]
    score.tracks[0].bars = melody.map((bar, i) => bar.map((midi, j) => ({
      ...blank(), draft: false, notes: i === 7 && j === 2 ? [] : [{ midi }],
      lyric: i === 7 && j === 2 ? undefined : words[i * 4 + j], chord: j === 0 ? ['C', 'Am', 'C', 'G', 'F', 'Am', 'G', 'C'][i] : undefined,
    })))
    score.tracks[0].bars[0].splice(0, 2,
      { ...score.tracks[0].bars[0][0], duration: 8, dots: 1 },
      { ...score.tracks[0].bars[0][1], duration: 16 },
      { ...blank(), draft: false })
    score.tracks[1].bars = melody.map((_, i) => {
      const tuning = score.tracks[1].tuning
      const frets = i % 2 ? [0, 1, 2, 2, 0, -1] : [0, 1, 0, 2, 3, -1]
      return [5, 4, 3, 2].map((s, j) => ({ ...blank(), draft: false,
        notes: (j ? [s] : [5, 3, 2]).map((string) => ({ string, fret: frets[string - 1], midi: tuning[string - 1] + frets[string - 1] })),
        chord: j ? undefined : i % 2 ? 'Am' : 'C', diagram: j ? undefined : frets }))
    })
    score.tracks[2].bars = melody.map((bar) => bar.filter((_, j) => j % 2 === 0)
      .map((midi) => ({ ...blank(2), draft: false, notes: [{ midi: midi + 12 }] })))
  }
  return score
}
export function changeBeat(score: Project, position: Position, edit: (beat: Beat) => Beat) {
  return { ...score, tracks: score.tracks.map((track) => {
    if (track.id !== position.track) return track
    const voice = position.voice ?? 0
    const bars = voiceBars(track, voice)
    const beats = beatList(score, bars[position.bar], position.bar)
    const previous = beats[position.beat]
    if (!previous) return track
    const updated = edit(previous)
    beats[position.beat] = updated
    const removed = new Set(previous.spans?.filter(({ id }) => !updated.spans?.some((point) => point.id === id)).map(({ id }) => id))
    const changed = bars.map((bar, index) => {
      const entries = index === position.bar ? beats : bar
      return removed.size ? entries.map((beat) => beat.spans?.some(({ id }) => removed.has(id))
        ? { ...beat, spans: beat.spans.filter(({ id }) => !removed.has(id)) } : beat) : entries
    })
    if (!voice) return { ...track, bars: changed }
    return { ...track, voices: track.voices?.map((item, index) => index === voice - 1 ? { ...item, bars: changed } : item) }
  }) }
}
export function previousBeat(score: Project, track: Track, position: Position) {
  const bars = voiceBars(track, position.voice)
  return position.beat > 0 ? beatList(score, bars[position.bar], position.bar)[position.beat - 1]
    : position.bar > 0 ? beatList(score, bars[position.bar - 1], position.bar - 1).at(-1) : undefined
}
export function matchingTie(left: Tone, right: Tone) {
  return left.midi === right.midi && left.string === right.string
}
export function beatRange(score: Project, track: Track, first: Position, last: Position) {
  const low = first.bar < last.bar || first.bar === last.bar && first.beat <= last.beat ? first : last
  const high = low === first ? last : first
  return voiceBars(track, low.voice).slice(low.bar, high.bar + 1).flatMap((bar, index) => {
    const number = low.bar + index
    return beatList(score, bar, number).flatMap((beat, offset) =>
      (number !== low.bar || offset >= low.beat) && (number !== high.bar || offset <= high.beat)
        ? [{ position: { track: track.id, bar: number, beat: offset, voice: low.voice }, beat }] : [])
  })
}
export function measureDifference(score: Project, track: Track, index: number, voice = 0) {
  const bar = voiceBars(track, voice)[index]
  const last = bar.findLastIndex((beat) => !beat.draft)
  const difference = capacity(score, index) - bar.slice(0, last + 1).reduce((sum, beat) => sum + ticks(beat), 0)
  return Math.abs(difference) < 1e-7 ? 0 : difference
}

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const number = (value: unknown, min: number, max: number) => typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
const string = (value: unknown, max = 200) => typeof value === 'string' && value.length <= max
const flag = (value: unknown) => value === undefined || typeof value === 'boolean'
const meterValid = (value: unknown) => Array.isArray(value) && value.length === 2 &&
  number(value[0], 1, 12) && [2, 4, 8, 16].includes(value[1])
const creditsValid = (value: unknown) => value === undefined || object(value) &&
  ['subtitle', 'lyricist', 'composer', 'arranger', 'engraver'].every((key) => value[key] === undefined || string(value[key]))
const modeValid = (value: unknown): value is Mode => typeof value === 'string' && Object.hasOwn(modes, value)
const layoutValid = (value: unknown) => object(value) && number(value.barsPerLine, 1, 12) &&
  number(value.systemsPerPage, 1, 6) && (value.mode === undefined || modeValid(value.mode)) &&
  (value.paper === undefined || validPaper(value.paper)) &&
  flag(value.compressRests) && flag(value.showPageNumbers) &&
  (value.printHeader === undefined || string(value.printHeader, 80)) &&
  (value.printFooter === undefined || string(value.printFooter, 80)) &&
  [value.systemBreaks, value.pageBreaks].every((items) => items === undefined ||
    Array.isArray(items) && items.length < 256 && items.every((item) => number(item, 1, 255)))
const marksValid = (value: unknown) => value === undefined || Array.isArray(value) && value.length <= 32 && value.every((mark) =>
  object(mark) && string(mark.id, 80) && typeof mark.code === 'string' && (mark.code === 'text' || Object.hasOwn(symbols, mark.code)) &&
  (mark.text === undefined || string(mark.text, 120)) && ['above', 'below', 'gap'].includes(String(mark.place)) &&
  number(mark.dx, -120, 120) && number(mark.dy, -120, 120) && (mark.string === undefined || number(mark.string, 1, 6)))
const spansValid = (value: unknown) => value === undefined || Array.isArray(value) && value.length <= 32 && value.every((end) =>
  object(end) && string(end.id, 80) && spanKinds.includes(end.kind as SpanEnd['kind']) && typeof end.end === 'boolean' &&
  (end.text === undefined || string(end.text, 120)))
function beatValid(beat: unknown, tuning: number[]) {
  return object(beat) && durations.includes(beat.duration as Duration) && number(beat.dots, 0, 2)
    && (beat.tuplet === undefined || Array.isArray(beat.tuplet) && beat.tuplet.length === 2 && beat.tuplet.every((n) => number(n, 1, 16)))
    && (beat.tupletGroup === undefined || string(beat.tupletGroup, 80))
    && (beat.grace === undefined || Array.isArray(beat.grace) && beat.grace.length <= 4 && beat.grace.every((pitch) => number(pitch, 0, 127)))
    && marksValid(beat.marks) && spansValid(beat.spans)
    && (beat.verses === undefined || Array.isArray(beat.verses) && beat.verses.length <= 5 && beat.verses.every((line) => string(line)))
    && typeof beat.triplet === 'boolean' && flag(beat.draft) && flag(beat.tie) && flag(beat.slur)
    && (beat.lyric === undefined || string(beat.lyric)) && (beat.chord === undefined || string(beat.chord, 30))
    && (beat.diagram === undefined || (tuning.length === 6 && Array.isArray(beat.diagram) && beat.diagram.length === 6
      && beat.diagram.every((fret) => number(fret, -1, 36))))
    && Array.isArray(beat.notes) && beat.notes.length <= 16 && beat.notes.every((note: unknown) =>
      object(note) && number(note.midi, 0, 127) && flag(note.slide) && flag(note.bend) &&
      (note.string === undefined ? note.fret === undefined : tuning.length === 6 && number(note.string, 1, 6) && number(note.fret, 0, 36)
        && note.midi === tuning[(note.string as number) - 1] + (note.fret as number)))
}
export function parseProject(raw: string): Project {
  const data: unknown = JSON.parse(raw)
  if (!object(data) || data.version !== 1 || !string(data.title) || !string(data.author) || !creditsValid(data.credits)
    || !number(data.bpm, 20, 300) || !number(data.key, -7, 7) || !Array.isArray(data.meter) || !meterValid(data.meter)
    || !number(data.pickup, 0, data.meter[0] - 1) || !layoutValid(data.layout) || !Array.isArray(data.measures)
    || !number(data.measures.length, 1, 256) || !data.measures.every((m) => object(m) && flag(m.start) && flag(m.end)
      && (m.meter === undefined || meterValid(m.meter)) && (m.key === undefined || number(m.key, -7, 7))
      && (m.bpm === undefined || number(m.bpm, 20, 300)) && (m.repeatCount === undefined || number(m.repeatCount, 2, 8))
      && (m.ending === undefined || object(m.ending) && number(m.ending.number, 1, 2) && (m.ending.length === undefined || number(m.ending.length, 1, 256)))
      && (m.directions === undefined || Array.isArray(m.directions) && m.directions.length <= 10 &&
        m.directions.every((item) => typeof item === 'string' && Object.hasOwn(navigationDirections, item)))
      && (m.barline === undefined || m.barline === 'double' || m.barline === 'final')
      && (m.rehearsal === undefined || string(m.rehearsal, 30))
      && (m.simile === undefined || m.simile === 'single' || m.simile === 'double' || m.simile === 'double-second'))
    || !Array.isArray(data.tracks) || !number(data.tracks.length, 1, 24)) throw new Error('文件不是有效的弦谱工程，或版本不受支持。')
  const ids = new Set<string>()
  const count = data.measures.length
  for (const track of data.tracks) {
    const validBars = (bars: unknown, tuning: number[]) => Array.isArray(bars) && bars.length === count &&
      bars.every((bar) => Array.isArray(bar) && bar.length <= 256 && bar.every((beat) => beatValid(beat, tuning)))
    if (!object(track) || typeof track.id !== 'string' || !track.id || ids.has(track.id) || !string(track.name)
      || typeof track.kind !== 'string' || !Object.hasOwn(kinds, track.kind) || !modeValid(track.mode) || !layoutValid(track.layout) || (track.sound !== undefined && !isSound(track.sound))
      || !Array.isArray(track.tuning) || track.tuning.length !== (track.kind === 'guitar' ? 6 : 0)
      || !track.tuning.every((note) => number(note, 0, 91))
      || (track.clef !== undefined && !['treble', 'alto', 'bass'].includes(String(track.clef)))
      || (track.scoreNote !== undefined && !string(track.scoreNote, 80))
      || (track.capo !== undefined && (track.kind !== 'guitar' || !number(track.capo, 0, 12) || track.tuning.some((note) => note < (track.capo as number))))
      || (track.transpose !== undefined && !number(track.transpose, -24, 24))
      || (track.technique !== undefined && (typeof track.technique !== 'string' || !Object.hasOwn(techniqueGroups, track.technique)))
      || !validBars(track.bars, track.tuning)
      || (track.voices !== undefined && (!Array.isArray(track.voices) || track.voices.length > 3 ||
        !track.voices.every((voice) => object(voice) && (voice.staff === undefined || number(voice.staff, 0, 1)) && validBars(voice.bars, track.tuning as number[]))))) {
      throw new Error('乐器或小节数据损坏，原工程已保留。')
    }
    ids.add(track.id)
  }
  return data as Project
}
