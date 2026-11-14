export type Paper = { size: 'a4' | 'a3' } | { size: 'custom'; width: number; height: number }

export const paperMargin = 12
export type PaperMargins = { top: number; right: number; bottom: number; left: number }
export const marginSides = ['top', 'right', 'bottom', 'left'] as const
const uniformMargins = (size: number): PaperMargins => ({ top: size, right: size, bottom: size, left: size })
export const marginPresets = { narrow: uniformMargins(6), normal: uniformMargins(paperMargin), wide: uniformMargins(20) }
export const maxPaperMargin = 100
export const paperMarginValues = (margins: PaperMargins) => marginSides.map((side) => margins[side])
export const paperMarginCss = (margins: PaperMargins) => paperMarginValues(margins).map((value) => value + 'mm').join(' ')
export function validPaperMargins(margins: PaperMargins, { width, height }: { width: number; height: number }) {
  return paperMarginValues(margins).every((value) => Number.isFinite(value) && value >= 0 && value <= maxPaperMargin) &&
    width - margins.left - margins.right >= 40 && height - margins.top - margins.bottom >= 40
}
export const pxPerMm = 96 / 25.4
export const paperLimits = { minWidth: 80, maxWidth: 600, minHeight: 100, maxHeight: 1000 }

export function paperDimensions(paper?: Paper) {
  if (paper?.size === 'custom') return { width: paper.width, height: paper.height }
  if (paper?.size === 'a3') return { width: 297, height: 420 }
  return { width: 210, height: 297 }
}

export function validPaper(paper: unknown): paper is Paper {
  if (!paper || typeof paper !== 'object' || !('size' in paper)) return false
  if (paper.size === 'a4' || paper.size === 'a3') return true
  if (paper.size !== 'custom' || !('width' in paper) || !('height' in paper)) return false
  return typeof paper.width === 'number' && Number.isFinite(paper.width) &&
    paper.width >= paperLimits.minWidth && paper.width <= paperLimits.maxWidth &&
    typeof paper.height === 'number' && Number.isFinite(paper.height) &&
    paper.height >= paperLimits.minHeight && paper.height <= paperLimits.maxHeight
}
