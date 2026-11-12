import { beatList, blank, capacity, durations, matchingTie, maxGraceNotes, ticks, voiceBars, type Beat, type Position, type Project, type Track } from './model.ts'
import { guitarFingering } from './keyChange.ts'

export type RhythmEdit = 'shorten' | 'lengthen' | 'add-extension' | 'remove-extension'
export const longValues = [{ duration: 4, dots: 0 }, { duration: 2, dots: 0 }, { duration: 2, dots: 1 }, { duration: 1, dots: 0 }] as const

export function steppedRhythm(beat: Pick<Beat, 'duration' | 'dots'>, action: RhythmEdit, numbered: boolean) {
  if (action === 'add-extension' || action === 'remove-extension') {
    const index = longValues.findIndex(({ duration, dots }) => duration === beat.duration && dots === beat.dots)
    return index < 0 ? undefined : longValues[index + (action === 'add-extension' ? 1 : -1)]
  }
  if (numbered && action === 'lengthen' && beat.duration <= 4) return
  const duration = durations[durations.indexOf(beat.duration) + (action === 'shorten' ? 1 : -1)]
  return duration && { duration }
}

export const sameVoice = (a: Position, b: Position) => a.track === b.track && (a.voice ?? 0) === (b.voice ?? 0)
export const sameBeat = (a: Position, b: Position) => sameVoice(a, b) && a.bar === b.bar && a.beat === b.beat
const beatOrder = (a: Position, b: Position) => a.bar - b.bar || a.beat - b.beat

type SelectedBeat = { position: Position; beat: Beat; notes: Set<number> | null }
export function selectedBeats(score: Project, positions: readonly Position[]) {
  const bars = new Map<string, Beat[]>()
  const result = new Map<string, SelectedBeat>()
  for (const position of positions) {
    const { track: id, bar, beat: index, note } = position
    const track = score.tracks.find(({ id: item }) => item === id)
    if (!track || !score.measures[bar] || score.measures[bar].simile) continue
    const barKey = JSON.stringify([id, position.voice ?? 0, bar])
    if (!bars.has(barKey)) bars.set(barKey, beatList(score, voiceBars(track, position.voice)[bar], bar))
    const beat = bars.get(barKey)?.[index]
    if (!beat || (note !== undefined && !beat.notes[note])) continue
    const key = barKey + ':' + index
    const prior = result.get(key)
    if (!prior || note === undefined) result.set(key, { position, beat, notes: note === undefined ? null : new Set([note]) })
    else prior.notes?.add(note)
  }
  return [...result.values()].sort((a, b) => beatOrder(a.position, b.position))
}

type Replacement = { position: Position; beat: Beat }
function replaceBeats(score: Project, edits: Replacement[], resetFormatting = false) {
  if (!edits.length) return score
  return { ...score, tracks: score.tracks.map((track) => {
    const trackEdits = edits.filter(({ position }) => position.track === track.id)
    if (!trackEdits.length) return track
    const replace = (bars: Beat[][], voice: number) => {
      const byBar = new Map<number, Replacement[]>()
      for (const edit of trackEdits) {
        if ((edit.position.voice ?? 0) !== voice) continue
        const bar = byBar.get(edit.position.bar) ?? []
        bar.push(edit)
        byBar.set(edit.position.bar, bar)
      }
      if (!byBar.size) return bars
      const removed = new Set<string>()
      const resetPositions = new Map<number, Set<number>>()
      const brokenTuplets = new Set<string>()
      const changed = bars.map((bar, index) => {
        const items = byBar.get(index)
        if (!items) return bar
        const last = Math.max(bar.length - 1, ...items.map(({ position }) => position.beat))
        const beats = beatList(score, bar, index).slice(0, last + 1)
        for (const { position, beat } of items) {
          const original = beats[position.beat]
          for (const span of original?.spans ?? []) {
            if (!beat.spans?.some(({ id }) => id === span.id)) removed.add(span.id)
          }
          if (resetFormatting && !beat.notes.length) {
            const reset = resetPositions.get(index) ?? new Set<number>()
            reset.add(position.beat)
            resetPositions.set(index, reset)
            if (original?.tupletGroup) brokenTuplets.add(original.tupletGroup)
          }
          beats[position.beat] = beat
        }
        return beats
      })
      if (!removed.size && !resetPositions.size) return changed
      return changed.map((bar, index) => bar.map((beat, offset) => {
        const reset = resetPositions.get(index)
        const cutSlur = beat.slur && (reset?.has(offset + 1) ||
          resetPositions.get(index + 1)?.has(0) && offset === beatList(score, bars[index], index).length - 1)
        const previousReset = resetPositions.get(index - 1)
        const cutTie = beat.tie && (offset > 0 ? reset?.has(offset - 1) :
          previousReset?.has(beatList(score, bars[index - 1], index - 1).length - 1))
        const cutSpan = beat.spans?.some(({ id }) => removed.has(id))
        const cutTuplet = beat.tupletGroup && brokenTuplets.has(beat.tupletGroup)
        if (!cutSlur && !cutTie && !cutSpan && !cutTuplet) return beat
        return { ...beat, ...(cutSlur ? { slur: false } : {}), ...(cutTie ? { tie: false } : {}),
          ...(cutSpan ? { spans: beat.spans?.filter(({ id }) => !removed.has(id)) } : {}),
          ...(cutTuplet ? { tupletGroup: undefined } : {}) }
      }))
    }
    return { ...track, bars: replace(track.bars, 0), voices: track.voices?.map((voice, index) => ({ ...voice, bars: replace(voice.bars, index + 1) })) }
  }) }
}

