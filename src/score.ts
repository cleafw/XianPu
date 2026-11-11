import { AlphaTabApi, FontFileFormat, model, NotationElement, Settings, SystemsLayoutMode } from '@coderline/alphatab'
import { translate, type Language } from './i18n'
import { engraveMarks, markSpace } from './engraveMarks'
import { createScoreWatermark } from './scoreWatermark'
import bravura from '@coderline/alphatab/font/Bravura.woff2?url'
import { beatList, guitarTuning, measureSettings, writtenKey, type Beat, type Project } from './model'
import { resolveScoreNavigation, type NavigationDirection } from './scoreNavigation'
import { alignBarColumns, enableScoreRendering, spaceTrackMarks } from './scoreRendering'

export function scoreSettings() {
  const settings = new Settings()
  settings.core.useWorkers = false
  settings.core.enableLazyLoading = false
  settings.core.includeNoteBounds = true
  settings.core.fontDirectory = bravura.slice(0, bravura.lastIndexOf('/') + 1)
  settings.core.smuflFontSources = new Map([[FontFileFormat.Woff2, bravura]])
  settings.display.systemsLayoutMode = SystemsLayoutMode.UseModelLayout
  settings.notation.elements.set(NotationElement.EffectDynamics, false)
  settings.notation.elements.set(NotationElement.EffectNumberedNotationKeySignature, false)
  settings.display.notationStaffPaddingBottom = 12
  const lyrics = settings.display.resources.elementFonts.get(NotationElement.EffectLyrics)!
  lyrics.families = ['XianPuLyrics', 'Microsoft YaHei UI', 'Microsoft YaHei', 'sans-serif']
  lyrics.style = model.FontStyle.Plain
  return settings
}

const directions = {
  segno: model.Direction.TargetSegno,
  coda: model.Direction.TargetCoda,
  fine: model.Direction.TargetFine,
  toCoda: model.Direction.JumpDaCoda,
  daCapo: model.Direction.JumpDaCapo,
  daCapoAlCoda: model.Direction.JumpDaCapoAlCoda,
  daCapoAlFine: model.Direction.JumpDaCapoAlFine,
  dalSegno: model.Direction.JumpDalSegno,
  dalSegnoAlCoda: model.Direction.JumpDalSegnoAlCoda,
  dalSegnoAlFine: model.Direction.JumpDalSegnoAlFine,
} satisfies Record<NavigationDirection, model.Direction>

