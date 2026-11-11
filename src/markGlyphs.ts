import { model } from '@coderline/alphatab'
import { symbols, type SymbolCode } from './notationMarks'

const { MusicFontSymbol: smufl } = model

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
}

export function markSymbol(code: SymbolCode, below = false) {
  const glyph = glyphs[code]
  return typeof glyph === 'number' ? glyph : glyph?.[below ? 1 : 0] ?? symbols[code][3]
}
