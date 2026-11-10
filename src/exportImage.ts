import bravura from '@coderline/alphatab/font/Bravura.woff2?url'

const svgNamespace = 'http://www.w3.org/2000/svg'
const imageScale = 2
let musicFont: Promise<string> | undefined

function embeddedMusicFont() {
  musicFont ??= (async () => {
    const response = await fetch(bravura)
    if (!response.ok) throw new Error('无法生成 PNG 图片。')
    const blob = await response.blob()
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as string)
      reader.onerror = () => reject(reader.error)
      reader.readAsDataURL(blob)
    })
  })().catch((error) => { musicFont = undefined; throw error })
  return musicFont
}

export async function renderPng(page: HTMLElement) {
  const font = await embeddedMusicFont()
  const bounds = page.getBoundingClientRect()
  const sheet = document.createElementNS(svgNamespace, 'svg')
  sheet.setAttribute('width', String(bounds.width))
  sheet.setAttribute('height', String(bounds.height))
  const style = document.createElementNS(svgNamespace, 'style')
  style.textContent = `@font-face { font-family: XianPuExportMusic; src: url("${font}") format("woff2"); }`
  sheet.append(style)

  for (const fragment of page.querySelectorAll<SVGSVGElement>(':scope > svg')) {
    const box = fragment.getBoundingClientRect()
    const clone = fragment.cloneNode(true) as SVGSVGElement
    clone.setAttribute('x', String(box.left - bounds.left))
    clone.setAttribute('y', String(box.top - bounds.top))
    clone.setAttribute('width', String(box.width))
    clone.setAttribute('height', String(box.height))
    const symbols = fragment.querySelectorAll<SVGTextElement>('.at > text')
    clone.querySelectorAll<SVGTextElement>('.at > text').forEach((symbol, index) => {
      symbol.style.fontFamily = 'XianPuExportMusic'
      symbol.style.fontSize = getComputedStyle(symbols[index]).fontSize
    })
    sheet.append(clone)
  }

  const svg = new Blob([new XMLSerializer().serializeToString(sheet)], { type: 'image/svg+xml;charset=utf-8' })
  const url = URL.createObjectURL(svg)
  const canvas = document.createElement('canvas')
  try {
    const image = new Image()
    image.src = url
    await image.decode()
    canvas.width = Math.round(bounds.width * imageScale)
    canvas.height = Math.round(bounds.height * imageScale)
    const context = canvas.getContext('2d', { alpha: false })
    if (!context) throw new Error('无法生成 PNG 图片。')
    context.scale(canvas.width / bounds.width, canvas.height / bounds.height)
    context.fillStyle = '#fff'
    context.fillRect(0, 0, bounds.width, bounds.height)
    context.drawImage(image, 0, 0, bounds.width, bounds.height)
    const label = page.querySelector<HTMLElement>('.sheet-label')
    if (label) {
      const box = label.getBoundingClientRect()
      const style = getComputedStyle(label)
      context.fillStyle = style.color
      context.font = `${style.fontSize} ${style.fontFamily}`
      context.textAlign = 'right'
      context.textBaseline = 'top'
      context.fillText(label.textContent, box.right - bounds.left - parseFloat(style.paddingRight), box.top - bounds.top + parseFloat(style.paddingTop))
    }
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('无法生成 PNG 图片。')), 'image/png')
    })
  } finally {
    URL.revokeObjectURL(url)
    canvas.width = canvas.height = 0
  }
}
