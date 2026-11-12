import assert from 'node:assert/strict'
import { test } from 'node:test'
import { beatList, blank, changeBeat, changeMeasures, createProject, measureDifference, measureSettings, midiForDegree, parseProject, ticks } from '../src/model.ts'

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

test('batch measure edits shift structure, keep surviving settings, and remove dangling links', () => {
  const project = createProject('demo')
  const track = project.tracks[0]
  track.voices = [{ bars: track.bars.map(() => []) }]
  project.intro = [2, 6, 960, 1920]
  project.layout.pageBreaks = [2, 3, 6]
  project.layout.hiddenLabels = { key: [2, 5] }
  track.layout.systemBreaks = [3, 6]
  project.measures[2] = { ending: { number: 1, length: 5 }, meter: [3, 4], key: 2, bpm: 110 }
  project.measures[3] = { simile: 'double' }
  project.measures[4] = { simile: 'double-second' }
  track.bars[1].at(-1)!.slur = true
  track.bars[4][0].tie = true
  track.bars[2][0].spans = [{ id: 'span', kind: 'crescendo', end: false }]
  track.bars[6][0].spans = [{ id: 'span', kind: 'crescendo', end: true }]
  assert.equal(changeMeasures(project, 4, 2), project)
  assert.equal(changeMeasures(project, 0, -8), project)

  const inserted = changeMeasures(project, 3, 2)
  assert.equal(inserted.measures.length, 10)
  assert.equal(inserted.measures[2].ending?.length, 7)
  assert.deepEqual(inserted.intro, [2, 8, 960, 1920])
  assert.deepEqual(inserted.layout.pageBreaks, [2, 5, 8])
  for (const item of inserted.tracks) assert.deepEqual(item.bars.slice(3, 5), [[], []])
  assert.equal(inserted.tracks[0].voices?.[0].bars.length, 10)

  const deleted = changeMeasures(project, 2, -2)
  assert.equal(deleted.measures.length, 6)
  assert.deepEqual(deleted.measures[2].ending, { number: 1, length: 3 })
  assert.equal(deleted.measures[2].simile, undefined)
  assert.deepEqual(deleted.intro, [2, 4, null, 1920])
  assert.deepEqual(deleted.layout.pageBreaks, [4])
  assert.deepEqual(deleted.layout.hiddenLabels?.key, [3])
  assert.deepEqual(deleted.tracks[0].layout.systemBreaks, [4])
  assert.deepEqual(measureSettings(deleted, 2), measureSettings(project, 4))
  assert.equal(deleted.tracks[0].bars[1].at(-1)?.slur, false)
  assert.equal(deleted.tracks[0].bars[2][0].tie, false)
  assert.deepEqual(deleted.tracks[0].bars[4][0].spans, [])
  assert.equal(deleted.tracks[0].voices?.[0].bars.length, 6)
  parseProject(JSON.stringify(deleted))
})
