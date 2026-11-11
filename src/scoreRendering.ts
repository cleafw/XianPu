import { Environment, rendering, type AlphaTabApi, type model, type platform } from '@coderline/alphatab'
import type { IntroRange } from './model'

// This adapter is for the renderer objects in the pinned alphaTab version.
type Glyph = {
  x: number; y: number; width: number
  paint(cx: number, cy: number, canvas: platform.ICanvas): void
  getBoundingBoxTop(): number
  getBoundingBoxBottom(): number
}
type BeatGlyph = Glyph & {
  container: BeatContainer; renderer: BarRenderer; computedWidth: number
  doLayout(): void
}
type NoteGlyph = BeatGlyph & {
  noteHeads: Glyph | null; onTimeX: number
  getNoteY(note: model.Note, position: number): number
  getHighestNoteY(position: number): number
  buildBoundingsLookup(bounds: rendering.BeatBounds, cx: number, cy: number): void
}
type BeatContainer = { beat?: model.Beat; preNotes?: BeatGlyph & { skipLayout: boolean }; onNotes?: NoteGlyph; barCount?: number }
type BarRenderer = {
  width: number
  beatGlyphsStart: number
  postBeatGlyphsStart: number
  _preBeatGlyphs: { width: number }
  _postBeatGlyphs: Pick<Glyph, 'width' | 'paint'>
  _createKeySignatureGlyphs?(): void
  addPreBeatGlyph(glyph: Glyph & { isEmpty?: boolean }): void
  createPreBeatGlyphs(): void
  createPostBeatGlyphs(): void
  buildBoundingsLookup(master: rendering.MasterBarBounds, cx: number, cy: number): void
  addBeatGlyph(container: BeatContainer): void
  shouldPaintBeamingHelper(helper: { isRestBeamHelper: boolean }): boolean
  beamSpacing: number
  beamThickness: number
}
type RendererFactory = { staffId: string; create(renderer: unknown, bar: model.Bar): BarRenderer }

const appScores = new WeakMap<model.Score, { intro?: IntroRange; hiddenKeys?: readonly number[] }>()
const introBounds = new WeakMap<rendering.BarBounds, { width: number; start: number; end: number }>()
const introPadding = 14
let installed = false

function withNote<T>(notes: model.Note[], note: model.Note, action: () => T): T {
  const first = notes[0]
  notes[0] = note
  try { return action() } finally { notes[0] = first }
}

function stack(container: BeatContainer, notes: model.Note[], pre: BeatGlyph & { skipLayout: boolean }, on: NoteGlyph) {
  const PreNotes = pre.constructor as new () => BeatGlyph
  const OnNotes = on.constructor as new () => NoteGlyph
  const extras = notes.slice(1).map((note) => ({ note, pre: new PreNotes(), on: new OnNotes(), y: 0 }))
  const layoutPre = pre.doLayout.bind(pre)
  const paintPre = pre.paint.bind(pre)
  let basePreWidth = 0
  let baseShift = 0
  pre.doLayout = () => {
    layoutPre()
    basePreWidth = pre.width
    if (pre.skipLayout) return
    for (const row of extras) {
      row.pre.renderer = pre.renderer
      row.pre.container = container
      withNote(notes, row.note, () => row.pre.doLayout())
      pre.width = Math.max(pre.width, row.pre.width)
    }
    pre.computedWidth = pre.width
  }
  pre.paint = (cx, cy, canvas) => {
    paintPre(cx + pre.width - basePreWidth, cy + baseShift, canvas)
    if (!pre.skipLayout) for (const row of extras) {
      row.pre.paint(cx + pre.x + pre.width - row.pre.width, cy + pre.y + row.y, canvas)
    }
  }

  const layoutNotes = on.doLayout.bind(on)
  const paintNotes = on.paint.bind(on)
  const top = on.getBoundingBoxTop.bind(on)
  const bottom = on.getBoundingBoxBottom.bind(on)
  const noteY = on.getNoteY.bind(on)
  const buildBounds = on.buildBoundingsLookup.bind(on)
  on.doLayout = () => {
    layoutNotes()
    const base = on.noteHeads
    baseShift = 0
    if (!base) return
    let upperEdge = base.getBoundingBoxTop()
    for (const row of extras) {
      row.on.renderer = on.renderer
      row.on.container = container
      withNote(notes, row.note, () => row.on.doLayout())
      const head = row.on.noteHeads
      if (!head) continue
      row.y = upperEdge - head.getBoundingBoxBottom() - 3
      upperEdge = row.y + head.getBoundingBoxTop()
    }
    // Put the center of the entire stack on the normal numbered-note baseline.
    baseShift = base.y - (upperEdge + base.getBoundingBoxBottom()) / 2
    base.y += baseShift
    for (const row of extras) row.y += baseShift
  }
  on.paint = (cx, cy, canvas) => {
    paintNotes(cx, cy, canvas)
    for (const row of extras) {
      const head = row.on.noteHeads
      if (!head) continue
      const x = on.onTimeX - head.x - head.width / 2
      withNote(notes, row.note, () => head.paint(cx + on.x + x, cy + on.y + row.y, canvas))
    }
  }
  on.getBoundingBoxTop = () => {
    const upper = extras.at(-1)!
    return upper.on.noteHeads ? Math.min(top(), upper.y + upper.on.noteHeads.getBoundingBoxTop()) : top()
  }
  on.getBoundingBoxBottom = () => Math.max(bottom(), on.noteHeads?.getBoundingBoxBottom() ?? 0)
  on.getNoteY = (note, position) => {
    const row = extras.find((item) => item.note === note)
    return row ? on.y + row.y + row.on.getNoteY(note, position) : noteY(note, position)
  }
  on.getHighestNoteY = (position) => on.getNoteY(extras.at(-1)!.note, position)
  on.buildBoundingsLookup = (bounds, cx, cy) => {
    if (!on.noteHeads) { buildBounds(bounds, cx, cy); return }
    const addBounds = (note: model.Note, head: Glyph, dy: number) => {
      const item = new rendering.NoteBounds()
      const box = new rendering.Bounds()
      box.x = cx + on.x + on.onTimeX - head.width / 2
      box.y = cy + on.y + dy + head.getBoundingBoxTop()
      box.w = head.width
      box.h = head.getBoundingBoxBottom() - head.getBoundingBoxTop()
      item.note = note
      item.noteHeadBounds = box
      bounds.addNote(item)
    }
    addBounds(notes[0], on.noteHeads, 0)
    for (const row of extras) if (row.on.noteHeads) addBounds(row.note, row.on.noteHeads, row.y)
  }
}

