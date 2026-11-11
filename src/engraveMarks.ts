import { model, type AlphaTabApi, type Settings } from '@coderline/alphatab'
import type { Beat, NumberedKeyLayout, Project, Track } from './model'
import { markSymbol } from './markGlyphs'
import { pairedSpans, type ScoreMark, type SpanEnd, type SpanKind } from './notationMarks'

const { MusicFontSymbol: smufl } = model
const belowSpan = (kind: SpanKind) => kind === 'crescendo' || kind === 'diminuendo' || kind === 'ottavaDown' || kind === 'pedal' || kind === 'lyricExtend'
const svgNs = 'http://www.w3.org/2000/svg'
const markLayer = 'xianpu-marks'
const rowHeight = 18

export function reserveMarkSpace(settings: Settings, tracks: readonly Track[], defaultKey?: NumberedKeyLayout) {
  let above = 0
  let below = 0
  for (const bars of tracks.flatMap((track) => [track.bars, ...track.voices?.map((voice) => voice.bars) ?? []])) {
    const beats = bars.flat().map((beat, index) => ({ beat, index }))
    const changes = new Map<number, [number, number]>()
    for (const { start, end, span } of pairedSpans(beats, ({ beat }) => beat.spans)) {
      const side = belowSpan(span.kind) ? 1 : 0
      const enter = changes.get(start.index) ?? [0, 0]
      enter[side]++
      changes.set(start.index, enter)
      const exit = changes.get(end.index + 1) ?? [0, 0]
      exit[side]--
      changes.set(end.index + 1, exit)
    }
    const spans = [0, 0]
    for (const { beat, index } of beats) {
      const [upper, lower] = changes.get(index) ?? [0, 0]
      spans[0] += upper
      spans[1] += lower
      const counts = [...spans]
      const offsets = [0, 0]
      for (const mark of beat.marks ?? []) {
        const side = mark.place === 'below' ? 1 : 0
        counts[side]++
        offsets[side] = Math.max(offsets[side], side ? mark.dy : -mark.dy)
      }
      above = Math.max(above, counts[0] * rowHeight + offsets[0])
      below = Math.max(below, counts[1] * rowHeight + offsets[1])
    }
  }
  const display = settings.display
  const keyAbove = Math.max(0, ...tracks.map((track) => {
    const key = track.layout.numberedKey ?? defaultKey
    return key?.hidden ? 0 : -(key?.y ?? 0)
  }))
  if (above || keyAbove) {
    const extra = above + keyAbove + 28
    display.firstNotationStaffPaddingTop += extra
    display.notationStaffPaddingTop += extra
  }
  if (below) {
    display.lastNotationStaffPaddingBottom += below + 6
    display.notationStaffPaddingBottom += below + 6
  }
}

type Lookup = NonNullable<AlphaTabApi['boundsLookup']>
type StaffBar = Lookup['staffSystems'][number]['bars'][number]['bars'][number]
type BeatBounds = StaffBar['beats'][number]
type Box = { left: number; right: number; top: number; bottom: number }
type Fragment = { source: SVGSVGElement; group: SVGGElement; x: number; y: number; width: number; height: number; occupied: Box[] }
type Anchor = { system: number; first: BeatBounds; last: BeatBounds; data: Beat }
type Lane = { fragment: Fragment; first: StaffBar; last: StaffBar }
let measureContext: CanvasRenderingContext2D | null = null

function svg<K extends keyof SVGElementTagNameMap>(name: K, attributes: Record<string, string | number> = {}) {
  const element = document.createElementNS(svgNs, name)
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value))
  return element
}

function label(group: SVGGElement, value: string | number, scale: number) {
  const music = typeof value === 'number'
  const parent = music ? group.appendChild(svg('g', { class: 'at' })) : group
  const text = svg('text', {
    'font-size': (music ? 36 : 12) * scale,
    'text-anchor': 'middle',
    'stroke': 'none',
  })
  if (!music) text.setAttribute('font-family', 'Microsoft YaHei, Arial, sans-serif')
  text.textContent = music ? String.fromCodePoint(value) : value
  parent.append(text)
  return text
}

