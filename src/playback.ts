import { AlphaTabApi, midi, PlayerMode, PlayerOutputMode, type synth } from '@coderline/alphatab'
import { beatList, capacity, ticks, type Project, type Tone } from './model'
import { scoreSettings } from './score'
import { drumSound, soundFor } from './sounds'

let player: synth.IAlphaSynth | undefined
let fontReady: Promise<void> | undefined
let queue: Promise<void> = Promise.resolve()
let done: (() => void) | undefined
let playbackId = 0

export function stopPlayback() {
  playbackId++
  done = undefined
  player?.stop()
}

export function playbackOrder(project: Project) {
  const order: number[] = []
  let repeatStart = 0
  for (const [index, bar] of project.measures.entries()) {
    if (bar.start) repeatStart = index
    order.push(index)
    if (bar.end) {
      for (let repeated = repeatStart; repeated <= index; repeated++) order.push(repeated)
      repeatStart = index + 1
    }
  }
  return order
}

type Sound = Tone & { start: number; end: number; slideTo?: number }

export function buildPlaybackMidi(project: Project, part: string | null) {
  const tracks = project.tracks.filter((track) => !part || track.id === part)
  if (!tracks.some((track) => track.bars.some((bar) => bar.some((beat) => beat.notes.length)))) {
    throw new Error('请先录入音符。')
  }
  const file = new midi.MidiFile()
  file.division = 960
  file.addEvent(new midi.TempoChangeEvent(0, Math.round(60_000_000 / project.bpm)))
  const sounds: Sound[][] = tracks.map(() => [])
  const previous: Map<string, Sound>[] = tracks.map(() => new Map())
  let start = 0
  for (const index of playbackOrder(project)) {
    let length = capacity(project, index)
    for (const [trackIndex, track] of tracks.entries()) {
      let offset = 0
      for (const beat of beatList(project, track.bars[index], index)) {
        const duration = ticks(beat)
        const time = start + offset
        const next = new Map<string, Sound>()
        for (const note of beat.notes) {
          const key = note.string ? 's' + note.string : 'm' + note.midi
          const prior = previous[trackIndex].get(key)
          if (prior?.end === time && beat.tie && prior.midi === note.midi) {
            prior.end += duration
            next.set(key, prior)
            continue
          }
          if (prior?.end === time && prior.slide) prior.slideTo = note.midi
          const sound = { ...note, start: time, end: time + duration }
          sounds[trackIndex].push(sound)
          next.set(key, sound)
        }
        previous[trackIndex] = next
        offset += duration
      }
      length = Math.max(length, offset)
    }
    start += length
  }

  const pitchRange = 36
  const percussionChannel = 9
  const drumKeys = new Set<number>()
  for (const [index, events] of sounds.entries()) {
    // Keep a single internal MIDI track and use independent channels for sound assignment.
    const track = 0
    // These events go directly to alphaTab's synthesizer, which supports more
    // than 16 internal channels. Keep channel 9 reserved for its GM drum mode.
    const channel = index < percussionChannel ? index : index + 1
    const sound = soundFor(tracks[index])
    const drums = sound === drumSound
    file.addEvent(new midi.ControlChangeEvent(track, 0, channel, midi.ControllerType.BankSelectCoarse, drums ? 128 : 0))
    file.addEvent(new midi.ProgramChangeEvent(track, 0, channel, drums ? 0 : sound))
    for (const [controller, value] of [[101, 0], [100, 0], [6, pitchRange]]) {
      file.addEvent(new midi.ControlChangeEvent(track, 0, channel, controller, value))
    }
    for (const note of events) {
      const key = drums && (note.midi < 35 || note.midi > 81) ? 36 : note.midi
      if (drums) drumKeys.add(key)
      file.addEvent(new midi.NoteOnEvent(track, note.start, channel, key, 80))
      const semitones = note.slideTo !== undefined ? note.slideTo - note.midi : note.bend ? 1 : 0
      if (!drums && semitones) {
        const rampStart = note.slideTo === undefined ? note.start : note.start + (note.end - note.start) * 0.55
        for (let step = 1; step <= 8; step++) {
          const tick = Math.min(note.end - 1, Math.round(rampStart + (note.end - rampStart) * step / 8))
          const ratio = Math.max(-1, Math.min(1, semitones / pitchRange)) * step / 8
          const wheel = Math.min(0xffffffff, Math.round(0x80000000 * (1 + ratio)))
          file.addEvent(new midi.NoteBendEvent(track, tick, channel, key, wheel))
        }
      }
      file.addEvent(new midi.NoteOffEvent(track, note.end, channel, key, 0))
    }
  }
  // AlphaSynth uses channel 9 to decide which percussion samples to decode.
  for (const key of drumKeys) file.addEvent(new midi.NoteOnEvent(0, 0, percussionChannel, key, 0))
  file.addEvent(new midi.EndOfTrackEvent(0, start))
  return file
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

export async function playScore(project: Project, part: string | null, onDone: () => void, onStarted: () => void) {
  stopPlayback()
  const job = playbackId
  const file = buildPlaybackMidi(project, part)
  const instance = getPlayer()
  instance.output.activate()
  const task = queue.then(async () => {
    if (job !== playbackId) return
    await loadFont(instance)
    if (job !== playbackId) return
    // The worker reports readiness after loading the score and its required presets.
    await waitForAudio(instance.readyForPlayback, instance.midiLoadFailed, () => instance.loadMidiFile(file))
    if (job !== playbackId) return
    done = onDone
    if (!instance.play()) { done = undefined; throw new Error('无法启动音色播放器。') }
    onStarted()
  })
  queue = task.catch(() => {})
  try { await task } catch (error) { if (job === playbackId) throw error }
}
