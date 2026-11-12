import { model } from '@coderline/alphatab'
import { symbols, type SymbolCode } from './notationMarks'

const { MusicFontSymbol: smufl } = model
type MarkGraphic = { path: string }
export type MarkSymbol = string | number | MarkGraphic

const arpeggioWave = 'M 0 -6 Q -4 -4 0 -2 Q 4 0 0 2 Q -4 4 0 6'
const graphics: Partial<Record<SymbolCode, MarkGraphic>> = {
  fluteRunUp: { path: 'M -6 6 L -3 2 L -2 2 L 1 -2 L 2 -2 L 6 -7' },
  fluteRunDown: { path: 'M -6 -7 L -2 -2 L -1 -2 L 2 2 L 3 2 L 6 6' },
  arpeggioUp: { path: arpeggioWave + ' M -3 -4 L 0 -7 L 3 -4' },
  arpeggioDown: { path: arpeggioWave + ' M -3 4 L 0 7 L 3 4' },
  nonArpeggio: { path: 'M 3 -7 H -2 V 7 H 3' },
}

const glyphs: Partial<Record<SymbolCode, number | readonly [number, number]>> = {
  accent: [smufl.ArticAccentAbove, smufl.ArticAccentBelow],
  staccato: [smufl.ArticStaccatoAbove, smufl.ArticStaccatoBelow],
  staccatissimo: [0xe4a6, 0xe4a7],
  tenuto: [smufl.ArticTenutoAbove, smufl.ArticTenutoBelow],
  marcato: [smufl.ArticMarcatoAbove, smufl.ArticMarcatoBelow],
  fermata: [smufl.FermataAbove, 0xe4c1],
  breath: 0xe4ce,
  caesura: 0xe4d1,
  trill: smufl.OrnamentTrill,
  fluteTrill: smufl.OrnamentTrill,
  mordent: smufl.OrnamentMordent,
  turn: smufl.OrnamentTurn,
  arpeggio: 0xeaa9,
  ppp: smufl.DynamicPPP,
  pp: smufl.DynamicPP,
  p: smufl.DynamicPiano,
  mp: smufl.DynamicMP,
  mf: smufl.DynamicMF,
  f: smufl.DynamicForte,
  ff: smufl.DynamicFF,
  fff: smufl.DynamicFFF,
  sfz: smufl.DynamicSforzato,
  fp: smufl.DynamicFortePiano,
  downBow: smufl.StringsDownBow,
  upBow: smufl.StringsUpBow,
  bowTremolo: smufl.Tremolo3,
  drumRoll: smufl.Tremolo3,
  pedalDown: smufl.KeyboardPedalPed,
  pedalUp: smufl.KeyboardPedalUp,
  guitarHarmonic: 0xe614,
  guitarStrumUp: 0xe846,
  guitarStrumDown: 0xe847,
  upperMordent: smufl.OrnamentShortTrill,
  lowerMordent: smufl.OrnamentMordent,
  invertedTurn: smufl.OrnamentTurnInverted,
  tenutoStaccato: [0xe4b2, 0xe4b3],
  shortFermata: [0xe4c4, 0xe4c5],
  longFermata: [0xe4c6, 0xe4c7],
  tremoloSingle: smufl.Tremolo3,
  guzhengArpeggio: 0xeaa9,
  guitarGolpe: smufl.GuitarGolpe,
  guitarVibrato: smufl.GuitarVibratoStroke,
  guitarWideVibrato: smufl.GuitarWideVibratoStroke,
  guitarTremoloPick: smufl.Tremolo3,
  guitarPickUp: smufl.StringsUpBow,
  guitarPickDown: smufl.StringsDownBow,
  windDouble: [0xe5f0, 0xe5f1],
  windTriple: [0xe5f2, 0xe5f3],
  windClosed: 0xe5f4,
  windHalfHole: 0xe5f6,
  windOpen: 0xe5f9,
  windTrillKey: 0xe5fa,
  fluteHalfHole: 0xe5f6,
  fluteMordentUp: smufl.OrnamentShortTrill,
  fluteMordentDown: smufl.OrnamentMordent,
  voiceBreath: 0xe4ce,
  erhuTremolo: smufl.Tremolo3,
  bowHarmonic: 0xe614,
  bowThumb: 0xe624,
  windScoop: 0xe5d0,
  windDoit: 0xe5d4,
  windFall: 0xe5d7,
  windPlop: 0xe5e0,
  windMute: 0xe5e5,
  windUnmute: 0xe5e7,
  pedalHalf: 0xe656,
  sostenutoPedal: 0xe659,
}

export function markSymbol(code: SymbolCode, below = false): MarkSymbol {
  const graphic = graphics[code]
  if (graphic) return graphic
  const glyph = glyphs[code]
  return typeof glyph === 'number' ? glyph : glyph?.[below ? 1 : 0] ?? symbols[code][3]
}
