const jumps = {
  daCapo: { start: 'beginning', finish: 'end' },
  daCapoAlFine: { start: 'beginning', finish: 'fine' },
  daCapoAlCoda: { start: 'beginning', finish: 'toCoda' },
  dalSegno: { start: 'segno', finish: 'end' },
  dalSegnoAlFine: { start: 'segno', finish: 'fine' },
  dalSegnoAlCoda: { start: 'segno', finish: 'toCoda' },
} as const

type JumpDirection = keyof typeof jumps
type TargetDirection = 'segno' | 'fine' | 'toCoda' | 'coda'

export type NavigationDirection = JumpDirection | TargetDirection

export type NavigationMeasure = {
  start?: boolean
  end?: boolean
  repeatCount?: number
  /** Set on the first bar of the ending. Length counts bars and defaults to one. */
  ending?: { number: 1 | 2; length?: number }
  directions?: readonly NavigationDirection[]
}

type DiagnosticCode =
  | 'invalid-repeat-count'
  | 'invalid-ending-range'
  | 'missing-target'
  | 'duplicate-target'
  | 'conflicting-jumps'
  | 'unreachable-target'
  | 'invalid-jump'

export type NavigationDiagnostic = {
  code: DiagnosticCode
  measureIndex: number
  message: string
  direction?: NavigationDirection
}

export type ScoreNavigation = {
  /** Zero-based measure indices. Empty when navigation has errors. */
  order: number[]
  diagnostics: NavigationDiagnostic[]
  /** Per-measure alternate-ending bitmasks for engraving. */
  endingMasks: number[]
}

type Repeat = { start: number; end: number; count: number }
type Ending = { start: number; end: number; number: 1 | 2 }

function isJump(direction: NavigationDirection): direction is JumpDirection {
  return Object.hasOwn(jumps, direction)
}

