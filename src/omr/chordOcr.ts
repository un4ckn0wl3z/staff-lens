// Chord-symbol OCR: reads text in the band above each staff system with Tesseract.js, keeps the words
// that are chord symbols, and snaps each one to the beat below it.

import { label4 } from './oemer/cv';
import type { TimelineEntry } from './oemer/builder';
import type { SystemLayout } from './oemer/pipeline';
import { parseChordSymbol } from '../theory/chord';

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface OcrWord {
  text: string;
  confidence: number;
  bbox: { x0: number; y0: number; x1: number; y1: number };
}

export interface ChordHit {
  measure: number;
  tick: number;
  text: string;
  confidence: number;
}

/** The text band above a system's top staff (where chord symbols are printed). */
export function chordBands(systems: SystemLayout[], width: number, height: number): { group: number; rect: Rect }[] {
  return systems.map((s) => {
    const top = Math.max(0, Math.round(s.top - 4.5 * s.unit));
    const bottom = Math.max(top + 1, Math.round(s.top - 0.15 * s.unit));
    const left = Math.max(0, Math.round(s.left - s.unit));
    const right = Math.min(width, Math.round(s.right + s.unit));
    return { group: s.group, rect: { left, top, width: Math.max(1, right - left), height: Math.min(height, bottom) - top } };
  });
}

