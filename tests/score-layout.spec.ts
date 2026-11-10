import { expect, test } from '@playwright/test'

test('renders combined notation, grand staff, clefs, concert-pitch transposition and part system breaks', async ({ page }) => {
  await page.goto('/')
  const rendered = await page.evaluate(async () => {
    const { blank, createProject, createTrack, parseProject } = await import('/src/model.ts') as typeof import('../src/model')
    const { buildScore, drawScore, scoreSettings } = await import('/src/score.ts') as typeof import('../src/score')
    const project = createProject('ensemble')
    const piano = createTrack(project, 'instrument', 'Piano')
    project.tracks[1] = piano
    const [melody, , alto] = project.tracks
    const beat = (...pitches: number[]) => ({ ...blank(), draft: false, notes: pitches.map((midi) => ({ midi })) })
    melody.mode = 'staff-numbered'
    melody.transpose = 2
    melody.clef = 'bass'
    melody.bars[0] = [beat(60)]
    piano.mode = 'piano'
    piano.bars[0] = [beat(48, 64)]
    alto.clef = 'alto'
    alto.voices = [{ bars: [[beat(55)], [], [], []] }]
    alto.bars[0] = [beat(67)]
    project.layout.systemBreaks = [1]
    melody.layout = { ...melody.layout, mode: 'staff', pageBreaks: [2] }
    const render = async (part: string | null) => {
      const element = document.body.appendChild(document.createElement('div'))
      const api = await new Promise<ReturnType<typeof drawScore>>((resolve, reject) => {
        const loaded = parseProject(JSON.stringify(project))
        const drawing = drawScore(element, loaded, part, 1, 'en', () => queueMicrotask(() => resolve(drawing)), reject)
      })
      const bounds = api.boundsLookup!
      const firstBar = bounds.findMasterBarByIndex(0)!
      const result = {
        starts: bounds.staffSystems.map((system) => system.bars[0].index),
        staffs: firstBar.bars.map(({ bar }) => [bar.staff.track.index, bar.staff.index]),
      }
      api.destroy()
      element.remove()
      return result
    }
    const { score } = buildScore(project, null, scoreSettings(), 'en')
    const writtenBar = score.tracks[0].staves[0].bars[0]
    const note = writtenBar.voices[0].beats[0].notes[0]
    const grandStaff = score.tracks[1].staves.map((staff) => ({
      clef: staff.bars[0].clef,
      pitches: staff.bars[0].voices[0].beats[0].notes.map((note) => note.realValue),
    }))
    piano.voices = [{ staff: 1, bars: [[beat(40)], [], [], []] }]
    const explicit = buildScore(project, null, scoreSettings(), 'en').score.tracks[1].staves.map((staff) =>
      staff.bars[0].voices.map((voice) => voice.beats[0].notes.map((note) => note.realValue)))
    delete piano.voices
    return {
      written: [writtenBar.clef, writtenBar.keySignature, note.displayValue, note.realValue],
      grandStaff,
      explicit,
      alto: score.tracks[2].staves[0].bars[0].clef,
      voices: score.tracks[2].staves[0].bars[0].voices.map((voice) => voice.beats[0].notes[0].realValue),
      unusedVoiceHidden: score.tracks[2].staves[0].bars[1].voices[1].isEmpty,
      full: await render(null),
      part: await render(melody.id),
    }
  })
  expect(rendered.written).toEqual([3, 2, 62, 60])
  expect(rendered.grandStaff).toEqual([{ clef: 4, pitches: [64] }, { clef: 3, pitches: [48] }])
  expect(rendered.explicit).toEqual([[[48, 64]], [[40]]])
  expect(rendered.alto).toBe(1)
  expect(rendered.voices).toEqual([67, 55])
  expect(rendered.unusedVoiceHidden).toBe(true)
  expect(rendered.full).toEqual({ starts: [0, 1], staffs: [[0, 0], [0, 0], [1, 0], [1, 1], [2, 0]] })
  expect(rendered.part).toEqual({ starts: [0, 2], staffs: [[0, 0]] })
})

