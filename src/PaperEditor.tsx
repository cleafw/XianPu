import { useState } from 'react'
import { useLanguage } from './i18n'
import { paperDimensions, paperLimits, validPaper, type Paper } from './paper'

export function PaperEditor({ paper, inherited, onApply }: {
  paper?: Paper; inherited?: Paper; onApply: (value: Paper | undefined) => void
}) {
  const { t } = useLanguage()
  const [size, setSize] = useState<Paper['size'] | 'inherit'>(paper?.size ?? (inherited ? 'inherit' : 'a4'))
  const initial = paperDimensions(paper ?? inherited)
  const [width, setWidth] = useState(String(initial.width))
  const [height, setHeight] = useState(String(initial.height))
  const value = size === 'inherit' ? undefined : size === 'custom'
    ? { size, width: Number(width), height: Number(height) } as const : { size } as const
  const dimensions = paperDimensions(value ?? inherited)
  const valid = !value || validPaper(value)

  return <>
    <label>{t('纸张尺寸')}<select value={size} onChange={(event) => setSize(event.target.value as typeof size)}>
      {inherited && <option value="inherit">{t('跟随总谱')}</option>}
      <option value="a4">A4 · 210 × 297 mm</option>
      <option value="a3">A3 · 297 × 420 mm</option>
      <option value="custom">{t('自定义尺寸')}</option>
    </select></label>
    {size === 'custom' && <div className="field-row">
      <label>{t('纸张宽度（mm）')}<input type="number" value={width} min={paperLimits.minWidth} max={paperLimits.maxWidth}
        step="any" onChange={(event) => setWidth(event.target.value)} /></label>
      <label>{t('纸张高度（mm）')}<input type="number" value={height} min={paperLimits.minHeight} max={paperLimits.maxHeight}
        step="any" onChange={(event) => setHeight(event.target.value)} /></label>
    </div>}
    {!valid && <p role="alert" className="inline-error">{t('宽度须为 80–600 mm，高度须为 100–1000 mm。')}</p>}
    {valid && <p>{t('预览和 PDF 使用 {width} × {height} mm。', dimensions)}</p>}
    <button className="primary" disabled={!valid} onClick={() => onApply(value)}>{t('应用纸张设置')}</button>
  </>
}