function labelInk(text: SVGTextElement, maxWidth = Infinity): Box {
  // SVG text boxes include Bravura's tall font line metrics, even for a dot.
  // Use the outline's actual bounds to position and stack the visible signs.
  const context = measureContext ??= document.createElement('canvas').getContext('2d')!
  const { fontStyle, fontWeight, fontSize, fontFamily } = getComputedStyle(text)
  context.font = `${fontStyle} ${fontWeight} ${fontSize} ${fontFamily}`
  context.textAlign = 'center'
  context.textBaseline = 'alphabetic'
  const metrics = context.measureText(text.textContent ?? '')
  const width = metrics.actualBoundingBoxLeft + metrics.actualBoundingBoxRight
  const fit = width > maxWidth ? maxWidth / width : 1
  if (fit < 1) {
    text.setAttribute('textLength', String(metrics.width * fit))
    text.setAttribute('lengthAdjust', 'spacingAndGlyphs')
  }
  return {
    left: -metrics.actualBoundingBoxLeft * fit, right: metrics.actualBoundingBoxRight * fit,
    top: -metrics.actualBoundingBoxAscent, bottom: metrics.actualBoundingBoxDescent,
  }
}

function place(fragment: Fragment, box: Box, below: boolean, scale: number) {
  const gap = 2 * scale
  const adjacent = fragment.occupied.filter((other) => box.left < other.right + gap && box.right > other.left - gap)
  const min = gap - box.top
  const max = fragment.height - gap - box.bottom
  const natural = Math.max(min, Math.min(max, 0))
  const fits = (move: number) => move >= min && move <= max && adjacent.every((other) =>
    box.bottom + move <= other.top - gap + 1e-5 || box.top + move >= other.bottom + gap - 1e-5)
  const positions = [natural, ...adjacent.flatMap((other) => [other.top - gap - box.bottom, other.bottom + gap - box.top])]
    .filter(fits).sort((a, b) => Math.abs(a) - Math.abs(b))
  const move = positions.find((offset) => below ? offset >= natural : offset <= natural) ?? positions[0] ?? natural
  fragment.occupied.push({ ...box, top: box.top + move, bottom: box.bottom + move })
  return move
}

function nativeInk(fragment: Fragment, text: SVGTextElement): Box | undefined {
  const transform = text.getCTM()
  const root = fragment.source.getCTM()
  if (!transform || !root) return
  const local = root.inverse().multiply(transform)
  const style = getComputedStyle(text)
  const context = measureContext ??= document.createElement('canvas').getContext('2d')!
  context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
  context.textAlign = style.textAnchor === 'middle' ? 'center' : style.textAnchor === 'end' ? 'right' : 'left'
  context.textBaseline = style.dominantBaseline === 'hanging' ? 'hanging'
    : style.dominantBaseline === 'middle' || style.dominantBaseline === 'central' ? 'middle' : 'alphabetic'
  const ink = context.measureText(text.textContent ?? '')
  const x = text.x.baseVal.numberOfItems ? text.x.baseVal.getItem(0).value : 0
  const y = text.y.baseVal.numberOfItems ? text.y.baseVal.getItem(0).value : 0
  const topLeft = new DOMPoint(x - ink.actualBoundingBoxLeft, y - ink.actualBoundingBoxAscent).matrixTransform(local)
  const bottomRight = new DOMPoint(x + ink.actualBoundingBoxRight, y + ink.actualBoundingBoxDescent).matrixTransform(local)
  return { left: topLeft.x, top: topLeft.y, right: bottomRight.x, bottom: bottomRight.y }
}

const keyCaption = /^[16]\s*=\s*[a-g]\s*$/i
const accidental = /^[\ue260-\ue264]$/