test('the MIDI sequencer follows endings and D.S. al Coda in total and part audition', async ({ page }) => {
  await page.goto('/')
  const emitted = await page.evaluate(async () => {
    const { createProject, blank } = await import('/src/model.ts') as typeof import('../src/model')
    const { buildPlaybackMidi } = await import('/src/playback.ts') as typeof import('../src/playback')
    const score = createProject('demo')
    score.measures = [{}, { start: true }, {}, { end: true, ending: { number: 1 } }, { ending: { number: 2 } }, {}]
    score.tracks = score.tracks.filter(({ kind }) => kind !== 'guitar')
    score.tracks.forEach((track, part) => { track.bars = score.measures.map((_, i) => [
      { ...blank(1), draft: false, notes: [{ midi: 60 + i + part * 12 }] },
    ]) })
    const keys = (part: string | null) => buildPlaybackMidi(score, part).events.flatMap((event) =>
      'noteKey' in event && 'noteVelocity' in event && event.noteVelocity > 0 ? [event.noteKey] : [])
    const endings = keys(null)
    score.measures = [{}, { directions: ['segno'] }, { directions: ['toCoda'] }, {},
      { directions: ['dalSegnoAlCoda'] }, { directions: ['coda'] }]
    return { endings, jump: keys(score.tracks[0].id) }
  })
  expect(emitted.endings).toEqual([60, 72, 61, 73, 62, 74, 63, 75, 61, 73, 62, 74, 64, 76, 65, 77])
  expect(emitted.jump).toEqual([60, 61, 62, 63, 64, 61, 62, 65])
})

test('maps percussion, navigation, simile and verse lines into native notation', async ({ page }) => {
  await page.goto('/')
  const engraving = await page.evaluate(async () => {
    const { createProject } = await import('/src/model.ts') as typeof import('../src/model')
    const { buildScore, drawScore, scoreSettings } = await import('/src/score.ts') as typeof import('../src/score')
    const project = createProject('demo')
    const [melody, , drums] = project.tracks
    drums.mode = 'percussion'
    drums.bars[0][0].notes = [{ midi: 42 }, { midi: 20 }]
    melody.bars[0][0].verses = ['verse one', 'verse two']
    project.measures[0] = { start: true, rehearsal: 'A', directions: ['segno'] }
    project.measures[1] = { barline: 'double' }
    project.measures[2] = { simile: 'single' }
    project.measures[3] = { end: true, ending: { number: 1 } }
    project.measures[4] = { ending: { number: 2 } }
    project.measures[5] = { simile: 'double' }
    project.measures[6] = { simile: 'double-second', barline: 'final' }
    const { score } = buildScore(project, null, scoreSettings(), 'en')
    const drumStaff = score.tracks[2].staves[0]
    const melodyBars = score.tracks[0].staves[0].bars
    const element = document.body.appendChild(document.createElement('div'))
    const api = await new Promise<ReturnType<typeof drawScore>>((resolve, reject) => {
      const drawing = drawScore(element, project, null, 1, 'en', () => queueMicrotask(() => resolve(drawing)), reject)
    })
    const text = element.textContent ?? ''
    api.destroy()
    element.remove()
    return {
      percussion: drumStaff.isPercussion,
      clef: drumStaff.bars[0].clef,
      drumKeys: drumStaff.bars[0].voices[0].beats[0].notes.map((note) => note.percussionArticulation),
      endings: score.masterBars.map((bar) => bar.alternateEndings),
      directions: [...score.masterBars[0].directions!],
      rehearsal: score.masterBars[0].section?.marker,
      barlines: [melodyBars[1].barLineRight, melodyBars[6].barLineRight],
      similes: melodyBars.map((bar) => bar.simileMark),
      lyrics: melodyBars[0].voices[0].beats[0].lyrics,
      text,
    }
  })
  expect(engraving).toMatchObject({
    percussion: true, clef: 0, drumKeys: [42, 36], endings: [0, 0, 0, 1, 2, 0, 0, 0],
    directions: [1], rehearsal: 'A', barlines: [7, 6], similes: [0, 0, 1, 0, 0, 2, 3, 0],
    lyrics: ['晚', 'verse one', 'verse two'],
  })
  expect(engraving.text).toContain('[A]')
  expect(engraving.text).toContain('verse two')
  expect(engraving.text).toContain('\ue500') // SMuFL Repeat1Bar
  expect(engraving.text).toContain('\ue501') // SMuFL Repeat2Bars
})
