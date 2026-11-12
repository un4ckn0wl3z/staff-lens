// Loading score images and PDF pages into RGBA buffers. pdf.js is loaded only when a PDF is opened.

import type { Img } from './geometry';

export const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'];
export const PDF_EXTENSIONS = ['pdf'];

export function isImageFile(name: string): boolean {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  return IMAGE_EXTENSIONS.includes(ext) || PDF_EXTENSIONS.includes(ext);
}

/** Longest side used when rasterising: enough for oemer's ~3.5 MP input. */
const MAX_SIDE = 3200;

function canvasToImg(canvas: HTMLCanvasElement | OffscreenCanvas): Img {
  const ctx = canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { width: data.width, height: data.height, data: data.data };
}

export async function loadImageFile(file: Blob): Promise<Img> {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = '#fff'; // transparent PNGs -> white paper
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  return canvasToImg(canvas);
}

export interface PdfHandle {
  pageCount: number;
  renderPage(index: number): Promise<Img>;
  destroy(): void;
}

export async function openPdf(data: Uint8Array): Promise<PdfHandle> {
  const pdfjs = await import('pdfjs-dist');
  const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  const task = pdfjs.getDocument({ data });
  const doc = await task.promise;
  return {
    pageCount: doc.numPages,
    async renderPage(index: number): Promise<Img> {
      const page = await doc.getPage(index + 1);
      const base = page.getViewport({ scale: 1 });
      const scale = MAX_SIDE / Math.max(base.width, base.height);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      await page.render({ canvas, viewport, background: '#ffffff' }).promise;
      page.cleanup();
      return canvasToImg(canvas);
    },
    destroy() {
      void task.destroy();
    },
  };
}

/** Draws an Img onto a canvas element (resizing the canvas). */
export function drawImg(canvas: HTMLCanvasElement, img: Img): void {
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d')!;
  ctx.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
}

export async function imgToPngBlob(img: Img): Promise<Blob> {
  const canvas = document.createElement('canvas');
  drawImg(canvas, img);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG encoding failed'))), 'image/png'));
}
