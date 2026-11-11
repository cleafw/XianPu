import assert from 'node:assert/strict'
import test from 'node:test'
import { changeKeySignature } from '../src/keyChange.ts'
import { blank, createProject, createTrack, parseProject } from '../src/model.ts'

test('changing the score key can retain pitches or transpose every pitched part', () => {
  const project = createProject('demo')
  const [numbered, guitar, staff] = project.tracks
  const drum = { ...createTrack(project, 'instrument'), mode: 'percussion' } as const
  drum.bars[0] = [{ ...blank(), notes: [{ midi: 38 }] }]
  project.tracks.push(drum)
  project.measures[2].key = 1
  staff.voices = [{ bars: project.measures.map(() => [{ ...blank(), notes: [{ midi: 48 }], grace: [47] }]) }]
  numbered.bars[0][0].chord = 'Cmaj7/E'

  const preserved = changeKeySignature(project, 2, 'pitch')
  assert.ok('score' in preserved)
  assert.equal(preserved.score.key, 2)
  assert.equal(preserved.score.measures[2].key, 1)
  assert.equal(preserved.score.tracks, project.tracks)

  const transposed = changeKeySignature(project, 2, 'numbered')
  assert.ok('score' in transposed)
  const score = parseProject(JSON.stringify(transposed.score))
  assert.equal(score.key, 2)
  assert.equal(score.measures[2].key, 3)
  assert.deepEqual(score.tracks[0].bars[0][0], {
    ...numbered.bars[0][0], notes: [{ midi: 62 }], chord: 'Dmaj7/F#',
  })
  assert.deepEqual(score.tracks[1].bars[0][0].diagram, guitar.bars[0][0].diagram!.map((fret) => fret < 0 ? fret : fret + 2))
  assert.deepEqual(score.tracks[2].voices![0].bars[0][0].grace, [49])
  assert.equal(score.tracks[2].voices![0].bars[0][0].notes[0].midi, 50)
  assert.deepEqual(score.tracks[3], drum)
})

test('a mid-score key change transposes only its section and can be removed', () => {
  const project = createProject('demo')
  project.measures[3].key = 1
  const result = changeKeySignature(project, 2, 'numbered', 1)
  assert.ok('score' in result)
  assert.equal(result.score.key, 0)
  assert.equal(result.score.measures[1].key, 2)
  assert.equal(result.score.measures[3].key, 1)
  const bars = result.score.tracks[0].bars
  assert.deepEqual(bars.slice(0, 4).map((bar) => bar[0].notes[0].midi), [60, 71, 62, 67])

  const removed = changeKeySignature(result.score, undefined, 'numbered', 1)
  assert.ok('score' in removed)
  assert.equal(JSON.stringify(removed.score), JSON.stringify(project))
})

test('guitar fingering can move strings and impossible transpositions leave the project intact', () => {
  const project = createProject('guitar')
  const guitar = project.tracks[0]
  guitar.bars[0] = [{ ...blank(), notes: [{ midi: 64, string: 1, fret: 0 }] }]
  const result = changeKeySignature(project, -7, 'numbered')
  assert.ok('score' in result)
  assert.deepEqual(result.score.tracks[0].bars[0][0].notes, [{ midi: 63, string: 2, fret: 4 }])
  guitar.bars[0][0].notes = [{ midi: 40, string: 6, fret: 0 }]
  assert.deepEqual(changeKeySignature(project, -7, 'numbered'), { error: 'guitar-range' })
  assert.equal(project.key, 0)
  assert.equal(guitar.bars[0][0].notes[0].midi, 40)

  const staff = createProject('ensemble')
  staff.tracks[2].bars[0] = [{ ...blank(), notes: [{ midi: 127 }] }]
  assert.deepEqual(changeKeySignature(staff, 2, 'numbered'), { error: 'pitch-range' })
})
