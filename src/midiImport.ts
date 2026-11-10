import { createTrack, durations, guitarTuning, layout, ticks, type Beat, type Measure, type Project, type Tone } from './model.ts'
import { drumSound, sounds } from './sounds.ts'
import { translate, type Language, type TextKey } from './i18n.ts'

export const maxMidiBytes = 16 * 1024 * 1024
const stepsPerQuarter = 8
const maxMeasures = 256
const maxTracks = 24
const voicesPerTrack = 4
const maxSteps = maxMeasures * 12 * 16 // 256 measures of 12/2
// Each retained pitch takes at least 56 bytes in the saved, indented JSON.
const maxSourceNotes = Math.floor(maxMidiBytes / 56)
const maxGuitarFret = 24

const invalid = 'MIDI 文件损坏或不完整。'
const tooManyMeasures = 'MIDI 超过 256 小节。'
const tooManyTracks = 'MIDI 超过 24 个乐器（含拆分的声部）。'
const projectTooLarge = '转换后的工程超过 16 MB。'
const warnings = {
  grid: '音符已对齐到三十二分音符，短音至少保留一格。',
  boundary: '小节中的拍号、调号或速度变化从下一小节起生效。',
  overwritten: '同一小节边界被覆盖的拍号、调号或速度变化已略过。',
  noNextMeasure: '没有后续小节可应用的拍号、调号或速度变化已略过。',
  settings: '已跳过无法表示的拍号、调号或速度。',
  minor: '小调保留原升降号，以对应的大调名称显示。',
  sound: '部分音色已使用库内相近的预设。',
  guitar: '无法分配弦品的吉他已使用五线谱。',
  split: '声部较多的乐器已拆分。',
  drums: '鼓组范围外的音高已保留，谱面和试听以底鼓表示。',
  unmatched: '未配对的关音已忽略，仍在持续的音符已在音轨结尾结束。',
} as const satisfies Record<string, TextKey>
type Warning = keyof typeof warnings

function fail(key: TextKey): never { throw new Error(key) }

class Reader {
  private offset = 0
  private readonly bytes: Uint8Array
  constructor(bytes: Uint8Array) { this.bytes = bytes }
  get remaining() { return this.bytes.length - this.offset }
  take(length: number) {
    if (length > this.remaining) fail(invalid)
    const start = this.offset
    this.offset += length
    return this.bytes.subarray(start, this.offset)
  }
  byte() {
    if (!this.remaining) fail(invalid)
    return this.bytes[this.offset++]
  }
  unsigned(length: number) {
    let result = 0
    for (let i = 0; i < length; i++) result = result * 256 + this.byte()
    return result
  }
  variable() {
    let result = 0
    for (let i = 0; i < 4; i++) {
      const byte = this.byte()
      result = result * 128 + (byte & 127)
      if (byte < 128) return result
    }
    return fail(invalid)
  }
  chunk() {
    const type = String.fromCharCode(...this.take(4))
    return { type, bytes: this.take(this.unsigned(4)) }
  }
}

type SourceNote = { midi: number; start: number; end: number; tone?: Tone }
type Instrument = { track: number; channel: number; program: number; bank: number; notes: SourceNote[] }
type SettingField = 'meter' | 'key' | 'bpm'
type Setting = { tick: number; field: SettingField; value: Measure; minor?: boolean }
type Active = { notes: SourceNote[]; next: number }
type Channel = { program: number; msb: number; lsb: number; bank: number; active: Map<number, Active> }
type ChannelEvent = { tick: number; channel: number; event: number; a: number; b: number }
type SourceTrack = { bytes: Uint8Array; name: string; channels: Map<number, Channel>; instruments: Map<number, Instrument> }

