// Shared state of the oemer post-processing port (oemer keeps these in a global "layers" registry).

import { raster, type Raster } from './cv';
import { npMean } from './pyport';

export interface ModelMaps {
  width: number;
  height: number;
  staff: Uint8Array;
  symbols: Uint8Array;
  stemsRests: Uint8Array;
  notehead: Uint8Array;
  clefsKeys: Uint8Array;
}

export class OemerContext {
  readonly width: number;
  readonly height: number;
  readonly staffPred: Raster;
  /** symbols + clefs/keys + stems/rests, clipped to 1 (as ete.extract registers it). */
  readonly symbolsPred: Raster;
  readonly stemsRestsPred: Raster;
  readonly noteheadPred: Raster;
  readonly clefsKeysPred: Raster;

  constructor(m: ModelMaps) {
    this.width = m.width;
    this.height = m.height;
    const r = (d: Uint8Array) => raster(m.width, m.height, d);
    this.staffPred = r(m.staff);
    this.stemsRestsPred = r(m.stemsRests);
    this.noteheadPred = r(m.notehead);
    this.clefsKeysPred = r(m.clefsKeys);
    const sym = new Uint8Array(m.symbols.length);
    for (let i = 0; i < sym.length; i++) sym[i] = m.symbols[i] || m.clefsKeys[i] || m.stemsRests[i] ? 1 : 0;
    this.symbolsPred = r(sym);
  }
}

/** Splits the two argmax maps of the inference worker into oemer's five binary layers. */
export function mapsFromSegmentation(width: number, height: number, staffSymbols: Uint8Array, sep: Uint8Array): ModelMaps {
  const n = width * height;
  const staff = new Uint8Array(n);
  const symbols = new Uint8Array(n);
  const stemsRests = new Uint8Array(n);
  const notehead = new Uint8Array(n);
  const clefsKeys = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (staffSymbols[i] === 1) staff[i] = 1;
    else if (staffSymbols[i] === 2) symbols[i] = 1;
    if (sep[i] === 1) stemsRests[i] = 1;
    else if (sep[i] === 2) notehead[i] = 1;
    else if (sep[i] === 3) clefsKeys[i] = 1;
  }
  return { width, height, staff, symbols, stemsRests, notehead, clefsKeys };
}

/** Unpacks the bit-packed fixture format (bit0 staff, bit1 symbols, bit2 stems/rests, bit3 noteheads, bit4 clefs/keys). */
export function mapsFromPacked(width: number, height: number, packed: Uint8Array): ModelMaps {
  const n = width * height;
  const bit = (b: number) => {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = (packed[i] >> b) & 1;
    return out;
  };
  return { width, height, staff: bit(0), symbols: bit(1), stemsRests: bit(2), notehead: bit(3), clefsKeys: bit(4) };
}

/** Python's round(): half to even. */
export function pyRound(v: number): number {
  const f = Math.floor(v);
  const d = v - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

/** np.mean (pairwise summation, bit-exact with numpy for float64). */
export function mean(a: ArrayLike<number>): number {
  return npMean(a);
}

export function std(a: ArrayLike<number>): number {
  const m = mean(a);
  const dev = new Float64Array(a.length);
  for (let i = 0; i < a.length; i++) dev[i] = (a[i] - m) ** 2;
  return Math.sqrt(npMean(dev));
}
