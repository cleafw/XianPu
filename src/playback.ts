import { AlphaTabApi, midi, PlayerMode, PlayerOutputMode, type synth } from '@coderline/alphatab'
import { beatList, capacity, measureSettings, ticks, voiceBars, type Beat, type Meter, type Position, type Project, type Tone } from './model'
import { articulation, dynamics, pairedSpans } from './notationMarks'
import { scoreSettings } from './score'
import { resolveScoreNavigation } from './scoreNavigation'
import { drumSound, soundFor } from './sounds'

let player: synth.IAlphaSynth | undefined
let fontReady: Promise<void> | undefined
let queue: Promise<void> = Promise.resolve()
let done: (() => void) | undefined
let removeProgress: (() => void) | undefined
let playbackId = 0

export function stopPlayback() {
  playbackId++
  removeProgress?.()
  removeProgress = undefined
  done = undefined
  player?.stop()
}

export function playbackOrder(project: Project) {
  const { order, diagnostics } = resolveScoreNavigation(project.measures)
  if (diagnostics.length) throw new Error(diagnostics[0].message)
  return order
}

type Sound = Tone & { start: number; end: number; release: number; velocity: number; slideTo?: number }
type TimedBeat = { beat: Beat; time: number; duration: number; bar: number; section: number; isSimile: boolean; rewind: boolean }
type Hairpin = { start: number; end: number; from: number; to: number }
const velocityLimit = (velocity: number) => Math.max(1, Math.min(127, Math.round(velocity)))
const interpolate = (hairpin: Hairpin, time: number) =>
  hairpin.from + (hairpin.to - hairpin.from) * (time - hairpin.start) / (hairpin.end - hairpin.start)

function writtenDynamic(beat: Beat, string?: number) {
  const mark = beat.marks?.findLast(({ code, string: target }) =>
    target === string && code !== 'text' && Object.hasOwn(dynamics, code))
  return mark && mark.code !== 'text' ? dynamics[mark.code] : undefined
}

