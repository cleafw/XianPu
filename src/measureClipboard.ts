import { measureDifference, shiftedEndings, shiftedIntro, shiftedLayout, voiceBars, type Beat, type Measure, type Project } from './model.ts'

export type MeasureClipboard = {
  measures: Measure[]
  all: boolean
  tracks: { id: string; voice: number; tuning: number[]; bars: Beat[][] }[]
  omittedLink: boolean
}
export type PasteMode = 'selection' | 'overwrite' | 'before' | 'after' | 'append'
export type PasteError = 'length' | 'end' | 'limit' | 'tracks' | 'simile'

function brokenSpans(bars: Beat[][], indices: number[]) {
  const ranges = new Map<string, { start?: number; end?: number }>()
  bars.forEach((bar, index) => bar.forEach((beat) => beat.spans?.forEach((point) => {
    const range = ranges.get(point.id) ?? {}
    range[point.end ? 'end' : 'start'] = index
    ranges.set(point.id, range)
  })))
  return new Set([...ranges].filter(([, { start, end }]) =>
    start === undefined || end === undefined || end < start || indices[end] - indices[start] !== end - start)
    .map(([id]) => id))
}

function withoutSpans(bars: Beat[][], ids: Set<string>) {
  return !ids.size ? bars : bars.map((bar) => bar.map((beat) => beat.spans?.some(({ id }) => ids.has(id))
    ? { ...beat, spans: beat.spans.filter(({ id }) => !ids.has(id)) } : beat))
}

export function copyMeasures(project: Project, indices: number[], trackId: string, all: boolean, selectedVoice = 0): MeasureClipboard {
  let omittedLink = false
  const tracks = project.tracks.filter((track) => all || track.id === trackId).flatMap((track) =>
    (all ? Array.from({ length: 1 + (track.voices?.length ?? 0) }, (_, voice) => voice) : [selectedVoice]).map((voice) => {
    const bars = indices.map((index, offset) => {
      const source = voiceBars(track, voice)[index]
      const bar = structuredClone(source.slice(0, source.findLastIndex((beat) => !beat.draft) + 1))
      if (indices[offset - 1] !== index - 1 && bar[0]?.tie) {
        delete bar[0].tie
        omittedLink = true
      }
      if (indices[offset + 1] !== index + 1 && bar.at(-1)?.slur) {
        delete bar.at(-1)!.slur
        omittedLink = true
      }
      return bar
    })
    const broken = brokenSpans(bars, indices)
    omittedLink ||= broken.size > 0
    return { id: track.id, voice, tuning: [...track.tuning], bars: withoutSpans(bars, broken) }
  }))
  return { measures: indices.map((index) => structuredClone(project.measures[index])), all, tracks, omittedLink }
}

