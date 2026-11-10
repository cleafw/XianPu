import assert from 'node:assert/strict'
import { test } from 'node:test'
import { importMidi } from '../src/midiImport.ts'
import { capacity, measureSettings, parseProject, ticks, voiceBars } from '../src/model.ts'
import { endTrack, ensembleMidi, event, midiFile } from './midi-fixtures.ts'

const convert = (bytes: Uint8Array) => importMidi(bytes, 'C:/Music/Take.MIDI', 'en')

test('format 0 separates channels, programs and banks and pairs running note-offs to the original program', () => {
  const { project, warnings, noteCount } = convert(midiFile(0, [[
    ...event(0, 0x90, 60, 90), ...event(0, 64, 90),
    ...event(0, 0xc1, 25), ...event(0, 0x91, 64, 90), ...event(0, 0x99, 36, 100),
    ...event(120, 36, 0), ...event(0, 0xb0, 0, 1), ...event(0, 0xc0, 0),
    ...event(120, 0x80, 60, 40), ...event(0, 64, 40),
    ...event(0, 0x90, 62, 90), ...event(240, 62, 0),
    ...event(0, 0x81, 64, 0), ...endTrack(),
  ]]))
  assert.equal(project.title, 'Take')
  assert.equal(noteCount, 5)
  assert.deepEqual(project.tracks.map(({ mode, sound }) => [mode, sound]), [
    ['staff', 0], ['tab', 24], ['percussion', 128], ['staff', 0],
  ])
  assert.deepEqual(project.tracks[0].bars[0][0].notes, [{ midi: 60 }, { midi: 64 }])
  assert.deepEqual(project.tracks[3].bars[0][1].notes, [{ midi: 62 }])
  assert.ok(warnings.includes('部分音色已使用库内相近的预设。'))
  assert.deepEqual(parseProject(JSON.stringify(project)), project)
})

test('format 1 shares control-only channel state in tick and track order while keeping note tracks independent', () => {
  const { project, warnings } = convert(midiFile(1, [
    [
      ...event(0, 0xb0, 0, 1),
      ...event(60, 0xc0, 40),
      ...event(60, 0xb0, 32, 2),
      ...event(120, 0xc0, 42), ...endTrack(),
    ],
    [
      ...event(120, 0x90, 60, 90), ...event(120, 60, 0),
      ...event(0, 62, 90), ...event(120, 64, 90), ...endTrack(240),
    ],
    [
      ...event(60, 0xc0, 57), ...event(60, 0x90, 65, 90),
      ...event(360, 0xb0, 123, 0), ...endTrack(120),
    ],
    [...event(240, 0xc0, 41), ...endTrack()],
  ]))
  assert.deepEqual(project.tracks.map(({ name, sound }) => [name.split(' · ').at(-1), sound]), [
    ['Track 2 / Ch. 1 / Patch 128:41', 40],
    ['Track 2 / Ch. 1 / Patch 130:43', 42],
    ['Track 2 / Ch. 1 / Patch 130:42', 41],
    ['Track 3 / Ch. 1 / Patch 128:58', 57],
  ])
  assert.ok(!warnings.some((warning) => warning.includes('未配对')))
  const thirdTrackNote = project.tracks[3].bars[0].filter(({ notes }) => notes.length)
  assert.equal(thirdTrackNote.reduce((total, beat) => total + ticks(beat), 0), 720)
})

test('CC 120 and 123 end all held notes on their own channel', () => {
  const { project, warnings } = convert(midiFile(0, [[
    ...event(0, 0x90, 60, 90), ...event(0, 64, 90), ...event(0, 0x91, 67, 90),
    ...event(480, 0xb0, 120, 0),
    ...event(0, 0x90, 60, 90), ...event(480, 0xb0, 123, 0),
    ...event(480, 0x81, 67, 0), ...endTrack(),
  ]]))
  const notes = (track: number) => project.tracks[track].bars[0].filter(({ notes }) => notes.length)
  assert.deepEqual(notes(0).map((beat) => [ticks(beat), beat.notes.length, beat.tie]), [
    [960, 2, undefined], [960, 1, undefined],
  ])
  assert.equal(notes(1).reduce((total, beat) => total + ticks(beat), 0), 2880)
  assert.ok(!warnings.some((warning) => warning.includes('未配对')))
})

