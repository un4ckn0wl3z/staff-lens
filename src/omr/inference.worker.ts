/// <reference lib="webworker" />
// Runs oemer's two segmentation models over a page with onnxruntime-web (WebGPU if available, else WASM).

import { oemerTargetSize, resize, type Img } from './geometry';
import { fillWindowBGR, OEMER_MODELS, ScoreAccumulator, stepFor, tiles, type Quality } from './tiling';

export interface InferenceRequest {
  type: 'run';
  image: Img;
  /** URL prefix of the .onnx files, e.g. "/staff-lens/models/". */
  modelBase: string;
  quality: Quality;
  allowGpu: boolean;
}

export type Provider = 'webgpu' | 'wasm';

export type InferenceMessage =
  | { type: 'progress'; stage: 'download' | 'load' | 'infer'; model: number; done: number; total: number; provider?: Provider; threads?: number }
  | {
      type: 'done';
      image: Img;
      /** maps[0]: 0 bg, 1 staff, 2 symbols. maps[1]: 0 bg, 1 stems/rests, 2 noteheads, 3 clefs/keys. */
      maps: Uint8Array[];
      provider: Provider;
      threads: number;
      ms: number;
    }
  | { type: 'error'; message: string };

const post = (m: InferenceMessage, transfer: Transferable[] = []) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(m, transfer);

async function download(url: string, model: number): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`model not found (${res.status}) at ${url} — run "npm run fetch-models"`);
  const total = Number(res.headers.get('content-length')) || 0;
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let done = 0;
  let last = 0;
  for (;;) {
    const r = await reader.read();
    if (r.done) break;
    chunks.push(r.value);
    done += r.value.length;
    if (done - last > 1_000_000) {
      last = done;
      post({ type: 'progress', stage: 'download', model, done, total });
    }
  }
  const out = new Uint8Array(done);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

async function hasWebGpu(): Promise<boolean> {
  const gpu = (navigator as unknown as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  if (!gpu) return false;
  try {
    return !!(await gpu.requestAdapter());
  } catch {
    return false;
  }
}

async function run(req: InferenceRequest): Promise<void> {
  const t0 = performance.now();
  const ort = await import('onnxruntime-web/webgpu');
  const isolated = (self as unknown as { crossOriginIsolated?: boolean }).crossOriginIsolated === true;
  const threads = isolated ? Math.max(1, Math.min(8, navigator.hardwareConcurrency || 4)) : 1;
  ort.env.wasm.numThreads = threads;
  let provider: Provider = req.allowGpu && (await hasWebGpu()) ? 'webgpu' : 'wasm';

  const target = oemerTargetSize(req.image.width, req.image.height);
  const image = resize(req.image, target.width, target.height);
  const maps: Uint8Array[] = [];

  for (let m = 0; m < OEMER_MODELS.length; m++) {
    const spec = OEMER_MODELS[m];
    const bytes = await download(req.modelBase + spec.file, m);
    post({ type: 'progress', stage: 'load', model: m, done: 0, total: 1, provider, threads });
    let session: Awaited<ReturnType<typeof ort.InferenceSession.create>>;
    try {
      session = await ort.InferenceSession.create(bytes, { executionProviders: [provider], graphOptimizationLevel: 'all' });
    } catch (e) {
      if (provider !== 'webgpu') throw e;
      provider = 'wasm'; // WebGPU present but unusable for this model
      session = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
    }
    const win = spec.window;
    const list = tiles(image.width, image.height, win, stepFor(win, req.quality));
    const batch = provider === 'webgpu' ? 4 : 1;
    const acc = new ScoreAccumulator(image.width, image.height, spec.classes);
    const input = session.inputNames[0];
    const output = session.outputNames[0];
    post({ type: 'progress', stage: 'infer', model: m, done: 0, total: list.length, provider, threads });
    for (let i = 0; i < list.length; i += batch) {
      const part = list.slice(i, i + batch);
      const data = new Uint8Array(part.length * win * win * 3);
      part.forEach((tile, k) => fillWindowBGR(image.data, image.width, image.height, tile, win, data, k * win * win * 3));
      const result = await session.run({ [input]: new ort.Tensor('uint8', data, [part.length, win, win, 3]) });
      const pred = (await result[output].getData()) as Float32Array;
      part.forEach((tile, k) => acc.add(tile, win, pred, k * win * win * spec.classes));
      result[output].dispose?.();
      post({ type: 'progress', stage: 'infer', model: m, done: Math.min(list.length, i + part.length), total: list.length, provider, threads });
    }
    await session.release();
    maps.push(acc.argmax());
  }
  post({ type: 'done', image, maps, provider, threads, ms: performance.now() - t0 }, [image.data.buffer, ...maps.map((x) => x.buffer)]);
}

self.onmessage = (e: MessageEvent<InferenceRequest>) => {
  if (e.data?.type !== 'run') return;
  run(e.data).catch((err: unknown) => post({ type: 'error', message: err instanceof Error ? err.message : String(err) }));
};
