import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveScoreNavigation, type NavigationMeasure } from '../src/scoreNavigation.ts'

function expectOrder(measures: readonly NavigationMeasure[], bars: number[]) {
  const result = resolveScoreNavigation(measures)
  assert.deepEqual(result.diagnostics, [])
  assert.deepEqual(result.order.map(index => index + 1), bars)
  return result
}

function expectError(measures: readonly NavigationMeasure[], code: string, index: number, direction?: string) {
  const { order, diagnostics } = resolveScoreNavigation(measures)
  assert.deepEqual(order, [])
  assert.ok(diagnostics.some(item => item.code === code && item.measureIndex === index && item.direction === direction),
    JSON.stringify(diagnostics))
}

test('empty and unmarked scores play in written order', () => {
  expectOrder([], [])
  expectOrder([{}, {}, {}], [1, 2, 3])
})

test('legacy repeats keep implicit starts, the most recent explicit start, and total pass counts', () => {
  expectOrder([
    {}, { end: true }, {}, { end: true, repeatCount: 3 },
    { start: true }, { start: true }, { end: true }, { start: true },
  ], [1, 2, 1, 2, 3, 4, 3, 4, 3, 4, 5, 6, 7, 6, 7, 8])
  expectOrder([{ start: true, end: true, repeatCount: 8 }], [1, 1, 1, 1, 1, 1, 1, 1])
})

test('planning fixture plays first and second endings on their respective passes', () => {
  const { endingMasks } = expectOrder([
    {}, { start: true }, {}, { end: true, ending: { number: 1 } }, { ending: { number: 2 } }, {},
  ], [1, 2, 3, 4, 2, 3, 5, 6])
  assert.deepEqual(endingMasks, [0, 0, 0, 1, 2, 0])
})

test('ranged endings cover every bar and the next implicit repeat begins after the second ending', () => {
  const { endingMasks } = expectOrder([
    { start: true }, { ending: { number: 1, length: 2 } }, { end: true },
    { ending: { number: 2, length: 2 } }, {}, {}, { end: true },
  ], [1, 2, 3, 1, 4, 5, 6, 7, 6, 7])
  assert.deepEqual(endingMasks, [0, 1, 1, 2, 2, 0, 0])
})

test('a first ending can be followed by ordinary bars', () => {
  expectOrder([{}, { end: true, ending: { number: 1 } }, {}], [1, 2, 1, 3])
})

test('planning fixture follows D.S. al Coda and reports a removed Coda', () => {
  const measures: NavigationMeasure[] = [
    {}, { directions: ['segno'] }, { directions: ['toCoda'] }, {},
    { directions: ['dalSegnoAlCoda'] }, { directions: ['coda'] },
  ]
  expectOrder(measures, [1, 2, 3, 4, 5, 2, 3, 6])
  expectError(measures.slice(0, -1), 'missing-target', 4, 'coda')
})

test('D.C. al Fine includes the Fine bar on both passes and then stops', () => {
  expectOrder([{}, { directions: ['fine'] }, {}, { directions: ['daCapoAlFine'] }, {}], [1, 2, 3, 4, 1, 2])
})

test('D.S. al Fine can return directly to a bar with both Segno and Fine', () => {
  expectOrder([{}, { directions: ['segno', 'fine'] }, { directions: ['dalSegnoAlFine'] }], [1, 2, 3, 2])
})

test('D.C. al Coda resumes written repeats in the coda', () => {
  expectOrder([
    { directions: ['toCoda'] }, { directions: ['daCapoAlCoda'] }, {},
    { start: true, directions: ['coda'] }, { end: true },
  ], [1, 2, 1, 4, 5, 4, 5])
})

test('plain D.C. and D.S. jump once and leave Fine and To Coda inactive', () => {
  expectOrder([{ directions: ['fine'] }, { directions: ['daCapo'] }, {}], [1, 2, 1, 2, 3])
  expectOrder([
    {}, { directions: ['segno', 'toCoda'] }, { directions: ['dalSegno'] }, {}, { directions: ['coda'] },
  ], [1, 2, 3, 2, 3, 4, 5])
  expectOrder([{ directions: ['daCapo'] }], [1, 1])
})

