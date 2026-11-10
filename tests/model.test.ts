import assert from 'node:assert/strict'
import { test } from 'node:test'
import { beatList, blank, changeBeat, createProject, measureDifference, midiForDegree, parseProject, ticks } from '../src/model.ts'

test('demo round-trips with 8 complete measures per instrument', () => {
  const project = createProject('demo')
  assert.deepEqual(parseProject(JSON.stringify(project)), JSON.parse(JSON.stringify(project)))
  assert.equal(project.measures.length, 8)
  for (const track of project.tracks) {
    for (const index of project.measures.keys()) assert.equal(measureDifference(project, track, index), 0)
  }
  assert.equal(project.tracks[1].bars[0][0].notes.length, 3)
})

test('pickup, dotted notes and triplets keep consistent timing', () => {
  let project = createProject('song')
  project = { ...project, pickup: 1 }
  const voice = project.tracks[0]
  assert.equal(beatList(project, voice.bars[0], 0).length, 1)
  assert.equal(ticks({ ...blank(8), triplet: true }), 320)
  project = changeBeat(project, { track: voice.id, bar: 0, beat: 0 }, (beat) => ({ ...beat, duration: 8, dots: 1, draft: false }))
  assert.equal(measureDifference(project, project.tracks[0], 0), 240)
  assert.equal(measureDifference(project, project.tracks[1], 0), 960)
  assert.equal(beatList(project, project.tracks[0].bars[0], 0).reduce((sum, beat) => sum + ticks(beat), 0), 960)
})

test('fret and MIDI validation prevents broken tuning data', () => {
  const project = createProject('demo')
  project.tracks[1].bars[0][0].notes[0].midi = 0
  assert.throws(() => parseProject(JSON.stringify(project)), /数据损坏/)
  assert.throws(() => parseProject('{"version":2}'), /不受支持/)
})

test('numeric input maps against the selected tonic and octave', () => {
  assert.equal(midiForDegree(1, 0, 0, 0), 60)
  assert.equal(midiForDegree(3, 0, 1, -1), 75)
  assert.equal(midiForDegree(2, 2, 0, 0), 64)
})