test('format 1 aligns settings, preserves a spread chord and voices, and ties only sustained notes', () => {
  const { project, warnings, noteCount } = convert(ensembleMidi())
  assert.equal(noteCount, 8)
  assert.equal(project.measures.length, 3)
  assert.deepEqual(measureSettings(project, 0), { key: -2, bpm: 120, meter: [4, 4] })
  assert.deepEqual(measureSettings(project, 1), { key: 2, bpm: 100, meter: [3, 8] })
  assert.deepEqual(measureSettings(project, 2), measureSettings(project, 1))
  const [piano, guitar] = project.tracks
  const chord = [{ midi: 60 }, { midi: 64 }, { midi: 67 }]
  assert.deepEqual(piano.bars[0][0].notes, chord)
  assert.equal(piano.voices?.length, 1)
  assert.deepEqual(piano.voices[0].bars[0].find(({ notes }) => notes.length)?.notes, [{ midi: 72 }])
  const shortNote = piano.voices[0].bars[0].find(({ notes }) => notes[0]?.midi === 74)
  assert.equal(shortNote?.duration, 32)
  assert.deepEqual(piano.bars[1][0].notes, chord)
  assert.equal(piano.bars[1][0].tie, true)
  assert.deepEqual(piano.bars[1][1].notes, [{ midi: 60 }])
  assert.equal(piano.bars[1][1].tie, undefined)
  assert.equal(piano.bars[2][0].tie, true)
  assert.equal(guitar.mode, 'tab')
  assert.equal(guitar.bars[0][0].notes[0].string, 2)
  assert.equal(guitar.voices?.[0].bars[0].find(({ notes }) => notes.length)?.notes[0].string, 1)
  for (const track of project.tracks) {
    for (let voice = 0; voice <= (track.voices?.length ?? 0); voice++) {
      const bars = voiceBars(track, voice)
      assert.equal(bars.length, project.measures.length)
      for (const [index, bar] of bars.entries()) {
        if (bar.length) assert.equal(bar.reduce((sum, beat) => sum + ticks(beat), 0), capacity(project, index))
      }
    }
  }
  assert.ok(warnings.includes('音符已对齐到三十二分音符，短音至少保留一格。'))
  assert.ok(warnings.includes('小节中的拍号、调号或速度变化从下一小节起生效。'))
  assert.ok(warnings.includes('小调保留原升降号，以对应的大调名称显示。'))
  assert.deepEqual(parseProject(JSON.stringify(project, null, 2)), project)
})

test('quantized duplicate unisons remain separate and overlapping guitar strings are never reused', () => {
  const { project, warnings } = convert(midiFile(0, [[
    ...event(0, 0xc0, 24), ...event(0, 0x90, 40, 80), ...event(2, 45, 80), ...event(2, 40, 80),
    ...event(236, 40, 0), ...event(2, 45, 0), ...event(2, 40, 0), ...endTrack(),
  ]]))
  const [guitar] = project.tracks
  assert.equal(guitar.mode, 'staff')
  assert.deepEqual(guitar.bars[0][0].notes, [{ midi: 40 }, { midi: 45 }])
  assert.deepEqual(guitar.voices?.[0].bars[0][0].notes, [{ midi: 40 }])
  assert.ok(warnings.includes('无法分配弦品的吉他已使用五线谱。'))
})

test('guitar fingering prefers the lowest fret and falls back above fret 24', () => {
  const guitar = (pitch: number) => convert(midiFile(0, [[
    ...event(0, 0xc0, 24), ...event(0, 0x90, pitch, 90), ...event(480, pitch, 0), ...endTrack(),
  ]]))
  assert.deepEqual(guitar(64).project.tracks[0].bars[0][0].notes, [{ midi: 64, string: 1, fret: 0 }])
  assert.deepEqual(guitar(88).project.tracks[0].bars[0][0].notes, [{ midi: 88, string: 1, fret: 24 }])
  const { project, warnings } = guitar(89)
  assert.equal(project.tracks[0].mode, 'staff')
  assert.deepEqual(project.tracks[0].bars[0][0].notes, [{ midi: 89 }])
  assert.ok(warnings.includes('无法分配弦品的吉他已使用五线谱。'))
})

test('distinguishes overwritten and final metadata from changes that move to the next measure', () => {
  const { project, warnings } = convert(midiFile(1, [
    [
      ...event(240, 0xff, 0x51, 3, 0x09, 0x27, 0xc0), // 100 BPM, overwritten
      ...event(240, 0xff, 0x59, 2, 0xfe, 1), // minor, overwritten
      ...event(1440, 0xff, 0x51, 3, 0x06, 0x1a, 0x80), // 150 BPM, on the bar
      ...event(0, 0xff, 0x59, 2, 2, 0),
      ...event(480, 0xff, 0x58, 4, 3, 3, 24, 8), // no following measure
      ...event(1440, 0xff, 0x59, 2, 0, 0), ...endTrack(),
    ],
    [...event(0, 0x90, 60, 90), ...event(2880, 60, 0), ...endTrack()],
  ]))
  assert.equal(project.measures.length, 2)
  assert.deepEqual(measureSettings(project, 1), { key: 2, bpm: 150, meter: [4, 4] })
  assert.deepEqual(warnings, [
    '同一小节边界被覆盖的拍号、调号或速度变化已略过。',
    '没有后续小节可应用的拍号、调号或速度变化已略过。',
  ])
})

