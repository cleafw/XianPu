import { AlphaTabApi, FontFileFormat, model, NotationElement, Settings, SystemsLayoutMode } from '@coderline/alphatab'
import { translate, type Language } from './i18n'
import bravura from '@coderline/alphatab/font/Bravura.woff2?url'
import { beatList, guitarTuning, type Project } from './model'

export function scoreSettings() {
  const settings = new Settings()
  settings.core.useWorkers = false
  settings.core.enableLazyLoading = false
  settings.core.includeNoteBounds = true
  settings.core.fontDirectory = bravura.slice(0, bravura.lastIndexOf('/') + 1)
  settings.core.smuflFontSources = new Map([[FontFileFormat.Woff2, bravura]])
  settings.display.systemsLayoutMode = SystemsLayoutMode.UseModelLayout
  settings.notation.elements.set(NotationElement.EffectDynamics, false)
  settings.display.notationStaffPaddingBottom = 12
  const lyrics = settings.display.resources.elementFonts.get(NotationElement.EffectLyrics)!
  lyrics.families = ['XianPuLyrics', 'Microsoft YaHei UI', 'Microsoft YaHei', 'sans-serif']
  lyrics.style = model.FontStyle.Plain
  return settings
}

export function buildScore(project: Project, part: string | null, settings: Settings, language: Language) {
  const score = new model.Score()
  score.title = project.title
  score.artist = project.author
  const tracks = project.tracks.filter((track) => !part || track.id === part)
  const currentLayout = part ? tracks[0].layout : project.layout
  score.defaultSystemsLayout = currentLayout.barsPerLine
  for (let index = 0; index < project.measures.length; index++) {
    const master = new model.MasterBar()
    master.timeSignatureNumerator = project.meter[0]
    master.timeSignatureDenominator = project.meter[1]
    master.isAnacrusis = index === 0 && project.pickup > 0
    master.isRepeatStart = Boolean(project.measures[index].start)
    master.repeatCount = project.measures[index].end ? 2 : 0
    if (!index) master.tempoAutomations.push(model.Automation.buildTempoAutomation(false, 0, project.bpm, 2))
    score.addMasterBar(master)
  }
  for (const track of tracks) {
    const target = new model.Track()
    target.name = track.name
    target.shortName = track.name
    target.defaultSystemsLayout = currentLayout.barsPerLine
    const staff = new model.Staff()
    const mode = part ? track.layout.mode ?? track.mode : track.mode
    staff.showNumbered = mode === 'numbered'
    staff.showStandardNotation = mode === 'staff' || mode === 'staff-tab'
    staff.showTablature = mode === 'tab' || mode === 'staff-tab'
    if (track.tuning.length) {
      const standard = guitarTuning.every((pitch, i) => pitch === track.tuning[i])
      staff.stringTuning = new model.Tuning(translate(language, standard ? '标准定弦' : '自定义定弦'), track.tuning, standard)
    }
    target.addStaff(staff)
    score.addTrack(target)
    for (const [barIndex, data] of track.bars.entries()) {
      const bar = new model.Bar()
      bar.keySignature = project.key
      staff.addBar(bar)
      const voice = new model.Voice()
      bar.addVoice(voice)
      for (const [index, dataBeat] of beatList(project, data, barIndex).entries()) {
        const beat = new model.Beat()
        beat.duration = dataBeat.duration
        beat.dots = dataBeat.dots
        if (dataBeat.triplet) {
          beat.tupletNumerator = 3
          beat.tupletDenominator = 2
        }
        if (dataBeat.lyric) beat.lyrics = [dataBeat.lyric]
        beat.isLegatoOrigin = Boolean(dataBeat.slur)
        voice.addBeat(beat)
        if (dataBeat.chord || dataBeat.diagram) {
          const chord = new model.Chord()
          chord.name = dataBeat.chord ?? ''
          chord.showName = !!dataBeat.chord
          chord.showDiagram = !!dataBeat.diagram
          chord.showFingering = false
          if (dataBeat.diagram) {
            chord.strings = dataBeat.diagram
            chord.firstFret = Math.max(1, Math.min(...dataBeat.diagram.filter((fret) => fret > 0), 24))
          }
          const id = track.id + ':' + barIndex + ':' + index
          staff.addChord(id, chord)
          beat.chordId = id
        }
        for (const tone of dataBeat.notes) {
          const note = new model.Note()
          if (tone.string) {
            note.string = 7 - tone.string
            note.fret = tone.fret!
          } else {
            note.octave = Math.floor(tone.midi / 12)
            note.tone = tone.midi % 12
          }
          note.isTieDestination = Boolean(dataBeat.tie)
          if (tone.slide) note.slideOutType = model.SlideOutType.Shift
          if (tone.bend) {
            note.addBendPoint(new model.BendPoint(0, 0))
            note.addBendPoint(new model.BendPoint(60, 2))
          }
          beat.addNote(note)
        }
      }
    }
  }
  score.finish(settings)
  return { score, tracks }
}

export function drawScore(element: HTMLElement, project: Project, part: string | null, scale: number, language: Language,
  onReady?: () => void, onError?: (error: Error) => void) {
  const settings = scoreSettings()
  settings.display.scale = scale
  const { score } = buildScore(project, part, settings, language)
  const api = new AlphaTabApi(element, settings)
  api.error.on((error) => onError?.(error instanceof Error ? error : new Error(String(error))))
  api.postRenderFinished.on(() => onReady?.())
  api.renderScore(score, score.tracks.map((track) => track.index))
  return api
}
