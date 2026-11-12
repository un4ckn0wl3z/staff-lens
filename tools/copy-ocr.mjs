// Copies Tesseract.js (Apache-2.0) and its English LSTM data into public/ocr/ so chord OCR works offline
// and without a CDN. Runs before `npm run dev` and `npm run build`.
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const nm = join(root, 'node_modules');
const out = join(root, 'public', 'ocr');
const files = [
  [join(nm, 'tesseract.js', 'dist', 'worker.min.js'), join(out, 'worker.min.js')],
  ...['tesseract-core-lstm.wasm.js', 'tesseract-core-simd-lstm.wasm.js', 'tesseract-core-relaxedsimd-lstm.wasm.js'].map((f) => [join(nm, 'tesseract.js-core', f), join(out, 'core', f)]),
  [join(nm, '@tesseract.js-data', 'eng', '4.0.0_best_int', 'eng.traineddata.gz'), join(out, 'lang', 'eng.traineddata.gz')],
];
for (const [src, dst] of files) {
  if (!existsSync(src)) throw new Error(`missing ${src} — run npm install`);
  mkdirSync(dirname(dst), { recursive: true });
  if (existsSync(dst) && statSync(dst).size === statSync(src).size) continue;
  copyFileSync(src, dst);
}
console.log('OCR files ready in public/ocr');