function* trackEvents(bytes: Uint8Array, metadata?: { source: SourceTrack; settings: Setting[]; flags: Set<Warning> }): Generator<ChannelEvent, void> {
  const reader = new Reader(bytes)
  let tick = 0
  let running = 0
  const dataByte = () => {
    const value = reader.byte()
    if (value >= 128) fail(invalid)
    return value
  }
  while (reader.remaining) {
    tick += reader.variable()
    const first = reader.byte()
    const status = first < 128 ? running : first
    if (status === 0xff || status === 0xf0 || status === 0xf7) {
      running = 0
      const type = status === 0xff ? dataByte() : -1
      const data = reader.take(reader.variable())
      if (type === 0x2f) {
        if (data.length || reader.remaining) fail(invalid)
        yield { tick, event: 0x2f, channel: 0, a: 0, b: 0 }
        return
      }
      if (!metadata) continue
      const { source, settings, flags } = metadata
      if (type === 3 && !source.name) source.name = new TextDecoder().decode(data.subarray(0, 800)).replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 120)
      if (type === 0x51) {
        if (data.length !== 3) fail(invalid)
        const bpm = Math.round(60_000_000 / (data[0] * 65536 + data[1] * 256 + data[2]))
        if (bpm >= 20 && bpm <= 300) settings.push({ tick, field: 'bpm', value: { bpm } })
        else flags.add('settings')
      }
      if (type === 0x58) {
        if (data.length !== 4) fail(invalid)
        if (data[0] >= 1 && data[0] <= 12 && data[1] >= 1 && data[1] <= 4) {
          settings.push({ tick, field: 'meter', value: { meter: [data[0], 2 ** data[1]] } })
        } else flags.add('settings')
      }
      if (type === 0x59) {
        if (data.length !== 2) fail(invalid)
        const key = data[0] < 128 ? data[0] : data[0] - 256
        if (key >= -7 && key <= 7 && data[1] <= 1) settings.push({ tick, field: 'key', value: { key }, minor: data[1] === 1 })
        else flags.add('settings')
      }
      continue
    }
    if (status < 0x80 || status >= 0xf0) fail(invalid)
    running = status
    const channel = status & 15
    const event = status >> 4
    const a = first < 128 ? first : dataByte()
    const b = event === 0xc || event === 0xd ? 0 : dataByte()
    if (event === 0x8 || event === 0x9 || event === 0xc ||
      (event === 0xb && (a === 0 || a === 32 || a === 120 || a === 123))) yield { tick, channel, event, a, b }
  }
  return fail(invalid)
}

function* mergeTracks(tracks: SourceTrack[]) {
  // Keep one pending event per track. Equal ticks use source track order, then file order within the track.
  const heap = tracks.flatMap(({ bytes }, track) => {
    const events = trackEvents(bytes)
    const first = events.next()
    return first.done || first.value.event === 0x2f ? [] : [{ track, events, next: first.value }]
  })
  const order = (a: typeof heap[number], b: typeof heap[number]) => a.next.tick - b.next.tick || a.track - b.track
  heap.sort(order)
  while (heap.length) {
    const first = heap[0]
    yield { track: first.track, ...first.next }
    const next = first.events.next()
    if (!next.done) first.next = next.value
    else {
      const last = heap.pop()!
      if (!heap.length) break
      heap[0] = last
    }
    for (let index = 0; index * 2 + 1 < heap.length;) {
      const left = index * 2 + 1
      const right = left + 1
      const child = right < heap.length && order(heap[right], heap[left]) < 0 ? right : left
      if (order(heap[index], heap[child]) <= 0) break
      const parent = heap[index]
      heap[index] = heap[child]
      heap[child] = parent
      index = child
    }
  }
}

function closeChannel(state: Channel, tick: number) {
  for (const { notes, next } of state.active.values()) {
    for (let i = next; i < notes.length; i++) notes[i].end = tick
  }
  state.active.clear()
}

function readInstruments(tracks: SourceTrack[], flags: Set<Warning>) {
  // For each channel, patch events from a track with note-ons are local to that track.
  // A track with no note-ons on that channel supplies shared patch events to all its note tracks.
  // Bank Select takes effect at Program Change. Individual note releases stay source-local.
  const shared = Array.from({ length: 16 }, () => [] as Channel[])
  for (const { channels } of tracks) {
    for (const [channel, state] of channels) shared[channel].push(state)
  }
  let count = 0
  for (const { track, tick, channel, event, a, b } of mergeTracks(tracks)) {
    const { instruments, channels } = tracks[track]
    const state = channels.get(channel)
    if (event === 0x2f) {
      for (const state of channels.values()) {
        if (state.active.size) flags.add('unmatched')
        closeChannel(state, tick)
      }
    } else if (event === 0xb && (a === 120 || a === 123)) {
      for (const target of shared[channel]) closeChannel(target, tick)
    } else if (event === 0xc || event === 0xb) {
      for (const target of state ? [state] : shared[channel]) {
        if (event === 0xc) {
          target.program = a
          target.bank = target.msb * 128 + target.lsb
        } else if (a === 0) target.msb = b
        else target.lsb = b
      }
    } else if (event === 0x9 && b > 0 && state) {
      const id = (state.bank * 128 + state.program) * 16 + channel
      let instrument = instruments.get(id)
      if (!instrument) {
        if (++count > maxTracks) fail(tooManyTracks)
        instrument = { track, channel, program: state.program, bank: state.bank, notes: [] }
        instruments.set(id, instrument)
      }
      const note = { midi: a, start: tick, end: tick }
      instrument.notes.push(note)
      const active = state.active.get(a) ?? { notes: [], next: 0 }
      active.notes.push(note)
      state.active.set(a, active)
    } else if (event === 0x8 || event === 0x9) {
      const active = state?.active.get(a)
      if (active) {
        active.notes[active.next++].end = tick
        if (active.next === active.notes.length) state?.active.delete(a)
      } else flags.add('unmatched')
    }
  }
  return tracks.flatMap(({ name, instruments }) => Array.from(instruments.values(), (instrument) => ({ ...instrument, name })))
}