/** Cleans up an OCR word and returns it if it reads as a chord symbol. */
export function normalizeChordText(raw: string): string | null {
  let t = raw.trim().replace(/^[[({'"`.,:;|]+|[\])}'"`.,:;|]+$/g, '');
  t = t.replace(/♯/g, '#').replace(/♭/g, 'b').replace(/[°º]/g, 'dim').replace(/Δ/g, 'maj7').replace(/ø/g, 'm7b5');
  t = t.replace(/^([a-g])/, (m) => m.toUpperCase());
  // italic 7s are often read as "/", "z", "r", ";", ":", "?" or "Y": repair only when that makes a valid chord
  const fixed = t.replace(/[/zZ?Yyr;:]$/, '7');
  if (fixed !== t && !parseChordSymbol(t) && parseChordSymbol(fixed)) t = fixed;
  if (!t || t.length > 10 || !/^[A-G]/.test(t)) return null;
  const parsed = parseChordSymbol(t);
  if (!parsed) return null;
  // single letters inside words ("A" in "Aura") are rejected by the suffix parser; also reject lone "B"/"C"… only when
  // OCR is unsure (handled by the caller's confidence threshold)
  return t;
}

/** Snaps recognised chord words to the nearest first-voice beat of the same system. */
export function placeChords(words: (OcrWord & { group: number })[], timeline: TimelineEntry[], systems: SystemLayout[], minConfidence = 30): ChordHit[] {
  const best = new Map<string, ChordHit>();
  for (const w of words) {
    if (w.confidence < minConfidence) continue;
    const text = normalizeChordText(w.text);
    if (!text) continue;
    const sys = systems.find((s) => s.group === w.group);
    if (!sys) continue;
    // chord symbols start at the note they belong to: compare the beat's centre with the word's left part
    const anchor = w.bbox.x0 + Math.min((w.bbox.x1 - w.bbox.x0) / 2, sys.unit * 0.6);
    let pick: TimelineEntry | null = null;
    let bd = Infinity;
    for (const e of timeline) {
      if (e.group !== w.group) continue;
      const d = Math.abs(e.x - anchor);
      if (d < bd) {
        bd = d;
        pick = e;
      }
    }
    if (!pick || bd > sys.unit * 2) continue;
    const key = `${pick.measure}:${pick.tick}`;
    const prev = best.get(key);
    if (!prev || prev.confidence < w.confidence) best.set(key, { measure: pick.measure, tick: pick.tick, text, confidence: w.confidence });
  }
  return [...best.values()].sort((a, b) => a.measure - b.measure || a.tick - b.tick);
}

/**
 * Finds word-sized groups of dark pixels in a band (chord symbols are short words above the staff).
 * `gray` is the page in 0..255, `rect` the band.
 */
export function findTextBlobs(gray: Uint8Array | Uint8ClampedArray, width: number, rect: Rect, unit: number): Rect[] {
  const { left, top, width: w, height: h } = rect;
  const bin = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) bin[y * w + x] = gray[(top + y) * width + left + x] < 200 ? 1 : 0; // light: thin italic strokes are anti-aliased grey
  const { labels, count } = label4({ width: w, height: h, data: bin });
  const box = Array.from({ length: count + 1 }, () => [Infinity, Infinity, -1, -1]);
  for (let i = 0; i < labels.length; i++) {
    const l = labels[i];
    if (!l) continue;
    const x = i % w;
    const y = (i - x) / w;
    const b = box[l];
    if (x < b[0]) b[0] = x;
    if (y < b[1]) b[1] = y;
    if (x > b[2]) b[2] = x;
    if (y > b[3]) b[3] = y;
  }
  const comps = box
    .slice(1)
    .filter((b) => b[2] >= 0)
    .filter((b) => {
      const bh = b[3] - b[1] + 1;
      const bw = b[2] - b[0] + 1;
      // drop only things that are too big for text (clef tops, stems running through the band)
      return bh <= unit * 2.2 && bw <= unit * 4 && !(b[1] <= 0 && b[3] >= h - 1);
    })
    .sort((a, b) => a[0] - b[0]);
  // merge neighbours into words
  const words: number[][] = [];
  for (const c of comps) {
    const last = words.find((wd) => c[0] - wd[2] < unit * 0.75 && c[0] >= wd[0] - unit * 0.2 && Math.min(c[3], wd[3]) - Math.max(c[1], wd[1]) > -unit * 0.3);
    if (last) {
      last[0] = Math.min(last[0], c[0]);
      last[1] = Math.min(last[1], c[1]);
      last[2] = Math.max(last[2], c[2]);
      last[3] = Math.max(last[3], c[3]);
    } else words.push([...c]);
  }
  const pad = Math.round(unit * 0.35);
  return words
    .filter((b) => b[3] - b[1] + 1 >= unit * 0.45)
    .map((b) => ({
      left: Math.max(0, left + b[0] - pad),
      top: Math.max(0, top + b[1] - pad),
      width: b[2] - b[0] + 1 + 2 * pad,
      height: b[3] - b[1] + 1 + 2 * pad,
    }));
}

/** Crops rectangles of a page out as PNG blobs (browser input for createTesseractEngine). */
export function pngCropper(page: ImageData): (rect: Rect) => Promise<Blob> {
  const src = new OffscreenCanvas(page.width, page.height);
  src.getContext('2d')!.putImageData(page, 0, 0);
  return (r) => {
    const c = new OffscreenCanvas(r.width, r.height);
    const g = c.getContext('2d')!;
    g.fillStyle = '#fff';
    g.fillRect(0, 0, r.width, r.height);
    g.drawImage(src, -r.left, -r.top);
    return c.convertToBlob({ type: 'image/png' });
  };
}

/** Words read in the last recognizeChords() call (for debugging and tests). */
export let lastWords: (OcrWord & { group: number })[] = [];

export interface OcrEngine {
  /** Recognise words inside `rect` of the image (coordinates in image pixels). */
  words(rect: Rect): Promise<OcrWord[]>;
  terminate(): Promise<void>;
}

/**
 * Tesseract.js-backed engine; paths point at self-hosted files (see tools/copy-ocr.mjs).
 * `image` is either a whole page Tesseract can read (node: a PNG buffer) or a function that returns the crop of
 * one rectangle (browser: a small PNG blob, since Tesseract.js cannot read ImageData there).
 */
export async function createTesseractEngine(
  image: unknown | ((rect: Rect) => Promise<unknown>),
  paths?: { workerPath: string; corePath: string; langPath: string },
): Promise<OcrEngine> {
  const { createWorker, PSM, OEM } = await import('tesseract.js');
  const opts = Object.fromEntries(Object.entries(paths ?? {}).filter(([, v]) => v !== undefined));
  const worker = await createWorker('eng', OEM.LSTM_ONLY, {
    ...opts,
    gzip: true,
    workerBlobURL: false,
    logger: () => undefined,
  });
  await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_WORD, preserve_interword_spaces: '0' });
  return {
    async words(rect: Rect) {
      type Input = Parameters<typeof worker.recognize>[0];
      const res =
        typeof image === 'function'
          ? await worker.recognize((await image(rect)) as Input, {}, { blocks: true })
          : await worker.recognize(image as Input, { rectangle: rect }, { blocks: true });
      const out: OcrWord[] = [];
      for (const block of res.data.blocks ?? [])
        for (const para of block.paragraphs)
          for (const line of para.lines)
            for (const word of line.words) out.push({ text: word.text, confidence: word.confidence, bbox: word.bbox });
      return out;
    },
    terminate: () => worker.terminate().then(() => undefined),
  };
}

/**
 * Runs OCR on each word-sized blob above every system and returns the chord symbols with their positions.
 * `gray` is the page used for OCR (width×height); `scale` maps layout coordinates to it.
 */
export async function recognizeChords(
  engine: OcrEngine,
  gray: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  systems: SystemLayout[],
  timeline: TimelineEntry[],
  scale = 1,
): Promise<ChordHit[]> {
  const words: (OcrWord & { group: number })[] = [];
  const scaled = systems.map((s) => ({ ...s, top: s.top * scale, left: s.left * scale, right: s.right * scale, unit: s.unit * scale }));
  for (const band of chordBands(scaled, width, height)) {
    const sys = scaled.find((s) => s.group === band.group)!;
    if (band.rect.width < 4 || band.rect.height < 4) continue;
    for (const blob of findTextBlobs(gray, width, band.rect, sys.unit)) {
      const found = await engine.words(blob);
      const text = found.map((f) => f.text).join('');
      if (!text) continue;
      const conf = Math.min(...found.map((f) => f.confidence));
      words.push({ text, confidence: conf, group: band.group, bbox: { x0: blob.left / scale, y0: blob.top / scale, x1: (blob.left + blob.width) / scale, y1: (blob.top + blob.height) / scale } });
    }
  }
  // blobs are padded: snap using the blob's own extent
  lastWords = words;
  return placeChords(words, timeline, systems);
}