const sourceIndexes = new WeakMap<model.Beat, { index: number; data?: Beat }>()
const sourceNotes = new WeakMap<model.Note, number>()
export const scoreNoteIndex = (note: model.Note) => sourceNotes.get(note) ?? note.index
export function scoreBeatIndex(beat: model.Beat) {
  return sourceIndexes.get(beat)?.index ?? beat.index
}
function addScoreBeat(voice: model.Voice, data: Beat, legacyLyrics: boolean, index: number, original: Beat) {
  const { bar } = voice
  const { staff } = bar
  const priorBeat = voice.beats.findLast((beat) => !beat.graceType) ?? staff.bars[bar.index - 1]?.voices[voice.index]?.beats.findLast((beat) => !beat.graceType)
  if (data.notes.length && !staff.isPercussion) {
    for (const pitch of data.grace ?? []) {
      const grace = new model.Beat()
      grace.duration = model.Duration.Eighth
      grace.graceType = model.GraceType.BeforeBeat
      const note = new model.Note()
      if (staff.isStringed) {
        const string = staff.tuning.findIndex((open) => pitch >= open + staff.capo && pitch - open - staff.capo <= 36)
        if (string < 0) continue
        note.string = staff.tuning.length - string
        note.fret = pitch - staff.tuning[string] - staff.capo
      } else {
        note.octave = Math.floor(pitch / 12)
        note.tone = pitch % 12
      }
      grace.addNote(note)
      sourceIndexes.set(grace, { index })
      voice.addBeat(grace)
    }
  }
  const beat = new model.Beat()
  sourceIndexes.set(beat, { index, data })
  beat.duration = data.duration
  beat.dots = data.dots
  if (data.tuplet || data.triplet) {
    const [actual, normal] = data.tuplet ?? [3, 2]
    beat.tupletNumerator = actual
    beat.tupletDenominator = normal
  }
  if (data.lyric || data.verses?.some(Boolean)) {
    beat.lyrics = [...(legacyLyrics ? [data.lyric ?? ''] : []), ...(data.verses ?? [])]
  }
  beat.isLegatoOrigin = Boolean(data.slur)
  voice.addBeat(beat)
  if (data.chord || data.diagram) {
    const chord = new model.Chord()
    chord.name = data.chord ?? ''
    chord.showName = !!data.chord
    chord.showDiagram = !!data.diagram
    chord.showFingering = false
    if (data.diagram) {
      chord.strings = data.diagram
      chord.firstFret = Math.max(1, Math.min(...data.diagram.filter((fret) => fret > 0), 24))
    }
    const id = `${bar.index}:${voice.index}:${beat.index}`
    staff.addChord(id, chord)
    beat.chordId = id
  }
  const orderedNotes = staff.showNumbered && data.notes.length > 1 ? [...data.notes].sort((a, b) => a.midi - b.midi) : data.notes
  for (const tone of orderedNotes) {
    const note = new model.Note()
    if (staff.isPercussion) {
      // Match the app's drum playback fallback for notes outside the GM kit.
      note.percussionArticulation = tone.midi >= 35 && tone.midi <= 81 ? tone.midi : 36
    } else if (tone.string && staff.isStringed) {
      note.string = staff.tuning.length + 1 - tone.string
      note.fret = tone.fret!
    } else {
      note.octave = Math.floor(tone.midi / 12)
      note.tone = tone.midi % 12
    }
    sourceNotes.set(note, original.notes.indexOf(tone))
    if (tone.slide) note.slideOutType = model.SlideOutType.Shift
    if (tone.bend) {
      note.addBendPoint(new model.BendPoint(0, 0))
      note.addBendPoint(new model.BendPoint(60, 2))
    }
    beat.addNote(note)
    note.isTieDestination = Boolean(data.tie && priorBeat?.notes.some((other) =>
      other.string === note.string && other.realValue === note.realValue))
  }
}

function pianoBeat(data: Beat, lower: boolean): Beat {
  const notes = data.notes.filter((tone) => (tone.midi < 60) === lower)
  if (!lower) return { ...data, notes }
  // Both hands retain the beat's timing. Beat-level lyrics and chords belong to the upper stream.
  const { duration, dots, triplet, tuplet, tie, slur } = data
  return { duration, dots, triplet, tuplet, tie, slur, notes }
}

function simileMark(measures: Project['measures'], index: number) {
  const { simile } = measures[index]
  if (simile === 'single' && index > 0) return model.SimileMark.Simple
  if (simile === 'double' && index > 1 && measures[index + 1]?.simile === 'double-second') return model.SimileMark.FirstOfDouble
  if (simile === 'double-second' && index > 2 && measures[index - 1].simile === 'double') return model.SimileMark.SecondOfDouble
  return model.SimileMark.None
}