test('the return skips repeat signs and takes the final ending', () => {
  expectOrder([
    { start: true, directions: ['segno'] }, { end: true, ending: { number: 1 } },
    { ending: { number: 2 }, directions: ['fine'] }, { directions: ['dalSegnoAlFine'] },
  ], [1, 2, 1, 3, 4, 1, 3])
})

test('a jump in a repeat executes on its final written visit', () => {
  expectOrder([
    { directions: ['fine'] }, { start: true }, { directions: ['daCapoAlFine'] }, { end: true, repeatCount: 3 },
  ], [1, 2, 3, 4, 2, 3, 4, 2, 3, 1])
  expectOrder([
    { directions: ['fine'] }, { start: true }, { end: true, directions: ['daCapoAlFine'] },
  ], [1, 2, 3, 2, 3, 1])
})

test('required targets are checked even before playback', () => {
  expectError([{ directions: ['dalSegno'] }], 'missing-target', 0, 'segno')
  expectError([{ directions: ['daCapoAlFine'] }], 'missing-target', 0, 'fine')
  expectError([{ directions: ['daCapoAlCoda'] }, { directions: ['coda'] }], 'missing-target', 0, 'toCoda')
  expectError([{ directions: ['toCoda'] }], 'missing-target', 0, 'coda')
})

test('duplicate targets and competing jumps are reported without choosing a route', () => {
  expectError([
    { directions: ['segno'] }, { directions: ['segno'] }, { directions: ['dalSegno'] },
  ], 'duplicate-target', 1, 'segno')
  expectError([
    { directions: ['toCoda'] }, { directions: ['daCapoAlCoda'] }, { directions: ['coda', 'coda'] },
  ], 'duplicate-target', 2, 'coda')
  expectError([{ directions: ['daCapo'] }, { directions: ['daCapo'] }], 'conflicting-jumps', 1, 'daCapo')
})

test('invalid ending lengths, overlaps and missing or incompatible repeat boundaries are reported', () => {
  for (const length of [0, -1, 1.5, 2, Infinity, NaN]) {
    expectError([{ end: true, ending: { number: 1, length } }], 'invalid-ending-range', 0)
  }
  expectError([
    { ending: { number: 1, length: 2 } }, { end: true, ending: { number: 2 } },
  ], 'invalid-ending-range', 1)
  expectError([{ ending: { number: 1 } }], 'invalid-ending-range', 0)
  expectError([{ ending: { number: 2 } }], 'invalid-ending-range', 0)
  expectError([{ end: true, repeatCount: 3, ending: { number: 1 } }], 'invalid-ending-range', 0)
  expectError([{ end: true, ending: { number: 1 } }, {}, { ending: { number: 2 } }], 'invalid-ending-range', 2)
  expectError([
    { end: true, ending: { number: 1 } }, { start: true, ending: { number: 2 } },
  ], 'invalid-ending-range', 1)
})

test('malformed counts and self-directed or unreachable routes stop with diagnostics', () => {
  for (const repeatCount of [0, 2.5, 9, Infinity, NaN]) {
    expectError([{ end: true, repeatCount }], 'invalid-repeat-count', 0)
  }
  expectError([{ directions: ['segno', 'dalSegno'] }], 'unreachable-target', 0, 'segno')
  expectError([{ directions: ['daCapoAlFine'] }, { directions: ['fine'] }], 'unreachable-target', 1, 'fine')
  expectError([
    { directions: ['coda'] }, { directions: ['toCoda'] }, { directions: ['daCapoAlCoda'] },
  ], 'unreachable-target', 0, 'coda')
  expectError([
    {}, { end: true, ending: { number: 1 }, directions: ['fine'] }, { directions: ['daCapoAlFine'] },
  ], 'unreachable-target', 1, 'fine')
  expectError([
    {}, { end: true, ending: { number: 1 }, directions: ['daCapo'] },
  ], 'invalid-jump', 1, 'daCapo')
})
