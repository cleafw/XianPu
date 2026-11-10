import { beatList, capacity, ticks, type Project, type Tone } from './model'
let context: AudioContext | undefined
let playing: OscillatorNode[] = []
let timer: ReturnType<typeof setTimeout> | undefined
let playbackId = 0

export function stopPlayback() {
  playbackId++
  clearTimeout(timer)
  for (const voice of playing) {
    try { voice.stop() } catch { /* Already completed. */ }
  }
  playing = []
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
const frequency = (midi: number) => 440 * 2 ** ((midi - 69) / 12)

export async function playScore(project: Project, part: string | null, done: () => void) {
  stopPlayback()
  const job = playbackId
  const tracks = project.tracks.filter((track) => !part || track.id === part)
  if (!tracks.some((track) => track.bars.some((bar) => bar.some((beat) => beat.notes.length)))) {
    throw new Error('请先录入音符。')
  }
  context ??= new AudioContext()
  const audio = context
  await audio.resume()
  if (job !== playbackId) return

  const secondsPerTick = 60 / project.bpm / 960
  const origin = audio.currentTime + 0.04
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

  for (const [index, events] of sounds.entries()) {
    for (const note of events) {
      const voice = audio.createOscillator()
      const gain = audio.createGain()
      const time = origin + note.start * secondsPerTick
      const end = origin + note.end * secondsPerTick
      const hz = frequency(note.midi)
      voice.type = tracks[index].kind === 'guitar' ? 'triangle' : 'sine'
      voice.frequency.setValueAtTime(hz, time)
      if (note.bend) voice.frequency.linearRampToValueAtTime(frequency(note.midi + 1), end)
      if (note.slideTo !== undefined) {
        voice.frequency.setValueAtTime(hz, end - (end - time) * 0.45)
        voice.frequency.linearRampToValueAtTime(frequency(note.slideTo), end)
      }
      gain.gain.setValueAtTime(0, time)
      gain.gain.linearRampToValueAtTime(0.11 / Math.max(1, tracks.length), time + 0.008)
      gain.gain.exponentialRampToValueAtTime(0.001, end + 0.02)
      voice.connect(gain).connect(audio.destination)
      voice.onended = () => { voice.disconnect(); gain.disconnect() }
      voice.start(time)
      voice.stop(end + 0.03)
      playing.push(voice)
    }
  }
  timer = setTimeout(() => { playing = []; done() }, Math.ceil((origin + start * secondsPerTick - audio.currentTime) * 1000) + 40)
}