function trackSounds(timeline: TimedBeat[]) {
  const sounds: Sound[] = []
  const byStart = new Map<TimedBeat, { end: TimedBeat; change: number }>()
  const muteStarts = new Map<TimedBeat, number>()
  const muteEnds = new Map<TimedBeat, number>()
  const pairs = pairedSpans(timeline, ({ beat, isSimile }) => isSimile ? undefined : beat.spans)
  for (const { start, end, span } of pairs) {
    if (start.section !== end.section) continue
    if (span.kind === 'palmMute') {
      muteStarts.set(start, (muteStarts.get(start) ?? 0) + 1)
      muteEnds.set(end, (muteEnds.get(end) ?? 0) + 1)
    }
    if (end.time <= start.time) continue
    if (span.kind === 'crescendo') byStart.set(start, { end, change: 22 })
    if (span.kind === 'diminuendo') byStart.set(start, { end, change: -22 })
  }

  const entranceVelocities = new Map<number, number>()
  let previous = new Map<string, Sound>()
  let base = 80
  let muted = 0
  let hairpin: Hairpin | undefined
  let section = -1
  for (const timing of timeline) {
    const { beat, time, duration, bar, rewind } = timing
    if (timing.section !== section) previous.clear()
    section = timing.section
    if (!entranceVelocities.has(bar)) entranceVelocities.set(bar, hairpin ? interpolate(hairpin, time) : base)
    if (rewind) base = entranceVelocities.get(bar)!
    const explicit = writtenDynamic(beat)
    if (explicit !== undefined) {
      base = explicit
      if (hairpin && time < hairpin.end) hairpin = { ...hairpin, from: explicit, start: time }
    }
    if (hairpin && time >= hairpin.end) {
      base = explicit ?? hairpin.to
      hairpin = undefined
    }
    const wedge = byStart.get(timing)
    if (wedge) {
      const from = hairpin ? interpolate(hairpin, time) : base
      hairpin = { start: time, end: wedge.end.time, from, to: writtenDynamic(wedge.end.beat) ?? velocityLimit(from + wedge.change) }
    }
    const level = hairpin ? interpolate(hairpin, time) : base
    muted += muteStarts.get(timing) ?? 0
    const next = new Map<string, Sound>()
    const grace = beat.notes.length ? beat.grace ?? [] : []
    const graceStep = grace.length ? Math.min(80, duration * 0.22 / grace.length) : 0
    for (const [i, pitch] of grace.entries()) {
      const start = time + i * graceStep
      sounds.push({ midi: pitch, start, end: start + graceStep, release: start + graceStep, velocity: velocityLimit(level * 0.8) })
    }
    const onset = time + grace.length * graceStep
    for (const note of beat.notes) {
      const key = note.string ? 's' + note.string : 'm' + note.midi
      const prior = previous.get(key)
      const adjacent = !grace.length && prior && Math.abs(prior.end - time) < 1e-7
      let velocity = (note.string === undefined ? undefined : writtenDynamic(beat, note.string)) ?? level
      let gate = muted ? 0.45 : 1
      let slide = note.slide
      let bend = note.bend
      let fortePiano = false
      for (const mark of beat.marks ?? []) {
        if (mark.code === 'text' || (mark.string !== undefined && mark.string !== note.string)) continue
        const effect = articulation[mark.code]
        if (!effect) continue
        fortePiano ||= mark.code === 'fp'
        gate = Math.min(gate, effect.gate ?? 1)
        velocity += effect.velocity ?? 0
        slide ||= effect.slide
        bend ||= effect.bend
      }
      const end = time + duration
      const release = Math.min(end, onset + Math.max(1, (end - onset) * gate))
      if (adjacent && beat.tie && prior.midi === note.midi) {
        prior.end = end
        prior.release = release
        prior.slide ||= slide
        next.set(key, prior)
        continue
      }
      if (adjacent && prior.slide) prior.slideTo = note.midi
      const sound = { ...note, start: onset, end, release, velocity: velocityLimit(fortePiano ? Math.max(94, velocity) : velocity), slide, bend }
      sounds.push(sound)
      next.set(key, sound)
    }
    previous = next
    if (beat.marks?.some(({ code, string }) => code === 'fp' && string === undefined)) {
      base = dynamics.p!
      if (hairpin && time < hairpin.end) hairpin = { ...hairpin, from: base, start: time }
    }
    muted -= muteEnds.get(timing) ?? 0
  }
  return sounds
}

type PlaybackPoint = { tick: number; position: Position }