function decode(bytes: Uint8Array, flags: Set<Warning>) {
  if (bytes.length > maxMidiBytes) fail('MIDI 文件超过 16 MB。')
  const reader = new Reader(bytes)
  const chunk = reader.chunk()
  if (chunk.type !== 'MThd') fail(invalid)
  const header = new Reader(chunk.bytes)
  const format = header.unsigned(2)
  const trackCount = header.unsigned(2)
  const ppq = header.unsigned(2)
  if (format > 1 || ppq >= 0x8000) fail('仅支持按四分音符计时的标准 MIDI 0 或 1 型。')
  if (!ppq || !trackCount || (format === 0 && trackCount !== 1)) fail(invalid)
  const settings: Setting[] = []
  const tracks: SourceTrack[] = []
  let noteCount = 0
  let noteTracks = 0
  let end = 0
  while (reader.remaining) {
    const chunk = reader.chunk()
    if (chunk.type !== 'MTrk') continue
    if (tracks.length >= trackCount) fail(invalid)
    const source: SourceTrack = { bytes: chunk.bytes, name: '', channels: new Map(), instruments: new Map() }
    for (const { tick, channel, event, b } of trackEvents(chunk.bytes, { source, settings, flags })) {
      if (event === 0x2f) end = Math.max(end, tick)
      if (event !== 0x9 || !b) continue
      if (++noteCount > maxSourceNotes) fail(projectTooLarge)
      if (Math.round(tick * stepsPerQuarter / ppq) >= maxSteps) fail(tooManyMeasures)
      if (!source.channels.has(channel)) source.channels.set(channel, { program: 0, msb: 0, lsb: 0, bank: 0, active: new Map() })
    }
    if (source.channels.size && ++noteTracks > maxTracks) fail(tooManyTracks)
    tracks.push(source)
  }
  if (tracks.length !== trackCount) fail(invalid)
  if (!noteCount) fail('MIDI 中没有可导入的音符。')
  return { ppq, settings, instruments: readInstruments(tracks, flags), end, noteCount }
}

type Chord = { start: number; end: number; notes: SourceNote[] }
function groupNotes(notes: SourceNote[], ppq: number, flags: Set<Warning>) {
  const quantized = notes.map((note) => {
    const start = Math.round(note.start * stepsPerQuarter / ppq)
    const end = Math.max(start + 1, Math.round(note.end * stepsPerQuarter / ppq))
    if (start * ppq !== note.start * stepsPerQuarter || end * ppq !== note.end * stepsPerQuarter) flags.add('grid')
    return { note, start, end }
  }).sort((a, b) => a.start - b.start || a.end - b.end)
  const chords: Chord[] = []
  let end = 0
  for (let i = 0; i < quantized.length;) {
    const { start, end: stop } = quantized[i]
    end = Math.max(end, stop)
    const atTime: Chord[] = []
    do {
      const { note } = quantized[i++]
      // Unisons use separate voices so the original attacks and releases survive.
      let chord = atTime.find(({ notes }) => !notes.some(({ midi }) => midi === note.midi))
      if (!chord) {
        if (atTime.length === maxTracks * voicesPerTrack) fail(tooManyTracks)
        chord = { start, end: stop, notes: [] }
        atTime.push(chord)
        chords.push(chord)
      }
      if (chord.notes.length === 16) fail('MIDI 和弦超过每拍 16 个音符。')
      chord.notes.push(note)
    } while (i < quantized.length && quantized[i].start === start && quantized[i].end === stop)
  }
  return { chords, end }
}

function assignVoices(chords: Chord[], limit: number) {
  const voices: Chord[][] = []
  for (const chord of chords) {
    const voice = voices.find((items) => items.at(-1)!.end <= chord.start)
    if (voice) voice.push(chord)
    else {
      if (voices.length >= limit) fail(tooManyTracks)
      voices.push([chord])
    }
  }
  return voices
}

