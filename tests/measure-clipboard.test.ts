import assert from 'node:assert/strict'
import { test } from 'node:test'
import { copyMeasures, pasteMeasures } from '../src/measureClipboard.ts'
import { createProject, parseProject } from '../src/model.ts'

test('copying a range remaps both endpoints, preserves the source, and drops partial spans', () => {
  const project = createProject('demo')
  const track = project.tracks[0]
  track.bars[1][0].spans = [{ id: 'span', kind: 'crescendo', end: false }]
  track.bars[3][0].spans = [{ id: 'span', kind: 'crescendo', end: true }]
  assert.equal(copyMeasures(project, [1, 3], track.id, false).omittedLink, true)
  const copied = copyMeasures(project, [1, 2, 3], track.id, false)
  const result = pasteMeasures(project, copied, track.id, 'overwrite', [], 5)
  assert.ok('score' in result && result.score)
  const after = parseProject(JSON.stringify(result.score))
  const bars = after.tracks[0].bars
  assert.equal(bars[1][0].spans?.[0].id, 'span')
  assert.notEqual(bars[5][0].spans?.[0].id, 'span')
  assert.equal(bars[5][0].spans?.[0].id, bars[7][0].spans?.[0].id)
  assert.equal(bars[7][0].spans?.[0].end, true)
})

test('inserting a voice range keeps all other voices aligned and moves independent page breaks', () => {
  const project = createProject('demo')
  const track = project.tracks[0]
  track.voices = [{ staff: 1, bars: track.bars.map((bar) => bar.slice(0, 1)) }]
  track.layout.pageBreaks = [4]
  project.layout.systemBreaks = [3]
  const copied = copyMeasures(project, [1, 2], track.id, false, 1)
  const result = pasteMeasures(project, copied, track.id, 'before', [], 3, false, 1)
  assert.ok('score' in result && result.score)
  const after = parseProject(JSON.stringify(result.score))
  assert.deepEqual(after.tracks[0].bars.slice(3, 5), [[], []])
  assert.equal(after.tracks[0].voices?.[0].bars[3][0].notes[0].midi, track.bars[1][0].notes[0].midi)
  assert.deepEqual(after.tracks[0].layout.pageBreaks, [6])
  assert.deepEqual(after.layout.systemBreaks, [5])
  assert.ok(after.tracks.every((item) => item.bars.length === 10))
})
