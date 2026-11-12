// Main-thread wrapper around the inference worker: promise + progress callback + cancel.

import type { Img } from './geometry';
import type { InferenceMessage, InferenceRequest, Provider } from './inference.worker';
import type { Quality } from './tiling';

export interface Segmentation {
  image: Img;
  maps: Uint8Array[];
  provider: Provider;
  threads: number;
  ms: number;
}

export type ProgressInfo = Extract<InferenceMessage, { type: 'progress' }>;

export class OmrRunner {
  private worker: Worker | null = null;
  private reject: ((e: Error) => void) | null = null;

  get running(): boolean {
    return this.worker !== null;
  }

  run(image: Img, quality: Quality, onProgress: (p: ProgressInfo) => void, allowGpu = true): Promise<Segmentation> {
    this.cancel();
    const worker = new Worker(new URL('./inference.worker.ts', import.meta.url), { type: 'module' });
    this.worker = worker;
    return new Promise<Segmentation>((resolve, reject) => {
      this.reject = reject;
      worker.onmessage = (e: MessageEvent<InferenceMessage>) => {
        const m = e.data;
        if (m.type === 'progress') onProgress(m);
        else if (m.type === 'done') {
          this.finish();
          resolve({ image: m.image, maps: m.maps, provider: m.provider, threads: m.threads, ms: m.ms });
        } else if (m.type === 'error') {
          this.finish();
          reject(new Error(m.message));
        }
      };
      worker.onerror = (e) => {
        this.finish();
        reject(new Error(e.message || 'inference worker failed'));
      };
      const copy = new Uint8ClampedArray(image.data); // keep the caller's buffer
      const req: InferenceRequest = {
        type: 'run',
        image: { width: image.width, height: image.height, data: copy },
        modelBase: `${import.meta.env.BASE_URL}models/`,
        quality,
        allowGpu,
      };
      worker.postMessage(req, [copy.buffer]);
    });
  }

  cancel(): void {
    if (!this.worker) return;
    const reject = this.reject;
    this.finish();
    reject?.(new Error('cancelled'));
  }

  private finish(): void {
    this.worker?.terminate();
    this.worker = null;
    this.reject = null;
  }
}

/** Colours for the segmentation preview: [map index, class] → RGB. */
export const LAYER_COLORS: { map: number; cls: number; key: string; rgb: [number, number, number] }[] = [
  { map: 0, cls: 1, key: 'staff', rgb: [59, 130, 196] },
  { map: 0, cls: 2, key: 'symbols', rgb: [46, 160, 90] },
  { map: 1, cls: 2, key: 'noteheads', rgb: [224, 69, 58] },
  { map: 1, cls: 1, key: 'stems', rgb: [235, 150, 30] },
  { map: 1, cls: 3, key: 'clefs', rgb: [150, 80, 200] },
];

/** Page image faded, with the selected layers painted on top. */
export function overlayImage(seg: Segmentation, layers: Set<string>): Img {
  const { width, height } = seg.image;
  const src = seg.image.data;
  const out = new Uint8ClampedArray(src.length);
  const active = LAYER_COLORS.filter((l) => layers.has(l.key));
  for (let p = 0, i = 0; p < width * height; p++, i += 4) {
    let r = 255 - (255 - src[i]) * 0.35;
    let g = 255 - (255 - src[i + 1]) * 0.35;
    let b = 255 - (255 - src[i + 2]) * 0.35;
    for (const l of active) {
      if (seg.maps[l.map][p] === l.cls) {
        [r, g, b] = l.rgb;
      }
    }
    out[i] = r;
    out[i + 1] = g;
    out[i + 2] = b;
    out[i + 3] = 255;
  }
  return { width, height, data: out };
}
