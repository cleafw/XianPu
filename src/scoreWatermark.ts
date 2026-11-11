import { defaultWatermarkStyle, type Project } from './model'

const svgNamespace = 'http://www.w3.org/2000/svg'
const fontFamily = 'Segoe UI, Microsoft YaHei UI, Microsoft YaHei, PingFang SC, sans-serif'
let nextPattern = 0
let measureContext: CanvasRenderingContext2D | null = null

function element<K extends keyof SVGElementTagNameMap>(tag: K, attributes: Record<string, string | number>) {
  const node = document.createElementNS(svgNamespace, tag)
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value))
  return node
}

function measureWidth(text: string, fontSize: number) {
  measureContext ??= document.createElement('canvas').getContext('2d')
  if (!measureContext) return [...text].length * fontSize
  measureContext.font = `600 ${fontSize}px ${fontFamily}`
  return measureContext.measureText(text).width
}

export function createScoreWatermark(project: Pick<Project, 'watermark' | 'watermarkStyle'>) {
  const text = project.watermark?.trim()
  if (!text) return

  const { layout, size, angle, opacity } = project.watermarkStyle ?? defaultWatermarkStyle
  const scale = size / 100
  const svg = element('svg', { class: 'score-watermark', 'aria-hidden': 'true' })
  const label = element('text', {
    'text-anchor': 'middle', 'dominant-baseline': 'middle',
    'font-family': fontFamily, 'font-weight': 600, fill: '#374f46', 'fill-opacity': opacity / 100,
  })
  label.textContent = text

  if (layout === 'single') {
    const fontSize = 56 * scale
    const radians = angle * Math.PI / 180
    const maxTextWidth = Math.min(520 / Math.abs(Math.cos(radians)), 330 / Math.abs(Math.sin(radians)))
    const width = measureWidth(text, fontSize)
    svg.setAttribute('viewBox', '0 0 600 400')
    label.setAttribute('x', '300')
    label.setAttribute('y', '200')
    label.setAttribute('transform', `rotate(${angle} 300 200)`)
    label.setAttribute('font-size', String(fontSize * Math.min(1, maxTextWidth / width)))
    svg.append(label)
    return svg
  }

  const fontSize = 20 * scale
  const width = Math.max(150 * scale, measureWidth(text, fontSize) + 44 * scale)
  const height = 66 * scale
  const id = 'xianpu-watermark-' + ++nextPattern
  const pattern = element('pattern', { id, width, height, patternUnits: 'userSpaceOnUse', patternTransform: `rotate(${angle})` })
  label.setAttribute('x', String(width / 2))
  label.setAttribute('y', String(height / 2))
  label.setAttribute('font-size', String(fontSize))
  pattern.append(label)
  const definitions = element('defs', {})
  definitions.append(pattern)
  svg.append(definitions, element('rect', { width: '100%', height: '100%', fill: `url(#${id})` }))
  return svg
}