export function editRhythmSelection(score: Project, targets: SelectedBeat[], update: (beat: Beat) => Partial<Beat> | undefined) {
  return replaceBeats(score, targets.flatMap(({ position, beat }) => {
    const rhythm = update(beat)
    return rhythm ? [{ position, beat: { ...beat, ...rhythm, draft: false } }] : []
  }))
}

export function shiftSelectedPitches(score: Project, targets: SelectedBeat[], amount: number, part: string | null) {
  const edits: Replacement[] = []
  for (const { position, beat, notes } of targets) {
    const track = score.tracks.find(({ id }) => id === position.track)!
    if ((part ? track.layout.mode ?? track.mode : track.mode) === 'percussion' || !beat.notes.length) continue
    const shifted = beat.notes.map((tone, index) => notes && !notes.has(index) ? tone : {
      ...tone, midi: tone.midi + amount, fret: tone.fret === undefined ? undefined : tone.fret + amount,
    })
    if (shifted.some(({ midi }) => midi < 0 || midi > 127)) return { error: 'pitch' } as const
    if (shifted.some(({ fret }) => fret !== undefined && (fret < 0 || fret > 36))) return { error: 'guitar' } as const
    edits.push({ position, beat: { ...beat, notes: shifted } })
  }
  return { score: replaceBeats(score, edits) }
}

export function clearSelectedNotes(score: Project, targets: SelectedBeat[]) {
  return replaceBeats(score, targets.map(({ position, beat, notes }) => {
    const remaining = notes ? beat.notes.filter((_, index) => !notes.has(index)) : []
    return { position, beat: remaining.length ? { ...beat, notes: remaining }
      : { ...blank(beat.duration), dots: beat.dots, triplet: beat.triplet, tuplet: beat.tuplet, tupletGroup: beat.tupletGroup, draft: false } }
  }))
}

export function resetSelectedNotes(score: Project, targets: SelectedBeat[]) {
  return replaceBeats(score, targets.filter(({ beat }) => !beat.draft).map(({ position, beat, notes }) => {
    const remaining = notes ? beat.notes.filter((_, index) => !notes.has(index)) : []
    return { position, beat: remaining.length ? { ...beat, notes: remaining } : { ...blank(), draft: false } }
  }), true)
}

