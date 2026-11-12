import assert from 'node:assert/strict'
import test from 'node:test'
import { blank, createProject, parseProject } from '../src/model.ts'
import { copySelectedNotes, editRhythmSelection, pasteSelectedNotes, selectedBeats, shiftSelectedPitches, steppedRhythm } from '../src/noteSelection.ts'

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

test('note clipboard remaps complete spans and covers positions across a barline', () => {
  const project = createProject('song')
  const track = project.tracks[0]
  track.bars[0] = [60, 62, 64, 65].map((midi) => ({ ...blank(), draft: false, notes: [{ midi }] }))
  track.bars[0][0].spans = [{ id: 'hairpin', kind: 'crescendo', end: false }]
  track.bars[0][1].spans = [{ id: 'hairpin', kind: 'crescendo', end: true }]
  const first = { track: track.id, bar: 0, beat: 0 }
  const clipboard = copySelectedNotes(selectedBeats(project, [first, { ...first, beat: 1 }]), track)
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