function arrangeNativeLabels(fragment: Fragment, system: Lookup['staffSystems'][number], tracks: readonly Track[],
  defaultKey: NumberedKeyLayout | undefined, scale: number) {
  const texts = [...fragment.source.querySelectorAll('text')]
  const keys = texts.filter((text) => keyCaption.test(text.textContent ?? '') && !text.hasAttribute('text-anchor')
    && text.style.fontFamily.includes('Arial'))
  for (const text of texts) {
    const value = text.textContent?.trim() ?? ''
    const chord = text.style.fontStyle === 'italic' && text.getAttribute('text-anchor') === 'middle'
    if (!/^=\s*\d/.test(value) && !/^[\ue080-\ue09f\ueca0-\uecaf]$/.test(value) &&
      !/^[0-9]+$/.test(value) && !chord) continue
    const ink = nativeInk(fragment, text)
    if (ink) fragment.occupied.push(ink)
  }
  const numbered = system.bars.flatMap(({ bars }) => bars.filter((entry) => entry.bar.staff.showNumbered))
  for (const text of keys) {
    let group = text.parentElement as Element | null
    if (!group?.hasAttribute('data-numbered-key')) {
      group = svg('g', { 'data-numbered-key': '' })
      const next = text.nextElementSibling
      text.before(group)
      group.append(text)
      if (next?.matches('g.at') && accidental.test(next.textContent ?? '')) group.append(next)
    }
    group.removeAttribute('display')
    group.removeAttribute('transform')
    const ink = nativeInk(fragment, text)
    if (!ink) continue
    const x = ink.left + fragment.x
    const y = ink.bottom + fragment.y
    const staff = numbered.reduce<StaffBar | undefined>((best, candidate) => {
      const bounds = candidate.realBounds
      if (x < bounds.x - 8 * scale || x > bounds.x + bounds.w || y > bounds.y + 3 * scale) return best
      return !best || bounds.y < best.realBounds.y ? candidate : best
    }, undefined)
    const index = staff?.bar.staff.track.index
    const options = (index === undefined ? undefined : tracks[index]?.layout.numberedKey) ?? defaultKey
    if (options?.hidden) {
      group.setAttribute('display', 'none')
      continue
    }
    const other = group.querySelector<SVGTextElement>('g.at text')
    const sign = other && nativeInk(fragment, other)
    const box = sign ? { left: Math.min(ink.left, sign.left), right: Math.max(ink.right, sign.right),
      top: Math.min(ink.top, sign.top), bottom: Math.max(ink.bottom, sign.bottom) } : ink
    const dx = Math.max(2 - box.left, Math.min(fragment.width - 2 - box.right, (options?.x ?? 0) * scale))
    const dy = (options?.y ?? 0) * scale
    const move = place(fragment, { left: box.left + dx, right: box.right + dx, top: box.top + dy, bottom: box.bottom + dy }, false, scale)
    if (dx || dy + move) group.setAttribute('transform', `translate(${dx} ${dy + move})`)
  }
}

function pointMark(fragment: Fragment, anchor: Anchor, mark: ScoreMark, scale: number) {
  const below = mark.place === 'below'
  const beat = below || mark.string ? anchor.last : anchor.first
  const staff = beat.barBounds.realBounds
  const note = beat.notes?.find(({ note }) => mark.string !== undefined && note.string === 7 - mark.string)
  const head = note?.noteHeadBounds
  let x = head ? head.x + head.w / 2 : beat.onNotesX
  if (mark.place === 'gap') {
    const next = beat.barBounds.beats[beat.beat.index + 1]
    x = (x + (next?.onNotesX ?? staff.x + staff.w)) / 2
  }
  x += mark.dx * scale - fragment.x
  const edge = staff.y + (below ? staff.h : 0) - fragment.y
  const group = svg('g', { 'data-mark': mark.id, 'data-code': mark.code })
  const value = mark.code === 'text' ? mark.text ?? '' : markSymbol(mark.code, below)
  if (value === '') return
  const text = label(group, value, scale)
  fragment.group.append(group)
  const bounds = labelInk(text, Math.max(1, fragment.width - (mark.string ? 16 : 4) * scale))
  if (mark.string) {
    const stringNumber = label(group, 0xe833 + mark.string, scale * 0.44)
    const number = labelInk(stringNumber)
    const offset = (bounds.top + bounds.bottom - number.top - number.bottom) / 2
    stringNumber.setAttribute('x', String(bounds.right + 2 * scale - number.left))
    stringNumber.setAttribute('y', String(offset))
    bounds.right += 2 * scale + number.right - number.left
    bounds.top = Math.min(bounds.top, number.top + offset)
    bounds.bottom = Math.max(bounds.bottom, number.bottom + offset)
  }
  x = Math.max(2 * scale - bounds.left, Math.min(fragment.width - 2 * scale - bounds.right, x))
  const y = edge + (below ? 4 * scale - bounds.top : -4 * scale - bounds.bottom) + mark.dy * scale
  const move = place(fragment, {
    left: x + bounds.left, right: x + bounds.right,
    top: y + bounds.top, bottom: y + bounds.bottom,
  }, below, scale)
  group.setAttribute('transform', `translate(${x} ${y + move})`)
}