function underlineRest(renderer: BarRenderer, glyph: NoteGlyph, lines: number) {
  const spacing = renderer.beamSpacing + renderer.beamThickness
  const paint = glyph.paint.bind(glyph)
  const bottom = glyph.getBoundingBoxBottom.bind(glyph)
  glyph.getBoundingBoxBottom = () => bottom() + 2 + lines * spacing
  glyph.paint = (cx, cy, canvas) => {
    paint(cx, cy, canvas)
    const head = glyph.noteHeads
    if (!head) return
    const x = cx + glyph.x + head.x
    const y = cy + glyph.y + head.getBoundingBoxBottom() + 2
    for (let line = 0; line < lines; line++) {
      canvas.fillRect(x, y + line * spacing, head.width, renderer.beamThickness)
    }
  }
}

function reserveIntroPadding(renderer: BarRenderer, opening: boolean, closing: boolean) {
  if (opening) {
    const create = renderer.createPreBeatGlyphs.bind(renderer)
    renderer.createPreBeatGlyphs = () => {
      create()
      renderer._preBeatGlyphs.width += introPadding
    }
  }
  if (closing) {
    const create = renderer.createPostBeatGlyphs.bind(renderer)
    renderer.createPostBeatGlyphs = () => {
      create()
      // Place the whole barline, including repeat dots, after the parenthesis.
      const glyphs = renderer._postBeatGlyphs
      const paint = glyphs.paint.bind(glyphs)
      glyphs.width += introPadding
      glyphs.paint = (cx, cy, canvas) => paint(cx + introPadding, cy, canvas)
    }
  }
  const build = renderer.buildBoundingsLookup.bind(renderer)
  renderer.buildBoundingsLookup = (master, cx, cy) => {
    const first = master.bars.length
    build(master, cx, cy)
    for (const bounds of master.bars.slice(first)) {
      introBounds.set(bounds, { width: renderer.width, start: renderer.beatGlyphsStart, end: renderer.postBeatGlyphsStart })
    }
  }
}

export function introContentEdges(bar: rendering.BarBounds) {
  const bounds = introBounds.get(bar)
  if (!bounds?.width) return
  const { x, w } = bar.realBounds
  return { start: x + bounds.start * w / bounds.width, end: x + bounds.end * w / bounds.width }
}