test('off-beat notes and rests stop at the next metric beat before using longer values', () => {
  const ranges = (track: number[]) => {
    const { project } = convert(midiFile(0, [[...track, ...endTrack()]]))
    let start = 0
    return project.tracks[0].bars[0].map((beat) => {
      const range = { start, end: start + ticks(beat) / 120, pitch: beat.notes[0]?.midi, tie: !!beat.tie }
      start = range.end
      return range
    })
  }
  const simple = ranges([
    ...event(0, 0x90, 60, 90), ...event(60, 60, 0),
    ...event(480, 62, 90), ...event(900, 62, 0),
  ])
  assert.ok(simple.some(({ end, pitch }) => end === 8 && pitch === undefined))
  assert.ok(simple.some(({ start, pitch, tie }) => start === 16 && pitch === 62 && tie))
  for (const { start, end, pitch, tie } of simple) {
    if (start % 8) assert.ok(end <= Math.ceil(start / 8) * 8)
    if (pitch === undefined) assert.equal(tie, false)
  }
  const compound = ranges([
    ...event(0, 0xff, 0x58, 4, 6, 3, 24, 8),
    ...event(60, 0x90, 60, 90), ...event(1020, 60, 0),
  ])
  assert.deepEqual(compound.filter(({ pitch }) => pitch === 60).map(({ start, end, tie }) => [start, end, tie]), [
    [1, 9, false], [9, 12, true], [12, 18, true],
  ])
})

test('splits instruments into extra parts when a fifth voice is needed', () => {
  const overlapping = (count: number) => [
    ...Array.from({ length: count }, () => event(0, 0x90, 60, 80)).flat(),
    ...Array.from({ length: count }, (_, i) => event(i === 0 ? 480 : 0, 0x80, 60, 0)).flat(),
    ...endTrack(),
  ]
  const { project, warnings } = convert(midiFile(0, [overlapping(5)]))
  assert.equal(project.tracks.length, 2)
  assert.equal(project.tracks[0].voices?.length, 3)
  assert.ok(warnings.includes('声部较多的乐器已拆分。'))
  assert.throws(() => convert(midiFile(0, [overlapping(97)])), /24 个乐器/)
})

test('rejects missing notes, invalid chunks and VLQs, unsupported timing, and project limits', () => {
  const phrase = [...event(0, 0x90, 60, 80), ...event(480, 60, 0), ...endTrack()]
  assert.throws(() => convert(midiFile(0, [endTrack()])), /没有可导入的音符/)
  assert.throws(() => convert(midiFile(2, [phrase])), /标准 MIDI 0 或 1 型/)
  assert.throws(() => convert(midiFile(0, [phrase], 0xe728)), /标准 MIDI 0 或 1 型/)
  assert.throws(() => convert(midiFile(0, [phrase]).subarray(0, -1)), /损坏或不完整/)
  assert.throws(() => convert(midiFile(0, [phrase.slice(0, -4)])), /损坏或不完整/)
  assert.throws(() => convert(midiFile(0, [[0x80, 0x80, 0x80, 0x80, ...phrase]])), /损坏或不完整/)
  assert.throws(() => convert(midiFile(0, [[...event(0, 0xff, 0x80, 0), ...phrase]])), /损坏或不完整/)
  const unsigned = midiFile(0, [phrase])
  unsigned.writeUInt32BE(0x80000000, 18)
  assert.throws(() => convert(unsigned), /损坏或不完整/)
  assert.throws(() => convert(midiFile(0, [[...phrase.slice(0, -4), ...endTrack(1920 * 256)]])), /256 小节/)
  assert.throws(() => convert(midiFile(1, Array.from({ length: 25 }, () => phrase))), /24 个乐器/)
  const chord = Array.from({ length: 17 }, (_, i) => event(0, 0x90, 50 + i, 80)).flat()
  const release = Array.from({ length: 17 }, (_, i) => event(i === 0 ? 480 : 0, 0x80, 50 + i, 0)).flat()
  assert.throws(() => convert(midiFile(0, [[...chord, ...release, ...endTrack()]])), /16 个音符/)
})

test('rejects note floods before grouping and catches oversized projects from modest input', () => {
  const pair = Buffer.from([...event(0, 0x90, 60, 90), ...event(0, 60, 0)])
  const flood = Buffer.alloc(300_000 * pair.length, pair)
  const header = midiFile(0, [[]])
  header.writeUInt32BE(flood.length + 4, 18)
  const tooLarge = /转换后的工程超过 16 MB/
  assert.throws(() => convert(Buffer.concat([header, flood, Buffer.from(endTrack())])), tooLarge)

  // Sixty-four held pitches per track expand into four tied chords per measure.
  const held = Array.from({ length: 64 }, (_, i) => event(0, 0x90, 48 + i % 16, 80)).flat()
  const released = Array.from({ length: 64 }, (_, i) => event(i === 0 ? 1920 * 256 : 0, 0x80, 48 + i % 16, 0)).flat()
  const small = midiFile(1, Array.from({ length: 20 }, () => [...held, ...released, ...endTrack()]))
  assert.ok(small.length < 11_000)
  assert.throws(() => convert(small), tooLarge)
})