const lineLabels: Partial<Record<SpanKind, string | number>> = {
  roll: '摇',
  flutter: '花舌',
  palmMute: 'P.M.',
  ottavaUp: smufl.OttavaAlta,
  ottavaDown: smufl.OttavaBassaVb,
  pedal: smufl.KeyboardPedalPed,
}

function rangeSegment(lane: Lane, span: SpanEnd, x1: number, x2: number, first: boolean, last: boolean,
  progress: number, nextProgress: number, scale: number) {
  const { fragment } = lane
  const below = belowSpan(span.kind)
  const isHairpin = span.kind === 'crescendo' || span.kind === 'diminuendo'
  const isSlur = span.kind === 'slur'
  const direction = below ? 1 : -1
  const edges = [lane.first.realBounds, lane.last.realBounds].map((bounds) => bounds.y + (below ? bounds.h : 0))
  const edge = (below ? Math.max(...edges) : Math.min(...edges)) - fragment.y
  x1 -= fragment.x
  x2 = Math.min(fragment.width - 2 * scale, Math.max(x1 + 5 * scale, x2 - fragment.x))
  x1 = Math.min(x1, x2 - 3 * scale)
  let y = edge + direction * 9 * scale
  const group = svg('g', { 'data-span': span.id, 'data-kind': span.kind })
  fragment.group.append(group)
  let startX = x1
  let captionHeight = 0
  const caption = span.text || lineLabels[span.kind]
  if (first && caption && !isHairpin && !isSlur) {
    const text = label(group, caption, scale * 0.85)
    const ink = labelInk(text, Math.max(1, x2 - x1 - 5 * scale))
    captionHeight = ink.bottom - ink.top
    text.setAttribute('x', String(x1 - ink.left))
    text.setAttribute('y', String(-ink.top - captionHeight / 2))
    startX = Math.min(x2 - scale, x1 + ink.right - ink.left + 3 * scale)
  }
  let d: string
  if (isHairpin) {
    const opening = (portion: number) => 4.5 * scale * (span.kind === 'crescendo' ? portion : 1 - portion)
    const a = opening(progress)
    const b = opening(nextProgress)
    d = `M ${x1} ${-a} L ${x2} ${-b} M ${x1} ${a} L ${x2} ${b}`
  } else if (isSlur) {
    const height = Math.min(9 * scale, (x2 - x1) / 6)
    d = `M ${x1} ${first ? 0 : -height / 2} Q ${(x1 + x2) / 2} ${-1.8 * height} ${x2} ${last ? 0 : -height / 2}`
  } else if (span.kind === 'roll' || span.kind === 'flutter') {
    d = `M ${startX} 0`
    for (let x = startX; x < x2; x += 6 * scale) {
      d += ` Q ${x + 1.5 * scale} ${-3 * scale} ${Math.min(x + 3 * scale, x2)} 0`
      if (x + 3 * scale < x2) d += ` Q ${x + 4.5 * scale} ${3 * scale} ${Math.min(x + 6 * scale, x2)} 0`
    }
  } else {
    d = `M ${startX} 0 H ${x2}${last && span.kind !== 'lyricExtend' ? ` v ${-direction * 4 * scale}` : ''}`
  }
  const path = svg('path', { d, fill: 'none', stroke: '#171717', 'stroke-width': 1.15 * scale, 'stroke-linecap': 'round' })
  if (['custom', 'palmMute', 'ottavaUp', 'ottavaDown'].includes(span.kind)) {
    path.setAttribute('stroke-dasharray', `${4 * scale} ${2.6 * scale}`)
  }
  group.append(path)
  const bounds = path.getBBox()
  y += place(fragment, {
    left: x1, right: x2,
    top: y + Math.min(bounds.y, -captionHeight / 2), bottom: y + Math.max(bounds.y + bounds.height, captionHeight / 2),
  }, below, scale)
  group.setAttribute('transform', `translate(0 ${y})`)
}