export function buildScore(project: Project, part: string | null, settings: Settings, language: Language) {
  const score = new model.Score()
  score.title = project.title
  score.subTitle = project.credits?.subtitle ?? ''
  score.words = project.credits?.lyricist ?? ''
  score.music = project.credits?.composer ?? ''
  score.artist = [
    project.author,
    project.credits?.arranger ? translate(language, '编曲：{name}', { name: project.credits.arranger }) : '',
    project.credits?.engraver ? translate(language, '制谱：{name}', { name: project.credits.engraver }) : '',
  ].filter(Boolean).join('  ·  ')
  const tracks = project.tracks.filter((track) => !part || track.id === part)
  const currentLayout = part ? tracks[0]?.layout ?? project.layout : project.layout
  const breaks = new Set([...(currentLayout.systemBreaks ?? []), ...(currentLayout.pageBreaks ?? [])])
  score.defaultSystemsLayout = currentLayout.barsPerLine
  const { endingMasks } = resolveScoreNavigation(project.measures)
  const simileMarks = project.measures.map((_, index) => simileMark(project.measures, index))
  for (const [index, measure] of project.measures.entries()) {
    const master = new model.MasterBar()
    const { meter, bpm } = measureSettings(project, index)
    master.timeSignatureNumerator = meter[0]
    master.timeSignatureDenominator = meter[1]
    master.isAnacrusis = index === 0 && project.pickup > 0
    master.isRepeatStart = Boolean(measure.start)
    master.repeatCount = measure.end ? measure.repeatCount ?? 2 : 0
    master.alternateEndings = endingMasks[index]
    for (const direction of measure.directions ?? []) master.addDirection(directions[direction])
    if (measure.rehearsal) {
      master.section = new model.Section()
      master.section.marker = measure.rehearsal
    }
    if (!index || measure.bpm !== undefined) {
      master.tempoAutomations.push(model.Automation.buildTempoAutomation(false, 0, bpm, 2, !currentLayout.hiddenLabels?.tempo?.includes(index)))
    }
    score.addMasterBar(master)
  }
  for (const track of tracks) {
    const target = new model.Track()
    target.name = track.name + (track.scoreNote ? ' · ' + track.scoreNote : '')
    target.shortName = track.name
    target.defaultSystemsLayout = currentLayout.barsPerLine
    const mode = part ? track.layout.mode ?? track.mode : track.mode
    const piano = mode === 'piano'
    const percussion = mode === 'percussion'
    const transpose = percussion ? 0 : track.transpose ?? 0
    const voices = track.voices ?? []
    const split = piano && !voices.some((voice) => voice.staff === 1)
    const clef = track.clef === 'bass' ? model.Clef.F4 : track.clef === 'alto' ? model.Clef.C3 : model.Clef.G2
    if (percussion) {
      target.playbackInfo.primaryChannel = 9
      target.playbackInfo.secondaryChannel = 9
    }
    for (const index of breaks) {
      if (index > 0 && index < project.measures.length && simileMarks[index] !== model.SimileMark.SecondOfDouble) target.addLineBreaks(index)
    }
    score.addTrack(target)
    for (let staffIndex = 0; staffIndex < (piano ? 2 : 1); staffIndex++) {
      const lower = staffIndex === 1
      const staff = new model.Staff()
      staff.isPercussion = percussion
      staff.showNumbered = mode === 'numbered' || mode === 'staff-numbered'
      staff.showStandardNotation = mode !== 'numbered' && mode !== 'tab'
      staff.showTablature = mode === 'tab' || mode === 'staff-tab'
      staff.displayTranspositionPitch = -transpose
      if (track.tuning.length && !piano && !percussion) {
        staff.capo = track.capo ?? 0
        const openStrings = track.tuning.map((pitch) => pitch - staff.capo)
        const standard = guitarTuning.every((pitch, i) => pitch === openStrings[i])
        staff.stringTuning = new model.Tuning(translate(language, standard ? '标准定弦' : '自定义定弦'), openStrings, standard)
      }
      target.addStaff(staff)
      const streams = voices.filter((voice) => !piano || (voice.staff ?? 0) === staffIndex).map((voice) => voice.bars)
      if (!lower || split) streams.unshift(track.bars)
      const legacyLyrics = streams.map((stream) => stream.some((bar) => bar.some((beat) => beat.lyric)))
      for (const [barIndex, measure] of project.measures.entries()) {
        const bar = new model.Bar()
        bar.clef = percussion ? model.Clef.Neutral : lower ? model.Clef.F4 : piano ? model.Clef.G2 : clef
        bar.keySignature = percussion ? model.KeySignature.C : writtenKey(measureSettings(project, barIndex).key, transpose)
        bar.simileMark = simileMarks[barIndex]
        if (measure.barline && !measure.end) {
          bar.barLineRight = measure.barline === 'double' ? model.BarLineStyle.LightLight : model.BarLineStyle.LightHeavy
        }
        staff.addBar(bar)
        for (const [voiceIndex, stream] of streams.entries()) {
          const voice = new model.Voice()
          bar.addVoice(voice)
          const source = stream[barIndex] ?? []
          if (bar.simileMark !== model.SimileMark.None || (voiceIndex > 0 && source.every((beat) => beat.draft))) {
            const beat = new model.Beat()
            beat.isEmpty = true
            voice.addBeat(beat)
            continue
          }
          for (const [index, data] of beatList(project, source, barIndex).entries()) {
            addScoreBeat(voice, split && voiceIndex === 0 ? pianoBeat(data, lower) : data, legacyLyrics[voiceIndex], index, data)
          }
        }
      }
    }
  }
  score.finish(settings)
  return { score, tracks }
}