function buildPlayback(project: Project, part: string | null, follow?: Position) {
  const tracks = project.tracks.filter((track) => !part || track.id === part)
  const cursorTrack = follow ? tracks.find(({ id }) => id === follow.track) ?? tracks[0] : undefined
  const points: PlaybackPoint[] = []
  const sourceBars: number[] = []
  for (const [index, { simile }] of project.measures.entries()) {
    const double = simile === 'double' && index >= 2 && project.measures[index + 1]?.simile === 'double-second'
      || simile === 'double-second' && index >= 3 && project.measures[index - 1]?.simile === 'double'
    sourceBars.push(sourceBars[index - (double ? 2 : simile === 'single' ? 1 : 0)] ?? index)
  }
  const { order, endingMasks, diagnostics } = resolveScoreNavigation(project.measures)
  if (diagnostics.length) throw new Error(diagnostics[0].message)
  const streams = tracks.flatMap((track) => {
    const mode = part ? track.layout.mode ?? track.mode : track.mode
    const sound = mode === 'percussion' && track.sound === undefined ? drumSound : soundFor(track)
    return [track.bars, ...(track.voices ?? []).map(({ bars }) => bars)]
      .filter((bars) => order.some((index) => bars[sourceBars[index]]?.some((beat) => beat.notes.length)))
      .map((bars) => ({ bars, sound, timeline: [] as TimedBeat[] }))
  })
  if (!streams.length) throw new Error('请先录入音符。')
  const file = new midi.MidiFile()
  file.division = 960
  let start = 0
  let tempo = 0
  let previousMeter: Meter | undefined
  let previousBar = -1
  let section = 0
  const entranceTempo = new Map<number, number>()
  for (const index of order) {
    const rewind = index <= previousBar
    const skippedFirstEnding = index > previousBar + 1 && endingMasks.slice(previousBar + 1, index).every((mask) => mask === 1)
    if (index !== previousBar + 1 && !skippedFirstEnding) section++
    const source = sourceBars[index]
    if (source !== index && capacity(project, source) !== capacity(project, index)) throw new Error('小节重复的原小节和目标小节拍数不同。')
    const meter = measureSettings(project, index).meter
    if (meter[0] !== previousMeter?.[0] || meter[1] !== previousMeter[1]) {
      file.addEvent(new midi.TimeSignatureEvent(0, start, meter[0], Math.log2(meter[1]), 96 / meter[1], 8))
      previousMeter = meter
    }
    const bpm = project.measures[index].bpm ?? (rewind ? entranceTempo.get(index) : undefined) ?? (tempo || project.bpm)
    if (!entranceTempo.has(index)) entranceTempo.set(index, bpm)
    if (tempo !== bpm) file.addEvent(new midi.TempoChangeEvent(start, Math.round(60_000_000 / bpm)))
    tempo = bpm
    if (cursorTrack && follow) {
      const voice = cursorTrack.id === follow.track ? follow.voice : 0
      const bars = voiceBars(cursorTrack, voice)
      let tick = start
      for (const [beat, item] of beatList(project, bars[index], index).entries()) {
        points.push({ tick, position: { track: cursorTrack.id, bar: index, beat, voice, lane: follow.lane } })
        if (source !== index) break
        tick += ticks(item)
      }
    }
    let length = capacity(project, index)
    for (const { bars, timeline } of streams) {
      let offset = 0
      for (const beat of beatList(project, bars[source] ?? [], source)) {
        const duration = ticks(beat)
        timeline.push({ beat, time: start + offset, duration, bar: index, section,
          isSimile: source !== index, rewind: rewind && offset === 0 })
        offset += duration
      }
      length = Math.max(length, offset)
    }
    start += length
    previousBar = index
  }

  const pitchRange = 36
  const percussionChannel = 9
  const drumKeys = new Set<number>()
  for (const [index, { timeline, sound }] of streams.entries()) {
    // Keep a single internal MIDI track and use independent channels for sound assignment.
    const track = 0
    // These events go directly to alphaTab's synthesizer, which supports more
    // than 16 internal channels. Keep channel 9 reserved for its GM drum mode.
    const channel = index < percussionChannel ? index : index + 1
    const drums = sound === drumSound
    file.addEvent(new midi.ControlChangeEvent(track, 0, channel, midi.ControllerType.BankSelectCoarse, drums ? 128 : 0))
    file.addEvent(new midi.ProgramChangeEvent(track, 0, channel, drums ? 0 : sound))
    for (const [controller, value] of [[101, 0], [100, 0], [6, pitchRange]]) {
      file.addEvent(new midi.ControlChangeEvent(track, 0, channel, controller, value))
    }
    for (const note of trackSounds(timeline)) {
      const key = drums && (note.midi < 35 || note.midi > 81) ? 36 : note.midi
      if (drums) drumKeys.add(key)
      file.addEvent(new midi.NoteOnEvent(track, note.start, channel, key, note.velocity))
      const semitones = note.slideTo !== undefined ? note.slideTo - note.midi : note.bend ? 1 : 0
      if (!drums && semitones) {
        const rampStart = note.slideTo === undefined ? note.start : note.start + (note.release - note.start) * 0.55
        for (let step = 1; step <= 8; step++) {
          const tick = Math.min(note.release - 1, Math.round(rampStart + (note.release - rampStart) * step / 8))
          const ratio = Math.max(-1, Math.min(1, semitones / pitchRange)) * step / 8
          const wheel = Math.min(0xffffffff, Math.round(0x80000000 * (1 + ratio)))
          file.addEvent(new midi.NoteBendEvent(track, tick, channel, key, wheel))
        }
      }
      file.addEvent(new midi.NoteOffEvent(track, note.release, channel, key, 0))
    }
  }
  // AlphaSynth uses channel 9 to decide which percussion samples to decode.
  for (const key of drumKeys) file.addEvent(new midi.NoteOnEvent(0, 0, percussionChannel, key, 0))
  file.addEvent(new midi.EndOfTrackEvent(0, start))
  return { file, points }
}