function introParenthesis(fragment: Fragment, bar: StaffBar, opening: boolean, scale: number, tick?: number | null) {
  const beats = bar.beats.filter(({ beat }) => beat.voice.index === 0 && !beat.graceType)
  const beat = opening
    ? (tick == null ? bar.beats[0] : beats.find(({ beat }) => beat.displayEnd > tick + 1e-5)) ?? beats.at(-1)
    : (tick == null ? undefined : beats.findLast(({ beat }) => beat.displayStart < tick - 1e-5)) ?? beats.at(-1)
  const next = beat && beats[beats.indexOf(beat) + 1]
  const heads = beat?.notes?.map(({ noteHeadBounds }) => noteHeadBounds) ?? []
  const staff = bar.realBounds
  const notesX = beat?.onNotesX ?? staff.x + staff.w / 2
  const edge = opening
    ? Math.min(beat?.visualBounds.x ?? notesX - 5 * scale, ...heads.map(({ x }) => x))
    : tick == null || !next ? staff.x + staff.w
      : Math.max(notesX + 5 * scale, ...heads.map(({ x, w }) => x + w),
        beat.beat.displayDuration > 960 ? next.visualBounds.x - 8 * scale : 0)
  const x = Math.max(staff.x + 7 * scale, Math.min(staff.x + staff.w - 7 * scale, edge + (opening ? -2 : 2) * scale)) - fragment.x
  const center = staff.y + staff.h / 2
  const top = Math.max(2, Math.min(center - 9 * scale, ...heads.map(({ y }) => y - 3 * scale)) - fragment.y)
  const bottom = Math.min(fragment.height - 2, Math.max(center + 9 * scale, ...heads.map(({ y, h }) => y + h + 3 * scale)) - fragment.y)
  const curve = x + (opening ? -6 : 6) * scale
  const height = bottom - top
  fragment.group.append(svg('path', {
    'data-intro-parenthesis': opening ? 'start' : 'end',
    'data-intro-track': bar.bar.staff.track.index,
    d: `M ${x} ${top} C ${curve} ${top + height / 4} ${curve} ${bottom - height / 4} ${x} ${bottom}`,
    fill: 'none', stroke: '#171717', 'stroke-width': 1.4 * scale, 'stroke-linecap': 'round',
  }))
}