export function convertNotesToGrace(score: Project, targets: SelectedBeat[], side: 'grace' | 'graceAfter') {
  const first = targets[0]?.position
  const track = score.tracks.find(({ id }) => id === first?.track)
  if (!first || !track || targets.some(({ position, beat }) => !sameVoice(position, first) || beat.draft || beat.notes.length !== 1)) {
    return { error: 'selection' } as const
  }
  const bars = voiceBars(track, first.voice)
  const startBar = Math.max(0, first.bar - 1)
  const endBar = targets.at(-1)!.position.bar + 1
  const beats = bars.slice(startBar, endBar + 1).flatMap((bar, index) => {
    const barIndex = startBar + index
    const count = score.measures[barIndex].simile ? 0 : bar.findLastIndex((beat) => !beat.draft) + 1
    return (count ? bar.slice(0, count) : [blank()]).map((beat, index) => ({
      position: { ...first, bar: barIndex, beat: index, note: undefined, string: undefined }, beat,
    }))
  })
  const start = beats.findIndex(({ position }) => sameBeat(position, first))
  if (start < 0 || targets.some(({ position }, index) => !beats[start + index] || !sameBeat(beats[start + index].position, position))) {
    return { error: 'selection' } as const
  }
  const anchor = beats[side === 'grace' ? start + targets.length : start - 1]
  if (!anchor?.beat.notes.length) return { error: 'anchor' } as const
  const pitches = targets.flatMap(({ beat }) => [...beat.grace ?? [], beat.notes[0].midi, ...beat.graceAfter ?? []])
  const existing = anchor.beat[side] ?? []
  if (pitches.length + existing.length > maxGraceNotes) return { error: 'limit' } as const

  const cleaned = replaceBeats(score, targets.map(({ position }) => ({ position, beat: { ...blank(), draft: false } })), true)
  const selectedByBar = new Map<number, Set<number>>()
  for (const { position: { bar, beat } } of targets) {
    const selected = selectedByBar.get(bar) ?? new Set<number>()
    selected.add(beat)
    selectedByBar.set(bar, selected)
  }
  const position = { ...anchor.position,
    beat: anchor.position.beat - [...selectedByBar.get(anchor.position.bar) ?? []].filter((index) => index < anchor.position.beat).length }
  const tracks = cleaned.tracks.map((item) => {
    if (item.id !== track.id) return item
    const updated = voiceBars(item, first.voice).map((bar, index) => {
      const selected = selectedByBar.get(index)
      if (!selected && index !== anchor.position.bar) return bar
      return bar.flatMap((beat, offset) => {
        if (selected?.has(offset)) return []
        return [index === anchor.position.bar && offset === anchor.position.beat
          ? { ...beat, [side]: side === 'grace' ? [...pitches, ...existing] : [...existing, ...pitches] } : beat]
      })
    })
    return first.voice ? { ...item, voices: item.voices?.map((voice, index) =>
      index + 1 === first.voice ? { ...voice, bars: updated } : voice) } : { ...item, bars: updated }
  })
  return { score: { ...cleaned, tracks }, position }
}

export type NoteClipboard = { beats: Beat[]; tuning: number[] }
export function copySelectedNotes(score: Project, targets: SelectedBeat[], track: Track): NoteClipboard {
  targets = targets.map((target) => target.notes?.size === target.beat.notes.length ? { ...target, notes: null } : target)
  const adjacent = (left: Position, right: Position) => left.bar === right.bar && left.beat + 1 === right.beat ||
    left.bar + 1 === right.bar && right.beat === 0 &&
      left.beat === beatList(score, voiceBars(track, left.voice)[left.bar], left.bar).length - 1
  const groupSizes = new Map<string, number>()
  const spans = new Map<string, { start?: number; end?: number }>()
  targets.forEach(({ beat, notes }, index) => {
    if (notes) return
    for (const span of beat.spans ?? []) {
      const pair = spans.get(span.id) ?? {}
      pair[span.end ? 'end' : 'start'] = index
      spans.set(span.id, pair)
    }
  })
  const joins = targets.map(({ position }, index) => index > 0 && adjacent(targets[index - 1].position, position))
  const completeSpans = new Set([...spans].flatMap(([id, { start, end }]) =>
    start !== undefined && end !== undefined && start < end && joins.slice(start + 1, end + 1).every(Boolean) ? [id] : []))
  for (const { beat, notes } of targets) if (!notes && beat.tupletGroup) {
    groupSizes.set(beat.tupletGroup, (groupSizes.get(beat.tupletGroup) ?? 0) + 1)
  }
  const beats = targets.map(({ beat, notes }, index) => {
    const prior = targets[index - 1]
    const selection = notes ? {
      ...blank(beat.duration), dots: beat.dots, triplet: beat.triplet, tuplet: beat.tuplet,
      notes: beat.notes.filter((_, index) => notes.has(index)),
    } : beat
    return { ...selection, draft: false, spans: selection.spans?.filter(({ id }) => completeSpans.has(id)),
      slur: !notes && !!joins[index + 1] && !targets[index + 1].notes && selection.slur,
      tie: !notes && !!joins[index] && !prior.notes && selection.tie,
      tupletGroup: beat.tupletGroup && groupSizes.get(beat.tupletGroup) === beat.tuplet?.[0] ? beat.tupletGroup : undefined }
  })
  return structuredClone({ beats, tuning: track.tuning })
}