export function enableScoreRendering(score: model.Score, intro?: IntroRange, hiddenKeys?: readonly number[]) {
  appScores.set(score, { intro, hiddenKeys })
  if (installed) return
  const factories = (Environment as unknown as { defaultRenderers: RendererFactory[] }).defaultRenderers
  installed = true
  for (const factory of factories) {
    const create = factory.create.bind(factory)
    factory.create = (renderer, bar) => {
      const result = create(renderer, bar)
      const options = appScores.get(bar.staff.track.score)
      if (!options) return result
      const range = options.intro
      if (range && (bar.index === range[0] || bar.index === range[1])) {
        reserveIntroPadding(result, bar.index === range[0], bar.index === range[1])
      }
      if (factory.staffId === 'numbered') patchNumberedNotation(result)
      if (factory.staffId === 'score') tagStaffKey(result, bar.index, options.hiddenKeys?.includes(bar.index) ?? false)
      return result
    }
  }
}

function tagStaffKey(renderer: BarRenderer, bar: number, hidden: boolean) {
  const create = renderer._createKeySignatureGlyphs?.bind(renderer)
  if (!create) return
  renderer._createKeySignatureGlyphs = () => {
    const add = renderer.addPreBeatGlyph
    renderer.addPreBeatGlyph = (glyph) => {
      if (glyph.isEmpty === false) {
        if (hidden) return
        const paint = glyph.paint.bind(glyph)
        glyph.paint = (x, y, canvas) => {
          canvas.beginGroup(`xianpu-staff-key-${bar}`)
          paint(x, y, canvas)
          canvas.endGroup()
        }
      }
      add.call(renderer, glyph)
    }
    try { create() } finally { renderer.addPreBeatGlyph = add }
  }
}

function patchNumberedNotation(result: BarRenderer) {
  // A rest-only beam has no highest note for alphaTab's overflow calculation.
  // Short rests draw their duration underlines with the zero glyph instead.
  const shouldPaint = result.shouldPaintBeamingHelper.bind(result)
  result.shouldPaintBeamingHelper = (helper) => !helper.isRestBeamHelper && shouldPaint(helper)
  const add = result.addBeatGlyph.bind(result)
  result.addBeatGlyph = (container) => {
    const { beat, preNotes, onNotes, barCount } = container
    if (beat && beat.notes.length > 1 && preNotes && onNotes) stack(container, beat.notes, preNotes, onNotes)
    if (beat?.isRest && !beat.isEmpty && onNotes) {
      const lines = barCount ?? Math.log2(beat.duration / 4)
      if (lines > 0) underlineRest(result, onNotes, lines)
    }
    add(container)
  }
}

type Staff = {
  topPadding: number; topOverflow: number; bottomPadding: number; height: number
  trackIndex: number; staffId: string; isVisible: boolean
  _applyStaffPaddings(): void
  resetSharedLayoutData(): void
  barRenderers: { x: number; y: number; bar: model.Bar; scaleToWidth(width: number): void }[]
}
type System = {
  accoladeWidth: number; width: number; x: number; y: number; lastBarIndex: number; allStaves: Staff[]
  reconcileMinDurationIfDirty(): void
  masterBarsRenderers: {
    maxFixedOverhead: number
    layoutingInfo: { minStretchForce: number; calculateVoiceWidth(force: number): number }
  }[]
}
type PageLayout = {
  _systems: System[]; _maxWidth: number; pagePadding: number[]; lastBarIndex: number
  _createStaffSystem(start: number, end: number): System
  _fitSystem(system: System): void
  _paintSystem(system: System, totalHeight: number): number
  _layoutAndRenderScore(y: number, start: number): number
  _scaleToWidth(system: System, width: number): void
}

function pageLayout(api: AlphaTabApi) {
  return (api.renderer as unknown as { instance?: { layout: PageLayout } }).instance?.layout
}