function guitarFingering(chords: Chord[]) {
  const notes = chords.flatMap(({ start, end, notes }) => notes.map((note) => ({ start, end, note })))
  const occupied = guitarTuning.map(() => 0)
  const candidates = notes.map(({ note }) => guitarTuning.flatMap((pitch, index) => {
    const fret = note.midi - pitch
    return fret >= 0 && fret <= maxGuitarFret ? [{ midi: note.midi, string: index + 1, fret }] : []
  }))
  if (candidates.some((options) => !options.length)) return false
  const next = notes.map(() => 0)
  const previousEnd = notes.map(() => 0)
  const chosen: (Tone & { string: number })[] = []
  let componentStart = 0
  let componentEnd = 0
  // Standard tuning is ordered high to low, so candidates try the lowest fret first.
  // Limit import fingering to 24 frets and bound backtracking inside each overlapping passage.
  let budget = notes.length * 12 + 10_000
  for (let i = 0; i < notes.length;) {
    if (--budget < 0) return false
    const { start, end } = notes[i]
    if (start >= componentEnd) {
      componentStart = i
      componentEnd = end
    }
    const tone = candidates[i][next[i]++]
    if (!tone) {
      next[i] = 0
      if (i === componentStart) return false
      i--
      occupied[chosen[i].string - 1] = previousEnd[i]
    } else if (occupied[tone.string - 1] <= start) {
      previousEnd[i] = occupied[tone.string - 1]
      occupied[tone.string - 1] = end
      componentEnd = Math.max(componentEnd, end)
      chosen[i++] = tone
    }
  }
  for (const [i, { note }] of notes.entries()) note.tone = chosen[i]
  return true
}

function sameSetting(value: Measure, minor: boolean | undefined, setting: Setting) {
  if (setting.field === 'meter') {
    return value.meter?.[0] === setting.value.meter![0] && value.meter?.[1] === setting.value.meter![1]
  }
  return value[setting.field] === setting.value[setting.field] && (setting.field !== 'key' || minor === setting.minor)
}

type MeasureSpan = { start: number; end: number; beatSteps: number }
function arrangeMeasures(project: Project, settings: Setting[], ppq: number, end: number, flags: Set<Warning>) {
  settings.sort((a, b) => a.tick - b.tick)
  const spans: MeasureSpan[] = []
  const current: Measure = { meter: project.meter, key: project.key, bpm: project.bpm }
  let minor = false
  let event = 0
  for (let start = 0; start < end;) {
    if (project.measures.length === maxMeasures) fail(tooManyMeasures)
    const latest = new Map<SettingField, Setting>()
    while (event < settings.length && settings[event].tick * stepsPerQuarter <= start * ppq) {
      const setting = settings[event++]
      const previous = latest.get(setting.field)
      if (previous && !sameSetting(previous.value, previous.minor, setting)) flags.add('overwritten')
      latest.set(setting.field, setting)
    }
    const measure: Measure = {}
    for (const setting of latest.values()) {
      if (sameSetting(current, minor, setting)) continue
      if (setting.tick * stepsPerQuarter !== start * ppq) flags.add('boundary')
      if (setting.field === 'key') {
        minor = setting.minor!
        if (minor) flags.add('minor')
      }
      Object.assign(measure, setting.value)
    }
    Object.assign(current, measure)
    if (start === 0) {
      Object.assign(project, measure)
      project.measures.push({})
    } else project.measures.push(measure)
    const [count, denominator] = current.meter!
    const unit = 32 / denominator
    const stop = start + count * unit
    // Compound eighth- and sixteenth-note meters use groups of three units.
    const compound = count >= 6 && count % 3 === 0 && denominator >= 8
    spans.push({ start, end: stop, beatSteps: compound ? 3 * unit : unit })
    start = stop
  }
  // Changes in the last measure have no following measure to apply to.
  for (; event < settings.length; event++) {
    if (!sameSetting(current, minor, settings[event])) {
      flags.add('noNextMeasure')
      break
    }
  }
  return spans
}

const values = durations.filter((duration) => duration <= 32).flatMap((duration) =>
  ([0, 1, 2] as const).map((dots) => {
    const beat = { duration, dots, triplet: false, notes: [] }
    return { beat, steps: ticks(beat) / 120 }
  })).filter(({ steps }) => Number.isInteger(steps)).sort((a, b) => b.steps - a.steps)

