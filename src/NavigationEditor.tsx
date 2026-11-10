import { useLanguage, type Language, type TextKey, type Translate } from './i18n'
import { navigationDirections, type Measure } from './model'
import { resolveScoreNavigation, type NavigationDiagnostic, type NavigationDirection } from './scoreNavigation'

const diagnoses: Record<NavigationDiagnostic['code'], TextKey> = {
  'invalid-repeat-count': '反复遍数应为 2 至 8。',
  'invalid-ending-range': '请检查房子的范围、反复结束线和第一房／第二房的顺序。',
  'missing-target': '缺少 {direction} 记号。',
  'duplicate-target': '{direction} 记号重复。',
  'conflicting-jumps': '一首曲谱只能设置一处 D.C. 或 D.S.。',
  'unreachable-target': '{direction} 不在可到达的跳转路径上。',
  'invalid-jump': '跳转必须放在最后一遍会经过的小节。',
}

export function navigationMessage(t: Translate, language: Language, issue: NavigationDiagnostic) {
  return t('第 {bar} 小节 · {detail}', { bar: issue.measureIndex + 1, detail: language === 'en' ? issue.message :
    t(diagnoses[issue.code], { direction: issue.direction ? navigationDirections[issue.direction] : '—' }) })
}

export function NavigationEditor({ measures, index, apply }: {
  measures: Measure[]; index: number; apply: (values: Partial<Measure>) => void
}) {
  const { t, language } = useLanguage()
  const measure = measures[index]
  const diagnostics = resolveScoreNavigation(measures).diagnostics
  return <fieldset><legend>{t('第 {bar} 小节的曲式与小节线', { bar: index + 1 })}</legend>
    <div className="field-row">
      <label>{t('小节线')}<select value={measure.barline ?? ''} onChange={(event) =>
        apply({ barline: (event.target.value || undefined) as Measure['barline'] })}>
        <option value="">{t('普通小节线')}</option><option value="double">{t('双小节线')}</option><option value="final">{t('终止线')}</option>
      </select></label>
      <label>{t('排练号')}<input maxLength={30} value={measure.rehearsal ?? ''} onChange={(event) =>
        apply({ rehearsal: event.target.value || undefined })} /></label>
    </div>
    <div className="field-row">
      <label>{t('反复房子')}<select value={measure.ending?.number ?? 0} onChange={(event) => {
        const number = Number(event.target.value)
        apply({ ending: number === 1 || number === 2 ? { number, length: measure.ending?.length ?? 1 } : undefined })
      }}><option value="0">{t('无房子')}</option><option value="1">{t('第一房')}</option><option value="2">{t('第二房')}</option></select></label>
      {measure.ending && <label>{t('房子小节数')}<select value={measure.ending.length ?? 1} onChange={(event) =>
        apply({ ending: { ...measure.ending!, length: Number(event.target.value) } })}>
        {Array.from({ length: Math.max(measure.ending.length ?? 1, measures.length - index) }, (_, i) => <option key={i}>{i + 1}</option>)}
      </select></label>}
      <label>{t('小节重复')}<select value={measure.simile === 'double-second' ? 'double-second' : measure.simile ?? ''} onChange={(event) =>
        apply({ simile: (event.target.value || undefined) as Measure['simile'] })}>
        <option value="">{t('无小节重复')}</option><option value="single" disabled={index < 1}>{t('重复前一小节')}</option>
        <option value="double" disabled={index < 2 || index === measures.length - 1}>{t('重复前两小节')}</option>
        {measure.simile === 'double-second' && <option value="double-second" disabled>{t('重复前两小节')} · 2</option>}
      </select></label>
    </div>
    <details><summary>{t('跳转与目标')}</summary>
      {Object.entries(navigationDirections).map(([key, label]) => {
        const direction = key as NavigationDirection
        return <label className="checkbox" key={direction}><input type="checkbox" checked={measure.directions?.includes(direction) ?? false}
          onChange={(event) => apply({ directions: event.target.checked ? [...measure.directions ?? [], direction] :
            measure.directions?.filter((item) => item !== direction) })} />{label}</label>
      })}
    </details>
    {diagnostics.map((issue, n) => <p key={n} className="inline-error">{navigationMessage(t, language, issue)}</p>)}
  </fieldset>
}