export function buildPlaybackMidi(project: Project, part: string | null) {
  return buildPlayback(project, part).file
}

function getPlayer() {
  if (player) return player
  const settings = scoreSettings()
  settings.player.playerMode = PlayerMode.EnabledSynthesizer
  settings.player.outputMode = PlayerOutputMode.WebAudioScriptProcessor
  settings.player.enableCursor = false
  const api = new AlphaTabApi(document.createElement('div'), settings)
  const instance = api.player
  if (!instance?.output) {
    api.destroy()
    throw new Error('无法启动音色播放器。')
  }
  instance.masterVolume = 0.45
  instance.finished.on(() => {
    const callback = done
    removeProgress?.()
    removeProgress = undefined
    done = undefined
    callback?.()
  })
  player = instance
  return instance
}

function waitForAudio(event: { on: (callback: () => void) => () => void },
  failed: { on: (callback: (error: Error) => void) => () => void },
  start: () => void) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => fail(new Error('加载试听音色超时。')), 15000)
    function cleanup() { clearTimeout(timer); removeReady(); removeFailure() }
    function ready() { cleanup(); resolve() }
    function fail(error: Error) { cleanup(); reject(error) }
    let armed = false
    const removeReady = event.on(() => { if (armed) ready() })
    const removeFailure = failed.on((error) => { if (armed) fail(error) })
    armed = true
    try { start() } catch (error) { fail(error instanceof Error ? error : new Error(String(error))) }
  })
}

function loadFont(instance: synth.IAlphaSynth) {
  fontReady ??= (async () => {
    const response = await fetch(import.meta.env.BASE_URL + 'soundfonts/NeuralNote_GM.sf3')
    if (!response.ok) throw new Error('无法读取试听音色库。')
    const bytes = new Uint8Array(await response.arrayBuffer())
    await waitForAudio(instance.soundFontLoaded, instance.soundFontLoadFailed, () => instance.loadSoundFont(bytes, false))
  })().catch((error) => { fontReady = undefined; throw error })
  return fontReady
}

export async function playScore(project: Project, part: string | null, onDone: () => void, onStarted: () => void,
  follow: Position, onProgress: (position: Position) => void) {
  stopPlayback()
  const job = playbackId
  const { file, points } = buildPlayback(project, part, follow)
  const instance = getPlayer()
  instance.output.activate()
  const task = queue.then(async () => {
    if (job !== playbackId) return
    await loadFont(instance)
    if (job !== playbackId) return
    // The worker reports readiness after loading the score and its required presets.
    await waitForAudio(instance.readyForPlayback, instance.midiLoadFailed, () => instance.loadMidiFile(file))
    if (job !== playbackId) return
    let last = -1
    function progress(tick: number) {
      if (job !== playbackId || !points.length) return
      let low = 0
      let high = points.length
      while (low < high) {
        const middle = (low + high) >>> 1
        if (points[middle].tick <= tick + 1e-7) low = middle + 1
        else high = middle
      }
      const index = Math.max(0, low - 1)
      if (last !== index) {
        last = index
        onProgress(points[index].position)
      }
    }
    done = onDone
    removeProgress = instance.positionChanged.on(({ currentTick }) => progress(currentTick))
    if (!instance.play()) {
      removeProgress()
      removeProgress = undefined
      done = undefined
      throw new Error('无法启动音色播放器。')
    }
    progress(0)
    onStarted()
  })
  queue = task.catch(() => {})
  try { await task } catch (error) { if (job === playbackId) throw error }
}
