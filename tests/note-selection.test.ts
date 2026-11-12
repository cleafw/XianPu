import assert from 'node:assert/strict'
import test from 'node:test'
import { beatList, blank, createProject, parseProject } from '../src/model.ts'
import { convertNotesToGrace, copySelectedNotes, editRhythmSelection, pasteSelectedNotes, resetSelectedNotes, selectedBeats, shiftSelectedPitches, steppedRhythm } from '../src/noteSelection.ts'

test('batch rhythm deduplicates chord notes and applies equally to explicit rests', () => {
  const project = createProject('song')
  const track = project.tracks[0]
  track.bars[0] = [
    { ...blank(), draft: false, notes: [{ midi: 60 }, { midi: 64 }] },
    { ...blank(), draft: false },
    { ...blank(), draft: false, notes: [{ midi: 67 }] },
  ]
  const first = { track: track.id, bar: 0, beat: 0 }
  const targets = selectedBeats(project, [{ ...first, note: 0 }, { ...first, note: 1 }, { ...first, beat: 1 }])
  const edited = editRhythmSelection(project, targets, (beat) => steppedRhythm(beat, 'add-extension', true))
  assert.deepEqual(edited.tracks[0].bars[0].map(({ duration }) => duration), [2, 2, 4])
  assert.equal(edited.tracks[0].bars[0][0].notes.length, 2)
  assert.equal(edited.tracks[0].bars[0][1].notes.length, 0)
})

test('octave moves selected chord tones only and refuses out-of-range edits atomically', () => {
  const project = createProject('song')
  const track = project.tracks[0]
  track.bars[0] = [
    { ...blank(), draft: false, notes: [{ midi: 60 }, { midi: 64 }] },
    { ...blank(), draft: false, notes: [{ midi: 127 }] },
  ]
  const start = { track: track.id, bar: 0, beat: 0, note: 1 }
  const targets = selectedBeats(project, [start, { ...start, beat: 1, note: 0 }])
  assert.deepEqual(shiftSelectedPitches(project, targets, 12, null), { error: 'pitch' })
  const result = shiftSelectedPitches(project, targets.slice(0, 1), -12, null)
  assert.ok('score' in result)
  assert.deepEqual(result.score.tracks[0].bars[0][0].notes.map(({ midi }) => midi), [60, 52])
})

test('clear formatting resets whole beats to plain rests and preserves unselected chord tones', () => {
  const project = createProject('song')
  const track = project.tracks[0]
  track.bars[0] = [
    { ...blank(), draft: false, notes: [{ midi: 60 }], slur: true },
    { ...blank(8), draft: false, dots: 1, grace: [59], notes: [{ midi: 60 }], lyric: '词', chord: 'C',
      tuplet: [3, 2], tupletGroup: 'group', marks: [{ id: 'mark', code: 'staccato', place: 'above', dx: 0, dy: 0 }],
      spans: [{ id: 'span', kind: 'crescendo', end: false }] },
    { ...blank(8), draft: false, tie: true, tuplet: [3, 2], tupletGroup: 'group', notes: [{ midi: 60 }, { midi: 64 }],
      spans: [{ id: 'span', kind: 'crescendo', end: true }] },
  ]
  const first = { track: track.id, bar: 0, beat: 1 }
  const reset = resetSelectedNotes(project, selectedBeats(project, [first, { ...first, beat: 2, note: 1 }]))
  const [before, rest, chord] = reset.tracks[0].bars[0]
  assert.deepEqual(rest, { ...blank(), draft: false })
  assert.equal(before.slur, false)
  assert.equal(chord.tie, false)
  assert.deepEqual(chord.spans, [])
  assert.equal(chord.tupletGroup, undefined)
  assert.deepEqual(chord.tuplet, [3, 2])
  assert.deepEqual(chord.notes, [{ midi: 60 }])
  assert.equal(reset.tracks[1], project.tracks[1])
  assert.equal(track.bars[0][1].notes.length, 1)
})

test('note clipboard remaps complete spans and covers positions across a barline', () => {
  const project = createProject('song')
  const track = project.tracks[0]
  track.bars[0] = [60, 62, 64, 65].map((midi) => ({ ...blank(), draft: false, notes: [{ midi }] }))
  track.bars[0][0].spans = [{ id: 'hairpin', kind: 'crescendo', end: false }]
  track.bars[0][1].spans = [{ id: 'hairpin', kind: 'crescendo', end: true }]
  const first = { track: track.id, bar: 0, beat: 0 }
  const clipboard = copySelectedNotes(project, selectedBeats(project, [first, { ...first, beat: 1 }]), track)
  const pasted = pasteSelectedNotes(project, { ...first, beat: 3 }, clipboard)
  assert.ok('score' in pasted)
  const bars = parseProject(JSON.stringify(pasted.score)).tracks[0].bars
  assert.equal(bars[0][3].notes[0].midi, 60)
  assert.equal(bars[1][0].notes[0].midi, 62)
  assert.notEqual(bars[0][3].spans?.[0].id, 'hairpin')
  assert.equal(bars[0][3].spans?.[0].id, bars[1][0].spans?.[0].id)
  assert.equal(pasted.score.tracks[1], project.tracks[1])
  assert.deepEqual(pasteSelectedNotes(project, { ...first, bar: 3, beat: 3 }, clipboard), { error: 'space' })
})

