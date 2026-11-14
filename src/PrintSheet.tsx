import { useRef } from 'react'
import { ScoreView } from './ScoreView'
import { useLanguage } from './i18n'
import { pageSystemLimitFor, paperFor, type Project } from './model'
import { paperDimensions, paperMarginCss, pxPerMm, type PaperMargins } from './paper'
import { createScoreWatermark } from './scoreWatermark'
import type { CSSProperties } from 'react'

export function PrintSheet({ project, part, margins, onReady, onError }: {
  project: Project; part: string | null; margins: PaperMargins; onReady: (pages: HTMLElement[]) => void; onError: (error: Error) => void
}) {
  const { t } = useLanguage()
  const { width, height } = paperDimensions(paperFor(project, part))
  const verticalInset = margins.top + margins.bottom
  const contentHeight = Math.floor((height - verticalInset) * pxPerMm) - 2
  const source = useRef<HTMLDivElement>(null)
  const pages = useRef<HTMLDivElement>(null)
  const instrument = project.tracks.find((track) => track.id === part)
  const layout = instrument?.layout ?? project.layout
  const limit = pageSystemLimitFor(layout)
  function paginate(systemCount: number, firstBars: number[]) {
    if (!source.current || !pages.current) return
    const surface = source.current.querySelector('.at-surface')
    const fragments = [...(surface?.querySelectorAll<SVGSVGElement>(':scope > div > svg') ?? [])]
    if (!systemCount || fragments.length < systemCount) {
      onError(new Error('无法为这份乐谱生成打印版面。'))
      return
    }
    const firstSystem = fragments.length - systemCount
    pages.current.replaceChildren()
    let currentPage: HTMLDivElement
    let footer: HTMLDivElement | undefined
    let watermark: SVGSVGElement | undefined
    let occupied = 0
    let systems = 0
    function newPage() {
      currentPage = document.createElement('div')
      // Preserve alphaTab’s font scope for the cloned SMuFL glyphs.
      currentPage.className = 'print-page ' + surface!.className
      const label = document.createElement('div')
      label.className = 'sheet-label'
      const heading = layout.printHeader || (instrument ? instrument.name + (instrument.scoreNote ? ' · ' + instrument.scoreNote : '') : t('总谱'))
      label.textContent = heading + (layout.showPageNumbers === false ? '' : ' · ' + (pages.current!.childElementCount + 1))
      currentPage.append(label)
      footer = layout.printFooter ? document.createElement('div') : undefined
      if (footer) {
        footer.className = 'sheet-label sheet-footer'
        footer.textContent = layout.printFooter ?? ''
        currentPage.append(footer)
      }
      watermark = createScoreWatermark(project)
      if (watermark) currentPage.append(watermark)
      pages.current!.append(currentPage)
      occupied = label.getBoundingClientRect().height + (footer?.getBoundingClientRect().height ?? 0)
      systems = 0
    }
    newPage()
    for (const [index, svg] of fragments.entries()) {
      const system = index >= firstSystem
      const height = svg.height.baseVal.value
      if (system && systems && (limit > 0 && systems >= limit ||
        layout.pageBreaks?.includes(firstBars[index - firstSystem]) || occupied + height > contentHeight)) newPage()
      const copy = svg.cloneNode(true) as SVGSVGElement
      const maxHeight = contentHeight - occupied
      if (height > maxHeight && maxHeight > 30) {
        copy.setAttribute('viewBox', '0 0 ' + svg.width.baseVal.value + ' ' + height)
        copy.setAttribute('height', String(maxHeight))
      }
      currentPage!.insertBefore(copy, footer ?? watermark ?? null)
      occupied += Math.min(height, Math.max(maxHeight, 0))
      if (system) systems++
    }
    onReady([...pages.current.querySelectorAll<HTMLElement>('.print-page')])
  }
  return <div className="print-sheet" style={{
    '--paper-width': width + 'mm', '--paper-height': height + 'mm', '--paper-margin': paperMarginCss(margins),
    '--paper-inset-x': margins.left + margins.right + 'mm', '--paper-inset-y': verticalInset + 'mm',
  } as CSSProperties}>
    <div className="print-render-source" ref={source} aria-hidden="true">
      <ScoreView project={project} part={part} print onReady={paginate} onError={onError} />
    </div>
    <div className="print-pages" ref={pages} />
  </div>
}