export function pasteSelectedNotes(score: Project, position: Position, clipboard: NoteClipboard) {
  const track = score.tracks.find(({ id }) => id === position.track)
  if (!track || !clipboard.beats.length) return { error: 'space' } as const
  const bars = voiceBars(track, position.voice)
  const positions: Position[] = []
  for (let bar = position.bar; bar < bars.length && positions.length < clipboard.beats.length; bar++) {
    if (score.measures[bar].simile) return { error: 'space' } as const
    const original = beatList(score, bars[bar], bar)
    const first = bar === position.bar ? position.beat : 0
    const limit = capacity(score, bar)
    let offset = original.slice(0, first).reduce((sum, beat) => sum + ticks(beat), 0)
    if (offset > limit + 1e-7) return { error: 'barline' } as const
    for (let beat = first; beat < 256 && positions.length < clipboard.beats.length; beat++) {
      if (offset >= limit - 1e-7) break
      const end = offset + ticks(clipboard.beats[positions.length])
      if (end > limit + 1e-7) return { error: 'barline' } as const
      positions.push({ ...position, bar, beat, note: undefined, string: undefined })
      offset = end
    }
    if (positions.length < clipboard.beats.length && offset < limit - 1e-7) return { error: 'space' } as const
  }
  if (positions.length < clipboard.beats.length) return { error: 'space' } as const

  const sameTuning = track.tuning.join() === clipboard.tuning.join()
  const edits: Replacement[] = []
  const tuplets = new Map<string, string>()
  const spanIds = new Map<string, string>()
  for (const [index, beat] of clipboard.beats.entries()) {
    const { tupletGroup, ...content } = beat
    if (tupletGroup && !tuplets.has(tupletGroup)) tuplets.set(tupletGroup, crypto.randomUUID())
    const notes = track.tuning.length
      ? guitarFingering(beat.notes, track.tuning, true)
      : beat.notes.map(({ midi, bend, slide }) => ({ midi, bend, slide }))
    if (!notes) return { error: 'guitar' } as const
    edits.push({ position: positions[index], beat: { ...content, notes,
      diagram: sameTuning ? beat.diagram : undefined,
      marks: sameTuning ? beat.marks : beat.marks?.filter(({ string }) => string === undefined),
      spans: beat.spans?.map((span) => {
        if (!spanIds.has(span.id)) spanIds.set(span.id, crypto.randomUUID())
        return { ...span, id: spanIds.get(span.id)! }
      }),
      tie: !!beat.tie && !!edits.at(-1)?.beat.notes.some((tone) => notes.some((note) => matchingTie(tone, note))),
      tupletGroup: tupletGroup ? tuplets.get(tupletGroup) : undefined,
    } })
  }
  const last = positions.at(-1)!
  const prior = position.beat ? { ...position, beat: position.beat - 1 }
    : { ...position, bar: position.bar - 1, beat: (bars[position.bar - 1]?.length ?? 0) - 1 }
  const next = bars[last.bar]?.[last.beat + 1] ? { ...last, beat: last.beat + 1 } : { ...last, bar: last.bar + 1, beat: 0 }
  const before = bars[prior.bar]?.[prior.beat]
  const after = bars[next.bar]?.[next.beat]
  if (before?.slur) edits.push({ position: prior, beat: { ...before, slur: false } })
  if (after?.tie) edits.push({ position: next, beat: { ...after, tie: false } })
  return { score: replaceBeats(score, edits), positions }
}
