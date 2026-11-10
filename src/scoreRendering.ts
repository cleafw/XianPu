import { Environment, rendering, type AlphaTabApi, type model, type platform } from '@coderline/alphatab'

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
type BeatContainer = { beat?: model.Beat; preNotes?: BeatGlyph & { skipLayout: boolean }; onNotes?: NoteGlyph }
type BarRenderer = { addBeatGlyph(container: BeatContainer): void }
type NumberedFactory = { staffId: string; create(renderer: unknown, bar: model.Bar): BarRenderer }

const appScores = new WeakSet<model.Score>()
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
    paintPre(cx + pre.width - basePreWidth, cy, canvas)
    if (!pre.skipLayout) for (const row of extras) {
      row.pre.paint(cx + pre.x + pre.width - row.pre.width, cy + pre.y + row.y, canvas)
    }
  }

  const layoutNotes = on.doLayout.bind(on)
  const paintNotes = on.paint.bind(on)
  const top = on.getBoundingBoxTop.bind(on)
  const noteY = on.getNoteY.bind(on)
  const buildBounds = on.buildBoundingsLookup.bind(on)
  on.doLayout = () => {
    layoutNotes()
    let upperEdge = on.noteHeads?.getBoundingBoxTop() ?? 0
    for (const row of extras) {
      row.on.renderer = on.renderer
      row.on.container = container
      withNote(notes, row.note, () => row.on.doLayout())
      const head = row.on.noteHeads
      if (!head) continue
      row.y = upperEdge - head.getBoundingBoxBottom() - 3
      upperEdge = row.y + head.getBoundingBoxTop()
    }
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
  on.getBoundingBoxTop = () => extras.at(-1)!.y + (extras.at(-1)!.on.noteHeads?.getBoundingBoxTop() ?? top())
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

export function enableNumberedStacks(score: model.Score) {
  appScores.add(score)
  if (installed) return
  const factories = (Environment as unknown as { defaultRenderers: NumberedFactory[] }).defaultRenderers
  const numbered = factories.find((factory) => factory.staffId === 'numbered')
  if (!numbered) return
  installed = true
  const create = numbered.create.bind(numbered)
  numbered.create = (renderer, bar) => {
    const result = create(renderer, bar)
    if (!appScores.has(bar.staff.track.score)) return result
    const add = result.addBeatGlyph.bind(result)
    result.addBeatGlyph = (container) => {
      const { beat, preNotes, onNotes } = container
      if (beat && beat.notes.length > 1 && preNotes && onNotes) stack(container, beat.notes, preNotes, onNotes)
      add(container)
    }
    return result
  }
}

type Staff = {
  topPadding: number; topOverflow: number
  resetSharedLayoutData(): void
  barRenderers: { x: number; y: number; scaleToWidth(width: number): void }[]
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
  const layout = (api.renderer as unknown as { instance?: { layout: PageLayout } }).instance?.layout
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