test('converting notes to ornaments preserves their order and can attach across a barline', () => {
  const project = createProject('song')
  const track = project.tracks[0]
  track.bars[0] = [60, 62, 64, 65].map((midi) => ({ ...blank(), draft: false, notes: [{ midi }] }))
  track.bars[1] = [67, 69, 71].map((midi) => ({ ...blank(), draft: false, notes: [{ midi }] }))
  const first = { track: track.id, bar: 1, beat: 0 }
  const targets = selectedBeats(project, [first, { ...first, beat: 1 }])
  const after = convertNotesToGrace(project, targets, 'graceAfter')
  assert.ok('score' in after)
  assert.deepEqual(after.score.tracks[0].bars[0][3].graceAfter, [67, 69])
  assert.deepEqual(after.score.tracks[0].bars[1].map(({ notes }) => notes[0].midi), [71])
  assert.deepEqual(after.position, { ...first, bar: 0, beat: 3, note: undefined, string: undefined })
  parseProject(JSON.stringify(after.score))

  const before = convertNotesToGrace(project, targets, 'grace')
  assert.ok('score' in before)
  assert.deepEqual(before.score.tracks[0].bars[1][0].grace, [67, 69])
  assert.equal(before.position.beat, 0)
  assert.deepEqual(convertNotesToGrace(project, selectedBeats(project, [first, { ...first, beat: 2 }]), 'grace'), { error: 'selection' })
})

test('pasting two eighth notes over the final quarter stays in that measure without adding a rest', () => {
  const project = createProject('song')
  const track = project.tracks[0]
  track.bars[0] = [60, 62].map((midi) => ({ ...blank(8), draft: false, notes: [{ midi }] }))
  track.bars[3] = [67, 69, 71, 72].map((midi) => ({ ...blank(), draft: false, notes: [{ midi }] }))
  const first = { track: track.id, bar: 0, beat: 0 }
  const clip = copySelectedNotes(project, selectedBeats(project, [first, { ...first, beat: 1 }]), track)
  const result = pasteSelectedNotes(project, { ...first, bar: 3, beat: 3 }, clip)
  assert.ok('score' in result)
  const bar = result.score.tracks[0].bars[3]
  assert.deepEqual(beatList(result.score, bar, 3).map(({ notes, duration }) => [notes[0]?.midi, duration]),
    [[67, 4], [69, 4], [71, 4], [60, 8], [62, 8]])
  assert.deepEqual(result.positions.map(({ bar, beat }) => [bar, beat]), [[3, 3], [3, 4]])
})

test('pasting mixed note lengths advances by time even when a blank bar has unused slots', () => {
  const project = createProject('song')
  const track = project.tracks[0]
  const note = (duration: 2 | 4 | 8, midi: number) => ({ ...blank(duration), draft: false, notes: [{ midi }] })
  track.bars[0] = [note(2, 60), note(4, 62), note(4, 64)]
  track.bars[1] = [note(8, 65), note(8, 67)]
  const source = { track: track.id, bar: 0, beat: 0 }
  const targets = selectedBeats(project, [source, { ...source, beat: 1 }, { ...source, beat: 2 },
    { ...source, bar: 1 }, { ...source, bar: 1, beat: 1 }])
  const clip = copySelectedNotes(project, targets, track)
  const result = pasteSelectedNotes(project, { ...source, bar: 2 }, clip)
  assert.ok('score' in result)
  assert.deepEqual(result.positions.map(({ bar, beat }) => [bar, beat]), [[2, 0], [2, 1], [2, 2], [3, 0], [3, 1]])
  assert.deepEqual(result.score.tracks[0].bars.slice(2).map((bar) => bar.map(({ notes, duration }) => [notes[0]?.midi, duration])),
    [[[60, 2], [62, 4], [64, 4]], [[65, 8], [67, 8]]])
  assert.deepEqual(pasteSelectedNotes(project, { ...source, bar: 2, beat: 3 }, clip), { error: 'barline' })
  assert.deepEqual(track.bars[2], [])
})