export function pasteMeasures(project: Project, clip: MeasureClipboard, trackId: string, mode: PasteMode,
  selection: number[], anchor: number, includeStructure = false, selectedVoice = 0) {
  const length = clip.measures.length
  const inserting = mode === 'before' || mode === 'after' || mode === 'append'
  const start = mode === 'append' ? project.measures.length : anchor + (mode === 'after' ? 1 : 0)
  if (inserting && project.measures[start]?.simile === 'double-second') return { error: 'simile' as const }
  if (mode === 'selection' && selection.length !== length) return { error: 'length' as const }
  const targets = mode === 'selection' ? selection : Array.from({ length }, (_, index) => start + index)
  if (inserting ? project.measures.length + length > 256 : targets.at(-1)! >= project.measures.length) {
    return { error: inserting ? 'limit' as const : 'end' as const }
  }
  const key = (id: string, voice: number) => JSON.stringify([id, voice])
  const sources = new Map(clip.tracks.map((track) => [key(clip.all ? track.id : trackId, clip.all ? track.voice : selectedVoice), track]))
  const available = new Map(project.tracks.flatMap((track) =>
    Array.from({ length: 1 + (track.voices?.length ?? 0) }, (_, voice) => [key(track.id, voice), track.tuning.join()] as const)))
  if ([...sources].some(([id, source]) => available.get(id) !== source.tuning.join()) ||
      clip.all && !inserting && sources.size !== available.size) {
    return { error: 'tracks' as const }
  }
  const indexes = new Map(targets.map((target, index) => [target, index]))
  const measures = inserting ? shiftedEndings(project.measures, start, length) : project.measures.slice()
  if (inserting) measures.splice(start, 0, ...clip.measures.map((measure) => clip.all && includeStructure ? structuredClone(measure) : {}))
  else if (clip.all && includeStructure) targets.forEach((target, index) => { measures[target] = structuredClone(clip.measures[index]) })

  if (clip.all && includeStructure && measures.some(({ simile }, index) =>
    simile === 'double' && measures[index + 1]?.simile !== 'double-second' ||
    simile === 'double-second' && measures[index - 1]?.simile !== 'double')) return { error: 'simile' as const }

  let affectedLink = false
  function pasteBars(existing: Beat[][], source?: MeasureClipboard['tracks'][number]) {
    if (!source && !inserting) return existing
    const content = clip.measures.map((_, index) => {
      const bar = structuredClone(source?.bars[index] ?? [])
      if (targets[index - 1] !== targets[index] - 1 && bar[0]?.tie) {
        delete bar[0].tie
        affectedLink = true
      }
      if (targets[index + 1] !== targets[index] + 1 && bar.at(-1)?.slur) {
        delete bar.at(-1)!.slur
        affectedLink = true
      }
      return bar
    })
    const broken = brokenSpans(content, targets)
    affectedLink ||= broken.size > 0
    const newIds = new Map<string, string>()
    const pasted = withoutSpans(content, broken).map((bar) => bar.map((beat) => ({ ...beat,
      marks: beat.marks?.map((mark) => ({ ...mark, id: crypto.randomUUID() })),
      spans: beat.spans?.map((point) => {
        if (!newIds.has(point.id)) newIds.set(point.id, crypto.randomUUID())
        return { ...point, id: newIds.get(point.id)! }
      }),
    })))
    const outside = existing.map((bar, index) => indexes.has(index) ? [] : bar)
    const clipped = inserting ? new Set<string>() : brokenSpans(outside, outside.map((_, index) => index))
    affectedLink ||= clipped.size > 0
    const old = withoutSpans(existing, clipped)
    const bars = inserting ? [...old.slice(0, start), ...pasted, ...old.slice(start)]
      : old.map((bar, index) => indexes.has(index) ? pasted[indexes.get(index)!] : bar)
    for (const index of targets) {
      if (!indexes.has(index - 1) && bars[index - 1]?.at(-1)?.slur) {
        bars[index - 1] = bars[index - 1].map((beat, offset, values) => offset === values.length - 1 ? { ...beat, slur: false } : beat)
        affectedLink = true
      }
      if (!indexes.has(index + 1) && bars[index + 1]?.[0]?.tie) {
        bars[index + 1] = [{ ...bars[index + 1][0], tie: false }, ...bars[index + 1].slice(1)]
        affectedLink = true
      }
    }
    return bars
  }
  const tracks = project.tracks.map((track) => ({
    ...track, layout: inserting ? shiftedLayout(track.layout, start, length) : track.layout,
    bars: pasteBars(track.bars, sources.get(key(track.id, 0))),
    voices: track.voices?.map((voice, index) => ({ ...voice, bars: pasteBars(voice.bars, sources.get(key(track.id, index + 1))) })),
  }))
  const score = { ...project, measures, tracks, intro: inserting ? shiftedIntro(project.intro, start, length) : project.intro,
    layout: inserting ? shiftedLayout(project.layout, start, length) : project.layout }
  const overfull = measures.flatMap((_, index) => {
    const oldIndex = inserting && index >= start ? index - length : index
    const over = tracks.some((track, trackIndex) => [track.bars, ...track.voices?.map((voice) => voice.bars) ?? []].some((_, voice) => {
      const difference = measureDifference(score, track, index, voice)
      if (difference >= 0) return false
      if (indexes.has(index) && sources.has(key(track.id, voice))) return true
      return oldIndex < 0 || difference < measureDifference(project, project.tracks[trackIndex], oldIndex, voice) - 1e-7
    }))
    return over ? [index] : []
  })
  return { score, targets, overfull, affectedLink }
}
