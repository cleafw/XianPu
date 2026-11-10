import { useState } from 'react'
import { useLanguage } from './i18n'
import { soundFor, sounds } from './sounds'
import type { Track } from './model'

export function SoundEditor({ tracks, onChange }: { tracks: Track[]; onChange: (sound: number, track?: string) => void }) {
  const { language, t } = useLanguage()
  const [all, setAll] = useState(52)
  const options = sounds.map(([program, zh, en]) => <option key={program} value={program}>{language === 'zh' ? zh : en}</option>)
  return <>
    <p>{t('音色只影响试听，谱面和音符保持原样。')}</p>
    <div className="field-row">
      <label>{t('统一音色')}<select value={all} onChange={(event) => setAll(Number(event.target.value))}>{options}</select></label>
      <button onClick={() => onChange(all)}>{t('应用到所有声部')}</button>
    </div>
    <div className="sound-tracks">{tracks.map((track) => <label key={track.id}>{track.name}
      <select value={soundFor(track)} onChange={(event) => onChange(Number(event.target.value), track.id)}>{options}</select>
    </label>)}</div>
  </>
}
