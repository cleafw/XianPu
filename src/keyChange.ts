import { measureSettings, tonic, writtenKey, type Beat, type Project, type Tone } from './model.ts'

export type KeyChangeMode = 'pitch' | 'numbered'
export type KeyChangeError = 'pitch-range' | 'guitar-range'

const pitchInRange = (midi: number) => midi >= 0 && midi <= 127
const fretInRange = (fret: number) => fret >= 0 && fret <= 36

function guitarFingering(notes: Tone[], tuning: number[]) {
  const fretted = notes.flatMap((note, index) => note.string === undefined ? [] : [{ note, index }])
  if (fretted.every(({ note }) => fretInRange(note.midi - tuning[note.string! - 1]))) {
    return notes.map((note) => note.string === undefined ? note : { ...note, fret: note.midi - tuning[note.string - 1] })
  }
  if (fretted.length > tuning.length) return undefined

  const candidates = fretted.map(({ note, index }) => ({
    index,
    options: tuning.map((open, string) => ({ ...note, string: string + 1, fret: note.midi - open }))
      .filter(({ fret }) => fretInRange(fret))
      .sort((a, b) => Number(b.string === note.string) - Number(a.string === note.string) || a.fret - b.fret),
  })).sort((a, b) => a.options.length - b.options.length)
  const result = notes.slice()
  function assign(i: number, occupied: number): boolean {
    if (i === candidates.length) return true
    const { index, options } = candidates[i]
    for (const option of options) {
      const mask = 1 << (option.string - 1)
      if (occupied & mask) continue
      result[index] = option
      if (assign(i + 1, occupied | mask)) return true
    }
    return false
  }
  return assign(0, 0) ? result : undefined
}

function shiftChord(chord: string, delta: number, key: number) {
  // Match common chord suffixes while leaving free-form labels alone.
  const root = /^([A-G])([#b♯♭]?)(?=$|[0-9/()+°øΔ−-]|(?:maj|min|dim|aug|sus|add|m)(?=$|[0-9/()+#b♯♭−-]))/
  if (!root.test(chord)) return chord
  const names = key < 0 ? ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B']
    : ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
  const transpose = (_: string, letter: string, sign: string) => {
    const natural = [9, 11, 0, 2, 4, 5, 7]['ABCDEFG'.indexOf(letter)]
    const accidental = sign === '#' || sign === '♯' ? 1 : sign ? -1 : 0
    return names[(natural + accidental + delta + 24) % 12]
  }
  return chord.replace(root, transpose).replace(/(?<=\/)([A-G])([#b♯♭]?)$/, transpose)
}

function shiftBeat(beat: Beat, tuning: number[], delta: number, key: number): Beat | KeyChangeError {
  if (!beat.notes.length && !beat.grace?.length && !beat.chord && !beat.diagram) return beat
  const shifted = beat.notes.map((note) => ({ ...note, midi: note.midi + delta }))
  const grace = beat.grace?.map((pitch) => pitch + delta)
  if (shifted.some(({ midi }) => !pitchInRange(midi)) || grace?.some((pitch) => !pitchInRange(pitch))) return 'pitch-range'

  const notes = guitarFingering(shifted, tuning)
  if (!notes || (tuning.length && grace?.some((pitch) => !tuning.some((open) => fretInRange(pitch - open))))) return 'guitar-range'
  let diagram = beat.diagram
  if (diagram) {
    const tones = diagram.flatMap((fret, i) => fret < 0 ? [] : [{ midi: tuning[i] + fret + delta, string: i + 1 }])
    if (tones.some(({ midi }) => !pitchInRange(midi))) return 'pitch-range'
    const fingering = guitarFingering(tones, tuning)
    if (!fingering) return 'guitar-range'
    diagram = diagram.map(() => -1)
    for (const { string, fret } of fingering) diagram[string! - 1] = fret!
  }
  const marks = beat.marks?.map((mark) => {
    if (mark.string === undefined) return mark
    const index = beat.notes.findIndex((note) => note.string === mark.string)
    const string = notes[index]?.string
    return string === undefined || string === mark.string ? mark : { ...mark, string }
  })
  return { ...beat, notes, grace, marks, diagram, chord: beat.chord && shiftChord(beat.chord, delta, key) }
}

export function changeKeySignature(project: Project, key: number | undefined, mode: KeyChangeMode, bar?: number):
  { score: Project } | { error: KeyChangeError } {
  if (bar === undefined ? project.key === key || key === undefined : project.measures[bar].key === key) return { score: project }

  const first = bar ?? 0
  const previous = bar === undefined ? project.key : measureSettings(project, bar).key
  const next = key ?? measureSettings(project, first - 1).key
  const delta = mode === 'numbered' ? tonic(next) - tonic(previous) : 0
  let current = bar === undefined ? next : project.key
  const keys: number[] = []
  let end = project.measures.length
  const measures = project.measures.map((measure, index) => {
    if (bar !== undefined && index > bar && measure.key !== undefined) end = Math.min(end, index)
    const signature = index === bar ? key
      : bar === undefined && measure.key !== undefined ? writtenKey(measure.key, delta) : measure.key
    current = signature ?? current
    keys.push(current)
    return signature === measure.key ? measure : { ...measure, key: signature }
  })
  const score = { ...project, key: bar === undefined ? next : project.key, measures }
  if (!delta) return { score }

  let error: KeyChangeError | undefined
  const tracks = project.tracks.map((track) => {
    if (track.mode === 'percussion' || track.layout.mode === 'percussion') return track
    const shift = (bars: Beat[][]) => bars.map((beats, index) => {
      if (index < first || index >= end) return beats
      return beats.map((beat) => {
        if (error) return beat
        const shifted = shiftBeat(beat, track.tuning, delta, keys[index])
        if (typeof shifted !== 'string') return shifted
        error = shifted
        return beat
      })
    })
    return { ...track, bars: shift(track.bars), voices: track.voices?.map((voice) => ({ ...voice, bars: shift(voice.bars) })) }
  })
  return error ? { error } : { score: { ...score, tracks } }
}
