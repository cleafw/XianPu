import { useRef } from 'react'
import { ScoreView } from './ScoreView'
import { useLanguage } from './i18n'
import { paperFor, type Project } from './model'
import { paperDimensions, paperMargin, pxPerMm } from './paper'
import type { CSSProperties } from 'react'

const labelHeight = 28

export function PrintSheet({ project, part, onReady, onError }: {
  project: Project; part: string | null; onReady: () => void; onError: (error: Error) => void
}) {
  const { t } = useLanguage()
  const { width, height } = paperDimensions(paperFor(project, part))
  const contentHeight = Math.floor((height - 2 * paperMargin) * pxPerMm) - 2
  const source = useRef<HTMLDivElement>(null)
  const pages = useRef<HTMLDivElement>(null)
  const instrument = project.tracks.find((track) => track.id === part)
  const limit = (instrument?.layout ?? project.layout).systemsPerPage
  function paginate(systemCount: number) {
    if (!source.current || !pages.current) return
    const surface = source.current.querySelector('.at-surface')
    const fragments = [...(surface?.querySelectorAll<SVGSVGElement>(':scope > div > svg') ?? [])]
    if (!fragments.length || !systemCount || fragments.length <= systemCount) {
      onError(new Error('无法为这份乐谱生成打印版面。'))
      return
    }
    const hasFooter = fragments.at(-1)?.textContent?.includes('rendered by alphaTab')
    const end = fragments.length - (hasFooter ? 1 : 0)
    const firstSystem = end - systemCount
    pages.current.replaceChildren()
    let currentPage: HTMLDivElement
    let occupied = 0
    let systems = 0
    function newPage() {
      currentPage = document.createElement('div')
      // Preserve alphaTab’s font scope for the cloned SMuFL glyphs.
      currentPage.className = 'print-page ' + surface!.className
      const label = document.createElement('div')
      label.className = 'sheet-label'
      label.textContent = (instrument?.name ?? t('总谱')) + ' · ' + (pages.current!.childElementCount + 1)
      currentPage.append(label)
      pages.current!.append(currentPage)
      occupied = labelHeight
      systems = 0
    }
    newPage()
    for (const [index, svg] of fragments.entries()) {
      const system = index >= firstSystem && index < end
      const height = svg.height.baseVal.value
      const footerReserve = index === end - 1 && hasFooter ? fragments[end].height.baseVal.value : 0
      if (system && systems && (systems >= limit || occupied + height + footerReserve > contentHeight)) newPage()
      const copy = svg.cloneNode(true) as SVGSVGElement
      const maxHeight = contentHeight - occupied - footerReserve
      if (height > maxHeight && maxHeight > 30) {
        copy.setAttribute('viewBox', '0 0 ' + svg.width.baseVal.value + ' ' + height)
        copy.setAttribute('height', String(maxHeight))
      }
      currentPage!.append(copy)
      occupied += Math.min(height, Math.max(maxHeight, 0))
      if (system) systems++
    }
    onReady()
  }
  return <div className="print-sheet" style={{
    '--paper-width': width + 'mm', '--paper-height': height + 'mm', '--paper-margin': paperMargin + 'mm',
  } as CSSProperties}>
    <div className="print-render-source" ref={source} aria-hidden="true">
      <ScoreView project={project} part={part} onReady={paginate} onError={onError} />
    </div>
    <div className="print-pages" ref={pages} />
  </div>
}
