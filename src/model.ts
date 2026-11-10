export type Mode = 'numbered' | 'tab' | 'staff' | 'staff-tab'
export type Kind = 'voice' | 'guitar' | 'instrument'
export type Duration = 1 | 2 | 4 | 8 | 16 | 32 | 64
export type Tone = { midi: number; string?: number; fret?: number; slide?: boolean; bend?: boolean }
export type Beat = {
  duration: Duration; dots: 0 | 1; triplet: boolean; notes: Tone[];
  draft?: boolean; lyric?: string; chord?: string; diagram?: number[]; tie?: boolean; slur?: boolean
}
export type Layout = { mode?: Mode; barsPerLine: number; systemsPerPage: number }
export type Track = { id: string; name: string; kind: Kind; mode: Mode; tuning: number[]; bars: Beat[][]; layout: Layout }
export type Project = {
  version: 1; title: string; author: string; bpm: number; key: number;
  meter: [number, number]; pickup: number; measures: { start?: boolean; end?: boolean }[];
  tracks: Track[]; layout: Layout
}
export type Position = { track: string; bar: number; beat: number; lane?: 'staff' | 'tab' }
export const modes = { numbered: '简谱', tab: '吉他六线谱', staff: '五线谱', 'staff-tab': '五线谱＋六线谱' } as const
export const kinds = { voice: '人声', guitar: '吉他', instrument: '五线谱乐器' } as const
export const guitarTuning = [64, 59, 55, 50, 45, 40]
export const durations: Duration[] = [1, 2, 4, 8, 16, 32, 64]
export const keyNames = ['C♭', 'G♭', 'D♭', 'A♭', 'E♭', 'B♭', 'F', 'C', 'G', 'D', 'A', 'E', 'B', 'F♯', 'C♯']
export const pitchNames = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B']
const intervals = [0, 2, 4, 5, 7, 9, 11]
export const layout = (): Layout => ({ barsPerLine: 4, systemsPerPage: 3 })
export const blank = (duration: Duration = 4): Beat => ({ duration, dots: 0, triplet: false, notes: [], draft: true })
export function ticks(beat: Beat) {
  return 3840 / beat.duration * (beat.dots ? 1.5 : 1) * (beat.triplet ? 2 / 3 : 1)
}
export function capacity(score: Project, bar: number) {
  return (bar === 0 && score.pickup ? score.pickup : score.meter[0]) * 3840 / score.meter[1]
}
export function tonic(key: number) {
  return 60 + ((key * 7 % 12) + 12) % 12 - (key > 0 && ((key * 7) % 12) > 5 ? 12 : 0)
}
export function midiForDegree(degree: number, key: number, octave: number, accidental: number) {
  return Math.max(0, Math.min(127, tonic(key) + intervals[degree - 1] + octave * 12 + accidental))
}
export function beatList(score: Project, bar: Beat[], index: number) {
  const end = bar.findLastIndex((beat) => !beat.draft)
  const placed = bar.slice(0, end + 1)
  let missing = capacity(score, index) - placed.reduce((sum, beat) => sum + ticks(beat), 0)
  const fill: Beat[] = []
  const unit = 3840 / score.meter[1]
  const options = durations.flatMap((duration) => [blank(duration), { ...blank(duration), triplet: true }, { ...blank(duration), dots: 1 as const }])
    .sort((a, b) => ticks(b) - ticks(a))
  while (missing > 0 && fill.length < 64) {
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
    const beats = beatList(score, track.bars[position.bar], position.bar)
    if (!beats[position.beat]) return track
    beats[position.beat] = edit(beats[position.beat])
    return { ...track, bars: track.bars.map((bar, index) => index === position.bar ? beats : bar) }
  }) }
}
export function measureDifference(score: Project, track: Track, index: number) {
  const bar = track.bars[index]
  const last = bar.findLastIndex((beat) => !beat.draft)
  return capacity(score, index) - bar.slice(0, last + 1).reduce((sum, beat) => sum + ticks(beat), 0)
}

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const number = (value: unknown, min: number, max: number) => typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
const string = (value: unknown, max = 200) => typeof value === 'string' && value.length <= max
const flag = (value: unknown) => value === undefined || typeof value === 'boolean'
const modeValid = (value: unknown): value is Mode => typeof value === 'string' && Object.hasOwn(modes, value)
const layoutValid = (value: unknown) => object(value) && number(value.barsPerLine, 1, 12) &&
  number(value.systemsPerPage, 1, 6) && (value.mode === undefined || modeValid(value.mode))
function beatValid(beat: unknown, tuning: number[]) {
  return object(beat) && durations.includes(beat.duration as Duration) && number(beat.dots, 0, 1)
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
  if (!object(data) || data.version !== 1 || !string(data.title) || !string(data.author)
    || !number(data.bpm, 20, 300) || !number(data.key, -7, 7) || !Array.isArray(data.meter)
    || data.meter.length !== 2 || !number(data.meter[0], 1, 12) || ![2, 4, 8, 16].includes(data.meter[1])
    || !number(data.pickup, 0, data.meter[0] - 1) || !layoutValid(data.layout) || !Array.isArray(data.measures)
    || !number(data.measures.length, 1, 256) || !data.measures.every((m) => object(m) && flag(m.start) && flag(m.end))
    || !Array.isArray(data.tracks) || !number(data.tracks.length, 1, 24)) throw new Error('文件不是有效的弦谱工程，或版本不受支持。')
  const ids = new Set<string>()
  const count = data.measures.length
  for (const track of data.tracks) {
    if (!object(track) || typeof track.id !== 'string' || !track.id || ids.has(track.id) || !string(track.name)
      || typeof track.kind !== 'string' || !Object.hasOwn(kinds, track.kind) || !modeValid(track.mode) || !layoutValid(track.layout)
      || !Array.isArray(track.tuning) || track.tuning.length !== (track.kind === 'guitar' ? 6 : 0)
      || !track.tuning.every((note) => number(note, 0, 91))
      || !Array.isArray(track.bars) || track.bars.length !== count
      || !track.bars.every((bar) => Array.isArray(bar) && bar.length <= 256 && bar.every((beat) => beatValid(beat, track.tuning as number[])))) {
      throw new Error('乐器或小节数据损坏，原工程已保留。')
    }
    ids.add(track.id)
  }
  return data as Project
}