export function drawScore(element: HTMLElement, project: Project, part: string | null, scale: number, language: Language,
  onReady?: () => void, onError?: (error: Error) => void, print = false) {
  const settings = scoreSettings()
  settings.display.scale = scale
  const { score, tracks } = buildScore(project, part, settings, language)
  const layout = part ? tracks[0].layout : project.layout
  const gap = part ? 0 : project.layout.trackGap ?? settings.display.trackStaffPaddingBetween
  settings.display.trackStaffPaddingBetween = Math.max(0, gap)
  if (print && part && !project.intro && tracks[0]?.layout.compressRests && !tracks[0].layout.pageBreaks?.length && !tracks[0].layout.systemBreaks?.length && !project.measures.some((measure) => measure.simile || measure.rehearsal || measure.directions?.length) &&
    ![tracks[0].bars, ...tracks[0].voices?.map((voice) => voice.bars) ?? []].some((bars) =>
      bars.some((bar) => bar.some((beat) => !beat.notes.length && (beat.marks?.length || beat.spans?.length || beat.lyric || beat.verses?.some(Boolean) || beat.chord || beat.diagram))))) {
    score.stylesheet.perTrackMultiBarRest = new Set([0])
  }
  const api = new AlphaTabApi(element, settings)
  enableScoreRendering(score, project.intro, layout.hiddenLabels?.key)
  const keyLayout = layout.numberedKey ?? project.layout.numberedKey
  const captionTrack = score.tracks.findIndex((track) => track.staves.some((staff) => staff.showNumbered))
  const captionStaff = score.tracks[captionTrack]?.staves.find((staff) => staff.showNumbered)
  const captionKeys = new Map<number, number>()
  if (!keyLayout?.hidden && captionStaff) {
    let previous: number | undefined
    for (const bar of captionStaff.bars) {
      const key = part ? bar.keySignature : measureSettings(project, bar.index).key
      if (key !== previous && !layout.hiddenLabels?.key?.includes(bar.index)) captionKeys.set(bar.index, key)
      previous = key
    }
  }
  spaceTrackMarks(api, tracks.map(markSpace), {
    track: captionTrack, bars: captionKeys, extra: Math.max(18, 24 - (keyLayout?.y ?? 0)),
  }, gap)
  if (!score.stylesheet.perTrackMultiBarRest?.size) {
    alignBarColumns(api, (part ? tracks[0]?.layout ?? project.layout : project.layout).barsPerLine)
  }
  api.error.on((error) => onError?.(error instanceof Error ? error : new Error(String(error))))
  api.postRenderFinished.on(() => {
    const footer = element.querySelector('.at-surface > div:last-child > svg')
    // Leave alphaTab's layout placeholder in place for subsequent resizes.
    if (footer?.textContent?.trim() === 'rendered by alphaTab') footer.remove()
    engraveMarks(element, api.boundsLookup, scale, (beat) => sourceIndexes.get(beat)?.data, project.intro, captionKeys, keyLayout)
    if (!print) {
      element.querySelector(':scope > .score-watermark')?.remove()
      const watermark = createScoreWatermark(project)
      if (watermark) element.append(watermark)
    }
    onReady?.()
  })
  api.renderScore(score, score.tracks.map((track) => track.index))
  return api
}