/** Resolve written repeats, one D.C./D.S. return, and an optional coda. */
export function resolveScoreNavigation(measures: readonly NavigationMeasure[]): ScoreNavigation {
  const order: number[] = []
  const diagnostics: NavigationDiagnostic[] = []
  const endingMasks = measures.map(() => 0)
  const report = (code: DiagnosticCode, measureIndex: number, message: string, direction?: NavigationDirection) => {
    diagnostics.push({ code, measureIndex, message, direction })
  }

  const repeats = new Map<number, Repeat>()
  const endings: Ending[] = []
  const targets = new Map<TargetDirection, number[]>()
  let repeatStart = 0
  let jump: { index: number; direction: JumpDirection } | undefined

  for (const [index, measure] of measures.entries()) {
    if (measure.start) repeatStart = index
    if (measure.end) {
      const count = measure.repeatCount ?? 2
      if (!Number.isInteger(count) || count < 2 || count > 8) {
        report('invalid-repeat-count', index, 'Repeat count must be an integer from 2 to 8.')
      }
      repeats.set(index, { start: repeatStart, end: index, count })
      repeatStart = index + 1
    }

    if (measure.ending) {
      const { number, length = 1 } = measure.ending
      const previous = endings.at(-1)
      if ((number !== 1 && number !== 2) || !Number.isSafeInteger(length) || length < 1 || length > measures.length - index) {
        report('invalid-ending-range', index, 'An ending must be numbered 1 or 2 and span one or more bars within the score.')
      } else if (previous && index <= previous.end) {
        report('invalid-ending-range', index, 'Ending ranges cannot overlap.')
      } else {
        endings.push({ start: index, end: index + length - 1, number })
      }
    }

    for (const direction of measure.directions ?? []) {
      if (isJump(direction)) {
        if (jump) report('conflicting-jumps', index, 'The score can contain one D.C. or D.S. instruction.', direction)
        else jump = { index, direction }
      } else {
        const matches = targets.get(direction)
        if (matches) {
          matches.push(index)
          report('duplicate-target', index, `The score contains more than one ${direction} mark.`, direction)
        } else targets.set(direction, [index])
      }
    }
  }

  const secondEndingEnds = new Map<number, number>()
  let firstEnding: Ending | undefined
  for (const ending of endings) {
    if (ending.number === 1) {
      firstEnding = undefined
      const repeat = repeats.get(ending.end)
      if (!repeat || ending.start < repeat.start || repeat.count !== 2) {
        report('invalid-ending-range', ending.start, 'The first ending must end at the closing barline of a two-pass repeat.')
        continue
      }
      firstEnding = ending
    } else {
      if (!firstEnding || ending.start !== firstEnding.end + 1) {
        report('invalid-ending-range', ending.start, 'The second ending must immediately follow its first ending.')
        continue
      }
      const containsRepeat = measures.slice(ending.start, ending.end + 1).some(({ start, end }) => start || end)
      if (containsRepeat) {
        report('invalid-ending-range', ending.start, 'A second ending cannot contain a repeat barline.')
        continue
      }
      secondEndingEnds.set(firstEnding.end, ending.end)
      firstEnding = undefined
    }
    endingMasks.fill(1 << (ending.number - 1), ending.start, ending.end + 1)
  }

  let previousRepeatEnd = -1
  for (const repeat of repeats.values()) {
    const previousSecondEnding = secondEndingEnds.get(previousRepeatEnd)
    if (previousSecondEnding !== undefined) repeat.start = Math.max(repeat.start, previousSecondEnding + 1)
    previousRepeatEnd = repeat.end
  }

  const jumpIndex = jump?.index
  const jumpRepeat = jumpIndex === undefined ? undefined : [...repeats.values()].find(({ start, end }) => start <= jumpIndex && jumpIndex <= end)
  const writtenEnd = jumpRepeat?.end ?? jumpIndex ?? measures.length - 1
  let returnStart: number | undefined
  let returnEnd = measures.length - 1
  let codaStart: number | undefined
  if (jump) {
    const { index, direction } = jump
    const { start, finish } = jumps[direction]
    if (endingMasks[index] === 1) {
      report('invalid-jump', index, 'D.C. or D.S. must be on a bar played on the final repeat pass.', direction)
    }

    const findTarget = (target: TargetDirection) => {
      const matches = targets.get(target)
      if (!matches) report('missing-target', index, `${direction} requires a ${target} mark.`, target)
      return matches?.length === 1 ? matches[0] : undefined
    }

    returnStart = start === 'segno' ? findTarget('segno') : 0
    if (start === 'segno' && returnStart !== undefined && (returnStart >= index || endingMasks[returnStart] === 1)) {
      report('unreachable-target', returnStart, 'Segno must be before D.S. and outside the first ending.', 'segno')
    }

    if (finish !== 'end') {
      const targetIndex = findTarget(finish)
      if (targetIndex !== undefined) {
        if (targetIndex < (returnStart ?? 0) || targetIndex > index || endingMasks[targetIndex] === 1) {
          report('unreachable-target', targetIndex, `${finish} must be on the return path.`, finish)
        }
        returnEnd = targetIndex
      }
      if (finish === 'toCoda') {
        codaStart = findTarget('coda')
        if (codaStart !== undefined && codaStart <= writtenEnd) {
          report('unreachable-target', codaStart, 'Coda must follow the passage played before the return.', 'coda')
        }
      }
    }
  }

  const toCoda = targets.get('toCoda')?.[0]
  if (toCoda !== undefined && (!jump || jumps[jump.direction].finish !== 'toCoda') && !targets.has('coda')) {
    report('missing-target', toCoda, 'To Coda requires a Coda mark.', 'coda')
  }

  if (diagnostics.length) return { order, diagnostics, endingMasks }

  // Repeat sections never overlap. Each written bar is visited at most eight
  // times in a written passage, and the return pass walks forward once.
  const playWritten = (from: number, through: number, finalPassEnd?: number) => {
    for (let index = from; index <= through; index++) {
      order.push(index)
      const repeat = repeats.get(index)
      if (!repeat || repeat.start < from) continue
      for (let pass = 2; pass <= repeat.count; pass++) {
        const end = repeat === jumpRepeat && pass === repeat.count ? finalPassEnd ?? index : index
        for (let bar = repeat.start; bar <= end; bar++) {
          if (endingMasks[bar] !== 1) order.push(bar)
        }
      }
    }
  }

  playWritten(0, writtenEnd, jumpIndex)
  if (returnStart !== undefined) {
    // On the return, bypass repeat signs and take the final ending.
    for (let index = returnStart; index <= returnEnd; index++) {
      if (endingMasks[index] !== 1) order.push(index)
    }
  }
  if (codaStart !== undefined) playWritten(codaStart, measures.length - 1)

  return { order, diagnostics, endingMasks }
}