function writeVoice(chords: Chord[], spans: MeasureSpan[]) {
  let index = 0
  return spans.map(({ start, end, beatSteps }) => {
    const beats: Beat[] = []
    let cursor = start
    const write = (until: number, notes: Tone[], continuation = false) => {
      while (cursor < until) {
        const offset = (cursor - start) % beatSteps
        const available = offset ? Math.min(until - cursor, beatSteps - offset) : until - cursor
        const { beat, steps } = values.find(({ steps }) => steps <= available)!
        beats.push({ ...beat, notes, ...(continuation && { tie: true }) })
        cursor += steps
        continuation = notes.length > 0
      }
    }
    while (index < chords.length && chords[index].start < end) {
      const chord = chords[index]
      write(chord.start, [])
      write(Math.min(end, chord.end), chord.notes.map((note) => note.tone ?? { midi: note.midi }), chord.start < start)
      if (chord.end > end) break
      index++
    }
    if (beats.length) write(end, [])
    return beats
  })
}

function presetFor(instrument: Instrument, flags: Set<Warning>) {
  const { channel, bank, program } = instrument
  const drum = channel === 9
  const score = (candidate: number) => Math.abs(program - candidate) + (program >> 3 === candidate >> 3 ? 0 : 128)
  const preset = drum ? sounds.find(([id]) => id === drumSound)!
    : sounds.filter(([id]) => id !== drumSound).reduce((best, item) => score(item[0]) < score(best[0]) ? item : best)
  if (bank || (drum ? program !== 0 : preset[0] !== program)) flags.add('sound')
  return preset
}

export function importMidi(bytes: Uint8Array, filename: string, language: Language) {
  const t = (key: TextKey) => translate(language, key)
  const flags = new Set<Warning>()
  const { ppq, settings, instruments, end, noteCount } = decode(bytes, flags)
  const project: Project = {
    version: 1, title: filename.split(/[/\\]/).at(-1)!.replace(/\.midi?$/i, '').trim().slice(0, 200) || t('未命名曲谱'),
    author: '', bpm: 120, meter: [4, 4], key: 0, pickup: 0, measures: [], tracks: [], layout: layout(),
  }
  const groups = instruments.map((item) => ({ ...groupNotes(item.notes, ppq, flags), item }))
  const spans = arrangeMeasures(project, settings, ppq,
    Math.max(Math.round(end * stepsPerQuarter / ppq), ...groups.map(({ end }) => end)), flags)
  // Use the same UTF-8 size and indentation as Save, so the result can be reopened.
  const encoder = new TextEncoder()
  let projectBytes = encoder.encode(JSON.stringify(project, null, 2)).length + 2
  for (const [index, { item, chords }] of groups.entries()) {
    const { channel, program, bank, name, track, notes } = item
    const available = maxTracks - project.tracks.length - (groups.length - index - 1)
    const voices = assignVoices(chords, available * voicesPerTrack)
    const preset = presetFor(item, flags)
    const drum = channel === 9
    if (drum && notes.some(({ midi }) => midi < 35 || midi > 81)) flags.add('drums')
    const guitar = !drum && program >= 24 && program <= 31
    const tab = guitar && guitarFingering(chords)
    if (guitar && !tab) flags.add('guitar')
    if (voices.length > voicesPerTrack) flags.add('split')
    const label = translate(language, '轨 {track}／通道 {channel}／音色 {program}', {
      track: track + 1, channel: channel + 1, program: bank ? `${bank}:${program + 1}` : program + 1,
    })
    const partName = [name, preset[language === 'zh' ? 1 : 2], label].filter(Boolean).join(' · ')
    for (let i = 0; i < voices.length; i += voicesPerTrack) {
      const name = voices.length > voicesPerTrack ? `${partName} · ${i / voicesPerTrack + 1}` : partName
      const track = createTrack(project, tab ? 'guitar' : 'instrument', name)
      track.sound = preset[0]
      if (drum) track.mode = 'percussion'
      const [primary, ...extra] = voices.slice(i, i + voicesPerTrack).map((voice) => writeVoice(voice, spans))
      track.bars = primary
      if (extra.length) track.voices = extra.map((bars) => ({ bars }))
      projectBytes += encoder.encode(JSON.stringify(track, null, 2).replace(/^/gm, '    ')).length + 2
      if (projectBytes > maxMidiBytes) fail(projectTooLarge)
      project.tracks.push(track)
    }
  }
  return { project, noteCount, warnings: [...flags].map((flag) => warnings[flag]) }
}