export function spaceTrackMarks(api: AlphaTabApi, padding: { above: number; below: number }[][],
  caption: { track: number; bars: ReadonlyMap<number, number>; extra: number }, gap: number) {
  const layout = pageLayout(api)
  if (!layout?._createStaffSystem) return
  const create = layout._createStaffSystem.bind(layout)
  layout._createStaffSystem = (start, end) => {
    const system = create(start, end)
    for (const [index, trackPadding] of padding.entries()) {
      const staves = system.allStaves.filter((staff) => staff.trackIndex === index &&
        ['score', 'numbered', 'tab'].includes(staff.staffId))
      const first = staves[0]
      const last = staves.at(-1)
      if (!first || !last) continue
      const measureIndices = first.barRenderers.map(({ bar }) => bar.index)
      const above = Math.max(0, ...measureIndices.map((bar) => trackPadding[bar].above))
      const below = Math.max(0, ...measureIndices.map((bar) => trackPadding[bar].below))
      const keySpace = caption.track === index && measureIndices.some((bar) => caption.bars.has(bar))
        ? caption.extra : 0
      const top = first._applyStaffPaddings.bind(first)
      first._applyStaffPaddings = () => { top(); first.topPadding += above + keySpace }
      const bottom = last._applyStaffPaddings.bind(last)
      last._applyStaffPaddings = () => { bottom(); last.bottomPadding += below }
      first._applyStaffPaddings()
      if (last !== first) last._applyStaffPaddings()
    }
    return system
  }
  if (gap >= 0) return
  const fit = layout._fitSystem.bind(layout)
  layout._fitSystem = (system) => {
    const heights = new Map<number, number>()
    for (const staff of system.allStaves) {
      if (staff.isVisible) heights.set(staff.trackIndex, (heights.get(staff.trackIndex) ?? 0) + staff.height)
    }
    const groups = [...heights.values()]
    // Preserve the order of the track origins even when a negative gap overlaps their content.
    api.settings.display.trackStaffPaddingBetween = Math.max(gap, 8 - Math.min(...groups.slice(0, -1)))
    try { fit(system) } finally { api.settings.display.trackStaffPaddingBetween = 0 }
  }
}

function barGrid(systems: System[], width: number, columns: number) {
  const count = Math.max(columns, ...systems.map((system) => system.masterBarsRenderers.length))
  const gutter = Math.max(0, ...systems.map((system) => system.accoladeWidth))
  const room = Math.max(0, width - gutter)
  const minimum = Array.from({ length: count }, () => 0)
  const fixed = [...minimum]
  for (const system of systems) {
    system.reconcileMinDurationIfDirty()
    for (const [index, { maxFixedOverhead, layoutingInfo }] of system.masterBarsRenderers.entries()) {
      fixed[index] = Math.max(fixed[index], maxFixedOverhead)
      minimum[index] = Math.max(minimum[index], maxFixedOverhead + layoutingInfo.calculateVoiceWidth(layoutingInfo.minStretchForce))
    }
  }
  const total = minimum.reduce((sum, value) => sum + value, 0)
  if (room < total) {
    const overhead = fixed.reduce((sum, value) => sum + value, 0)
    if (room <= overhead) return null
    return { gutter, widths: minimum.map((value, index) =>
      fixed[index] + (value - fixed[index]) * (room - overhead) / (total - overhead)) }
  }
  // Equalize columns wherever the glyphs fit, reserving extra space for wider columns.
  let remaining = room
  let slots = count
  for (const value of [...minimum].sort((a, b) => b - a)) {
    if (value <= remaining / slots || slots === 1) break
    remaining -= value
    slots--
  }
  return { gutter, widths: minimum.map((value) => Math.max(value, remaining / slots)) }
}

export function alignBarColumns(api: AlphaTabApi, columns: number) {
  const layout = pageLayout(api)
  if (!layout?._scaleToWidth) return
  const scaleToWidth = layout._scaleToWidth.bind(layout)
  let cached: { systems: System[]; width: number; grid: ReturnType<typeof barGrid> } | undefined
  layout._layoutAndRenderScore = (y, start) => {
    // Collect every row before fitting the first one so corresponding bars
    // can share a column even when their time signatures or contents differ.
    const first = layout._systems.length
    for (let index = start; index <= layout.lastBarIndex;) {
      const system = layout._createStaffSystem(index, layout.lastBarIndex)
      layout._systems.push(system)
      index = system.lastBarIndex + 1
    }
    cached = undefined
    for (const system of layout._systems.slice(first)) {
      system.x = layout.pagePadding[0]
      system.y = y
      layout._fitSystem(system)
      y += layout._paintSystem(system, y)
    }
    return y
  }
  layout._scaleToWidth = (system, width) => {
    if (cached?.systems !== layout._systems || cached.width !== layout._maxWidth) {
      cached = { systems: layout._systems, width: layout._maxWidth, grid: barGrid(layout._systems, layout._maxWidth, columns) }
    }
    if (!cached.grid) {
      scaleToWidth(system, width)
      return
    }
    const { gutter, widths } = cached.grid
    system.accoladeWidth = gutter
    for (const staff of system.allStaves) {
      staff.resetSharedLayoutData()
      let x = 0
      for (const [index, bar] of staff.barRenderers.entries()) {
        bar.x = x
        bar.y = staff.topPadding + staff.topOverflow
        bar.scaleToWidth(widths[index])
        x += widths[index]
      }
    }
    system.width = gutter + widths.slice(0, system.masterBarsRenderers.length).reduce((sum, value) => sum + value, 0)
  }
}