/** Add cloneable SVG to alphaTab's rendered system fragments before pagination. */
export function engraveMarks(element: HTMLElement, lookup: Lookup | null, tracks: readonly Track[], scale: number,
  sourceData: (beat: BeatBounds['beat']) => Beat | undefined, intro?: Project['intro'], defaultKey?: NumberedKeyLayout) {
  const surface = element.querySelector('.at-surface')
  if (!surface || !lookup) return
  surface.querySelectorAll(`.${markLayer}`).forEach((layer) => layer.remove())
  const numbered = lookup.staffSystems.some((system) => system.bars.some(({ bars }) => bars.some(({ bar }) => bar.staff.showNumbered)))
  if (!intro && !numbered && !tracks.some((track) => [track.bars, ...track.voices?.map((voice) => voice.bars) ?? []].some((bars) =>
    bars.some((bar) => bar.some((beat) => beat.marks?.length || beat.spans?.length))))) return

  const fragments = new Map<number, Fragment>()
  for (const source of surface.querySelectorAll<SVGSVGElement>(':scope > div > svg')) {
    const wrapper = source.parentElement!
    const y = parseFloat(wrapper.style.top)
    const x = parseFloat(wrapper.style.left)
    fragments.set(y, { source, group: svg('g', { class: markLayer, fill: '#171717', 'pointer-events': 'none' }),
      x, y, width: source.width.baseVal.value, height: source.height.baseVal.value, occupied: [] })
    source.append(fragments.get(y)!.group)
  }
  const lanes = new Map<string, Map<number, { upper: Lane; lower: Lane }>>()
  const anchors = new Map<string, Anchor[]>()
  for (const system of lookup.staffSystems) {
    // System bounds include alphaTab's internal top padding. The wrapper's top
    // is the coordinate origin of the SVG that will be copied for print.
    const top = system.visualBounds.y
    const fragment = [...fragments.values()].find(({ y, height }) => top >= y && top < y + height)
    if (!fragment) continue
    arrangeNativeLabels(fragment, system, tracks, defaultKey, scale)
    for (const master of system.bars) {
      if (intro && (master.index === intro[0] || master.index === intro[1])) {
        const firstStaffByTrack = new Map<number, StaffBar>()
        for (const staff of master.bars) {
          const track = staff.bar.staff.track.index
          const first = firstStaffByTrack.get(track)
          if (!first || staff.realBounds.y < first.realBounds.y) firstStaffByTrack.set(track, staff)
        }
        for (const staff of firstStaffByTrack.values()) {
          if (master.index === intro[0]) introParenthesis(fragment, staff, true, scale, intro[2])
          if (master.index === intro[1]) introParenthesis(fragment, staff, false, scale, intro[3])
        }
      }
      for (const modelBar of new Set(master.bars.map(({ bar }) => bar))) {
        const bars = master.bars.filter(({ bar }) => bar === modelBar)
          .sort((a, b) => a.realBounds.y - b.realBounds.y)
        const staffKey = modelBar.staff.track.index + ':' + modelBar.staff.index
        if (!lanes.has(staffKey)) lanes.set(staffKey, new Map())
        const staffLanes = lanes.get(staffKey)!
        const first = bars[0]
        const last = bars.at(-1)!
        const lane = staffLanes.get(system.index)
        if (lane) {
          lane.upper.last = first
          lane.lower.last = last
        } else {
          staffLanes.set(system.index, {
            upper: { fragment, first, last: first }, lower: { fragment, first: last, last },
          })
        }
        for (const beat of first.beats) {
          const data = sourceData(beat.beat)
          if (!data || data.draft) continue
          const other = last === first ? beat : last.beats.find((candidate) => candidate.beat === beat.beat) ?? beat
          const anchor = { system: system.index, first: beat, last: other, data }
          const key = staffKey + ':' + beat.beat.voice.index
          if (!anchors.has(key)) anchors.set(key, [])
          anchors.get(key)!.push(anchor)
          for (const mark of data.marks ?? []) pointMark(fragment, anchor, mark, scale)
        }
      }
    }
  }
  for (const [key, beats] of anchors) {
    const staffLanes = lanes.get(key.slice(0, key.lastIndexOf(':')))
    for (const { start, end, span } of pairedSpans(beats, ({ data }) => data.spans)) {
      const side = belowSpan(span.kind) ? 'lower' : 'upper'
      const segments = []
      for (let system = start.system; system <= end.system; system++) {
        const lane = staffLanes?.get(system)?.[side]
        if (!lane) continue
        const first = system === start.system
        const last = system === end.system
        const right = lane.last.realBounds
        const x1 = first ? (side === 'upper' ? start.first : start.last).onNotesX : lane.first.realBounds.x + 2 * scale
        const x2 = last ? (side === 'upper' ? end.first : end.last).onNotesX : right.x + right.w - 2 * scale
        segments.push({ lane, x1, x2, first, last, width: Math.max(scale, x2 - x1) })
      }
      const width = segments.reduce((sum, segment) => sum + segment.width, 0)
      let offset = 0
      for (const segment of segments) {
        const { lane, x1, x2, first, last } = segment
        rangeSegment(lane, span, x1, x2, first, last, offset / width, (offset + segment.width) / width, scale)
        offset += segment.width
      }
    }
  }
  for (const { group } of fragments.values()) if (!group.childElementCount) group.remove()
}
